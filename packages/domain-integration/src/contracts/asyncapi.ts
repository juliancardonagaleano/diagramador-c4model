import type { AttachmentDiagnostic, AttachmentTextResult } from '@iark/kernel';
import { isRecord, prettyJson } from './json';
import { Reporter, checkInfo, checkLocalRefs, failureDiagnostic, parseStructured, reformatStructured, resolveLocalRef, slugify } from './shared';

export function checkAsyncApi(text: string): AttachmentDiagnostic[] {
  const parsed = parseStructured(text, true);
  if (!parsed.ok) return failureDiagnostic(parsed);
  const report = new Reporter(parsed.locate);
  const doc = parsed.value;
  if (!isRecord(doc)) {
    report.error('El documento AsyncAPI debe ser un objeto (mapa) en la raíz.', []);
    return report.diagnostics;
  }

  const { asyncapi } = doc;
  if (asyncapi === undefined) report.error('Falta el campo «asyncapi» (p. ej. "3.0.0").', []);
  else if (typeof asyncapi !== 'string' || !/^[23]\.\d+\.\d+/.test(asyncapi)) {
    const hint = typeof asyncapi === 'number' ? ' En YAML, ponla entre comillas.' : '';
    report.error(`«asyncapi» debe ser una versión 2.x o 3.x (p. ej. "3.0.0") y es ${JSON.stringify(asyncapi)}.${hint}`, ['asyncapi']);
  }

  checkInfo(doc.info, report);

  const { channels } = doc;
  if (channels === undefined) report.warning('Falta «channels»: el contrato no describe ningún canal.', []);
  else if (!isRecord(channels)) report.error('«channels» debe ser un objeto cuyas claves son los canales.', ['channels']);
  else if (Object.keys(channels).length === 0) report.info('«channels» está vacío.', ['channels']);

  if (typeof asyncapi === 'string' && asyncapi.startsWith('3')) checkOperations(doc.operations, report);
  checkLocalRefs(doc, report);
  return report.diagnostics;
}

function checkOperations(operations: unknown, report: Reporter): void {
  if (operations === undefined) return;
  if (!isRecord(operations)) {
    report.error('«operations» debe ser un objeto cuyas claves son las operaciones.', ['operations']);
    return;
  }
  for (const [id, operation] of Object.entries(operations)) {
    const path = ['operations', id];
    if (!isRecord(operation)) {
      report.error(`La operación «${id}» debe ser un objeto.`, path);
      continue;
    }
    if (operation.action !== 'send' && operation.action !== 'receive') report.error(`La operación «${id}» debe tener action: "send" o "receive".`, path);
    if (operation.channel === undefined) report.error(`La operación «${id}» no indica su «channel».`, path);
  }
}

export function reformatAsyncApi(text: string): AttachmentTextResult {
  return reformatStructured(text, { yaml: true });
}

export function summarizeAsyncApi(text: string): string[] {
  const parsed = parseStructured(text, true);
  if (!parsed.ok || !isRecord(parsed.value)) return [];
  const doc = parsed.value;
  const lines: string[] = [];

  if (isRecord(doc.operations)) {
    for (const [id, operation] of Object.entries(doc.operations)) {
      if (!isRecord(operation)) continue;
      const ref = isRecord(operation.channel) && typeof operation.channel.$ref === 'string' ? operation.channel.$ref : undefined;
      const channel = ref ? resolveLocalRef(doc, ref) : undefined;
      const address = isRecord(channel) && typeof channel.address === 'string' ? channel.address : ref?.split('/').pop();
      lines.push(`${String(operation.action ?? '?').toUpperCase()} ${address ?? '?'} — ${id}`);
    }
    return lines;
  }
  if (isRecord(doc.channels)) {
    for (const [name, channel] of Object.entries(doc.channels)) {
      if (!isRecord(channel)) continue;
      for (const action of ['publish', 'subscribe'] as const) {
        const operation = channel[action];
        if (!isRecord(operation)) continue;
        const id = typeof operation.operationId === 'string' ? ` — ${operation.operationId}` : '';
        lines.push(`${action.toUpperCase()} ${name}${id}`);
      }
    }
  }
  return lines;
}

export function asyncApiTemplate(name: string): string {
  const slug = slugify(name, 'eventos');
  return prettyJson({
    asyncapi: '3.0.0',
    info: { title: name.trim() || 'Eventos', version: '1.0.0' },
    channels: {
      recursoCreado: {
        address: `${slug}.recurso.creado`,
        messages: { recursoCreado: { $ref: '#/components/messages/recursoCreado' } },
      },
    },
    operations: {
      publicarRecursoCreado: {
        action: 'send',
        channel: { $ref: '#/channels/recursoCreado' },
      },
    },
    components: {
      messages: {
        recursoCreado: {
          name: 'RecursoCreado',
          contentType: 'application/json',
          payload: {
            type: 'object',
            properties: { id: { type: 'string' }, creado: { type: 'string', format: 'date-time' } },
            required: ['id'],
          },
        },
      },
    },
  });
}
