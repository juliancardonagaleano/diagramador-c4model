/**
 * Tabla de tipos de Terraform que se importan (familias aws, azurerm y google) y su correspondencia con el modelo de
 * plataforma, más los módulos públicos conocidos que se despliegan en recursos. Lo que no está aquí se avisa agrupado.
 */
import { HclExpr, isExpr, type HclValue } from './hcl';
import { dig, type Scope, type TfModule, type TfNode, type TfObject } from './terraformModel';
import type { ResourceKind } from '../types';

export type SpecKind = ResourceKind | 'network' | 'service';

/** Consulta de los atributos de un recurso (o de una de sus instancias) con lo que se pueda evaluar. */
export interface Q {
  node: TfNode;
  attrs: TfObject;
  scope: Scope;
  str(path: string): string | undefined;
  num(path: string): number | undefined;
  bool(path: string): boolean | undefined;
  strings(path: string): string[];
  tags: Record<string, string>;
}

export function query(node: TfNode, scope: Scope, attrs: TfObject = node.attrs): Q {
  return {
    node,
    attrs,
    scope,
    str: (p) => scope.str(dig(attrs, p)),
    num: (p) => scope.num(dig(attrs, p)),
    bool: (p) => scope.bool(dig(attrs, p)),
    strings: (p) => scope.strings(dig(attrs, p)),
    tags: scope.tags(attrs),
  };
}

export interface Spec {
  kind: SpecKind;
  /** Red que contiene subredes (VPC, red virtual). */
  container?: boolean;
  technology?: string | ((q: Q) => string | undefined);
  version?: (q: Q) => string | undefined;
  /** Datos que se añaden a la descripción (`Multi-AZ`, `interno`…). */
  extra?: (q: Q) => string[];
}

const ENGINES: Record<string, string> = {
  postgres: 'PostgreSQL',
  postgresql: 'PostgreSQL',
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  aurora: 'Aurora MySQL',
  'aurora-postgresql': 'Aurora PostgreSQL',
  'aurora-mysql': 'Aurora MySQL',
  oracle: 'Oracle',
  sqlserver: 'SQL Server',
  redis: 'Redis',
  memcached: 'Memcached',
  valkey: 'Valkey',
  docdb: 'DocumentDB',
  neptune: 'Neptune',
};

export function engineName(engine: string | undefined): string | undefined {
  if (!engine) return undefined;
  const key = engine.toLowerCase();
  const hit = Object.keys(ENGINES)
    .sort((a, b) => b.length - a.length)
    .find((k) => key === k || key.startsWith(`${k}-`));
  return hit ? ENGINES[hit] : engine;
}

const join = (...parts: Array<string | undefined>): string | undefined => {
  const text = parts.filter(Boolean).join(' ');
  return text || undefined;
};

const rds = (q: Q): string => {
  const engine = engineName(q.str('engine'));
  return engine?.startsWith('Aurora') ? `Amazon ${engine}` : join('Amazon RDS', engine)!;
};

const flag = (q: Q, path: string, text: string): string[] => (q.bool(path) === true ? [text] : []);

/** Cadena `Azure SQL` + versión de la base de datos: `version` o `database_version`. */
const databaseVersion = (q: Q): string | undefined => q.str('engine_version') ?? q.str('version') ?? q.str('database_version');

const gcpDatabase = (q: Q): { technology: string; version?: string } => {
  const raw = q.str('database_version');
  const m = raw ? /^([A-Z]+)(?:_(\d[\d_]*))?/.exec(raw) : null;
  const names: Record<string, string> = { POSTGRES: 'PostgreSQL', MYSQL: 'MySQL', SQLSERVER: 'SQL Server' };
  const engine = m ? (names[m[1]] ?? m[1]) : undefined;
  return { technology: join('Cloud SQL', engine)!, ...(m?.[2] ? { version: m[2].replace(/_/g, '.') } : {}) };
};

const vm = (technology: string, sizeKey: string) => ({ kind: 'vm' as const, technology: (q: Q) => join(technology, q.str(sizeKey)) });

