import { Button, Tooltip } from '@douyinfe/semi-ui';
import { IconArrowUp } from '@douyinfe/semi-icons';
import { useReactFlow } from '@xyflow/react';
import { useMemo } from 'react';
import { viewBreadcrumb, viewLevel } from '../../../core/model/factories';
import { VIEW_TYPE_LABELS } from '../../../core/model/types';
import { useDocumentStore } from '../../store/documentStore';

/**
 * Barra de navegación entre niveles C4: C1 Contexto › C2 Contenedores › C3 Componentes.
 * Los tramos son clicables; "Subir nivel" vuelve a la vista del nivel superior.
 */
export function Breadcrumb() {
  const doc = useDocumentStore((s) => s.doc);
  const activeViewId = useDocumentStore((s) => s.activeViewId);
  const setActiveView = useDocumentStore((s) => s.setActiveView);
  const drillUp = useDocumentStore((s) => s.drillUp);
  const { fitView } = useReactFlow();

  const chain = useMemo(() => (activeViewId ? viewBreadcrumb(doc, activeViewId) : []), [doc, activeViewId]);
  if (chain.length === 0) return null;
  const current = chain[chain.length - 1];
  const level = viewLevel(current);
  const scopeName = (scopeId?: string) => doc.model.elements.find((e) => e.id === scopeId)?.name;

  return (
    <div className="c4-breadcrumb toolbar-theme border border-color shadow-lg" data-level={level}>
      {chain.map((v, i) => {
        const isCurrent = v.id === current.id;
        const lvl = viewLevel(v);
        const scope = scopeName(v.scopeId);
        return (
          <span key={v.id} className="flex items-center gap-1 min-w-0">
            {i > 0 && <span className="text-color-3">›</span>}
            <button
              type="button"
              className={`c4-crumb ${isCurrent ? 'is-current' : 'hover-2'}`}
              onClick={() => {
                if (!isCurrent) {
                  setActiveView(v.id);
                  setTimeout(() => fitView({ padding: 0.15, duration: 300 }), 80);
                }
              }}
              title={v.title ?? VIEW_TYPE_LABELS[v.type]}
            >
              <span className="c4-crumb-level">{lvl}</span>
              <span className="truncate">{VIEW_TYPE_LABELS[v.type]}</span>
              {scope && <span className="text-color-3 truncate">· {scope}</span>}
            </button>
          </span>
        );
      })}
      {level !== 'C1' && (
        <Tooltip content="Subir nivel (Alt+↑)">
          <Button
            size="small"
            theme="borderless"
            type="tertiary"
            icon={<IconArrowUp />}
            aria-label="Subir nivel"
            onClick={() => {
              if (drillUp()) setTimeout(() => fitView({ padding: 0.15, duration: 300 }), 80);
            }}
          />
        </Tooltip>
      )}
      {level !== 'C3' && <span className="text-xs text-color-3 hidden lg:inline pl-1">Doble clic en un {level === 'C1' ? 'sistema' : 'contenedor'} para bajar de nivel</span>}
    </div>
  );
}
