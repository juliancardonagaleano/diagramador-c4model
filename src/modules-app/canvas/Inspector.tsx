import { useEffect, useState } from 'react';
import { formatUrn, type EditorSpec, type EntityRef, type FieldSpec } from '@iark/kernel';
import type { Backlink } from '../links';
import { resolveRef } from '../links';

/** Lo que el banco de trabajo sabe de los demás módulos, para enlazar sin escribir URN a mano. */
export interface LinkTools {
  modules: Array<{ id: string; label: string }>;
  entities(moduleId: string): Promise<EntityRef[]>;
  backlinks(moduleId: string, elementId: string): Promise<Backlink[]>;
  follow(urn: string): void;
}

interface Props {
  spec: EditorSpec<unknown>;
  document: unknown;
  id: string;
  readOnly: boolean;
  /** Módulo del documento que se edita (para los enlaces entrantes). */
  moduleId?: string;
  links?: LinkTools;
  onPatch(id: string, patch: Record<string, unknown>): void;
  onRemove(id: string): void;
}

function RefPicker({ value, readOnly, links, onCommit }: { value: string; readOnly: boolean; links: LinkTools; onCommit(value: string): void }) {
  const current = resolveRef(value);
  const [moduleId, setModuleId] = useState(current?.moduleId ?? '');
  const [entities, setEntities] = useState<EntityRef[]>([]);
  useEffect(() => {
    setModuleId(current?.moduleId ?? '');
  }, [current?.moduleId]);
  useEffect(() => {
    if (!moduleId) return void setEntities([]);
    let alive = true;
    void links.entities(moduleId).then((list) => alive && setEntities(list));
    return () => {
      alive = false;
    };
  }, [moduleId, links]);
  return (
    <div className="cv-field" data-testid="ref-picker">
      <label htmlFor="cv-f-ref-module">Enlace a otro módulo</label>
      <div className="cv-ref-row">
        <select id="cv-f-ref-module" value={moduleId} disabled={readOnly} onChange={(e) => (setModuleId(e.target.value), e.target.value === '' && onCommit(''))} aria-label="Módulo enlazado">
          <option value="">—</option>
          {links.modules.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <select value={current?.moduleId === moduleId ? current.elementId : ''} disabled={readOnly || !moduleId} onChange={(e) => e.target.value && onCommit(formatUrn(moduleId, e.target.value))} aria-label="Elemento enlazado">
          <option value="">{moduleId ? (entities.length ? 'Elige un elemento' : 'Sin elementos') : '—'}</option>
          {entities.map((en) => (
            <option key={en.id} value={en.id}>
              {en.name} ({en.kind})
            </option>
          ))}
        </select>
        {current && (
          <button type="button" className="cv-tool" onClick={() => links.follow(current.urn)} title={`Ir a ${current.urn} (doble clic o Alt+↓)`} data-testid="follow-ref">
            Ir ⤷
          </button>
        )}
      </div>
      <small className="cv-hint">{value || 'Sin enlace'}</small>
    </div>
  );
}

function Backlinks({ moduleId, elementId, links }: { moduleId: string; elementId: string; links: LinkTools }) {
  const [items, setItems] = useState<Backlink[] | undefined>();
  useEffect(() => {
    let alive = true;
    setItems(undefined);
    void links.backlinks(moduleId, elementId).then((list) => alive && setItems(list));
    return () => {
      alive = false;
    };
  }, [moduleId, elementId, links]);
  if (!items || items.length === 0) return null;
  return (
    <div className="cv-field" data-testid="backlinks">
      <label>Referenciado por</label>
      <ul className="cv-backlinks">
        {items.map((b) => (
          <li key={b.urn}>
            <button type="button" className="cv-tool" onClick={() => links.follow(b.urn)} title={`Ir a ${b.urn}`}>
              {b.moduleLabel}: {b.name} <small>({b.kind})</small> ⤷
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
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
export function Inspector({ spec, document, id, readOnly, moduleId, links, onPatch, onRemove }: Props) {
  const item = spec.read(document, id);
  if (!item) return <div className="cv-inspector cv-empty">Selecciona un elemento o una relación para ver sus propiedades.</div>;
  const notation = item.type === 'node' ? spec.nodeKinds.find((k) => k.kind === item.kind) : spec.edgeKinds.find((k) => k.kind === item.kind);
  const fields = spec.fields({ type: item.type, kind: item.kind }, document);
  return (
    <aside className="cv-inspector" aria-label="Propiedades" data-testid="inspector">
      <h3>
        {notation?.label ?? item.kind} <small>{id}</small>
      </h3>
      {fields.map((f) =>
        f.key === 'ref' && links ? (
          <RefPicker key={`${id}:ref`} value={typeof item.values.ref === 'string' ? item.values.ref : ''} readOnly={readOnly} links={links} onCommit={(value) => onPatch(id, { ref: value })} />
        ) : (
          <Field key={`${id}:${f.key}`} field={f} value={item.values[f.key]} readOnly={readOnly} onCommit={(value) => onPatch(id, { [f.key]: value })} />
        ),
      )}
      {links && moduleId && item.type === 'node' && <Backlinks moduleId={moduleId} elementId={id} links={links} />}
      {!readOnly && (
        <button type="button" className="cv-danger" onClick={() => onRemove(id)}>
          Borrar (Supr)
        </button>
      )}
    </aside>
  );
}
