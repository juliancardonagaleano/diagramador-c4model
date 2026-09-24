import { Button, Empty, Input, Select } from '@douyinfe/semi-ui';
import { IconDelete, IconPlus, IconTreeTriangleDown, IconTreeTriangleRight } from '@douyinfe/semi-icons';
import { useEffect, useState } from 'react';
import type { C4Relationship } from '../../../core/model/types';
import { useDocumentStore } from '../../store/documentStore';

function RelationshipCard({ rel, selected }: { rel: C4Relationship; selected: boolean }) {
  const doc = useDocumentStore((s) => s.doc);
  const readOnly = useDocumentStore((s) => s.readOnly);
  const { updateRelationship, removeRelationship, select } = useDocumentStore.getState();
  const [open, setOpen] = useState(selected);
  const expanded = open || selected;
  const name = (id: string) => doc.model.elements.find((e) => e.id === id)?.name ?? id;
  const options = doc.model.elements.map((e) => ({ value: e.id, label: e.name }));
  return (
    <div className={`c4-card ${selected ? 'is-selected' : ''}`} data-relationship-id={rel.id}>
      <div
        className="c4-card-header"
        onClick={() => {
          setOpen(!expanded);
          select({ kind: 'relationship', id: rel.id });
        }}
      >
        {expanded ? <IconTreeTriangleDown size="small" /> : <IconTreeTriangleRight size="small" />}
        <span className="truncate flex-1 text-sm">
          <span className="font-medium">{name(rel.sourceId)}</span> <span className="text-color-3">→</span> <span className="font-medium">{name(rel.targetId)}</span>
        </span>
        {rel.description && <span className="text-xs text-color-3 truncate max-w-[40%]">{rel.description}</span>}
      </div>
      {expanded && (
        <div className="c4-card-body">
          <div className="c4-field">
            <label>Origen</label>
            <Select size="small" className="w-full" value={rel.sourceId} optionList={options} disabled={readOnly} filter onChange={(v) => updateRelationship(rel.id, { sourceId: v as string })} />
          </div>
          <div className="c4-field">
            <label>Destino</label>
            <Select size="small" className="w-full" value={rel.targetId} optionList={options} disabled={readOnly} filter onChange={(v) => updateRelationship(rel.id, { targetId: v as string })} />
          </div>
          <div className="c4-field">
            <label>Descripción</label>
            <Input size="small" value={rel.description ?? ''} placeholder="p. ej. Consulta saldos en" disabled={readOnly} onChange={(v) => updateRelationship(rel.id, { description: v })} />
          </div>
          <div className="c4-field">
            <label>Tecnología</label>
            <Input size="small" value={rel.technology ?? ''} placeholder="p. ej. HTTPS/JSON" disabled={readOnly} onChange={(v) => updateRelationship(rel.id, { technology: v })} />
          </div>
          <div className="flex justify-between items-center">
            <span className="text-xs text-color-3 font-mono">id: {rel.id}</span>
            <Button size="small" type="danger" theme="light" icon={<IconDelete />} disabled={readOnly} onClick={() => removeRelationship(rel.id)}>
              Eliminar
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function RelationshipsTab() {
  const doc = useDocumentStore((s) => s.doc);
  const selection = useDocumentStore((s) => s.selection);
  const readOnly = useDocumentStore((s) => s.readOnly);
  const addRelationship = useDocumentStore((s) => s.addRelationship);
  const [source, setSource] = useState<string | undefined>();
  const [target, setTarget] = useState<string | undefined>();
  const options = doc.model.elements.map((e) => ({ value: e.id, label: e.name }));

  useEffect(() => {
    if (selection.kind !== 'relationship') return;
    document.querySelector(`[data-relationship-id="${CSS.escape(selection.id)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selection]);

  return (
    <div className="p-3 space-y-2">
      <div className="flex gap-2 items-center">
        <Select size="small" placeholder="Origen" className="flex-1" value={source} optionList={options} filter onChange={(v) => setSource(v as string)} disabled={readOnly} />
        <span className="text-color-3">→</span>
        <Select size="small" placeholder="Destino" className="flex-1" value={target} optionList={options} filter onChange={(v) => setTarget(v as string)} disabled={readOnly} />
        <Button
          icon={<IconPlus />}
          theme="solid"
          size="small"
          disabled={readOnly || !source || !target || source === target}
          onClick={() => {
            if (source && target) addRelationship(source, target);
          }}
        />
      </div>
      <p className="text-xs text-color-3">También puedes arrastrar desde el punto de conexión de un nodo hasta otro en el lienzo.</p>
      {doc.model.relationships.length === 0 ? (
        <Empty description="Aún no hay relaciones" className="py-6" />
      ) : (
        doc.model.relationships.map((r) => <RelationshipCard key={r.id} rel={r} selected={selection.kind === 'relationship' && selection.id === r.id} />)
      )}
    </div>
  );
}
