import { useSyncExternalStore } from 'react';
import type { WorkbenchController, WorkbenchState } from './controller';

/**
 * Barra del proyecto abierto: cuál es, qué diagrama se está editando, cómo va el guardado y cómo abrir el gestor.
 * Con un diagrama abierto, sus cambios se guardan solos; sin él, el documento es un borrador y se ofrece guardarlo.
 */
export function ProjectBar({ controller, state, onManage, notify }: { controller: WorkbenchController; state: WorkbenchState; onManage(): void; notify(message: string): void }) {
  const session = controller.projects!;
  const projects = useSyncExternalStore(session.subscribe, session.getState);
  const project = projects.projects.find((p) => p.id === projects.projectId);
  const moduleLabel = (id: string): string => controller.sources.find((s) => s.id === id)?.label ?? id;
  const attached = project?.diagrams.find((d) => d.id === projects.diagramId);
  const draft = !!project && !attached && !!controller.currentDocument();
  const run = (work: () => Promise<void>): void => void work().catch((error: Error) => notify(error.message));

  const byModule = new Map<string, NonNullable<typeof project>['diagrams']>();
  for (const d of project?.diagrams ?? []) byModule.set(d.module, [...(byModule.get(d.module) ?? []), d]);

  return (
    <div className="wb-projectbar" role="region" aria-label="Proyecto" data-testid="project-bar">
      <label>
        Proyecto
        <select aria-label="Proyecto" value={projects.projectId ?? ''} onChange={(e) => run(() => controller.enterProject(e.target.value || undefined))} disabled={!projects.available}>
          <option value="">Sin proyecto (borrador)</option>
          {projects.projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {project && (
        <label>
          Diagrama
          <select
            aria-label="Diagrama"
            value={attached?.id ?? ''}
            onChange={(e) => e.target.value && run(() => controller.openDiagram(project.id, e.target.value))}
            disabled={project.diagrams.length === 0 && !draft}
          >
            {!attached && <option value="">{project.diagrams.length === 0 ? 'Sin diagramas todavía' : 'Borrador (sin guardar en el proyecto)'}</option>}
            {[...byModule].map(([module, list]) => (
              <optgroup key={module} label={moduleLabel(module)}>
                {list.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
      )}
      <button type="button" onClick={onManage} disabled={!projects.available && projects.projects.length === 0 && !projects.error}>
        Proyectos…
      </button>
      {draft && project && (
        <button type="button" className="primary" onClick={() => run(() => controller.saveToProject())} data-testid="save-to-project">
          Guardar en «{project.name}»
        </button>
      )}
      <span className="wb-save" role="status" data-testid="save-status" data-save={attached ? projects.save : draft ? 'draft' : 'none'}>
        {!projects.available
          ? 'Almacenamiento no disponible'
          : attached
            ? projects.save === 'pending' || projects.save === 'saving'
              ? 'Guardando…'
              : projects.save === 'error'
                ? `No se pudo guardar: ${projects.saveError ?? 'error desconocido'}`
                : projects.save === 'conflict'
                  ? 'Hay un conflicto de guardado'
                  : `Guardado en «${project?.name}»`
            : draft
              ? 'Borrador: aún no está en el proyecto'
              : ''}
      </span>
      {attached && projects.save === 'error' && (
        <button type="button" onClick={() => run(() => session.retry())}>
          Reintentar
        </button>
      )}
      {attached && projects.save === 'conflict' && (
        <span className="wb-conflict" role="alert" data-testid="save-conflict">
          Otra pestaña guardó «{attached.name}» mientras lo editabas.
          <button type="button" onClick={() => run(() => controller.resolveConflict('overwrite'))}>
            Quedarme con mi versión
          </button>
          <button type="button" onClick={() => run(() => controller.resolveConflict('reload'))}>
            Cargar la otra
          </button>
        </span>
      )}
      {state.replaced && (
        <span className="wb-conflict" role="status" data-testid="replaced-note">
          Se reemplazó el contenido de «{state.replaced.label}».
          <button type="button" onClick={() => controller.undoReplace()} data-testid="undo-replace">
            Deshacer
          </button>
          <button type="button" onClick={() => controller.dismissReplaced()} aria-label="Descartar aviso">
            ✕
          </button>
        </span>
      )}
    </div>
  );
}
