/**
 * Documento del módulo de arquitectura de seguridad: zonas de confianza (con sus fronteras), activos (actores, entidades
 * externas, procesos y almacenes de datos), flujos de datos entre ellos, amenazas clasificadas con STRIDE y los controles que
 * las mitigan. Sigue el modelo clásico de diagramas de flujo de datos de un análisis de amenazas. No guarda coordenadas: los
 * diagramas se calculan al exportar.
 */
export const SECURITY_DOCUMENT_VERSION = '1.0' as const;

/** De menos a más confiable: cruzar de una zona a otra es cruzar una frontera de confianza. */
export const TRUST_LEVELS = ['untrusted', 'dmz', 'internal', 'restricted'] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];

/** `actor` = persona; `external` = sistema de un tercero; `process` = componente que ejecuta código; `datastore` = guarda datos. */
export const ASSET_KINDS = ['actor', 'external', 'process', 'datastore'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

/** De menos a más sensible. */
export const CLASSIFICATIONS = ['public', 'internal', 'confidential', 'restricted'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

export const AUTHENTICATIONS = ['none', 'password', 'token', 'mtls', 'sso'] as const;
export type Authentication = (typeof AUTHENTICATIONS)[number];

/** Suplantación, manipulación, repudio, divulgación de información, denegación de servicio y elevación de privilegios. */
export const STRIDE = ['spoofing', 'tampering', 'repudiation', 'information-disclosure', 'denial-of-service', 'elevation-of-privilege'] as const;
export type Stride = (typeof STRIDE)[number];

export const LIKELIHOODS = ['low', 'medium', 'high'] as const;
export type Likelihood = (typeof LIKELIHOODS)[number];
export const IMPACTS = ['low', 'medium', 'high', 'critical'] as const;
export type Impact = (typeof IMPACTS)[number];
export const RISK_RATINGS = ['low', 'medium', 'high', 'critical'] as const;
export type RiskRating = (typeof RISK_RATINGS)[number];

export const THREAT_STATUSES = ['open', 'mitigated', 'accepted'] as const;
export type ThreatStatus = (typeof THREAT_STATUSES)[number];

export const CONTROL_KINDS = ['authentication', 'authorization', 'encryption', 'logging', 'validation', 'network', 'rate-limit', 'backup', 'secrets', 'other'] as const;
export type ControlKind = (typeof CONTROL_KINDS)[number];
export const CONTROL_STATUSES = ['planned', 'implemented'] as const;
export type ControlStatus = (typeof CONTROL_STATUSES)[number];

export interface Zone {
  id: string;
  name: string;
  /** Si no se indica, `internal`. */
  trust?: TrustLevel;
  /** Zona que la contiene (una zona restringida dentro de la red interna). */
  parentId?: string;
  description?: string;
}

export interface Asset {
  id: string;
  name: string;
  kind: AssetKind;
  zoneId: string;
  description?: string;
  technology?: string;
  owner?: string;
  /** La clasificación más alta de los datos que trata o guarda. */
  classification?: Classification;
  /** Almacenes: los datos van cifrados en reposo. Si no se indica, no se sabe. */
  encryptedAtRest?: boolean;
  ref?: string;
  tags?: string[];
}

/** Datos que viajan del origen al destino. */
export interface Flow {
  id: string;
  sourceId: string;
  targetId: string;
  description?: string;
  protocol?: string;
  classification?: Classification;
  /** Va cifrado en tránsito. Si no se indica, no se sabe. */
  encrypted?: boolean;
  /** Cómo se autentica quien lo envía. Si no se indica, no se sabe. */
  authentication?: Authentication;
}

export interface Threat {
  id: string;
  title: string;
  category: Stride;
  /** Activo o flujo amenazado. */
  targetId: string;
  /** Si no se indica, `medium`. */
  likelihood?: Likelihood;
  /** Si no se indica, `medium`. */
  impact?: Impact;
  /** Si no se indica, `open`. */
  status?: ThreatStatus;
  description?: string;
  controlIds?: string[];
}

export interface Control {
  id: string;
  name: string;
  kind: ControlKind;
  /** Si no se indica, `implemented`. */
  status?: ControlStatus;
  description?: string;
  owner?: string;
}

export interface SecurityDocument {
  version: typeof SECURITY_DOCUMENT_VERSION;
  workspace: { name: string; description?: string };
  zones: Zone[];
  assets: Asset[];
  flows: Flow[];
  threats: Threat[];
  controls: Control[];
}

export type ElementKind = 'zone' | 'asset' | 'flow' | 'threat' | 'control';
export type Item = Zone | Asset | Flow | Threat | Control;

/** Elemento del documento con su tipo (los ids son únicos entre tipos). */
export interface Element {
  kind: ElementKind;
  id: string;
  name: string;
  item: Item;
}

export const ELEMENT_LABELS: Record<ElementKind, string> = { zone: 'Zona', asset: 'Activo', flow: 'Flujo', threat: 'Amenaza', control: 'Control' };
export const TRUST_LABELS: Record<TrustLevel, string> = { untrusted: 'no confiable', dmz: 'DMZ', internal: 'interna', restricted: 'restringida' };
export const ASSET_LABELS: Record<AssetKind, string> = { actor: 'Actor', external: 'Sistema externo', process: 'Proceso', datastore: 'Almacén de datos' };
export const CLASSIFICATION_LABELS: Record<Classification, string> = { public: 'pública', internal: 'interna', confidential: 'confidencial', restricted: 'restringida' };
/** «datos ___»: la clasificación como complemento de «datos». */
export const DATA_LABELS: Record<Classification, string> = { public: 'públicos', internal: 'internos', confidential: 'confidenciales', restricted: 'restringidos' };
export const AUTHENTICATION_LABELS: Record<Authentication, string> = { none: 'sin autenticación', password: 'contraseña', token: 'token', mtls: 'mTLS', sso: 'SSO' };
export const STRIDE_LABELS: Record<Stride, string> = {
  spoofing: 'Suplantación',
  tampering: 'Manipulación',
  repudiation: 'Repudio',
  'information-disclosure': 'Divulgación de información',
  'denial-of-service': 'Denegación de servicio',
  'elevation-of-privilege': 'Elevación de privilegios',
};
export const RATING_LABELS: Record<RiskRating, string> = { low: 'bajo', medium: 'medio', high: 'alto', critical: 'crítico' };
export const STATUS_LABELS: Record<ThreatStatus, string> = { open: 'abierta', mitigated: 'mitigada', accepted: 'aceptada' };
export const CONTROL_LABELS: Record<ControlKind, string> = {
  authentication: 'Autenticación',
  authorization: 'Autorización',
  encryption: 'Cifrado',
  logging: 'Registro y auditoría',
  validation: 'Validación de entradas',
  network: 'Control de red',
  'rate-limit': 'Limitación de tasa',
  backup: 'Copias de seguridad',
  secrets: 'Gestión de secretos',
  other: 'Otro control',
};
export const CONTROL_STATUS_LABELS: Record<ControlStatus, string> = { planned: 'prevista', implemented: 'implementada' };

/** Categorías STRIDE que se aplican a cada tipo de elemento de un diagrama de flujo de datos. */
export const STRIDE_BY_ELEMENT: Record<AssetKind | 'flow', Stride[]> = {
  actor: ['spoofing', 'repudiation'],
  external: ['spoofing', 'repudiation'],
  process: [...STRIDE],
  datastore: ['tampering', 'repudiation', 'information-disclosure', 'denial-of-service'],
  flow: ['tampering', 'information-disclosure', 'denial-of-service'],
};

const TRUST_RANK: Record<TrustLevel, number> = { untrusted: 0, dmz: 1, internal: 2, restricted: 3 };
const CLASSIFICATION_RANK: Record<Classification, number> = { public: 0, internal: 1, confidential: 2, restricted: 3 };
const LIKELIHOOD_RANK: Record<Likelihood, number> = { low: 1, medium: 2, high: 3 };
const IMPACT_RANK: Record<Impact, number> = { low: 1, medium: 2, high: 3, critical: 4 };

export const trustOf = (z: Zone): TrustLevel => z.trust ?? 'internal';
export const trustRank = (t: TrustLevel): number => TRUST_RANK[t];
export const classificationRank = (c: Classification): number => CLASSIFICATION_RANK[c];
export const statusOf = (t: Threat): ThreatStatus => t.status ?? 'open';
export const controlStatusOf = (c: Control): ControlStatus => c.status ?? 'implemented';
export const sensitive = (c: Classification | undefined): boolean => c === 'confidential' || c === 'restricted';

/** Riesgo = probabilidad (1-3) × impacto (1-4): 1-2 bajo, 3-4 medio, 6 alto, 8-12 crítico. */
export function riskOf(t: Threat): { score: number; rating: RiskRating } {
  const score = LIKELIHOOD_RANK[t.likelihood ?? 'medium'] * IMPACT_RANK[t.impact ?? 'medium'];
  return { score, rating: score <= 2 ? 'low' : score <= 4 ? 'medium' : score <= 6 ? 'high' : 'critical' };
}

/** Todos los elementos del documento por id. */
export function indexElements(doc: SecurityDocument): Map<string, Element> {
  const map = new Map<string, Element>();
  const add = (kind: ElementKind, items: Array<{ id: string; name?: string; title?: string }>): void => {
    for (const item of items) if (!map.has(item.id)) map.set(item.id, { kind, id: item.id, name: item.name ?? item.title ?? item.id, item: item as Item });
  };
  add('zone', doc.zones);
  add('asset', doc.assets);
  add('flow', doc.flows.map((f) => ({ ...f, name: flowName(doc, f) })));
  add('threat', doc.threats);
  add('control', doc.controls);
  return map;
}

/** Nombre legible de un flujo: su descripción o «Origen → Destino». */
export function flowName(doc: SecurityDocument, f: Flow): string {
  if (f.description) return f.description;
  const name = (id: string): string => doc.assets.find((a) => a.id === id)?.name ?? id;
  return `${name(f.sourceId)} → ${name(f.targetId)}`;
}
