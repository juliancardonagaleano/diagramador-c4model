import { currencyOf, type PlatformDocument } from './types';

/** Una partida de coste mensual: un recurso o una instancia desplegada. */
export interface CostLine {
  /** Id del recurso o del despliegue. */
  id: string;
  kind: 'resource' | 'deployment';
  name: string;
  amount: number;
}

export interface EnvironmentCost {
  environmentId: string;
  total: number;
  lines: CostLine[];
}

/** Coste mensual de cada entorno: lo que cuestan sus recursos más sus instancias desplegadas. Solo los entornos con alguna partida. */
export function costsByEnvironment(doc: PlatformDocument): EnvironmentCost[] {
  const services = new Map(doc.services.map((s) => [s.id, s]));
  return doc.environments
    .map((environment): EnvironmentCost => {
      const lines: CostLine[] = [
        ...doc.resources.filter((r) => r.environmentId === environment.id && r.monthlyCost !== undefined).map((r): CostLine => ({ id: r.id, kind: 'resource', name: r.name, amount: r.monthlyCost! })),
        ...doc.deployments
          .filter((d) => d.environmentId === environment.id && d.monthlyCost !== undefined)
          .map((d): CostLine => ({ id: d.id, kind: 'deployment', name: services.get(d.serviceId)?.name ?? d.serviceId, amount: d.monthlyCost! })),
      ];
      return { environmentId: environment.id, total: lines.reduce((sum, l) => sum + l.amount, 0), lines };
    })
    .filter((e) => e.lines.length > 0);
}

export const hasCosts = (doc: PlatformDocument): boolean => doc.resources.some((r) => r.monthlyCost !== undefined) || doc.deployments.some((d) => d.monthlyCost !== undefined);

/** «1.250 EUR/mes»: miles con punto y hasta dos decimales con coma, sin depender de la configuración regional. */
export function formatCost(amount: number, doc: PlatformDocument): string {
  const [whole, decimals] = (Math.round(amount * 100) / 100).toString().split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${grouped}${decimals ? `,${decimals}` : ''} ${currencyOf(doc)}/mes`;
}
