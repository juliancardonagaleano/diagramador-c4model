/**
 * Importador de Terraform para el módulo de plataforma. Acepta HCL (`.tf`; varios archivos se importan concatenándolos), su
 * versión JSON (`.tf.json`), el estado (`.tfstate`, versión 4) y la salida de `terraform show -json` (de un estado o de un
 * plan). El estado y el plan son más fiables que el HCL: traen los recursos reales, sus ids y sus dependencias.
 *
 * Correspondencia (familias aws, azurerm y google; el detalle por tipo está en `terraformSpecs.ts`):
 *
 *   entrada                                              → elemento del módulo
 *   ---------------------------------------------------------------------------------------------------------------
 *   el stack entero                                      → UN entorno. Su nombre sale, por este orden, de la variable
 *                                                          `environment`/`env`/`stage`, un local, `default_tags`, la
 *                                                          etiqueta `Environment` más frecuente, el workspace de Terraform
 *                                                          Cloud o el nombre del archivo/carpeta (aviso). Con él: `kind`
 *                                                          (dev/test/staging/prod por su nombre), `provider` y `region`.
 *   aws_vpc / azurerm_virtual_network /
 *   google_compute_network                               → red (contenedora)
 *   aws_subnet / azurerm_subnet /
 *   google_compute_subnetwork                            → red hija de su VPC, con su CIDR. Exposición `public` si hay
 *                                                          `map_public_ip_on_launch = true`, una ruta a un internet gateway
 *                                                          (tablas de rutas y asociaciones), la etiqueta de ELB público, un
 *                                                          nombre «public»/«dmz» o una instancia con IP pública; `private` en
 *                                                          los casos contrarios. Si nada lo dice, privada y se avisa.
 *   aws_eks_cluster, aws_ecs_cluster,
 *   azurerm_kubernetes_cluster,
 *   google_container_cluster                             → recurso `cluster` (anfitrión de servicios)
 *   aws_instance, aws_autoscaling_group,
 *   azurerm_*_virtual_machine*, google_compute_instance  → recurso `vm`
 *   bases de datos, cachés, colas y tópicos,
 *   almacenamiento, balanceadores, pasarelas, DNS,
 *   secretos/KMS, registros, certificados, monitorización → recurso de su clase (`database`, `cache`, `queue`, `storage`,
 *                                                          `load-balancer`, `gateway`, `dns`, `secret-store`, `registry`,
 *                                                          `certificate`, `monitoring`); lambdas y apps de Azure/Google
 *                                                          son `other`. Todos con `iac: true`; en un plan, `planned` (crear)
 *                                                          o `decommissioned` (destruir).
 *   aws_ecs_service                                      → servicio + despliegue en su clúster ECS (réplicas =
 *                                                          `desired_count`; imagen y CPU/memoria de su task definition)
 *   module "…" de terraform-aws-modules (vpc, eks, rds,
 *   s3-bucket, sqs, sns, alb, dynamodb-table, ecr), aks,
 *   gke, sql-db y las redes de Azure y Google            → los recursos que despliegan (la VPC con sus subredes
 *                                                          públicas/privadas); el resto de módulos se avisa
 *   referencias entre recursos (también a través de
 *   `local.*`, la definición de tarea de ECS o la plantilla de lanzamiento) y `depends_on`
 *                                                        → dependencia (`data` hacia bases de datos, cachés y almacenes;
 *                                                          `messages` hacia colas; `calls` hacia lo demás)
 *   reglas de ingreso de grupos de seguridad             → dependencia de los miembros del grupo origen hacia los del
 *                                                          destino, con el puerto como protocolo
 *   listeners y grupos de destino de un balanceador      → dependencia balanceador → lo que sirve
 *
 * Lo que NO se mapea y cómo se avisa (todo va a los avisos, agrupado): tipos desconocidos, recursos de soporte que solo se
 * consultan (IAM, tablas de rutas, grupos de seguridad, listeners…, nunca se dibujan), fuentes de datos (`data`), módulos
 * locales o desconocidos (su contenido no está en el archivo), `count`/`for_each` que no se evalúan (un solo recurso), líneas
 * de HCL que no se entienden, redes de exposición desconocida y un entorno por defecto cuando el stack no lo dice. Los
 * valores del estado (contraseñas, claves) nunca se copian: solo se leen los atributos que se mapean.
 *
 * Decisiones conservadoras: un recurso con varias subredes se coloca en la primera privada (o en la pública, si es de los
 * que guardan datos y alguna lo es: así el análisis lo señala); un recurso sin red conocida queda sin red; las instancias
 * de un `for_each`/`count` del estado se expanden solo en las redes. No se crean pipelines: `iac: true` ya indica que el
 * recurso se gestiona como código.
 */
import { pickId, Warnings } from '@iark/kernel';
import { formatPlatformIssues, validatePlatformDocument } from '../schema';
import {
  PLATFORM_DOCUMENT_VERSION,
  type Dependency,
  type DependencyKind,
  type Deployment,
  type Environment,
  type Exposure,
  type Network,
  type PlatformDocument,
  type Resource,
  type ResourceKind,
  type ResourceStatus,
  type Service,
} from '../types';
import { countedList, environmentKindOf, shortList, sourceName, uniqueId, type InfraImportOptions } from './common';
import { PlatformImportError, slug, type PlatformImportResult } from './fromMermaid';
import { isExpr } from './hcl';
import { blocksOf, physicalRefs, readTerraform, Scope, type TfModel, type TfNode, type TfObject } from './terraformModel';
import { CARRIER_TYPES, SPECS, isSupportType, providerFamily, query, synthesizeModule, type Q } from './terraformSpecs';

