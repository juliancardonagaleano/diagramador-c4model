import { Button, Dropdown, Empty, Input } from '@douyinfe/semi-ui';
import { IconPlus, IconSearch } from '@douyinfe/semi-icons';
import { useEffect, useMemo, useState } from 'react';
import { ELEMENT_TYPE_LABELS, type ElementType } from '../../../core/model/types';
import { useDocumentStore } from '../../store/documentStore';
import { ElementCard } from './ElementCard';

export function ElementsTab() {
  const doc = useDocumentStore((s) => s.doc);
  const activeViewId = useDocumentStore((s) => s.activeViewId);
  const selection = useDocumentStore((s) => s.selection);
  const readOnly = useDocumentStore((s) => s.readOnly);
  const addElement = useDocumentStore((s) => s.addElement);
  const [query, setQuery] = useState('');
  const [onlyView, setOnlyView] = useState(false);

  const view = doc.views.find((v) => v.id === activeViewId);
  const inView = useMemo(() => new Set(view?.elements.map((e) => e.id) ?? []), [view]);

  const elements = useMemo(() => {
    const q = query.trim().toLowerCase();
    return doc.model.elements.filter((e) => {
      if (onlyView && view && !inView.has(e.id) && view.scopeId !== e.id) return false;
      if (!q) return true;
      return e.name.toLowerCase().includes(q) || e.id.includes(q) || (e.technology ?? '').toLowerCase().includes(q);
    });
  }, [doc, query, onlyView, view, inView]);

  useEffect(() => {
    if (selection.kind !== 'element') return;
    const el = document.querySelector(`[data-element-id="${CSS.escape(selection.id)}"]`);
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selection]);

  return (
    <div className="p-3 space-y-2">
      <div className="flex gap-2">
        <Input prefix={<IconSearch />} placeholder="Buscar elemento…" value={query} onChange={setQuery} showClear className="flex-1" />
        <Dropdown
          trigger="click"
          render={
            <Dropdown.Menu>
              {(Object.keys(ELEMENT_TYPE_LABELS) as ElementType[]).map((t) => (
                <Dropdown.Item key={t} onClick={() => addElement(t)}>
                  {ELEMENT_TYPE_LABELS[t]}
                </Dropdown.Item>
              ))}
            </Dropdown.Menu>
          }
        >
          <Button icon={<IconPlus />} theme="solid" disabled={readOnly}>
            Añadir
          </Button>
        </Dropdown>
      </div>
      {view && (
        <label className="flex items-center gap-2 text-xs text-color-2 select-none cursor-pointer">
          <input type="checkbox" checked={onlyView} onChange={(e) => setOnlyView(e.target.checked)} />
          Solo los de la vista activa ({view.title ?? view.id})
        </label>
      )}
      {elements.length === 0 ? (
        <Empty description={doc.model.elements.length === 0 ? 'Aún no hay elementos. Añade una persona o un sistema.' : 'Sin resultados'} className="py-6" />
      ) : (
        elements.map((e) => <ElementCard key={e.id} element={e} inActiveView={inView.has(e.id)} selected={selection.kind === 'element' && selection.id === e.id} />)
      )}
    </div>
  );
}
