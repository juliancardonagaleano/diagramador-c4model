import type { AttachmentDiagnostic, AttachmentFormat, AttachmentTextResult } from '@iark/kernel';
import type { ContractFormat } from '../types';
import { asyncApiTemplate, checkAsyncApi, reformatAsyncApi, summarizeAsyncApi } from './asyncapi';
import { avroTemplate, checkAvro, reformatAvro, summarizeAvro } from './avro';
import { checkCloudEvent, cloudEventTemplate, reformatCloudEvent, summarizeCloudEvent } from './cloudevents';
import { checkGraphql, graphqlTemplate, reformatGraphql, summarizeGraphql } from './graphql';
import { checkJsonSchema, jsonSchemaTemplate, reformatJsonSchema, summarizeJsonSchema } from './jsonschema';
import { checkMcp, mcpTemplate, reformatMcp, summarizeMcp } from './mcp';
import { OPENAPI_ROOT_ORDER, checkOpenApi, openApiTemplate, reformatOpenApi, summarizeOpenApi } from './openapi';
import { checkProto, protoTemplate, reformatProto, summarizeProto } from './proto';
import { convertStructured, sortDiagnostics } from './shared';
import { checkWsdl, reformatWsdl, summarizeWsdl, wsdlTemplate } from './wsdl';

export const CONTRACT_FORMAT_INFO: Record<ContractFormat, AttachmentFormat> = {
  openapi: { id: 'openapi', label: 'OpenAPI (REST)', language: 'json', extension: '.json', description: 'Contrato de una API REST: rutas, operaciones, parámetros y esquemas (JSON o YAML).' },
  asyncapi: { id: 'asyncapi', label: 'AsyncAPI', language: 'json', extension: '.json', description: 'Contrato de una API basada en eventos o mensajes: canales, operaciones y mensajes (JSON o YAML).' },
  graphql: { id: 'graphql', label: 'GraphQL (SDL)', language: 'graphql', extension: '.graphql', description: 'Esquema de una API GraphQL en lenguaje de definición (SDL).' },
  protobuf: { id: 'protobuf', label: 'Protobuf / gRPC (.proto)', language: 'proto', extension: '.proto', description: 'Definición de mensajes y servicios gRPC en un archivo .proto.' },
  avro: { id: 'avro', label: 'Avro', language: 'json', extension: '.avsc', description: 'Esquema Avro de los registros que viajan por un broker.' },
  'json-schema': { id: 'json-schema', label: 'JSON Schema', language: 'json', extension: '.json', description: 'Esquema JSON que valida la estructura de un mensaje.' },
  wsdl: { id: 'wsdl', label: 'WSDL (XML)', language: 'xml', extension: '.wsdl', description: 'Descripción de un servicio web SOAP.' },
  cloudevents: { id: 'cloudevents', label: 'CloudEvents (JSON)', language: 'json', extension: '.json', description: 'Evento en estructura JSON de CloudEvents 1.0 (o un lote de eventos).' },
  mcp: { id: 'mcp', label: 'MCP (JSON)', language: 'json', extension: '.json', description: 'Manifiesto de un servidor MCP: herramientas, recursos y prompts.' },
  other: { id: 'other', label: 'Otro', language: 'text', extension: '.txt', description: 'Texto libre sin comprobaciones de formato.' },
};

interface FormatHandler {
  check(text: string): AttachmentDiagnostic[];
  reformat(text: string, context: { name: string }): AttachmentTextResult;
  summarize(text: string): string[];
  template(name: string): string;
}

const HANDLERS: Record<ContractFormat, FormatHandler> = {
  openapi: { check: checkOpenApi, reformat: reformatOpenApi, summarize: summarizeOpenApi, template: openApiTemplate },
  asyncapi: { check: checkAsyncApi, reformat: reformatAsyncApi, summarize: summarizeAsyncApi, template: asyncApiTemplate },
  graphql: { check: checkGraphql, reformat: reformatGraphql, summarize: summarizeGraphql, template: graphqlTemplate },
  protobuf: { check: checkProto, reformat: reformatProto, summarize: summarizeProto, template: protoTemplate },
  avro: { check: checkAvro, reformat: reformatAvro, summarize: summarizeAvro, template: avroTemplate },
  'json-schema': { check: checkJsonSchema, reformat: reformatJsonSchema, summarize: summarizeJsonSchema, template: jsonSchemaTemplate },
  wsdl: { check: checkWsdl, reformat: reformatWsdl, summarize: summarizeWsdl, template: wsdlTemplate },
  cloudevents: { check: checkCloudEvent, reformat: reformatCloudEvent, summarize: summarizeCloudEvent, template: cloudEventTemplate },
  mcp: { check: checkMcp, reformat: reformatMcp, summarize: summarizeMcp, template: mcpTemplate },
  other: { check: () => [], reformat: (text) => ({ ok: true, text }), summarize: () => [], template: () => '' },
};

const EMPTY_CONTRACT = 'El contrato no tiene contenido.';

function crashMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function contractTemplate(format: ContractFormat, name: string): string {
  return HANDLERS[format].template(name);
}

export function checkContract(format: ContractFormat, text: string): AttachmentDiagnostic[] {
  if (text.trim() === '') return [{ severity: 'info', message: EMPTY_CONTRACT }];
  try {
    return sortDiagnostics(HANDLERS[format].check(text));
  } catch (error) {
    return [{ severity: 'error', message: `No se pudo analizar el contrato: ${crashMessage(error)}` }];
  }
}

export function reformatContract(format: ContractFormat, text: string, context: { name: string }): AttachmentTextResult {
  if (format !== 'other' && text.trim() === '') return { ok: false, reason: EMPTY_CONTRACT };
  try {
    return HANDLERS[format].reformat(text, context);
  } catch (error) {
    return { ok: false, reason: `No se pudo formatear el contrato: ${crashMessage(error)}` };
  }
}

export function summarizeContract(format: ContractFormat, text: string): string[] {
  if (text.trim() === '') return [];
  try {
    return HANDLERS[format].summarize(text);
  } catch {
    return [];
  }
}

export interface ContractTransform {
  id: string;
  label: string;
  formats: ContractFormat[];
  run(text: string, context: { name: string; format: ContractFormat }): AttachmentTextResult;
}

function convert(text: string, format: ContractFormat, target: 'json' | 'yaml'): AttachmentTextResult {
  if (text.trim() === '') return { ok: false, reason: EMPTY_CONTRACT };
  try {
    return convertStructured(text, target, format === 'openapi' ? OPENAPI_ROOT_ORDER : undefined);
  } catch (error) {
    return { ok: false, reason: `No se pudo convertir el contrato: ${crashMessage(error)}` };
  }
}

export const CONTRACT_TRANSFORMS: ContractTransform[] = [
  { id: 'to-yaml', label: 'Convertir a YAML', formats: ['openapi', 'asyncapi'], run: (text, context) => convert(text, context.format, 'yaml') },
  { id: 'to-json', label: 'Convertir a JSON', formats: ['openapi', 'asyncapi'], run: (text, context) => convert(text, context.format, 'json') },
];
