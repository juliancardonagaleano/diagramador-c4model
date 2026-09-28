import { describe, expect, it } from 'vitest';
import { credentialsHint, resolveModel, resolveProvider } from './client';

describe('resolveProvider', () => {
  it('usa Anthropic por defecto y Foundry cuando el entorno trae variables de Foundry', () => {
    expect(resolveProvider(undefined, {})).toBe('anthropic');
    expect(resolveProvider('auto', { ANTHROPIC_API_KEY: 'k' })).toBe('anthropic');
    expect(resolveProvider('auto', { ANTHROPIC_FOUNDRY_API_KEY: 'k' })).toBe('foundry');
    expect(resolveProvider(undefined, { ANTHROPIC_FOUNDRY_BASE_URL: 'https://x.services.ai.azure.com/anthropic/' })).toBe('foundry');
    expect(resolveProvider(undefined, { ANTHROPIC_FOUNDRY_RESOURCE: 'mi-recurso' })).toBe('foundry');
  });

  it('la elección explícita gana sobre el entorno', () => {
    expect(resolveProvider('anthropic', { ANTHROPIC_FOUNDRY_API_KEY: 'k' })).toBe('anthropic');
    expect(resolveProvider('foundry', {})).toBe('foundry');
  });
});

describe('resolveModel', () => {
  it('prioriza el modelo pedido, luego ANTHROPIC_FOUNDRY_MODEL (solo en Foundry) y luego el valor por defecto', () => {
    const env = { ANTHROPIC_FOUNDRY_MODEL: 'despliegue-sonnet' };
    expect(resolveModel('foundry', 'otro', 'def', env)).toBe('otro');
    expect(resolveModel('foundry', undefined, 'def', env)).toBe('despliegue-sonnet');
    expect(resolveModel('anthropic', undefined, 'def', env)).toBe('def');
    expect(resolveModel('foundry', undefined, 'def', {})).toBe('def');
  });
});

describe('credentialsHint', () => {
  it('nombra las variables de la plataforma correcta', () => {
    expect(credentialsHint('foundry')).toMatch(/ANTHROPIC_FOUNDRY_API_KEY/);
    expect(credentialsHint('anthropic')).toMatch(/ANTHROPIC_API_KEY/);
  });
});

describe('createAiClient', () => {
  it('construye el cliente de Foundry a partir de las variables de entorno', async () => {
    const saved = { key: process.env.ANTHROPIC_FOUNDRY_API_KEY, url: process.env.ANTHROPIC_FOUNDRY_BASE_URL };
    process.env.ANTHROPIC_FOUNDRY_API_KEY = 'clave-de-prueba';
    process.env.ANTHROPIC_FOUNDRY_BASE_URL = 'https://mi-recurso.services.ai.azure.com/anthropic/';
    try {
      const { createAiClient } = await import('./client');
      const client = await createAiClient('foundry');
      expect(client.beta.messages.parse).toBeTypeOf('function');
      expect(client.baseURL).toContain('mi-recurso.services.ai.azure.com');
    } finally {
      if (saved.key === undefined) delete process.env.ANTHROPIC_FOUNDRY_API_KEY;
      else process.env.ANTHROPIC_FOUNDRY_API_KEY = saved.key;
      if (saved.url === undefined) delete process.env.ANTHROPIC_FOUNDRY_BASE_URL;
      else process.env.ANTHROPIC_FOUNDRY_BASE_URL = saved.url;
    }
  });
});