export const SPECS: Record<string, Spec> = {
  // ───────── AWS ─────────
  aws_vpc: { kind: 'network', container: true },
  aws_subnet: { kind: 'network' },
  aws_eks_cluster: { kind: 'cluster', technology: 'Amazon EKS', version: (q) => q.str('version') },
  aws_ecs_cluster: { kind: 'cluster', technology: 'Amazon ECS' },
  aws_ecs_service: { kind: 'service' },
  aws_instance: { ...vm('Amazon EC2', 'instance_type'), extra: (q) => flag(q, 'associate_public_ip_address', 'IP pública') },
  aws_autoscaling_group: { kind: 'vm', technology: 'Amazon EC2 Auto Scaling' },
  aws_db_instance: { kind: 'database', technology: rds, version: (q) => q.str('engine_version'), extra: (q) => [...flag(q, 'multi_az', 'Multi-AZ'), ...(q.str('instance_class') ? [q.str('instance_class')!] : [])] },
  aws_rds_cluster: { kind: 'database', technology: (q) => (q.str('engine')?.startsWith('aurora') ? `Amazon ${engineName(q.str('engine'))}` : rds(q)), version: (q) => q.str('engine_version') },
  aws_dynamodb_table: { kind: 'database', technology: 'Amazon DynamoDB' },
  aws_docdb_cluster: { kind: 'database', technology: 'Amazon DocumentDB', version: (q) => q.str('engine_version') },
  aws_neptune_cluster: { kind: 'database', technology: 'Amazon Neptune', version: (q) => q.str('engine_version') },
  aws_redshift_cluster: { kind: 'database', technology: 'Amazon Redshift' },
  aws_opensearch_domain: { kind: 'database', technology: 'Amazon OpenSearch', version: (q) => q.str('engine_version') },
  aws_elasticsearch_domain: { kind: 'database', technology: 'Amazon OpenSearch', version: (q) => q.str('elasticsearch_version') },
  aws_elasticache_cluster: { kind: 'cache', technology: (q) => join('Amazon ElastiCache', engineName(q.str('engine'))), version: (q) => q.str('engine_version') },
  aws_elasticache_replication_group: { kind: 'cache', technology: (q) => join('Amazon ElastiCache', engineName(q.str('engine')) ?? 'Redis'), version: (q) => q.str('engine_version') },
  aws_memorydb_cluster: { kind: 'cache', technology: 'Amazon MemoryDB', version: (q) => q.str('engine_version') },
  aws_dax_cluster: { kind: 'cache', technology: 'Amazon DAX' },
  aws_sqs_queue: { kind: 'queue', technology: (q) => (q.bool('fifo_queue') ? 'Amazon SQS FIFO' : 'Amazon SQS') },
  aws_sns_topic: { kind: 'queue', technology: 'Amazon SNS' },
  aws_mq_broker: { kind: 'queue', technology: (q) => join('Amazon MQ', q.str('engine_type')), version: (q) => q.str('engine_version') },
  aws_msk_cluster: { kind: 'queue', technology: 'Amazon MSK (Kafka)', version: (q) => q.str('kafka_version') },
  aws_kinesis_stream: { kind: 'queue', technology: 'Amazon Kinesis' },
  aws_s3_bucket: { kind: 'storage', technology: 'Amazon S3' },
  aws_efs_file_system: { kind: 'storage', technology: 'Amazon EFS' },
  aws_ebs_volume: { kind: 'storage', technology: 'Amazon EBS' },
  aws_lb: { kind: 'load-balancer', technology: (q) => ({ network: 'Amazon NLB', gateway: 'Amazon GWLB' })[q.str('load_balancer_type') ?? ''] ?? 'Amazon ALB', extra: (q) => (q.bool('internal') === true ? ['interno'] : []) },
  aws_alb: { kind: 'load-balancer', technology: 'Amazon ALB', extra: (q) => (q.bool('internal') === true ? ['interno'] : []) },
  aws_elb: { kind: 'load-balancer', technology: 'Amazon ELB clásico' },
  aws_api_gateway_rest_api: { kind: 'gateway', technology: 'Amazon API Gateway' },
  aws_apigatewayv2_api: { kind: 'gateway', technology: 'Amazon API Gateway' },
  aws_cloudfront_distribution: { kind: 'gateway', technology: 'Amazon CloudFront' },
  aws_route53_zone: { kind: 'dns', technology: 'Amazon Route 53', extra: (q) => flag(q, 'private_zone', 'zona privada') },
  aws_secretsmanager_secret: { kind: 'secret-store', technology: 'AWS Secrets Manager' },
  aws_kms_key: { kind: 'secret-store', technology: 'AWS KMS' },
  aws_ecr_repository: { kind: 'registry', technology: 'Amazon ECR' },
  aws_acm_certificate: { kind: 'certificate', technology: 'AWS Certificate Manager' },
  aws_prometheus_workspace: { kind: 'monitoring', technology: 'Amazon Managed Prometheus' },
  aws_grafana_workspace: { kind: 'monitoring', technology: 'Amazon Managed Grafana' },
  aws_cloudwatch_dashboard: { kind: 'monitoring', technology: 'Amazon CloudWatch' },
  aws_lambda_function: { kind: 'other', technology: (q) => join('AWS Lambda', q.str('runtime') ? `(${q.str('runtime')})` : undefined) },

  // ───────── Azure ─────────
  azurerm_virtual_network: { kind: 'network', container: true },
  azurerm_subnet: { kind: 'network' },
  azurerm_kubernetes_cluster: { kind: 'cluster', technology: 'Azure AKS', version: (q) => q.str('kubernetes_version') },
  azurerm_linux_virtual_machine: vm('Azure Virtual Machine', 'size'),
  azurerm_windows_virtual_machine: vm('Azure Virtual Machine', 'size'),
  azurerm_virtual_machine: vm('Azure Virtual Machine', 'vm_size'),
  azurerm_linux_virtual_machine_scale_set: vm('Azure VM Scale Set', 'sku'),
  azurerm_windows_virtual_machine_scale_set: vm('Azure VM Scale Set', 'sku'),
  azurerm_postgresql_flexible_server: { kind: 'database', technology: 'Azure Database for PostgreSQL', version: databaseVersion },
  azurerm_postgresql_server: { kind: 'database', technology: 'Azure Database for PostgreSQL', version: databaseVersion },
  azurerm_mysql_flexible_server: { kind: 'database', technology: 'Azure Database for MySQL', version: databaseVersion },
  azurerm_mysql_server: { kind: 'database', technology: 'Azure Database for MySQL', version: databaseVersion },
  azurerm_mariadb_server: { kind: 'database', technology: 'Azure Database for MariaDB', version: databaseVersion },
  azurerm_mssql_server: { kind: 'database', technology: 'Azure SQL', version: databaseVersion },
  azurerm_sql_server: { kind: 'database', technology: 'Azure SQL', version: databaseVersion },
  azurerm_mssql_managed_instance: { kind: 'database', technology: 'Azure SQL Managed Instance' },
  azurerm_cosmosdb_account: { kind: 'database', technology: 'Azure Cosmos DB' },
  azurerm_redis_cache: { kind: 'cache', technology: 'Azure Cache for Redis', version: (q) => q.str('redis_version') },
  azurerm_servicebus_namespace: { kind: 'queue', technology: 'Azure Service Bus' },
  azurerm_eventhub_namespace: { kind: 'queue', technology: 'Azure Event Hubs' },
  azurerm_eventgrid_topic: { kind: 'queue', technology: 'Azure Event Grid' },
  azurerm_storage_account: { kind: 'storage', technology: 'Azure Storage' },
  azurerm_managed_disk: { kind: 'storage', technology: 'Azure Managed Disk' },
  azurerm_lb: { kind: 'load-balancer', technology: 'Azure Load Balancer' },
  azurerm_application_gateway: { kind: 'load-balancer', technology: 'Azure Application Gateway' },
  azurerm_api_management: { kind: 'gateway', technology: 'Azure API Management' },
  azurerm_frontdoor: { kind: 'gateway', technology: 'Azure Front Door' },
  azurerm_cdn_frontdoor_profile: { kind: 'gateway', technology: 'Azure Front Door' },
  azurerm_dns_zone: { kind: 'dns', technology: 'Azure DNS' },
  azurerm_private_dns_zone: { kind: 'dns', technology: 'Azure DNS', extra: () => ['zona privada'] },
  azurerm_key_vault: { kind: 'secret-store', technology: 'Azure Key Vault' },
  azurerm_container_registry: { kind: 'registry', technology: 'Azure Container Registry' },
  azurerm_log_analytics_workspace: { kind: 'monitoring', technology: 'Azure Log Analytics' },
  azurerm_application_insights: { kind: 'monitoring', technology: 'Azure Application Insights' },
  azurerm_linux_function_app: { kind: 'other', technology: 'Azure Functions' },
  azurerm_windows_function_app: { kind: 'other', technology: 'Azure Functions' },
  azurerm_function_app: { kind: 'other', technology: 'Azure Functions' },
  azurerm_linux_web_app: { kind: 'other', technology: 'Azure App Service' },
  azurerm_windows_web_app: { kind: 'other', technology: 'Azure App Service' },
  azurerm_app_service: { kind: 'other', technology: 'Azure App Service' },

  // ───────── Google Cloud ─────────
  google_compute_network: { kind: 'network', container: true },
  google_compute_subnetwork: { kind: 'network' },
  google_container_cluster: { kind: 'cluster', technology: 'Google GKE', version: (q) => q.str('min_master_version') },
  google_compute_instance: vm('Google Compute Engine', 'machine_type'),
  google_sql_database_instance: { kind: 'database', technology: (q) => gcpDatabase(q).technology, version: (q) => gcpDatabase(q).version },
  google_spanner_instance: { kind: 'database', technology: 'Google Cloud Spanner' },
  google_bigtable_instance: { kind: 'database', technology: 'Google Cloud Bigtable' },
  google_firestore_database: { kind: 'database', technology: 'Google Firestore' },
  google_alloydb_cluster: { kind: 'database', technology: 'Google AlloyDB' },
  google_bigquery_dataset: { kind: 'database', technology: 'Google BigQuery' },
  google_redis_instance: { kind: 'cache', technology: 'Google Memorystore Redis', version: (q) => q.str('redis_version')?.replace(/^REDIS_/, '').replace(/_/g, '.') },
  google_memcache_instance: { kind: 'cache', technology: 'Google Memorystore Memcached' },
  google_pubsub_topic: { kind: 'queue', technology: 'Google Pub/Sub' },
  google_cloud_tasks_queue: { kind: 'queue', technology: 'Google Cloud Tasks' },
  google_storage_bucket: { kind: 'storage', technology: 'Google Cloud Storage' },
  google_compute_disk: { kind: 'storage', technology: 'Google Persistent Disk' },
  google_filestore_instance: { kind: 'storage', technology: 'Google Filestore' },
  google_compute_forwarding_rule: { kind: 'load-balancer', technology: 'Google Cloud Load Balancing', extra: (q) => (q.str('load_balancing_scheme') === 'INTERNAL' ? ['interno'] : []) },
  google_compute_global_forwarding_rule: { kind: 'load-balancer', technology: 'Google Cloud Load Balancing' },
  google_api_gateway_gateway: { kind: 'gateway', technology: 'Google API Gateway' },
  google_dns_managed_zone: { kind: 'dns', technology: 'Google Cloud DNS' },
  google_secret_manager_secret: { kind: 'secret-store', technology: 'Google Secret Manager' },
  google_kms_key_ring: { kind: 'secret-store', technology: 'Google Cloud KMS' },
  google_artifact_registry_repository: { kind: 'registry', technology: 'Google Artifact Registry' },
  google_container_registry: { kind: 'registry', technology: 'Google Container Registry' },
  google_compute_managed_ssl_certificate: { kind: 'certificate', technology: 'Google Cloud SSL' },
  google_certificate_manager_certificate: { kind: 'certificate', technology: 'Google Certificate Manager' },
  google_cloud_run_service: { kind: 'other', technology: 'Google Cloud Run' },
  google_cloud_run_v2_service: { kind: 'other', technology: 'Google Cloud Run' },
  google_cloudfunctions_function: { kind: 'other', technology: 'Google Cloud Functions' },
  google_cloudfunctions2_function: { kind: 'other', technology: 'Google Cloud Functions' },
};

