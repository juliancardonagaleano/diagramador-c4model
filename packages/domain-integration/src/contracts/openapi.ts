import type { AttachmentDiagnostic, AttachmentTextResult } from '@iark/kernel';
import { isRecord, prettyJson } from './json';
import { Reporter, checkInfo, checkLocalRefs, failureDiagnostic, parseStructured, reformatStructured, resolveLocalRef, type Path } from './shared';

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;
export const OPENAPI_ROOT_ORDER = ['openapi', 'swagger', 'info', 'servers', 'tags', 'paths', 'components', 'security'] as const;

const METHOD_SET = new Set<string>(METHODS);
const RESPONSE_CODE = /^(?:[1-5][0-9]{2}|[1-5]XX|default)$/;

interface ParameterRef {
  name: string;
  in: string;
  required: unknown;
  path: Path;
}

export function checkOpenApi(text: string): AttachmentDiagnostic[] {
  const parsed = parseStructured(text, true);
  if (!parsed.ok) return failureDiagnostic(parsed);
  const report = new Reporter(parsed.locate);
  const doc = parsed.value;
  if (!isRecord(doc)) {
    report.error('El documento OpenAPI debe ser un objeto (mapa) en la raíz.', []);
    return report.diagnostics;
  }

  const { openapi, swagger } = doc;
  if (openapi === undefined) {
    if (swagger !== undefined) report.warning('Es un documento Swagger 2.0: usa OpenAPI 3 («openapi: 3.0.3» o posterior).', ['swagger']);
    else report.error('Falta el campo «openapi» (p. ej. "3.0.3").', []);
  } else if (typeof openapi !== 'string' || !/^3\.\d+\.\d+/.test(openapi)) {
    const hint = typeof openapi === 'number' ? ' En YAML, ponla entre comillas.' : '';
    report.error(`«openapi» debe ser una versión 3.x (p. ej. "3.0.3") y es ${JSON.stringify(openapi)}.${hint}`, ['openapi']);
  }

  checkInfo(doc.info, report);

  const schemes = securitySchemes(doc);
  const is31 = typeof openapi === 'string' && /^3\.([1-9]\d*)\./.test(openapi);
  const { paths } = doc;
  if (paths === undefined) {
    if (!(is31 && (doc.webhooks !== undefined || doc.components !== undefined))) report.error('Falta «paths».', []);
  } else if (!isRecord(paths)) {
    report.error('«paths» debe ser un objeto cuyas claves son las rutas.', ['paths']);
  } else {
    if (Object.keys(paths).length === 0) report.info('«paths» está vacío: la API no declara ninguna ruta.', ['paths']);
    const operationIds = new Map<string, string>();
    for (const [route, item] of Object.entries(paths)) checkPathItem(doc, route, item, schemes, operationIds, report);
  }

  checkSecurity(doc.security, schemes, ['security'], report);
  checkLocalRefs(doc, report);
  return report.diagnostics;
}

function securitySchemes(doc: Record<string, unknown>): Record<string, unknown> | undefined {
  const components = isRecord(doc.components) ? doc.components : undefined;
  if (isRecord(components?.securitySchemes)) return components.securitySchemes;
  return isRecord(doc.securityDefinitions) ? doc.securityDefinitions : undefined;
}

function checkSecurity(security: unknown, schemes: Record<string, unknown> | undefined, path: Path, report: Reporter): void {
  if (security === undefined) return;
  if (!Array.isArray(security)) {
    report.error('«security» debe ser un array de requisitos de seguridad.', path);
    return;
  }
  security.forEach((requirement, index) => {
    if (!isRecord(requirement)) {
      report.error('Cada requisito de «security» debe ser un objeto.', [...path, index]);
      return;
    }
    for (const name of Object.keys(requirement)) {
      if (!schemes || !Object.hasOwn(schemes, name)) {
        report.error(`El esquema de seguridad «${name}» no está declarado en components.securitySchemes.`, [...path, index, name]);
      }
    }
  });
}

function collectParameters(doc: Record<string, unknown>, parameters: unknown, path: Path): { list: ParameterRef[]; complete: boolean } {
  const list: ParameterRef[] = [];
  let complete = true;
  if (!Array.isArray(parameters)) return { list, complete };
  parameters.forEach((entry, index) => {
    let parameter = entry;
    if (isRecord(entry) && typeof entry.$ref === 'string') parameter = resolveLocalRef(doc, entry.$ref);
    if (isRecord(parameter) && typeof parameter.name === 'string' && typeof parameter.in === 'string') {
      list.push({ name: parameter.name, in: parameter.in, required: parameter.required, path: [...path, index] });
    } else {
      complete = false;
    }
  });
  return { list, complete };
}

