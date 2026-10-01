import type { AttachmentDiagnostic, AttachmentTextResult } from '@iark/kernel';
import { describeJsonError, isRecord, orderKeys, parseJson, prettyJson } from './json';
import { Reporter, failureDiagnostic, parseStructured, slugify, type Path } from './shared';

const ROOT_ORDER = ['name', 'version', 'protocolVersion', 'serverInfo', 'capabilities', 'tools', 'resources', 'resourceTemplates', 'prompts'] as const;
const SERVER_INFO_ORDER = ['name', 'title', 'version'] as const;
const TOOL_ORDER = ['name', 'title', 'description', 'inputSchema', 'outputSchema', 'annotations'] as const;
const RESOURCE_ORDER = ['uri', 'name', 'title', 'description', 'mimeType'] as const;
const TEMPLATE_ORDER = ['uriTemplate', 'name', 'title', 'description', 'mimeType'] as const;
const PROMPT_ORDER = ['name', 'title', 'description', 'arguments'] as const;
const ARGUMENT_ORDER = ['name', 'title', 'description', 'required'] as const;
const HINTS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const;
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const URI_WITH_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\S*$/;

const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
const named = (name: unknown, detail: string): string => (isText(name) ? `${name} (${detail})` : detail);
const hasItems = (value: unknown): boolean => Array.isArray(value) && value.length > 0;

export function checkMcp(text: string): AttachmentDiagnostic[] {
  const parsed = parseStructured(text, false);
  if (!parsed.ok) return failureDiagnostic(parsed);
  const report = new Reporter(parsed.locate);
  const doc = parsed.value;
  if (!isRecord(doc)) {
    report.error('El documento MCP debe ser un objeto JSON con «tools», «resources» o «prompts».', []);
    return report.diagnostics;
  }

  checkHeader(doc, report);
  checkTools(doc.tools, report);
  checkResources(doc.resources, report);
  checkResourceTemplates(doc.resourceTemplates, report);
  checkPrompts(doc.prompts, report);
  if (![doc.tools, doc.resources, doc.resourceTemplates, doc.prompts].some(hasItems)) {
    report.warning('El servidor no declara herramientas, recursos ni prompts.', []);
  }
  return report.diagnostics;
}

function checkHeader(doc: Record<string, unknown>, report: Reporter): void {
  const { serverInfo } = doc;
  if (serverInfo !== undefined) {
    if (!isRecord(serverInfo)) report.error('«serverInfo» debe ser un objeto con «name» y «version».', ['serverInfo']);
    else {
      if (!isText(serverInfo.name)) report.error('Falta «serverInfo.name» (texto no vacío).', ['serverInfo']);
      if (!isText(serverInfo.version)) report.warning('Falta «serverInfo.version».', ['serverInfo']);
    }
  } else if (doc.name !== undefined) {
    if (!isText(doc.name)) report.error('«name» debe ser un texto no vacío.', ['name']);
    if (!isText(doc.version)) report.warning('Falta «version» del servidor (texto, p. ej. "1.0.0").', doc.version === undefined ? [] : ['version']);
  } else if (['version', 'protocolVersion', 'capabilities', 'resources', 'resourceTemplates', 'prompts'].some((key) => doc[key] !== undefined)) {
    report.warning('Falta «name» (o «serverInfo.name») del servidor.', []);
  } else {
    report.info('Sin «name» ni «serverInfo»: se interpreta como el resultado desnudo de tools/list.', []);
  }

  if (doc.protocolVersion !== undefined && (typeof doc.protocolVersion !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(doc.protocolVersion))) {
    report.warning('«protocolVersion» debería ser una fecha con la forma AAAA-MM-DD (p. ej. "2025-06-18").', ['protocolVersion']);
  }
  if (doc.capabilities !== undefined && !isRecord(doc.capabilities)) report.error('«capabilities» debe ser un objeto.', ['capabilities']);
}