/** Familia de proveedor de un tipo de recurso. */
export function providerFamily(type: string): 'aws' | 'azure' | 'gcp' | undefined {
  if (type.startsWith('aws_')) return 'aws';
  if (type.startsWith('azurerm_')) return 'azure';
  if (type.startsWith('google_')) return 'gcp';
  return undefined;
}

/**
 * Tipos que no son infraestructura que dibujar pero que el importador consulta: permisos, tablas de rutas, grupos de
 * seguridad, listeners, asociaciones, políticas, recursos auxiliares (`random_*`, `null_resource`…). Se avisan aparte de los
 * tipos desconocidos.
 */
const SUPPORT_TOKENS =
  /(?:^|_)(?:iam|role|roles|policy|policies|permission|permissions|security|firewall|nsg|route|routes|association|associations|attachment|attachments|subnet_group|parameter_group|option_group|listener|listener_rule|target_group|log_group|log_stream|metric_alarm|alarm|endpoint|peering|nat_gateway|internet_gateway|eip|public_ip|network_interface|resource_group|role_assignment|diagnostic|acl|key_pair|alias|rule|record|secret_version|node_group|node_pool|addon|fargate_profile|task_definition|launch_template|launch_configuration|autoscaling|lifecycle|public_access_block|ownership_controls|encryption|versioning|logging|notification|cors|website|subscription|flow_log|dhcp|vpn|customer_gateway)(?:_|$)/;