type Elem =
  | { kind: 'network'; id: string; node: TfNode; net: Network }
  | { kind: 'resource'; id: string; node: TfNode; res: Resource }
  | { kind: 'service'; id: string; node: TfNode; svc: Service };

interface Candidate {
  source: Elem & { kind: 'resource' | 'service' };
  target: Elem & { kind: 'resource' | 'service' };
  protocol?: string;
  description: string;
  rank: number;
}

const ENV_VARIABLES = ['environment', 'env', 'stage', 'environment_name', 'env_name', 'deployment_environment', 'deploy_env', 'app_environment'];
const ENV_TAG = /^(?:environment|env|stage|environment_name)$/i;
const GENERIC_LABELS = new Set(['main', 'this', 'default', 'primary', 'self', 'it', 'one', 'current', 'selected']);
const OWNER_TAG = /^(?:owner|team|team_owner|squad)$/i;
const NAME_ATTRIBUTES = ['name', 'identifier', 'cluster_identifier', 'cluster_name', 'replication_group_id', 'cluster_id', 'bucket', 'repository_name', 'domain_name', 'function_name', 'server_name', 'display_name', 'group_name', 'table_name', 'secret_id', 'repository_id'];
/** Tipos cuyo texto descriptivo sirve de nombre cuando no tienen otro (una clave KMS no se llama de ninguna forma). */
const DESCRIBED = new Set(['aws_kms_key', 'aws_secretsmanager_secret', 'google_secret_manager_secret']);
const SUBNET_CARRIERS = /subnet_group$|^azurerm_network_interface$|^aws_network_interface$/;
const SECURITY_GROUP = /^aws_(?:default_)?security_group$/;
const INGRESS_RULE = /^aws_(?:security_group_rule|vpc_security_group_ingress_rule)$/;
const LISTENER = /^aws_(?:lb|alb)_listener$/;
const LISTENER_RULE = /^aws_(?:lb|alb)_listener_rule$/;
const TARGET_GROUP = /^aws_(?:lb|alb)_target_group$/;

const words = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

const unique = <T>(items: T[]): T[] => [...new Set(items)];

function formatCpu(units: number): string {
  return String(Math.round((units / 1024) * 100) / 100);
}

function formatMemory(mib: number): string {
  return mib >= 1024 && mib % 1024 === 0 ? `${mib / 1024} GiB` : `${mib} MiB`;
}

class TerraformBuilder {
  private readonly scope: Scope;
  private readonly warnings = new Warnings();
  private readonly taken = new Set<string>();
  private nodes: TfNode[] = [];
  private readonly byAddress = new Map<string, TfNode>();
  private readonly moduleOutputs = new Map<string, string[]>();
  private readonly elems = new Map<string, Elem[]>();
  private environmentId = '';
  private readonly networks: Network[] = [];
  private readonly resources: Resource[] = [];
  private readonly services: Service[] = [];
  private readonly deployments: Deployment[] = [];
  private readonly dependencies: Dependency[] = [];
  private readonly publicIpSubnets = new Set<string>();
  private routeExposure = new Map<string, Exposure>();
  private readonly unknownExposure: string[] = [];
  private readonly dynamicCount: string[] = [];
  private readonly mismatches: string[] = [];

  constructor(
    private readonly model: TfModel,
    private readonly options: InfraImportOptions,
  ) {
    this.scope = new Scope(model);
  }

  build(): PlatformImportResult {
    const { model } = this;
    for (const w of model.warnings) this.warnings.add(w);
    const unmappedModules = this.collectNodes();

    const groups = { network: [] as TfNode[], resource: [] as TfNode[], service: [] as TfNode[] };
    const support: string[] = [];
    const unknown: string[] = [];
    const data: string[] = [];
    const disabled: string[] = [];
    for (const node of this.nodes) {
      if (node.mode === 'data') data.push(node.address);
      else if (node.count === 0) disabled.push(node.address);
      else {
        const spec = SPECS[node.type];
        if (spec) groups[spec.kind === 'network' || spec.kind === 'service' ? spec.kind : 'resource'].push(node);
        else if (isSupportType(node.type)) support.push(node.type);
        else unknown.push(node.type);
      }
    }
    const mapped = [...groups.network, ...groups.resource, ...groups.service];
    if (mapped.length === 0) {
      throw new PlatformImportError(
        `El Terraform no define ningún recurso que se pueda importar (redes, clústeres, bases de datos, colas, almacenamiento…).${unknown.length > 0 ? ` Tipos sin mapear: ${countedList(unknown)}.` : ''}`,
      );
    }

    const environment = this.createEnvironment(mapped);
    this.createNetworks(groups.network);
    this.routeExposure = this.routeEvidence();
    this.collectPublicIps();
    this.linkNetworks();
    this.createResources(groups.resource);
    this.createServices(groups.service);
    this.createDependencies();

    this.reportWarnings({ unknown, support, data, disabled, unmappedModules });
    const result = validatePlatformDocument({
      version: PLATFORM_DOCUMENT_VERSION,
      workspace: { name: this.options.name?.trim() || sourceName(this.options) || 'Arquitectura de plataforma' },
      environments: [environment],
      networks: this.networks,
      resources: this.resources,
      services: this.services,
      deployments: this.deployments,
      dependencies: this.dependencies,
      pipelines: [],
    });
    if (!result.ok) throw new PlatformImportError(`No se pudo construir un documento válido a partir de Terraform:\n${formatPlatformIssues(result.issues)}`);
    return { document: result.document as PlatformDocument, warnings: this.warnings.result() };
  }