function checkTools(tools: unknown, report: Reporter): void {
  if (tools === undefined) return;
  if (!Array.isArray(tools)) {
    report.error('«tools» debe ser un array de herramientas.', ['tools']);
    return;
  }
  const names = new Map<string, number>();
  tools.forEach((tool, index) => {
    const path: Path = ['tools', index];
    if (!isRecord(tool)) {
      report.error(`La herramienta nº ${index + 1} debe ser un objeto.`, path);
      return;
    }
    const { name } = tool;
    const label = isText(name) ? `«${name}»` : `nº ${index + 1}`;
    if (!isText(name)) {
      report.error(`La herramienta nº ${index + 1} no tiene «name».`, path);
    } else {
      if (!TOOL_NAME.test(name)) report.error(`El nombre de herramienta «${name}» no es válido: usa solo letras, dígitos, «_», «-» y «.» (de 1 a 128 caracteres).`, [...path, 'name']);
      const previous = names.get(name);
      if (previous !== undefined) report.error(`La herramienta «${name}» está repetida (ya es la nº ${previous + 1}).`, [...path, 'name']);
      else names.set(name, index);
    }
    if (!isText(tool.description)) report.warning(`La herramienta ${label} no tiene «description»: el modelo la necesita para decidir cuándo usarla.`, path);
    checkInputSchema(tool.inputSchema, label, path, report);
    if (tool.outputSchema !== undefined && (!isRecord(tool.outputSchema) || tool.outputSchema.type !== 'object')) {
      report.error(`El «outputSchema» de la herramienta ${label} debe ser un objeto con type: "object".`, [...path, 'outputSchema']);
    }
    checkAnnotations(tool.annotations, label, path, report);
  });
}

function checkInputSchema(schema: unknown, label: string, path: Path, report: Reporter): void {
  const where: Path = [...path, 'inputSchema'];
  if (schema === undefined) {
    report.error(`La herramienta ${label} no tiene «inputSchema» (obligatorio, con type: "object").`, path);
    return;
  }
  if (!isRecord(schema)) {
    report.error(`El «inputSchema» de la herramienta ${label} debe ser un objeto.`, where);
    return;
  }
  if (schema.type !== 'object') report.error(`El «inputSchema» de la herramienta ${label} debe tener type: "object".`, where);
  const { properties } = schema;
  if (properties === undefined) report.info(`El «inputSchema» de la herramienta ${label} no declara «properties»: no recibe parámetros.`, where);
  else if (!isRecord(properties)) report.error(`«properties» del «inputSchema» de la herramienta ${label} debe ser un objeto.`, [...where, 'properties']);
  if (schema.required === undefined) return;
  if (!Array.isArray(schema.required) || schema.required.some((item) => typeof item !== 'string')) {
    report.error(`«required» del «inputSchema» de la herramienta ${label} debe ser un array de nombres.`, [...where, 'required']);
    return;
  }
  const declared = isRecord(properties) ? properties : {};
  for (const name of schema.required as string[]) {
    if (!Object.hasOwn(declared, name)) report.error(`«required» de la herramienta ${label} menciona «${name}», que no está en «properties».`, [...where, 'required']);
  }
}

function checkAnnotations(annotations: unknown, label: string, path: Path, report: Reporter): void {
  if (annotations === undefined) return;
  const where: Path = [...path, 'annotations'];
  if (!isRecord(annotations)) {
    report.error(`«annotations» de la herramienta ${label} debe ser un objeto.`, where);
    return;
  }
  for (const hint of HINTS) {
    if (annotations[hint] !== undefined && typeof annotations[hint] !== 'boolean') {
      report.error(`«annotations.${hint}» de la herramienta ${label} debe ser un booleano (true o false).`, [...where, hint]);
    }
  }
}