/** Hijos de otros recursos que sí se dibujan (la cola dentro de su espacio de nombres, la base dentro de su servidor). */
const SUPPORT_CHILDREN = /^(?:azurerm_(?:servicebus_(?:queue|topic|subscription)|eventhub(?:_\w+)?|storage_(?:container|queue|share|table|blob)|(?:mssql|postgresql|mysql|mariadb|sql)_(?:\w+_)?database|cosmosdb_\w+)|google_(?:sql_(?:database|user)|bigtable_table|spanner_database|pubsub_subscription))$/;
const GLUE = /^(?:random|null|time|tls|local|archive|external|http|template|terraform_data)(?:_|$)/;

export const isSupportType = (type: string): boolean => GLUE.test(type) || SUPPORT_CHILDREN.test(type) || (providerFamily(type) !== undefined && SUPPORT_TOKENS.test(type.replace(/^(?:aws|azurerm|google)_/, '')));

/** Nodos por los que una referencia sigue (su contenido cuenta como del que los referencia): definiciones de tareas y plantillas de lanzamiento. */
export const CARRIER_TYPES = /^(?:aws_ecs_task_definition|aws_launch_template|aws_launch_configuration|azurerm_container_group)$/;

// ───────────── módulos públicos conocidos ─────────────

export interface Synthesized {
  nodes: TfNode[];
  /** Salida del módulo (`private_subnets`) → direcciones de los nodos; `''` es la predeterminada (el recurso principal). */
  outputs: Record<string, string[]>;
}