  // ───────────── nodos y módulos ─────────────

  /** Reúne los nodos (los del código más los que despliegan los módulos conocidos) y devuelve los módulos que no se pueden mapear. */
  private collectNodes(): string[] {
    this.nodes = [...this.model.nodes];
    const unmapped: string[] = [];
    for (const mod of this.model.modules) {
      const synthesized = synthesizeModule(mod, this.scope);
      if (!synthesized) {
        unmapped.push(`module.${mod.name}${mod.source ? ` (${mod.source})` : ''}`);
        continue;
      }
      this.nodes.push(...synthesized.nodes);
      const base = `module.${mod.name}`;
      for (const [output, addresses] of Object.entries(synthesized.outputs)) this.moduleOutputs.set(output === '' ? base : `${base}.${output}`, addresses);
    }
    for (const n of this.nodes) if (!this.byAddress.has(n.address)) this.byAddress.set(n.address, n);
    return unmapped;
  }

  /** Nodos a los que apunta una referencia: el nodo con esa dirección o los que despliega un módulo (`module.vpc.private_subnets`). */
  private resolveRef(ref: string): string[] {
    if (this.byAddress.has(ref)) return [ref];
    if (ref.startsWith('module.')) return this.moduleOutputs.get(ref) ?? this.moduleOutputs.get(ref.split('.').slice(0, 2).join('.')) ?? [];
    return [];
  }

  /** Referencias sin `local.*` (se sustituyen por lo que contiene su valor) ni `var.*`. */
  private expandRefs(refs: string[], seen = new Set<string>()): string[] {
    const out: string[] = [];
    for (const ref of refs) {
      if (ref.startsWith('local.')) {
        if (seen.has(ref)) continue;
        seen.add(ref);
        const value = this.model.locals.get(ref.slice(6));
        out.push(...this.expandRefs(physicalRefs(this.model, value), seen));
      } else if (!ref.startsWith('var.') && ref !== 'terraform.workspace') out.push(ref);
    }
    return out;
  }

  /** Nodos a los que apunta un valor (referencias y ids físicos), resueltos a nodos del conjunto. */
  private nodesIn(value: unknown): TfNode[] {
    const found: TfNode[] = [];
    for (const address of this.expandRefs(physicalRefs(this.model, value)).flatMap((r) => this.resolveRef(r))) {
      const node = this.byAddress.get(address);
      if (node && !found.includes(node)) found.push(node);
    }
    return found;
  }

  private nodesOf(node: TfNode): TfNode[] {
    return unique(this.expandRefs(node.refs).flatMap((r) => this.resolveRef(r)))
      .map((a) => this.byAddress.get(a)!)
      .filter((n) => n && n !== node);
  }

  // ───────────── entorno ─────────────

