import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DslImportError, fromStructurizrDsl, type IncludeResolver } from '../../src/core/import/structurizr/fromStructurizrDsl';
import { validateDocument } from '../../src/core/model/schema';

function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Textos arbitrarios sobre el importador de DSL, con semillas fijas (reproducibles). Deben producir siempre un
// documento válido o un `DslImportError` con motivo; nunca una excepción cruda ni un documento que rompa el
// esquema (ese caso lo delata el mensaje "No se pudo construir un documento C4 válido"). Por defecto es ligero;
// para una pasada profunda:
//   SEEDS=3000 npx vitest run tests/fuzz/importDsl
const SEEDS = Number(process.env.SEEDS ?? 300);

function check(text: string, label: string, failures: string[], resolveInclude?: IncludeResolver): 'ok' | 'error' {
  try {
    const { document } = fromStructurizrDsl(text, { resolveInclude, file: 'main.dsl' });
    const result = validateDocument(document);
    if (!result.ok) failures.push(`${label}: documento inválido ${JSON.stringify(result.issues.slice(0, 2))}`);
    return 'ok';
  } catch (error) {
    if (!(error instanceof DslImportError)) failures.push(`${label}: excepción cruda ${(error as Error).stack?.split('\n').slice(0, 3).join(' | ')}`);
    else if (/No se pudo construir un documento C4 válido/.test(error.message)) failures.push(`${label}: invariante interna rota: ${error.message.slice(0, 200)}`);
    return 'error';
  }
}

describe('importación de DSL: textos arbitrarios', () => {
  it('un DSL válido mutado (líneas, palabras, llaves, comillas, truncado) nunca produce una excepción cruda', () => {
    const base = readFileSync('examples/banca.dsl', 'utf8');
    const GARBAGE = ['', '->', '=', '{', '}', '"', '"""', '*', '${X}', '!include', 'this', 'a.b.c', '__proto__', 'x'.repeat(300), '#', '//', '/*', '\\', 'element.tag==', '->x->', 'autolayout', 'person', 'container'];
    const failures: string[] = [];
    let ok = 0;
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const rnd = mulberry32(seed);
      const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
      let lines = base.split('\n');
      for (let n = 1 + Math.floor(rnd() * 6); n > 0 && lines.length > 0; n -= 1) {
        const i = Math.floor(rnd() * lines.length);
        const op = Math.floor(rnd() * 6);
        if (op === 0) lines.splice(i, 1);
        else if (op === 1) lines.splice(i, 0, lines[i]);
        else if (op === 2) lines.sort(() => rnd() - 0.5);
        else if (op === 3) {
          const words = lines[i].split(' ');
          words[Math.floor(rnd() * words.length)] = pick(GARBAGE);
          lines[i] = words.join(' ');
        } else if (op === 4) lines.splice(i, 0, pick(GARBAGE));
        else lines = lines.slice(0, Math.floor(rnd() * lines.length));
      }
      let text = lines.join(rnd() < 0.1 ? '\r\n' : '\n');
      if (rnd() < 0.15) text = text.slice(0, Math.floor(rnd() * text.length));
      if (check(text, `mutación semilla ${seed}`, failures, () => ({ file: 'inc.dsl', text: lines.slice(0, 5).join('\n') })) === 'ok') ok += 1;
    }
    expect(failures).toEqual([]);
    expect(ok).toBeGreaterThan(SEEDS * 0.1); // que una parte de las entradas llegue a producir documento
  }, 120_000);

  it('DSL generado al azar con construcciones sueltas (anidamientos imposibles, identificadores repetidos, vistas raras)', () => {
    const IDENTS = ['a', 'b', 'c', 'web', 'db', 'x.y', 'a.web', '__proto__', 'constructor', 'this', 'a-b'];
    const NAMES = ['"Uno"', '"Dos"', '""', '"a -> b"', 'SinComillas', '"${K}"', '"Nombre largo con espacios"'];
    const TAGS = ['', ' "External"', ' "Database,Custom"', ' "Existing System"'];
    const STYLE_BLOCKS = ['styles { element "Custom" { background #f80 shape pipe } element "Database" { shape cylinder } }', 'styles { element "" { } }', 'styles { element }'];
    const failures: string[] = [];
    let ok = 0;
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const rnd = mulberry32(seed * 7919);
      const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
      const statement = (depth: number): string => {
        const r = rnd();
        const ident = rnd() < 0.7 ? `${pick(IDENTS)} = ` : '';
        if (r < 0.14) return `${ident}person ${pick(NAMES)}${TAGS.length ? pick(TAGS) : ''}`;
        if (r < 0.28) return `${ident}softwareSystem ${pick(NAMES)}${rnd() < 0.4 ? ` "desc" "${pick(['External', 'x'])}"` : ''}${depth < 3 && rnd() < 0.6 ? ` { ${statement(depth + 1)}\n ${statement(depth + 1)} }` : ''}`;
        if (r < 0.42) return `${ident}container ${pick(NAMES)} "d" "Tech"${pick(TAGS)}${depth < 3 && rnd() < 0.5 ? ` { ${statement(depth + 1)} }` : ''}`;
        if (r < 0.52) return `${ident}component ${pick(NAMES)} "d" "Tech"`;
        if (r < 0.7) return `${rnd() < 0.15 ? '' : pick(IDENTS)} -> ${pick(IDENTS)} ${pick(NAMES)}${rnd() < 0.5 ? ' "HTTPS"' : ''}`;
        if (r < 0.76) return `group ${pick(NAMES)} { ${statement(depth + 1)} }`;
        if (r < 0.8) return `tags "T1,T2"\ndescription "x"\nurl "http://x"`;
        if (r < 0.84) return `deploymentEnvironment "Live" { deploymentNode "N" { containerInstance ${pick(IDENTS)} } }`;
        if (r < 0.88) return `!identifiers ${pick(['hierarchical', 'flat'])}`;
        if (r < 0.92) return `!const K "valor"\n!include ${pick(['inc.dsl', 'nada.dsl', 'main.dsl'])}`;
        return `${pick(IDENTS)}`;
      };
      const view = (): string => {
        const kind = pick(['systemContext', 'container', 'component', 'systemLandscape', 'dynamic', 'filtered']);
        const scope = kind === 'systemLandscape' ? '' : ` ${pick(IDENTS)}`;
        const includes = Array.from({ length: Math.floor(rnd() * 3) }, () => `\n    ${pick(['include', 'exclude'])} ${pick(['*', ...IDENTS, `->${pick(IDENTS)}->`, 'element.tag==External', 'element.type==Container', 'relationship==*', '"?"'])}`).join('');
        return `${kind}${scope}${rnd() < 0.7 ? ` "${pick(['k1', 'k2', 'k1', ''])}"` : ''} {${includes}\n    ${pick(['autoLayout', 'autoLayout rl 100 50', 'title "T"', 'animation { }'])}\n  }`;
      };
      const statements = Array.from({ length: 1 + Math.floor(rnd() * 8) }, () => statement(0)).join('\n    ');
      const views = Array.from({ length: Math.floor(rnd() * 4) }, view).concat(rnd() < 0.5 ? [pick(STYLE_BLOCKS)] : []).join('\n  ');
      const text = `workspace "F${seed}" {\n  model {\n    ${statements}\n  }\n  views {\n  ${views}\n  }\n}`;
      if (check(text, `generado semilla ${seed}`, failures, () => ({ file: 'inc.dsl', text: 'ip = person "IncP"' })) === 'ok') ok += 1;
    }
    expect(failures).toEqual([]);
    expect(ok).toBeGreaterThan(SEEDS * 0.3);
  }, 120_000);
});
