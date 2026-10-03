import { ProjectError } from './errors';
import { cleanName, requireModuleId, sameName, uniqueSlug } from './names';
import type { Diagram, DiagramMeta, ProjectStore, ProjectSummary, SaveDiagramInput } from './types';

interface StoredProject {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  diagrams: Map<string, Diagram>;
}

const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || (a.name < b.name ? -1 : 1);

const meta = ({ id, module, name, createdAt, updatedAt }: Diagram): DiagramMeta => ({ id, module, name, createdAt, updatedAt });

/**
 * Almacén en memoria: la referencia del contrato de `ProjectStore` (los demás almacenes deben comportarse igual) y lo que
 * usan las pruebas y los anfitriones sin almacenamiento persistente.
 */
export class MemoryProjectStore implements ProjectStore {
  readonly kind = 'memory';
  private readonly projects = new Map<string, StoredProject>();
  private counter = 0;

  constructor(private readonly clock: () => Date = () => new Date()) {}

  private now(): string {
    // Estrictamente creciente aunque el reloj no avance entre dos llamadas seguidas (las pruebas y los guardados rápidos).
    const stamp = this.clock().getTime();
    this.last = Math.max(stamp, this.last + 1);
    return new Date(this.last).toISOString();
  }
  private last = 0;

  private project(id: string): StoredProject {
    const project = this.projects.get(id);
    if (!project) throw new ProjectError('not-found', `No existe el proyecto «${id}».`);
    return project;
  }

  private summary(project: StoredProject): ProjectSummary {
    return {
      id: project.id,
      name: project.name,
      ...(project.description ? { description: project.description } : {}),
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      diagrams: [...project.diagrams.values()].map(meta).sort(byName),
    };
  }

  async listProjects(): Promise<ProjectSummary[]> {
    return [...this.projects.values()].map((p) => this.summary(p)).sort(byName);
  }

  async getProject(id: string): Promise<ProjectSummary | undefined> {
    const project = this.projects.get(id);
    return project ? this.summary(project) : undefined;
  }

  async createProject(input: { name: string; description?: string }): Promise<ProjectSummary> {
    const name = cleanName(input.name, 'del proyecto');
    if ([...this.projects.values()].some((p) => sameName(p.name, name))) throw new ProjectError('exists', `Ya existe un proyecto llamado «${name}».`);
    const now = this.now();
    const id = uniqueSlug(`p${++this.counter}`, this.projects.keys());
    const description = input.description?.trim() || undefined;
    const project: StoredProject = { id, name, description, createdAt: now, updatedAt: now, diagrams: new Map() };
    this.projects.set(id, project);
    return this.summary(project);
  }

  async renameProject(id: string, rawName: string): Promise<ProjectSummary> {
    const project = this.project(id);
    const name = cleanName(rawName, 'del proyecto');
    if ([...this.projects.values()].some((p) => p.id !== id && sameName(p.name, name))) throw new ProjectError('exists', `Ya existe un proyecto llamado «${name}».`);
    project.name = name;
    project.updatedAt = this.now();
    return this.summary(project);
  }

  async deleteProject(id: string): Promise<void> {
    this.project(id);
    this.projects.delete(id);
  }

  async getDiagram(projectId: string, diagramId: string): Promise<Diagram | undefined> {
    const diagram = this.project(projectId).diagrams.get(diagramId);
    return diagram ? { ...diagram } : undefined;
  }

  async saveDiagram(projectId: string, input: SaveDiagramInput): Promise<DiagramMeta> {
    const project = this.project(projectId);
    if (typeof input.text !== 'string') throw new ProjectError('invalid', 'El documento del diagrama debe ser un texto.');
    const now = this.now();
    if (input.id !== undefined) {
      const current = project.diagrams.get(input.id);
      if (!current) throw new ProjectError('not-found', `No existe el diagrama «${input.id}» en el proyecto «${project.name}».`);
      if (input.module !== undefined && input.module !== current.module) throw new ProjectError('invalid', `Un diagrama no cambia de módulo (es de «${current.module}»).`);
      if (input.ifUpdatedAt !== undefined && input.ifUpdatedAt !== current.updatedAt) {
        throw new ProjectError('conflict', `El diagrama «${current.name}» cambió desde que se abrió (otra pestaña o proceso lo guardó).`);
      }
      const updated: Diagram = { ...current, text: input.text, updatedAt: now };
      project.diagrams.set(current.id, updated);
      project.updatedAt = now;
      return meta(updated);
    }
    const module = requireModuleId(input.module);
    const name = cleanName(input.name ?? 'Sin título', 'del diagrama');
    if ([...project.diagrams.values()].some((d) => sameName(d.name, name))) throw new ProjectError('exists', `Ya hay un diagrama llamado «${name}» en el proyecto «${project.name}».`);
    const id = uniqueSlug(`d${++this.counter}`, project.diagrams.keys());
    const created: Diagram = { id, module, name, text: input.text, createdAt: now, updatedAt: now };
    project.diagrams.set(id, created);
    project.updatedAt = now;
    return meta(created);
  }

  async renameDiagram(projectId: string, diagramId: string, rawName: string): Promise<DiagramMeta> {
    const project = this.project(projectId);
    const current = project.diagrams.get(diagramId);
    if (!current) throw new ProjectError('not-found', `No existe el diagrama «${diagramId}» en el proyecto «${project.name}».`);
    const name = cleanName(rawName, 'del diagrama');
    if ([...project.diagrams.values()].some((d) => d.id !== diagramId && sameName(d.name, name))) throw new ProjectError('exists', `Ya hay un diagrama llamado «${name}» en el proyecto «${project.name}».`);
    const now = this.now();
    const updated: Diagram = { ...current, name, updatedAt: now };
    project.diagrams.set(diagramId, updated);
    project.updatedAt = now;
    return meta(updated);
  }

  async deleteDiagram(projectId: string, diagramId: string): Promise<void> {
    const project = this.project(projectId);
    if (!project.diagrams.delete(diagramId)) throw new ProjectError('not-found', `No existe el diagrama «${diagramId}» en el proyecto «${project.name}».`);
    project.updatedAt = this.now();
  }
}
