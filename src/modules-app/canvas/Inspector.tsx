import { useEffect, useState } from 'react';
import type { EditorSpec, FieldSpec } from '@iark/kernel';

interface Props {
  spec: EditorSpec<unknown>;
  document: unknown;
  id: string;
  readOnly: boolean;
  onPatch(id: string, patch: Record<string, unknown>): void;
  onRemove(id: string): void;
}

const asText = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const asList = (v: unknown): string => (Array.isArray(v) ? v.join(', ') : '');

function Field({ field, value, readOnly, onCommit }: { field: FieldSpec; value: unknown; readOnly: boolean; onCommit(value: unknown): void }) {
  const [draft, setDraft] = useState(field.type === 'list' ? asList(value) : asText(value));
  useEffect(() => setDraft(field.type === 'list' ? asList(value) : asText(value)), [value, field.type]);
  const id = `cv-f-${field.key}`;

  if (field.type === 'boolean') {
    return (
      <label className="cv-field cv-check" htmlFor={id}>
        <input id={id} type="checkbox" checked={value === true} disabled={readOnly} onChange={(e) => onCommit(e.target.checked ? true : undefined)} />
        {field.label}
      </label>
    );
  }
  if (field.type === 'select') {
    return (
      <div className="cv-field">
        <label htmlFor={id}>{field.label}</label>
        <select id={id} value={asText(value)} disabled={readOnly} onChange={(e) => onCommit(e.target.value)}>
          {field.allowEmpty && <option value="">—</option>}
          {field.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
    );
  }
  const commit = (): void => {
    if (field.type === 'list') {
      const list = draft
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (list.join(',') !== asList(value).replace(/, /g, ',')) onCommit(list);
    } else if (draft !== asText(value)) onCommit(draft);
  };
  return (
    <div className="cv-field">
      <label htmlFor={id}>{field.label}</label>
      {field.type === 'longtext' ? (
        <textarea id={id} rows={3} value={draft} readOnly={readOnly} onChange={(e) => setDraft(e.target.value)} onBlur={commit} />
      ) : (
        <input id={id} type="text" value={draft} readOnly={readOnly} placeholder={field.hint} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
      )}
    </div>
  );
}

/** Panel de propiedades común: los campos de cada tipo los declara el módulo (`EditorSpec.fields`). */
export function Inspector({ spec, document, id, readOnly, onPatch, onRemove }: Props) {
  const item = spec.read(document, id);
  if (!item) return <div className="cv-inspector cv-empty">Selecciona un elemento o una relación para ver sus propiedades.</div>;
  const notation = item.type === 'node' ? spec.nodeKinds.find((k) => k.kind === item.kind) : spec.edgeKinds.find((k) => k.kind === item.kind);
  const fields = spec.fields({ type: item.type, kind: item.kind }, document);
  return (
    <aside className="cv-inspector" aria-label="Propiedades" data-testid="inspector">
      <h3>
        {notation?.label ?? item.kind} <small>{id}</small>
      </h3>
      {fields.map((f) => (
        <Field key={`${id}:${f.key}`} field={f} value={item.values[f.key]} readOnly={readOnly} onCommit={(value) => onPatch(id, { [f.key]: value })} />
      ))}
      {!readOnly && (
        <button type="button" className="cv-danger" onClick={() => onRemove(id)}>
          Borrar (Supr)
        </button>
      )}
    </aside>
  );
}
