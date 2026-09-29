/**
 * Documento del módulo de arquitectura empresarial (un subconjunto pequeño de ArchiMate/TOGAF): unidades de la
 * organización, capacidades de negocio (jerárquicas), procesos, aplicaciones y tecnología, unidos por relaciones
 * tipadas. Cada aplicación y cada tecnología tiene un ciclo de vida, y las capacidades, la madurez y la importancia.
 * No guarda coordenadas: los diagramas se calculan al exportar.
 */
export const ENTERPRISE_DOCUMENT_VERSION = '1.0' as const;

/** Tipos de elemento del modelo. Las unidades son la organización: responsables, no se dibujan. */
export const ELEMENT_KINDS = ['unit', 'capability', 'process', 'application', 'technology'] as const;
export type ElementKind = (typeof ELEMENT_KINDS)[number];
/** Los que se dibujan en los diagramas. */
export type DrawnKind = Exclude<ElementKind, 'unit'>;
export const DRAWN_KINDS: DrawnKind[] = ['capability', 'process', 'application', 'technology'];

export const LIFECYCLES = ['planned', 'active', 'sunset', 'retired'] as const;
export type Lifecycle = (typeof LIFECYCLES)[number];

/** De menos a más crítica. */
export const CRITICALITIES = ['low', 'medium', 'high', 'critical'] as const;
export type Criticality = (typeof CRITICALITIES)[number];
export const CRITICALITY_RANK: Record<Criticality, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/** `differentiating` = da ventaja competitiva; `core` = imprescindible; `supporting` = de apoyo (o commodity). */
export const IMPORTANCES = ['differentiating', 'core', 'supporting'] as const;
export type Importance = (typeof IMPORTANCES)[number];

export const TECHNOLOGY_KINDS = ['platform', 'infrastructure', 'database', 'runtime', 'middleware', 'service'] as const;
export type TechnologyKind = (typeof TECHNOLOGY_KINDS)[number];

/**
 * - `supports`: una aplicación soporta una capacidad o un proceso.
 * - `realizes`: un proceso realiza una capacidad.
 * - `runs-on`: una aplicación se ejecuta sobre una tecnología.
 * - `depends-on`: una aplicación depende de otra, o una tecnología de otra.
 */
export const RELATION_KINDS = ['supports', 'realizes', 'runs-on', 'depends-on'] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];

/** Pares (origen, destino) que admite cada tipo de relación. */
export const RELATION_RULES: Record<RelationKind, Array<[ElementKind, ElementKind]>> = {
  supports: [['application', 'capability'], ['application', 'process']],
  realizes: [['process', 'capability']],
  'runs-on': [['application', 'technology']],
  'depends-on': [['application', 'application'], ['technology', 'technology']],
};

export const MATURITY_MIN = 1;
export const MATURITY_MAX = 5;

export interface Unit {
  id: string;
  name: string;
  description?: string;
  /** Unidad que la contiene (un equipo dentro de su dirección). */
  parentId?: string;
  external?: boolean;
}

export interface Capability {
  id: string;
  name: string;
  description?: string;
  /** Capacidad de la que forma parte: el mapa de capacidades es un árbol. */
  parentId?: string;
  /** Unidad responsable. Si no la declara, la hereda de su capacidad padre. */
  ownerId?: string;
  importance?: Importance;
  /** De 1 (inicial) a 5 (optimizada). */
  maturity?: number;
  tags?: string[];
}

export interface Process {
  id: string;
  name: string;
  description?: string;
  ownerId?: string;
  tags?: string[];
}

export interface Application {
  id: string;
  name: string;
  description?: string;
  /** Pila o producto (`SAP S/4HANA`, `Java + PostgreSQL`). La infraestructura sobre la que corre se modela con `runs-on`. */
  technology?: string;
  vendor?: string;
  /** Responsable de negocio. */
  ownerId?: string;
  /** Si no se indica, `active`. */
  lifecycle?: Lifecycle;
  criticality?: Criticality;
  /** Producto o servicio de un tercero (SaaS). */
  external?: boolean;
  /** Referencia a un elemento de otro módulo (`urn:iark:c4:tienda`). */
  ref?: string;
  tags?: string[];
}