const list = (scope: Scope, v: HclValue | undefined): string[] => scope.strings(v);

/** CIDR de cada subred de una lista de un módulo (`''` si no se evalúa); `undefined` si ni siquiera se sabe cuántas hay. */
function cidrs(scope: Scope, v: HclValue | undefined): string[] | undefined {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v.map((x) => scope.str(x) ?? '');
  const r = scope.value(v);
  return Array.isArray(r) ? r.map((x) => (typeof x === 'string' ? x : '')) : undefined;
}

const SUBNET_GROUPS: Array<[output: string, label: string, isPublic: boolean]> = [
  ['public_subnets', 'public', true],
  ['private_subnets', 'private', false],
  ['database_subnets', 'database', false],
  ['elasticache_subnets', 'elasticache', false],
  ['redshift_subnets', 'redshift', false],
  ['intra_subnets', 'intra', false],
];

const SIMPLE_AWS: Record<string, { type: string; nameKey?: string }> = {
  eks: { type: 'aws_eks_cluster', nameKey: 'cluster_name' },
  rds: { type: 'aws_db_instance', nameKey: 'identifier' },
  's3-bucket': { type: 'aws_s3_bucket', nameKey: 'bucket' },
  sqs: { type: 'aws_sqs_queue' },
  sns: { type: 'aws_sns_topic' },
  alb: { type: 'aws_lb' },
  'dynamodb-table': { type: 'aws_dynamodb_table' },
  ecr: { type: 'aws_ecr_repository', nameKey: 'repository_name' },
};

/**
 * Sustituye un `module` conocido del registro público por los recursos que despliega: `terraform-aws-modules/vpc` es una VPC
 * con sus subredes (públicas y privadas según el nombre de la lista), y eks, rds, s3-bucket, sqs, sns, alb, dynamodb-table y
 * ecr son un recurso cada uno; también aks, gke, sql-db y las redes de Azure y Google. Devuelve `undefined` si el módulo no es
 * uno de ellos (o su origen es local, que no se puede seguir).
 */