  private environmentFrom(nodes: TfNode[]): { name: string; reason: string; fallback: boolean } {
    const { scope, model } = this;
    for (const key of ENV_VARIABLES) {
      const value = model.variables.has(key) ? scope.str(model.variables.get(key)) : undefined;
      if (value) return { name: value, reason: `de la variable «${key}»`, fallback: false };
    }
    for (const key of ENV_VARIABLES) {
      const value = model.locals.has(key) ? scope.str(model.locals.get(key)) : undefined;
      if (value) return { name: value, reason: `del valor local «${key}»`, fallback: false };
    }
    const pick = (tags: Record<string, string>): string | undefined => {
      const key = Object.keys(tags).find((k) => ENV_TAG.test(k) && tags[k].trim() !== '');
      return key ? tags[key].trim() : undefined;
    };
    for (const p of model.providers) {
      const tags = scope.tags(blocksOf(p.attrs, 'default_tags')[0] ?? {});
      const value = pick(tags);
      if (value) return { name: value, reason: 'de las etiquetas por defecto del proveedor', fallback: false };
    }
    const counts = new Map<string, number>();
    for (const node of nodes) {
      const value = pick(scope.tags(node.attrs));
      if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    if (counts.size > 0) {
      const ranked = [...counts].sort((a, b) => b[1] - a[1]);
      if (ranked.length > 1) this.warnings.add(`Las etiquetas de entorno de los recursos tienen valores distintos (${ranked.map(([v, n]) => `${v} ×${n}`).join(', ')}): se usa «${ranked[0][0]}» para todo el stack.`);
      return { name: ranked[0][0], reason: 'de la etiqueta de entorno de los recursos', fallback: false };
    }
    if (model.workspace) return { name: model.workspace, reason: 'del workspace de Terraform', fallback: false };
    const name = sourceName(this.options);
    return { name: name ?? 'Entorno principal', reason: name ? 'del nombre del archivo' : 'del valor por defecto', fallback: true };
  }

  private regionOf(nodes: TfNode[]): string | undefined {
    const counts = new Map<string, number>();
    const bump = (region: string | undefined, weight = 1): void => {
      if (region) counts.set(region, (counts.get(region) ?? 0) + weight);
    };
    for (const p of this.model.providers) for (const key of ['region', 'location']) bump(this.scope.str(p.attrs[key]), 3);
    for (const node of nodes) {
      const q = query(node, this.scope);
      const zone = q.str('availability_zone');
      bump(q.str('location') ?? q.str('region') ?? (zone && /^[a-z]{2}-[a-z]+-\d[a-z]$/.test(zone) ? zone.slice(0, -1) : undefined));
      const arn = /^arn:aws[a-z-]*:[a-z0-9-]+:([a-z]{2}-[a-z]+-\d):/.exec(q.str('arn') ?? '');
      bump(arn?.[1]);
    }
    return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  }

  private createEnvironment(mapped: TfNode[]): Environment {
    const found = this.environmentFrom(mapped);
    const all = this.nodes.filter((n) => n.mode === 'managed');
    if (found.fallback) {
      this.warnings.add(`No se pudo deducir el entorno de variables, etiquetas ni workspace${this.model.usesWorkspace || this.scope.usedWorkspace ? ' (depende de terraform.workspace, que no se evalúa)' : ''}: se crea el entorno «${found.name}» a partir ${found.reason}.`);
    }
    this.environmentId = uniqueId(found.name, 'entorno', this.taken);
    const families = new Map<string, number>();
    for (const n of mapped) {
      const family = providerFamily(n.type);
      if (family) families.set(family, (families.get(family) ?? 0) + 1);
    }
    const provider = [...families].sort((a, b) => b[1] - a[1]).map(([f]) => f).join(', ');
    const region = this.regionOf(all);
    const kind = environmentKindOf(found.name);
    return {
      id: this.environmentId,
      name: found.name,
      description: `Entorno deducido ${found.reason}.`,
      ...(kind ? { kind } : {}),
      ...(provider ? { provider } : {}),
      ...(region ? { region } : {}),
    };
  }

  // ───────────── nombres e ids ─────────────

  private explicitName(q: Q): string | undefined {
    for (const key of NAME_ATTRIBUTES) {
      const value = q.str(key);
      if (value && value.trim() !== '') return value.trim();
    }
    const described = DESCRIBED.has(q.node.type) ? q.str('description') : undefined;
    return q.tags.Name ?? q.tags.name ?? (described && described.length <= 60 ? described : undefined);
  }

  /** Nombre de un recurso: el que declara; si no, la etiqueta de Terraform (con el tipo delante si es genérica: `main`, `this`). */
  private nameOf(q: Q, technology: string | undefined): string {
    const explicit = this.explicitName(q);
    if (explicit) return explicit;
    return GENERIC_LABELS.has(slug(q.node.name)) && technology ? `${technology} (${q.node.name})` : q.node.name;
  }

  private idBase(node: TfNode): string {
    const label = slug(node.name);
    const module = node.modulePath ? slug(node.modulePath.replace(/^module\./, '').replace(/\.module\./g, '-')) : '';
    const short = slug(node.type.replace(/^(?:aws|azurerm|google)_/, ''));
    if (!GENERIC_LABELS.has(label)) return module ? `${module}-${label}` : label;
    if (module) return module === short || short.startsWith(module) || module.startsWith(short) ? module : `${module}-${short}`;
    return `${short}-${label}`;
  }

  private shortType(node: TfNode): string {
    return node.type.replace(/^(?:aws|azurerm|google)_/, '').replace(/_/g, '-');
  }

  private add(address: string, el: Elem): void {
    this.elems.set(address, [...(this.elems.get(address) ?? []), el]);
  }

  private first(address: string): Elem | undefined {
    return this.elems.get(address)?.[0];
  }

  private owner(q: Q): string | undefined {
    const key = Object.keys(q.tags).find((k) => OWNER_TAG.test(k));
    return key ? q.tags[key] : undefined;
  }

  // ───────────── redes ─────────────

  private createNetworks(nodes: TfNode[]): void {
    for (const node of nodes) {
      const instances = node.instances.length > 1 ? node.instances : [node.instances[0] ?? { attrs: node.attrs }];
      const multi = instances.length > 1;
      instances.forEach((inst, index) => {
        const q = query(node, this.scope, inst.attrs);
        const key = multi ? String(inst.key ?? index) : undefined;
        const explicit = this.explicitName(q);
        const cidr = q.str('cidr_block') ?? q.str('ip_cidr_range') ?? q.strings('address_prefixes')[0] ?? q.str('address_prefix') ?? q.strings('address_space')[0];
        const net: Network = {
          id: uniqueId(multi ? `${node.name}-${key}` : this.idBase(node), this.shortType(node), this.taken),
          name: explicit ?? (multi ? `${node.name}[${key}]` : node.name),
          environmentId: this.environmentId,
          ...(cidr ? { cidr } : {}),
          description: `Terraform ${node.address}${key !== undefined ? `[${key}]` : ''}`,
        };
        this.networks.push(net);
        this.add(node.address, { kind: 'network', id: net.id, node, net });
      });
    }
  }

  /** Exposición de las subredes que deduce el código de rutas: tablas con salida a un internet gateway (pública) o solo a un NAT (privada). */
  private routeEvidence(): Map<string, Exposure> {
    const result = new Map<string, Exposure>();
    const tables = new Map<string, { igw: boolean; nat: boolean }>();
    const types = (nodes: TfNode[]): { igw: boolean; nat: boolean } => ({ igw: nodes.some((n) => n.type === 'aws_internet_gateway'), nat: nodes.some((n) => n.type === 'aws_nat_gateway') });
    for (const node of this.nodes) {
      if (node.type !== 'aws_route_table' && node.type !== 'aws_default_route_table') continue;
      const flags = { igw: false, nat: false };
      for (const inst of node.instances.length > 0 ? node.instances : [{ attrs: node.attrs }]) {
        for (const block of blocksOf(inst.attrs, 'route')) {
          const f = types(this.nodesIn(block));
          flags.igw ||= f.igw;
          flags.nat ||= f.nat;
        }
      }
      tables.set(node.address, flags);
    }
    for (const node of this.nodes.filter((n) => n.type === 'aws_route')) {
      const f = types(this.nodesIn(node.attrs));
      for (const table of this.nodesIn(node.attrs.route_table_id)) {
        const current = tables.get(table.address) ?? { igw: false, nat: false };
        tables.set(table.address, { igw: current.igw || f.igw, nat: current.nat || f.nat });
      }
    }
    for (const node of this.nodes.filter((n) => n.type === 'aws_route_table_association')) {
      const flags = [...this.nodesIn(node.attrs.route_table_id)].map((t) => tables.get(t.address)).filter((f): f is { igw: boolean; nat: boolean } => !!f);
      const exposure: Exposure | undefined = flags.some((f) => f.igw) ? 'public' : flags.some((f) => f.nat) ? 'private' : undefined;
      if (!exposure) continue;
      for (const subnet of this.nodesIn(node.attrs.subnet_id)) if (result.get(subnet.address) !== 'public') result.set(subnet.address, exposure);
    }
    return result;
  }

  /** Subredes donde hay una instancia con IP pública. */
  private collectPublicIps(): void {
    for (const node of this.nodes) {
      if (node.mode !== 'managed' || query(node, this.scope).bool('associate_public_ip_address') !== true) continue;
      for (const el of this.networkCandidates(node)) this.publicIpSubnets.add(el.node.address);
    }
  }

  private subnetExposure(el: Elem & { kind: 'network' }, q: Q): { exposure: Exposure; known: boolean } {
    const tags = q.tags;
    const mapPublic = q.bool('map_public_ip_on_launch');
    const route = this.routeExposure.get(el.node.address);
    const hint = words(`${el.node.name} ${q.str('name') ?? ''} ${tags.Name ?? ''}`);
    if (mapPublic === true) return { exposure: 'public', known: true };
    if (route === 'public') return { exposure: 'public', known: true };
    if (tags['kubernetes.io/role/elb'] !== undefined) return { exposure: 'public', known: true };
    if (tags['kubernetes.io/role/internal-elb'] !== undefined) return { exposure: 'private', known: true };
    if (route === 'private') return { exposure: 'private', known: true };
    if (mapPublic === false) return { exposure: 'private', known: true };
    if (hint.some((w) => w === 'public' || w === 'dmz')) return { exposure: 'public', known: true };
    if (hint.some((w) => ['private', 'internal', 'data', 'database', 'db', 'intra', 'backend'].includes(w))) return { exposure: 'private', known: true };
    if (this.publicIpSubnets.has(el.node.address)) return { exposure: 'public', known: true };
    return { exposure: 'private', known: false };
  }

  /** Enlaza cada subred con su red contenedora y fija su exposición. */
  private linkNetworks(): void {
    for (const el of [...this.elems.values()].flat()) {
      if (el.kind !== 'network') continue;
      if (SPECS[el.node.type]?.container) continue;
      const parent = this.nodesOf(el.node)
        .filter((n) => SPECS[n.type]?.container)
        .map((n) => this.first(n.address))
        .find((e): e is Elem & { kind: 'network' } => e?.kind === 'network');
      if (parent) el.net.parentId = parent.id;
      const { exposure, known } = this.subnetExposure(el, query(el.node, this.scope, this.instanceAttrs(el)));
      el.net.exposure = exposure;
      if (!known) this.unknownExposure.push(el.net.name);
    }
  }

  /** Atributos de la instancia que originó una red expandida (la que coincide con su id); si no, los del nodo. */
  private instanceAttrs(el: Elem & { kind: 'network' }): TfObject {
    const idx = this.elems.get(el.node.address)!.indexOf(el);
    return el.node.instances.length > 1 ? el.node.instances[idx].attrs : (el.node.instances[0]?.attrs ?? el.node.attrs);
  }

  /** Redes donde puede estar un recurso: las que nombra directamente, a través de grupos de subredes o NIC y, en último caso, la VPC de sus grupos de seguridad. */
  private networkCandidates(node: TfNode): Array<Elem & { kind: 'network' }> {
    const found: Array<Elem & { kind: 'network' }> = [];
    const take = (n: TfNode): void => {
      for (const el of this.elems.get(n.address) ?? []) if (el.kind === 'network' && !found.includes(el)) found.push(el);
    };
    const direct = this.nodesOf(node);
    direct.forEach(take);
    for (const carrier of direct.filter((n) => SUBNET_CARRIERS.test(n.type))) this.nodesOf(carrier).forEach(take);
    if (found.length === 0) for (const sg of direct.filter((n) => SECURITY_GROUP.test(n.type))) this.nodesOf(sg).forEach(take);
    return found;
  }

  private placement(node: TfNode, sensitive: boolean): string | undefined {
    const candidates = this.networkCandidates(node);
    const subnets = candidates.filter((c) => c.net.parentId !== undefined);
    const pool = subnets.length > 0 ? subnets : candidates;
    if (pool.length === 0) return undefined;
    const isPublic = (c: Elem & { kind: 'network' }): boolean => c.net.exposure === 'public';
    const chosen = sensitive ? (pool.find(isPublic) ?? pool[0]) : (pool.find((c) => !isPublic(c)) ?? pool[0]);
    return chosen.id;
  }

  // ───────────── recursos ─────────────

  private createResources(nodes: TfNode[]): void {
    for (const node of nodes) {
      const spec = SPECS[node.type];
      const kind = spec.kind as ResourceKind;
      const q = query(node, this.scope);
      const technology = typeof spec.technology === 'function' ? spec.technology(q) : spec.technology;
      const version = spec.version?.(q);
      const extras = [...(spec.extra?.(q) ?? [])];
      const count = node.instances.length > 1 ? node.instances.length : typeof node.count === 'number' && node.count > 1 ? node.count : undefined;
      if (count) extras.push(`${count} instancias`);
      else if (node.count === 'dynamic') this.dynamicCount.push(node.address);
      const about = DESCRIBED.has(node.type) && !this.explicitName(q)?.includes(q.str('description') ?? '\0') ? q.str('description') : undefined;
      const networkId = this.placement(node, ['database', 'cache', 'queue', 'secret-store'].includes(kind));
      const status: ResourceStatus | undefined = node.action === 'create' || node.action === 'replace' ? 'planned' : node.action === 'delete' ? 'decommissioned' : undefined;
      const owner = this.owner(q);
      const res: Resource = {
        id: uniqueId(this.idBase(node), this.shortType(node), this.taken),
        name: this.nameOf(q, technology),
        kind,
        environmentId: this.environmentId,
        ...(networkId ? { networkId } : {}),
        ...(technology ? { technology } : {}),
        ...(version ? { version } : {}),
        ...(status ? { status } : {}),
        iac: true,
        ...(owner ? { owner } : {}),
        description: [about, `Terraform ${node.address}`, ...extras].filter(Boolean).join(' · '),
      };
      this.resources.push(res);
      this.add(node.address, { kind: 'resource', id: res.id, node, res });
      if (q.bool('publicly_accessible') === true) {
        const net = networkId ? this.networks.find((n) => n.id === networkId) : undefined;
        if (!net || net.exposure !== 'public') this.mismatches.push(`«${res.name}» (${node.address}) tiene publicly_accessible = true pero ${net ? `está en la red ${net.exposure === 'private' ? 'privada' : 'no pública'} «${net.name}»` : 'no se sabe en qué red está'}: el modelo no refleja esa exposición.`);
      }
    }
  }

  // ───────────── servicios (ECS) ─────────────

  /** Imagen y etiqueta de la primera definición de contenedor de una task definition (la imagen, si es literal). */
  private firstContainer(task: TfNode): { image?: string; version?: string } {
    const raw = task.attrs.container_definitions;
    let definitions: unknown = isExpr(raw) && raw.call?.fn === 'jsonencode' ? raw.call.args[0] : raw;
    if (typeof definitions === 'string') {
      try {
        definitions = JSON.parse(definitions);
      } catch {
        definitions = undefined;
      }
    }
    const first = Array.isArray(definitions) ? (definitions[0] as Record<string, unknown> | null) : undefined;
    const image = first && typeof first === 'object' ? first.image : undefined;
    const text = this.scope.str(image) ?? (isExpr(image) ? image.template : undefined) ?? (typeof image === 'string' ? image : undefined);
    if (!text) return {};
    const tag = /:([^:/@}]+)$/.exec(text)?.[1];
    return { ...(this.scope.str(image) ? { image: text } : {}), ...(tag ? { version: tag } : {}) };
  }