export interface Technology {
  id: string;
  name: string;
  description?: string;
  /** Si no se indica, `platform`. */
  kind?: TechnologyKind;
  version?: string;
  ownerId?: string;
  /** Si no se indica, `active`. */
  lifecycle?: Lifecycle;
  /** Fin de soporte del fabricante (`2027-06` o `2027-06-30`). */
  endOfLife?: string;
  ref?: string;
  tags?: string[];
}

export interface Relation {
  id: string;
  kind: RelationKind;
  sourceId: string;
  targetId: string;
  description?: string;
}

export interface EnterpriseDocument {
  version: typeof ENTERPRISE_DOCUMENT_VERSION;
  workspace: { name: string; description?: string };
  units: Unit[];
  capabilities: Capability[];
  processes: Process[];
  applications: Application[];
  technologies: Technology[];
  relations: Relation[];
}

export type Item = Unit | Capability | Process | Application | Technology;

/** Elemento del documento con su tipo. */
export interface Element {
  kind: ElementKind;
  id: string;
  name: string;
  item: Item;
}

export const KIND_LABELS: Record<ElementKind, string> = {
  unit: 'Unidad',
  capability: 'Capacidad',
  process: 'Proceso',
  application: 'Aplicación',
  technology: 'Tecnología',
};

export const LIFECYCLE_LABELS: Record<Lifecycle, string> = {
  planned: 'prevista',
  active: 'activa',
  sunset: 'en retirada',
  retired: 'retirada',
};

export const CRITICALITY_LABELS: Record<Criticality, string> = {
  low: 'baja',
  medium: 'media',
  high: 'alta',
  critical: 'crítica',
};

export const IMPORTANCE_LABELS: Record<Importance, string> = {
  differentiating: 'diferenciadora',
  core: 'esencial',
  supporting: 'de apoyo',
};

export const TECHNOLOGY_KIND_LABELS: Record<TechnologyKind, string> = {
  platform: 'Plataforma',
  infrastructure: 'Infraestructura',
  database: 'Base de datos',
  runtime: 'Entorno de ejecución',
  middleware: 'Middleware',
  service: 'Servicio',
};

export const RELATION_LABELS: Record<RelationKind, string> = {
  supports: 'soporta',
  realizes: 'realiza',
  'runs-on': 'se ejecuta en',
  'depends-on': 'depende de',
};

export const lifecycleOf = (x: { lifecycle?: Lifecycle }): Lifecycle => x.lifecycle ?? 'active';

/** Todos los elementos del documento por id (los ids son únicos entre tipos). */
export function indexElements(doc: EnterpriseDocument): Map<string, Element> {
  const map = new Map<string, Element>();
  const add = (kind: ElementKind, items: Item[]): void => {
    for (const item of items) if (!map.has(item.id)) map.set(item.id, { kind, id: item.id, name: item.name, item });
  };
  add('unit', doc.units);
  add('capability', doc.capabilities);
  add('process', doc.processes);
  add('application', doc.applications);
  add('technology', doc.technologies);
  return map;
}

/** Tipo de relación que une dos tipos de elemento, si lo hay (en cualquiera de los dos sentidos). */
export function relationBetween(a: ElementKind, b: ElementKind): { kind: RelationKind; reversed: boolean } | undefined {
  for (const kind of RELATION_KINDS) {
    for (const [from, to] of RELATION_RULES[kind]) {
      if (from === a && to === b) return { kind, reversed: false };
      if (from === b && to === a) return { kind, reversed: true };
    }
  }
  return undefined;
}

/**
 * Sentido en que se dibuja una relación: de quien se apoya a aquello en lo que se apoya (capacidad → aplicación que la
 * soporta → tecnología en la que corre). Coincide con la dirección de la dependencia, salvo `supports` y `realizes`,
 * que en el modelo van de la aplicación (o el proceso) a lo que soportan.
 */
export function drawnEnds(r: Relation): { from: string; to: string } {
  return r.kind === 'supports' || r.kind === 'realizes' ? { from: r.targetId, to: r.sourceId } : { from: r.sourceId, to: r.targetId };
}