function checkPathItem(
  doc: Record<string, unknown>,
  route: string,
  item: unknown,
  schemes: Record<string, unknown> | undefined,
  operationIds: Map<string, string>,
  report: Reporter,
): void {
  const base: Path = ['paths', route];
  if (!route.startsWith('/')) report.error(`La ruta «${route}» debe empezar por «/».`, base);
  if (!isRecord(item)) {
    report.error(`La ruta «${route}» debe ser un objeto.`, base);
    return;
  }

  const shared = collectParameters(doc, item.parameters, [...base, 'parameters']);
  const templated = [...route.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
  for (const parameter of shared.list) {
    if (parameter.in !== 'path') continue;
    if (parameter.required !== true) report.error(`El parámetro de ruta «${parameter.name}» debe tener «required: true».`, parameter.path);
    if (!templated.includes(parameter.name)) report.warning(`El parámetro de ruta «${parameter.name}» no aparece en la ruta «${route}».`, parameter.path);
  }

  for (const key of Object.keys(item)) {
    if (METHOD_SET.has(key.toLowerCase()) && !METHOD_SET.has(key)) {
      report.warning(`«${key}» no es una operación válida en «${route}»: usa «${key.toLowerCase()}» en minúsculas.`, [...base, key]);
    }
  }

  for (const method of METHODS) {
    if (!Object.hasOwn(item, method)) continue;
    const operation = item[method];
    const label = `${method.toUpperCase()} ${route}`;
    const path: Path = [...base, method];
    if (!isRecord(operation)) {
      report.error(`La operación ${label} debe ser un objeto.`, path);
      continue;
    }

    const { responses } = operation;
    if (responses === undefined) report.error(`La operación ${label} no tiene «responses».`, path);
    else if (!isRecord(responses)) report.error(`«responses» de ${label} debe ser un objeto.`, [...path, 'responses']);
    else if (Object.keys(responses).length === 0) report.error(`«responses» de ${label} está vacío: declara al menos una respuesta.`, [...path, 'responses']);
    else {
      for (const code of Object.keys(responses)) {
        if (!RESPONSE_CODE.test(code)) report.warning(`El código de respuesta «${code}» de ${label} no es válido (usa 200, 4XX o default).`, [...path, 'responses', code]);
      }
    }

    if (operation.operationId !== undefined) {
      const { operationId } = operation;
      if (typeof operationId !== 'string' || operationId.trim() === '') {
        report.error(`El «operationId» de ${label} debe ser un texto no vacío.`, [...path, 'operationId']);
      } else if (operationIds.has(operationId)) {
        report.error(`El operationId «${operationId}» está repetido (ya lo usa ${operationIds.get(operationId)}).`, [...path, 'operationId']);
      } else {
        operationIds.set(operationId, label);
      }
    }

    const own = collectParameters(doc, operation.parameters, [...path, 'parameters']);
    const declared = [...shared.list, ...own.list].filter((parameter) => parameter.in === 'path');
    const known = new Set(declared.map((parameter) => parameter.name));
    if (shared.complete && own.complete) {
      for (const name of templated) {
        if (!known.has(name)) report.warning(`La ruta «${route}» usa {${name}} pero ${label} no lo declara como parámetro «in: path».`, path);
      }
      for (const parameter of own.list) {
        if (parameter.in === 'path' && !templated.includes(parameter.name)) {
          report.warning(`El parámetro de ruta «${parameter.name}» de ${label} no aparece en la ruta «${route}».`, parameter.path);
        }
      }
    }
    for (const parameter of own.list) {
      if (parameter.in === 'path' && parameter.required !== true) report.error(`El parámetro de ruta «${parameter.name}» debe tener «required: true».`, parameter.path);
    }

    checkSecurity(operation.security, schemes, [...path, 'security'], report);
  }
}

export function reformatOpenApi(text: string): AttachmentTextResult {
  return reformatStructured(text, { yaml: true, order: OPENAPI_ROOT_ORDER });
}

export function summarizeOpenApi(text: string): string[] {
  const parsed = parseStructured(text, true);
  if (!parsed.ok || !isRecord(parsed.value) || !isRecord(parsed.value.paths)) return [];
  const lines: string[] = [];
  for (const [route, item] of Object.entries(parsed.value.paths)) {
    if (!isRecord(item)) continue;
    for (const method of METHODS) {
      const operation = item[method];
      if (!isRecord(operation)) continue;
      const id = typeof operation.operationId === 'string' && operation.operationId ? operation.operationId : undefined;
      lines.push(id ? `${method.toUpperCase()} ${route} — ${id}` : `${method.toUpperCase()} ${route}`);
    }
  }
  return lines;
}

export function openApiTemplate(name: string): string {
  return prettyJson({
    openapi: '3.0.3',
    info: { title: name.trim() || 'API', version: '1.0.0' },
    servers: [{ url: 'https://api.example.com' }],
    paths: {
      '/recursos': {
        get: {
          operationId: 'listarRecursos',
          summary: 'Lista los recursos',
          responses: {
            '200': {
              description: 'Listado de recursos',
              content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Recurso' } } } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Recurso: {
          type: 'object',
          properties: { id: { type: 'string' }, nombre: { type: 'string' } },
          required: ['id'],
        },
      },
    },
  });
}