  private createServices(nodes: TfNode[]): void {
    for (const node of nodes) {
      const q = query(node, this.scope);
      const related = this.nodesOf(node);
      const hostNode = related.find((n) => n.type === 'aws_ecs_cluster');
      const host = hostNode ? this.first(hostNode.address) : undefined;
      const task = related.find((n) => n.type === 'aws_ecs_task_definition');
      const container = task ? this.firstContainer(task) : {};
      const launch = q.str('launch_type') ?? (q.attrs.capacity_provider_strategy ? 'capacity provider' : undefined);
      const owner = this.owner(q);
      const svc: Service = {
        id: uniqueId(this.idBase(node), this.shortType(node), this.taken),
        name: this.explicitName(q) ?? node.name,
        technology: launch ? `Amazon ECS (${launch})` : 'Amazon ECS',
        ...(owner ? { owner } : {}),
        description: [container.image ? `Imagen ${container.image}` : undefined, `Terraform ${node.address}`].filter(Boolean).join(' · '),
      };
      this.services.push(svc);
      this.add(node.address, { kind: 'service', id: svc.id, node, svc });
      if (!host || host.kind !== 'resource') {
        this.warnings.add(`El servicio ${node.address} no referencia ningún clúster ECS del archivo: se importa sin despliegue.`);
        continue;
      }
      const desired = q.num('desired_count');
      if (desired === 0) this.warnings.add(`El servicio ${node.address} tiene desired_count = 0: se importa sin réplicas indicadas.`);
      const cpu = task ? this.scope.num(task.attrs.cpu) : undefined;
      const memory = task ? this.scope.num(task.attrs.memory) : undefined;
      this.deployments.push({
        id: pickId(`${svc.id}-${this.environmentId}`, new Set(this.deployments.map((d) => d.id))),
        serviceId: svc.id,
        environmentId: this.environmentId,
        hostId: host.id,
        ...(desired !== undefined && Number.isInteger(desired) && desired >= 1 ? { replicas: desired } : {}),
        ...(container.version ? { version: container.version } : {}),
        ...(cpu ? { cpuLimit: formatCpu(cpu) } : {}),
        ...(memory ? { memoryLimit: formatMemory(memory) } : {}),
      });
    }
  }