function checkResources(resources: unknown, report: Reporter): void {
  if (resources === undefined) return;
  if (!Array.isArray(resources)) {
    report.error('«resources» debe ser un array de recursos.', ['resources']);
    return;
  }
  const uris = new Map<string, number>();
  resources.forEach((resource, index) => {
    const path: Path = ['resources', index];
    if (!isRecord(resource)) {
      report.error(`El recurso nº ${index + 1} debe ser un objeto.`, path);
      return;
    }
    const { uri } = resource;
    if (!isText(uri)) report.error(`El recurso nº ${index + 1} no tiene «uri».`, path);
    else {
      if (!URI_WITH_SCHEME.test(uri)) report.error(`La «uri» del recurso «${uri}» debe tener esquema (p. ej. file:///ruta o https://host/recurso).`, [...path, 'uri']);
      const previous = uris.get(uri);
      if (previous !== undefined) report.warning(`La «uri» «${uri}» está repetida (ya es el recurso nº ${previous + 1}).`, [...path, 'uri']);
      else uris.set(uri, index);
    }
    if (!isText(resource.name)) report.error(`El recurso ${isText(uri) ? `«${uri}»` : `nº ${index + 1}`} no tiene «name».`, path);
  });
}

function checkResourceTemplates(templates: unknown, report: Reporter): void {
  if (templates === undefined) return;
  if (!Array.isArray(templates)) {
    report.error('«resourceTemplates» debe ser un array.', ['resourceTemplates']);
    return;
  }
  templates.forEach((template, index) => {
    const path: Path = ['resourceTemplates', index];
    if (!isRecord(template)) {
      report.error(`La plantilla de recurso nº ${index + 1} debe ser un objeto.`, path);
      return;
    }
    if (!isText(template.uriTemplate)) report.error(`La plantilla de recurso nº ${index + 1} no tiene «uriTemplate».`, path);
    if (!isText(template.name)) report.error(`La plantilla de recurso nº ${index + 1} no tiene «name».`, path);
  });
}

function checkPrompts(prompts: unknown, report: Reporter): void {
  if (prompts === undefined) return;
  if (!Array.isArray(prompts)) {
    report.error('«prompts» debe ser un array de prompts.', ['prompts']);
    return;
  }
  const names = new Map<string, number>();
  prompts.forEach((prompt, index) => {
    const path: Path = ['prompts', index];
    if (!isRecord(prompt)) {
      report.error(`El prompt nº ${index + 1} debe ser un objeto.`, path);
      return;
    }
    const { name } = prompt;
    if (!isText(name)) {
      report.error(`El prompt nº ${index + 1} no tiene «name».`, path);
    } else {
      const previous = names.get(name);
      if (previous !== undefined) report.error(`El prompt «${name}» está repetido (ya es el nº ${previous + 1}).`, [...path, 'name']);
      else names.set(name, index);
    }
    const label = isText(name) ? `«${name}»` : `nº ${index + 1}`;
    if (prompt.arguments === undefined) return;
    if (!Array.isArray(prompt.arguments)) {
      report.error(`«arguments» del prompt ${label} debe ser un array.`, [...path, 'arguments']);
      return;
    }
    const argumentNames = new Map<string, number>();
    prompt.arguments.forEach((argument, position) => {
      const where: Path = [...path, 'arguments', position];
      if (!isRecord(argument) || !isText(argument.name)) {
        report.error(`El argumento nº ${position + 1} del prompt ${label} no tiene «name».`, where);
        return;
      }
      const previous = argumentNames.get(argument.name);
      if (previous !== undefined) report.error(`El argumento «${argument.name}» del prompt ${label} está repetido (ya es el nº ${previous + 1}).`, [...where, 'name']);
      else argumentNames.set(argument.name, position);
      if (argument.required !== undefined && typeof argument.required !== 'boolean') {
        report.error(`«required» del argumento «${argument.name}» del prompt ${label} debe ser un booleano.`, [...where, 'required']);
      }
    });
  });
}