export function synthesizeModule(mod: TfModule, scope: Scope): Synthesized | undefined {
  const source = (mod.source ?? '').toLowerCase().replace(/^(?:git::)?(?:https?:\/\/)?(?:registry\.terraform\.io\/|github\.com\/)/, '').replace(/\.git(?:\?.*)?$/, '');
  const base = `module.${mod.name}`;
  const make = (type: string, name: string, attrs: TfObject, address = base, refs = mod.refs): TfNode => ({ address, mode: 'managed', type, name, attrs, instances: [], refs, dependsOn: mod.dependsOn, ...(mod.line !== undefined ? { line: mod.line } : {}) });
  const named = (key: string | undefined, fallback = mod.name): TfObject => (key && mod.attrs[key] !== undefined ? { name: mod.attrs[key] } : { name: fallback });

  const aws = /^terraform-aws-modules\/(?:terraform-aws-)?([a-z0-9-]+?)(?:\/aws)?(?:\/\/.*)?$/.exec(source);
  if (aws) {
    const kind = aws[1];
    if (kind === 'vpc') {
      const vpc = make('aws_vpc', mod.name, { cidr_block: mod.attrs.cidr ?? null, tags: { Name: mod.attrs.name ?? mod.name } });
      const nodes = [vpc];
      const outputs: Record<string, string[]> = { '': [base], vpc_id: [base] };
      for (const [output, label, isPublic] of SUBNET_GROUPS) {
        const given = cidrs(scope, mod.attrs[output]);
        if (given !== undefined && given.length === 0) continue;
        const entries = given ?? [''];
        entries.forEach((cidr, i) => {
          const name = entries.length > 1 ? `${label}_${i + 1}` : label;
          const address = `${base}.aws_subnet.${name}`;
          nodes.push(make('aws_subnet', name, { cidr_block: cidr || null, map_public_ip_on_launch: isPublic, vpc_id: new HclExpr(base, [base]), tags: { Name: `${mod.name}-${name}` } }, address, [base, ...mod.dependsOn]));
          outputs[output] = [...(outputs[output] ?? []), address];
        });
      }
      return { nodes, outputs };
    }
    const simple = SIMPLE_AWS[kind];
    if (simple) {
      const attrs: TfObject = { ...mod.attrs, ...named(simple.nameKey) };
      if (kind === 'eks') attrs.version = mod.attrs.cluster_version ?? mod.attrs.kubernetes_version ?? null;
      return { nodes: [make(simple.type, mod.name, attrs)], outputs: { '': [base] } };
    }
    return undefined;
  }

  if (/^azure\/aks\/azurerm/.test(source)) {
    return { nodes: [make('azurerm_kubernetes_cluster', mod.name, { ...mod.attrs, ...named('cluster_name', mod.name) })], outputs: { '': [base] } };
  }
  if (/^azure\/vnet\/azurerm/.test(source)) {
    const vnet = make('azurerm_virtual_network', mod.name, { name: mod.attrs.vnet_name ?? mod.name, address_space: mod.attrs.address_space ?? null });
    const names = list(scope, mod.attrs.subnet_names);
    const prefixes = list(scope, mod.attrs.subnet_prefixes);
    const nodes = [vnet];
    const outputs: Record<string, string[]> = { '': [base], vnet_id: [base] };
    names.forEach((n, i) => {
      const address = `${base}.azurerm_subnet.${n}`;
      nodes.push(make('azurerm_subnet', n, { name: n, address_prefixes: prefixes[i] ? [prefixes[i]] : null, virtual_network_name: new HclExpr(base, [base]) }, address, [base, ...mod.dependsOn]));
      outputs.vnet_subnets = [...(outputs.vnet_subnets ?? []), address];
    });
    return { nodes, outputs };
  }
  if (/^terraform-google-modules\/(?:terraform-google-)?kubernetes-engine\/google/.test(source)) {
    return { nodes: [make('google_container_cluster', mod.name, { ...mod.attrs, ...named('name'), min_master_version: mod.attrs.kubernetes_version ?? null })], outputs: { '': [base] } };
  }
  if (/^googlecloudplatform\/sql-db\/google/.test(source) || /^terraform-google-modules\/(?:terraform-google-)?sql-db\/google/.test(source)) {
    return { nodes: [make('google_sql_database_instance', mod.name, { ...mod.attrs, ...named('name') })], outputs: { '': [base] } };
  }
  if (/^terraform-google-modules\/(?:terraform-google-)?network\/google/.test(source)) {
    const net = make('google_compute_network', mod.name, { name: mod.attrs.network_name ?? mod.name });
    const nodes = [net];
    const outputs: Record<string, string[]> = { '': [base], network_name: [base] };
    const subnets = Array.isArray(mod.attrs.subnets) ? mod.attrs.subnets : [];
    for (const s of subnets) {
      if (s === null || typeof s !== 'object' || Array.isArray(s) || isExpr(s)) continue;
      const name = scope.str((s as TfObject).subnet_name);
      if (!name) continue;
      const address = `${base}.google_compute_subnetwork.${name}`;
      nodes.push(make('google_compute_subnetwork', name, { name, ip_cidr_range: (s as TfObject).subnet_ip ?? null, network: new HclExpr(base, [base]) }, address, [base, ...mod.dependsOn]));
      outputs.subnets = [...(outputs.subnets ?? []), address];
    }
    return { nodes, outputs };
  }
  return undefined;
}