  // ───────────── dependencias ─────────────

  private endpoint(node: TfNode): (Elem & { kind: 'resource' | 'service' }) | undefined {
    const el = this.first(node.address);
    return el && el.kind !== 'network' ? el : undefined;
  }

  private dependencyKind(target: Elem & { kind: 'resource' | 'service' }): DependencyKind {
    if (target.kind === 'service') return 'calls';
    if (target.res.kind === 'queue') return 'messages';
    if (['database', 'cache', 'storage'].includes(target.res.kind)) return 'data';
    return 'calls';
  }

  private createDependencies(): void {
    const candidates: Candidate[] = [];
    const push = (source: Elem | undefined, target: Elem | undefined, rank: number, description: string, protocol?: string): void => {
      if (!source || !target || source.kind === 'network' || target.kind === 'network' || source.id === target.id) return;
      candidates.push({ source, target, rank, description, ...(protocol ? { protocol } : {}) });
    };

    this.securityGroupDependencies(push);
    this.balancerDependencies(push);
    this.dnsDependencies(push);
    this.roleAssignmentDependencies(push);

    // Referencias entre recursos, también a través de definiciones de tarea y plantillas de lanzamiento.
    for (const node of this.nodes) {
      const source = this.endpoint(node);
      if (!source || node.mode !== 'managed') continue;
      const host = node.type === 'aws_ecs_service' ? this.nodesOf(node).find((n) => n.type === 'aws_ecs_cluster') : undefined;
      const seen = new Set<string>([node.address]);
      const queue = this.nodesOf(node).map((n) => ({ node: n, via: undefined as string | undefined }));
      while (queue.length > 0) {
        const { node: target, via } = queue.shift()!;
        if (seen.has(target.address)) continue;
        seen.add(target.address);
        if (this.elems.has(target.address)) {
          if (target === host) continue;
          const el = this.endpoint(target);
          const explicit = node.dependsOn.includes(target.address);
          const origin = this.model.format === 'state' ? 'Dependencia registrada en el estado' : explicit && !via ? 'depends_on' : 'Referencia en Terraform';
          push(source, el, explicit && !via && this.model.format !== 'state' ? 3 : 2, `${origin}${via ? ` (vía ${via})` : ''}: ${target.address}`);
        } else if (CARRIER_TYPES.test(target.type)) for (const next of this.nodesOf(target)) queue.push({ node: next, via: via ?? target.address });
      }
    }

    const ids = new Set<string>();
    const signatures = new Set<string>();
    for (const c of [...candidates].sort((a, b) => a.rank - b.rank)) {
      const kind = this.dependencyKind(c.target);
      const signature = `${kind}|${c.source.id}|${c.target.id}`;
      if (signatures.has(signature)) continue;
      signatures.add(signature);
      this.dependencies.push({ id: pickId(`${c.source.id}--${c.target.id}`, ids), sourceId: c.source.id, targetId: c.target.id, kind, ...(c.protocol ? { protocol: c.protocol } : {}), description: c.description });
    }
  }