function orderEach(value: unknown, order: readonly string[]): unknown {
  return Array.isArray(value) ? value.map((item) => (isRecord(item) ? orderKeys(item, order) : item)) : value;
}

export function reformatMcp(text: string): AttachmentTextResult {
  const parsed = parseJson(text);
  if (!parsed.ok) return { ok: false, reason: describeJsonError(parsed) };
  if (!isRecord(parsed.value)) return { ok: false, reason: 'El documento MCP debe ser un objeto JSON.' };
  const root = orderKeys(parsed.value, ROOT_ORDER);
  if (isRecord(root.serverInfo)) root.serverInfo = orderKeys(root.serverInfo, SERVER_INFO_ORDER);
  if (root.tools !== undefined) root.tools = orderEach(root.tools, TOOL_ORDER);
  if (root.resources !== undefined) root.resources = orderEach(root.resources, RESOURCE_ORDER);
  if (root.resourceTemplates !== undefined) root.resourceTemplates = orderEach(root.resourceTemplates, TEMPLATE_ORDER);
  if (Array.isArray(root.prompts)) {
    root.prompts = root.prompts.map((prompt: unknown) => {
      if (!isRecord(prompt)) return prompt;
      const ordered = orderKeys(prompt, PROMPT_ORDER);
      if (ordered.arguments !== undefined) ordered.arguments = orderEach(ordered.arguments, ARGUMENT_ORDER);
      return ordered;
    });
  }
  return { ok: true, text: prettyJson(root) };
}

export function summarizeMcp(text: string): string[] {
  const parsed = parseJson(text);
  if (!parsed.ok || !isRecord(parsed.value)) return [];
  const doc = parsed.value;
  const lines: string[] = [];
  const records = (value: unknown): Array<Record<string, unknown>> => (Array.isArray(value) ? value.filter(isRecord) : []);

  for (const tool of records(doc.tools)) {
    if (!isText(tool.name)) continue;
    const props = isRecord(tool.inputSchema) && isRecord(tool.inputSchema.properties) ? Object.keys(tool.inputSchema.properties) : [];
    lines.push(`herramienta ${tool.name}(${props.join(', ')})`);
  }
  for (const resource of records(doc.resources)) {
    if (isText(resource.uri)) lines.push(`recurso ${named(resource.name, resource.uri)}`);
  }
  for (const template of records(doc.resourceTemplates)) {
    if (isText(template.uriTemplate)) lines.push(`plantilla de recurso ${named(template.name, template.uriTemplate)}`);
  }
  for (const prompt of records(doc.prompts)) {
    if (!isText(prompt.name)) continue;
    const args = records(prompt.arguments).filter((argument) => isText(argument.name)).map((argument) => argument.name as string);
    lines.push(`prompt ${prompt.name}(${args.join(', ')})`);
  }
  return lines;
}

export function mcpTemplate(name: string): string {
  return prettyJson({
    name: slugify(name, 'servidor-mcp'),
    version: '1.0.0',
    protocolVersion: '2025-06-18',
    capabilities: { tools: {}, resources: {}, prompts: {} },
    tools: [
      {
        name: 'consultar_estado',
        title: 'Consultar estado',
        description: 'Devuelve el estado de un registro a partir de su identificador.',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string', description: 'Identificador del registro' } },
          required: ['id'],
        },
        outputSchema: {
          type: 'object',
          properties: { id: { type: 'string' }, estado: { type: 'string' } },
          required: ['id', 'estado'],
        },
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
    ],
    resources: [{ uri: 'file:///docs/guia.md', name: 'guia', description: 'Guía de uso del servidor.', mimeType: 'text/markdown' }],
    prompts: [
      {
        name: 'resumir_estado',
        description: 'Resume el estado de un registro.',
        arguments: [{ name: 'id', description: 'Identificador del registro', required: true }],
      },
    ],
  });
}
