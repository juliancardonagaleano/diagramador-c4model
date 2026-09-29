import { describe, expect, it } from 'vitest';
import { WorkbenchController } from './controller';
import { resolveRef, SuiteLinks } from './links';
import { MODULE_SOURCES } from './modules';

describe('SuiteLinks', () => {
  it('resuelve URN y encuentra quién apunta a un elemento entre los ejemplos de todos los módulos', async () => {
    expect(resolveRef('urn:iark:integration:pedidos')).toEqual({ moduleId: 'integration', elementId: 'pedidos', urn: 'urn:iark:integration:pedidos' });
    expect(resolveRef('pedidos')).toBeUndefined();
    const controller = new WorkbenchController(MODULE_SOURCES);
    const links = new SuiteLinks(controller);
    const back = await links.backlinks('integration', 'pedidos');
    expect(back.map((b) => `${b.moduleId}:${b.elementId}`).sort()).toEqual(['data:erp', 'platform:pedidos']);
    expect(await links.exists('urn:iark:integration:pedidos')).toBe(true);
    expect(await links.exists('urn:iark:integration:no-existe')).toBe(false);
    expect(await links.exists('urn:iark:otro:x')).toBeUndefined();
    const entities = await links.entities('c4');
    expect(entities.length).toBeGreaterThan(0);
  }, 30000);
});
