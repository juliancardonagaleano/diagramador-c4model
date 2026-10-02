import { describe, expect, it } from 'vitest';
import { HclExpr, HclSyntaxError, isExpr, normalizeRef, parseHcl, refFromTraversal, refsOf, type HclBlock } from './hcl';

const first = (source: string): HclBlock => {
  const file = parseHcl(source);
  expect(file.blocks.length).toBeGreaterThan(0);
  return file.blocks[0];
};

describe('analizador de HCL: estructura', () => {
  it('lee bloques con etiquetas, atributos literales y bloques anidados', () => {
    const b = first(`
      resource "aws_db_instance" "orders" {
        engine         = "postgres"
        engine_version = "15.4"
        multi_az       = true
        allocated_storage = 100
        timeouts {
          create = "60m"
        }
      }
    `);
    expect(b).toMatchObject({ type: 'resource', labels: ['aws_db_instance', 'orders'], attrs: { engine: 'postgres', engine_version: '15.4', multi_az: true, allocated_storage: 100 } });
    expect(b.blocks).toHaveLength(1);
    expect(b.blocks[0]).toMatchObject({ type: 'timeouts', attrs: { create: '60m' } });
  });

  it('acepta comentarios de los tres estilos, comas finales y etiquetas sin comillas', () => {
    const file = parseHcl(`# almacén
// otro
/* varias
   líneas */
variable env { default = "prod" } # al final
locals {
  azs = ["a", "b",]
  tags = { Name = "x", Env = "y", }
}`);
    expect(file.blocks.map((b) => [b.type, b.labels])).toEqual([['variable', ['env']], ['locals', []]]);
    expect(file.blocks[0].attrs.default).toBe('prod');
    expect(file.blocks[1].attrs).toEqual({ azs: ['a', 'b'], tags: { Name: 'x', Env: 'y' } });
    expect(file.warnings).toEqual([]);
  });

  it('lee heredocs (con y sin sangría) como cadenas literales', () => {
    const b = first(`resource "aws_iam_policy" "p" {
  policy = <<-EOT
    {
      "Version": "2012-10-17"
    }
  EOT
  other = <<EOF
línea 1
línea 2
EOF
}`);
    expect(String(b.attrs.policy)).toContain('"Version": "2012-10-17"');
    expect(String(b.attrs.other)).toBe('línea 1\nlínea 2\n');
  });

  it('conserva números negativos, flotantes y null', () => {
    const b = first('x "y" {\n a = -1\n b = 2.5\n c = null\n d = 1e3\n}');
    expect(b.attrs).toMatchObject({ a: -1, b: 2.5, c: null, d: 1000 });
  });

  it('guarda los atributos de primer nivel que no son HCL de Terraform válido', () => {
    const file = parseHcl('region = "eu-west-1"\nresource "a_b" "c" {}\n');
    expect(file.attrs.region).toBe('eu-west-1');
    expect(file.blocks).toHaveLength(1);
  });

  it('un archivo vacío o de solo comentarios no tiene bloques', () => {
    expect(parseHcl('').blocks).toEqual([]);
    expect(parseHcl('# nada\n').blocks).toEqual([]);
  });
});