  /** Elementos que usan un grupo de seguridad (lo referencian en sus atributos), sin contar otros grupos ni reglas. */
  private members(sg: TfNode): TfNode[] {
    return this.nodes.filter((n) => n.mode === 'managed' && this.elems.has(n.address) && !this.elems.get(n.address)!.some((e) => e.kind === 'network') && this.nodesOf(n).includes(sg));
  }

  private portText(block: TfObject): string | undefined {
    const proto = this.scope.str(block.protocol);
    if (proto === '-1') return 'todo el tráfico';
    const from = this.scope.num(block.from_port);
    const to = this.scope.num(block.to_port);
    const name = (proto ?? 'tcp').toLowerCase();
    if (from === undefined) return proto ? name : undefined;
    return from === to || to === undefined ? `${name}/${from}` : `${name}/${from}-${to}`;
  }

  /** Reglas de ingreso entre grupos de seguridad: quien pertenece al grupo origen puede llamar a quien pertenece al destino. */
  private securityGroupDependencies(push: (s: Elem | undefined, t: Elem | undefined, rank: number, description: string, protocol?: string) => void): void {
    const rules: Array<{ via: string; target: TfNode; sources: TfNode[]; block: TfObject }> = [];
    for (const node of this.nodes) {
      if (SECURITY_GROUP.test(node.type)) {
        for (const block of blocksOf(node.attrs, 'ingress')) {
          const sources = this.nodesIn(block.security_groups);
          if (sources.length > 0) rules.push({ via: `El ingreso de ${node.address}`, target: node, sources, block });
        }
      } else if (INGRESS_RULE.test(node.type) && (node.type !== 'aws_security_group_rule' || this.scope.str(node.attrs.type) === 'ingress')) {
        const sources = this.nodesIn(node.attrs.source_security_group_id ?? node.attrs.referenced_security_group_id);
        const targets = this.nodesIn(node.attrs.security_group_id);
        if (sources.length > 0) for (const target of targets) rules.push({ via: `La regla ${node.address}`, target, sources, block: node.attrs });
      }
    }
    for (const { via, target, sources, block } of rules) {
      const targets = this.endpoint(target) ? [target] : this.members(target);
      const protocol = this.portText(block);
      for (const source of sources) {
        if (source === target) continue;
        const origin = this.endpoint(source) ? [source] : this.members(source);
        for (const o of origin) {
          for (const t of targets) if (o !== t) push(this.endpoint(o), this.endpoint(t), 0, `${via} admite el tráfico de ${source.address}`, protocol);
        }
      }
    }
  }

