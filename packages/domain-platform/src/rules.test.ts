import { describe, expect, it } from 'vitest';
import example from '../../../examples/plataforma-ejemplo.json';
import { platformEditor } from './editor';
import { platformModule } from './module';
import { dependencyEnvironmentViolation, exposureViolation, placementViolation } from './rules';
import type { PlatformDocument } from './types';

const doc = platformModule.schema.parse(example) as PlatformDocument;

describe('reglas de colocación y conexión', () => {
  it('bases, cachés y colas no van en una red pública; un balanceador sí', () => {
    expect(placementViolation(doc, 'database', 'subred-publica')).toMatch(/pública/);
    expect(placementViolation(doc, 'queue', 'subred-publica')).toMatch(/pública/);
    expect(placementViolation(doc, 'database', 'subred-datos')).toBeUndefined();
    expect(placementViolation(doc, 'load-balancer', 'subred-publica')).toBeUndefined();
    expect(placementViolation(doc, 'database', undefined)).toBeUndefined();
  });

  it('el editor rechaza crear o mover un dato a una red pública y hacer pública la red que ya los contiene', () => {
    const added = platformEditor.addNode(doc, 'database', 'Caché web', 'subred-publica', 'env:prod');
    expect(added).toMatchObject({ ok: false });
    expect(platformEditor.update(doc, 'pedidos-db-prod', { networkId: 'subred-publica' })).toMatchObject({ ok: false });
    expect(platformEditor.update(doc, 'pedidos-db-prod', { networkId: 'subred-apps' })).toMatchObject({ ok: true });
    expect(exposureViolation(doc, 'subred-datos', 'public')).toMatch(/Base de pedidos/);
    expect(platformEditor.update(doc, 'subred-datos', { exposure: 'public' })).toMatchObject({ ok: false });
    expect(platformEditor.update(doc, 'subred-publica', { exposure: 'private' })).toMatchObject({ ok: true });
  });

  it('un documento que ya incumple la regla sigue editándose si no se toca la red ni la clase', () => {
    const bad = { ...doc, resources: doc.resources.map((r) => (r.id === 'pedidos-db-prod' ? { ...r, networkId: 'subred-publica' } : r)) };
    expect(platformEditor.update(bad, 'pedidos-db-prod', { technology: 'MySQL' })).toMatchObject({ ok: true });
  });

  it('una dependencia no cruza entornos: un servicio solo depende de recursos de donde corre', () => {
    expect(dependencyEnvironmentViolation(doc, 'pedidos-db-dev', 'kafka-prod')).toMatch(/no cruza entornos/);
    expect(dependencyEnvironmentViolation(doc, 'pedidos', 'kafka-prod')).toBeUndefined();
    expect(dependencyEnvironmentViolation(doc, 'pedidos', 'pasarela-pagos')).toBeUndefined();
    expect(platformEditor.canConnect!(doc, 'data', 'pedidos-db-dev', 'kafka-prod')).toMatch(/no cruza entornos/);
    // La instancia de producción de un servicio tampoco usa recursos de desarrollo, aunque el servicio corra en ambos.
    expect(platformEditor.canConnect!(doc, 'messages', 'i:reportes-prod', 'kafka-dev')).toMatch(/no cruza entornos/);
    expect(platformEditor.canConnect!(doc, 'messages', 'reportes', 'kafka-dev')).toBeUndefined();
  });

  it('una instancia solo corre en anfitriones de su entorno y no en uno dado de baja', () => {
    expect(platformEditor.canConnect!(doc, 'runs-on', 'i:reportes-prod', 'k8s-dev')).toMatch(/Promover a otro entorno/);
    const decommissioned = { ...doc, resources: doc.resources.map((r) => (r.id === 'k8s-dev' ? { ...r, status: 'decommissioned' as const } : r)) };
    expect(platformEditor.canConnect!(decommissioned, 'runs-on', 'tienda-web', 'k8s-dev')).toMatch(/dado de baja/);
  });
});