describe('analizador de HCL: expresiones y referencias', () => {
  it('distingue cadenas literales de interpolaciones y extrae sus referencias', () => {
    const b = first(`resource "aws_subnet" "a" {
  vpc_id = aws_vpc.main.id
  name   = "\${var.project}-\${local.suffix}-a"
  plain  = "sin interpolar"
  escaped = "\${"$"}{no}"
}`);
    const vpc = b.attrs.vpc_id;
    expect(isExpr(vpc)).toBe(true);
    expect((vpc as HclExpr).refs).toEqual(['aws_vpc.main']);
    const name = b.attrs.name as HclExpr;
    expect(isExpr(name)).toBe(true);
    expect(name.template).toBe('${var.project}-${local.suffix}-a');
    expect(name.refs).toEqual(['var.project', 'local.suffix']);
    expect(b.attrs.plain).toBe('sin interpolar');
  });

  it('reconoce referencias con índices, splat, módulos, datos y funciones', () => {
    const b = first(`resource "aws_lb" "x" {
  subnets   = aws_subnet.public[*].id
  subnet    = aws_subnet.private[0].id
  vpc       = module.vpc.vpc_id
  ami       = data.aws_ami.ubuntu.id
  merged    = merge(local.tags, { Name = aws_vpc.main.id })
  cond      = var.enabled ? aws_eip.a.id : null
  for_ids   = [for s in aws_subnet.private : s.id]
  workspace = terraform.workspace
}`);
    const refs = (name: string): string[] => (b.attrs[name] as HclExpr).refs;
    expect(refs('subnets')).toEqual(['aws_subnet.public']);
    expect(refs('subnet')).toEqual(['aws_subnet.private']);
    expect(refs('vpc')).toEqual(['module.vpc.vpc_id']);
    expect(refs('ami')).toEqual(['data.aws_ami.ubuntu']);
    expect(refs('merged')).toEqual(expect.arrayContaining(['local.tags', 'aws_vpc.main']));
    expect(refs('cond')).toEqual(expect.arrayContaining(['var.enabled', 'aws_eip.a']));
    expect(refs('for_ids')).toContain('aws_subnet.private');
    expect(refs('workspace')).toEqual(['terraform.workspace']);
    expect(refsOf(b.attrs.subnets)).toEqual(['aws_subnet.public']);
  });

  it('las llamadas a funciones conservan nombre y argumentos', () => {
    const b = first('locals {\n  all = concat(["a"], ["b"])\n  low = lower("ABC")\n}');
    const all = b.attrs.all as HclExpr;
    expect(all.call?.fn).toBe('concat');
    expect(all.call?.args).toEqual([['a'], ['b']]);
    expect((b.attrs.low as HclExpr).call).toMatchObject({ fn: 'lower', args: ['ABC'] });
  });

  it('las listas y los mapas mezclan literales y referencias', () => {
    const b = first(`resource "aws_x" "y" {
  ids  = [aws_a.one.id, "literal", aws_b.two.arn]
  tags = { Name = "n", Owner = var.owner }
}`);
    expect(refsOf(b.attrs.ids)).toEqual(['aws_a.one', 'aws_b.two']);
    expect(refsOf(b.attrs.tags)).toEqual(['var.owner']);
    expect((b.attrs.tags as Record<string, unknown>).Name).toBe('n');
  });

  it('normaliza el texto de una referencia', () => {
    expect(normalizeRef('aws_subnet.private[0].id')).toBe('aws_subnet.private');
    expect(normalizeRef('module.vpc.private_subnets')).toBe('module.vpc.private_subnets');
    expect(normalizeRef('var.environment')).toBe('var.environment');
    expect(normalizeRef('each.value')).toBeUndefined();
    expect(normalizeRef('path.module')).toBeUndefined();
    expect(refFromTraversal(['data', 'aws_ami', 'x', 'id'])).toBe('data.aws_ami.x');
    expect(refFromTraversal(['data'])).toBeUndefined();
    expect(refFromTraversal(['count', 'index'])).toBeUndefined();
  });
});

describe('analizador de HCL: tolerancia y errores', () => {
  it('avisa de lo que no entiende y sigue con el resto del archivo', () => {
    const file = parseHcl(`resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
  ???
}
resource "aws_s3_bucket" "assets" {
  bucket = "assets"
}`);
    expect(file.blocks.map((b) => b.labels[1])).toEqual(['main', 'assets']);
    expect(file.blocks[0].attrs.cidr_block).toBe('10.0.0.0/16');
    expect(file.warnings.length).toBeGreaterThan(0);
    expect(file.warnings[0]).toMatch(/línea 3/);
  });

  it.each([
    ['una cadena sin cerrar', 'resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16\n}\n', /cadena.*sin cerrar/i, 2],
    ['un heredoc sin cerrar', 'resource "a_b" "c" {\n  x = <<EOT\n  texto\n}\n', /heredoc.*sin cerrar/i, 2],
    ['una llave sin cerrar', 'resource "a_b" "c" {\n  x = 1\n', /llave de cierre.*línea 1/i, 1],
    ['un comentario sin cerrar', 'resource "a_b" "c" {}\n/* nunca se cierra\n', /comentario.*sin cerrar/i, 2],
  ])('falla con el número de línea ante %s', (_name, source, message, line) => {
    let error: unknown;
    try {
      parseHcl(source);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(HclSyntaxError);
    expect((error as HclSyntaxError).message).toMatch(message);
    expect((error as HclSyntaxError).line).toBe(line);
  });
});