  /** Una zona DNS → aquello a lo que apuntan sus registros (el balanceador, la pasarela). */
  private dnsDependencies(push: (s: Elem | undefined, t: Elem | undefined, rank: number, description: string, protocol?: string) => void): void {
    for (const record of this.nodes.filter((n) => /(?:route53_record|dns_(?:a|aaaa|cname)_record|dns_record_set)$/.test(n.type))) {
      const related = this.nodesOf(record).filter((n) => this.endpoint(n));
      const zones = related.filter((n) => this.endpoint(n)!.kind === 'resource' && (this.endpoint(n) as Elem & { kind: 'resource' }).res.kind === 'dns');
      for (const zone of zones) for (const target of related.filter((n) => !zones.includes(n))) push(this.endpoint(zone), this.endpoint(target), 2, `El registro ${record.address} apunta a ${target.address}`);
    }
  }

  /** Asignación de rol de Azure: la identidad (p. ej. la del clúster) puede usar el recurso sobre el que se asigna. */
  private roleAssignmentDependencies(push: (s: Elem | undefined, t: Elem | undefined, rank: number, description: string, protocol?: string) => void): void {
    for (const assignment of this.nodes.filter((n) => n.type === 'azurerm_role_assignment')) {
      const principals = this.nodesIn(assignment.attrs.principal_id).filter((n) => this.endpoint(n));
      const scopes = this.nodesIn(assignment.attrs.scope).filter((n) => this.endpoint(n));
      for (const p of principals) for (const s of scopes) push(this.endpoint(p), this.endpoint(s), 2, `La asignación de rol ${assignment.address} da acceso a ${s.address}`);
    }
  }

  /** Balanceador → lo que sirve (por sus listeners, reglas y grupos de destino). */
  private balancerDependencies(push: (s: Elem | undefined, t: Elem | undefined, rank: number, description: string, protocol?: string) => void): void {
    const balancers = this.nodes.filter((n) => ['aws_lb', 'aws_alb'].includes(n.type) && this.elems.has(n.address));
    for (const lb of balancers) {
      const listeners = this.nodes.filter((n) => LISTENER.test(n.type) && this.nodesOf(n).includes(lb));
      for (const listener of listeners) {
        const rules = this.nodes.filter((n) => LISTENER_RULE.test(n.type) && this.nodesOf(n).includes(listener));
        const groups = unique([...this.nodesOf(listener), ...rules.flatMap((r) => this.nodesOf(r))].filter((n) => TARGET_GROUP.test(n.type)));
        const protocol = this.scope.str(listener.attrs.protocol)?.toUpperCase();
        // Lo que el listener usa directamente (un certificado).
        for (const used of this.nodesOf(listener)) if (used !== lb && this.endpoint(used)) push(this.endpoint(lb), this.endpoint(used), 2, `El listener ${listener.address} usa ${used.address}`);
        for (const group of groups) {
          // Quien usa el grupo de destino (un servicio ECS, un grupo de autoescalado) y lo que registran sus asociaciones (instancias).
          const users = this.nodes.filter((n) => n !== lb && this.nodesOf(n).includes(group));
          const served = users.flatMap((u) => (this.endpoint(u) ? [u] : /attachment/.test(u.type) ? this.nodesOf(u) : []));
          for (const target of served) push(this.endpoint(lb), this.endpoint(target), 1, `El listener ${listener.address} lo sirve por el grupo de destino ${group.address}`, protocol);
        }
      }
    }
  }

  // ───────────── avisos ─────────────

  private reportWarnings(w: { unknown: string[]; support: string[]; data: string[]; disabled: string[]; unmappedModules: string[] }): void {
    const n = (count: number, one: string, many: string): string => (count === 1 ? one : many.replace('{n}', String(count)));
    if (w.unknown.length > 0) {
      this.warnings.add(`${n(w.unknown.length, '1 recurso de un tipo sin mapear, que no se importa', '{n} recursos de tipos sin mapear, que no se importan')}: ${countedList(w.unknown)}.`);
    }
    if (w.support.length > 0) {
      this.warnings.add(
        `${n(w.support.length, '1 recurso de soporte que no se dibuja', '{n} recursos de soporte que no se dibujan')} (solo se consultan para deducir redes, exposición y dependencias): ${countedList(w.support)}.`,
      );
    }
    if (w.data.length > 0) this.warnings.add(`${n(w.data.length, '1 fuente de datos (data) sin importar', '{n} fuentes de datos (data) sin importar')}: ${shortList(w.data)}.`);
    if (w.unmappedModules.length > 0) {
      this.warnings.add(`${n(w.unmappedModules.length, '1 módulo sin mapear', '{n} módulos sin mapear')} (su contenido no está en el archivo): ${shortList(w.unmappedModules)}.`);
    }
    if (w.disabled.length > 0) this.warnings.add(`${n(w.disabled.length, '1 recurso con count = 0, que no se importa', '{n} recursos con count = 0, que no se importan')}: ${shortList(w.disabled)}.`);
    if (this.dynamicCount.length > 0) {
      this.warnings.add(`${n(this.dynamicCount.length, '1 recurso con count o for_each que no se evalúa', '{n} recursos con count o for_each que no se evalúan')}: se importa como un solo recurso (${shortList(this.dynamicCount)}).`);
    }
    if (this.unknownExposure.length > 0) {
      this.warnings.add(
        `${n(this.unknownExposure.length, '1 red sin dato de exposición', '{n} redes sin dato de exposición')} (ni IP pública, ni ruta a un internet gateway, ni nombre o etiqueta que lo indique): se importan como privadas: ${shortList(this.unknownExposure)}.`,
      );
    }
    for (const m of this.mismatches) this.warnings.add(m);
  }
}

/** Importa Terraform (HCL, `.tf.json`, estado o `terraform show -json`) como documento de plataforma. */
export function fromTerraform(source: string, options: InfraImportOptions = {}): PlatformImportResult {
  return new TerraformBuilder(readTerraform(source), options).build();
}
