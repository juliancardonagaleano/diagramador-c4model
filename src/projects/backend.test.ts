// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BACKEND_KEY, browserAreas, chooseLocalBackend, forgetBackend, loadBackend, pointerKey, saveBackend, TOKEN_KEY_PREFIX, type StorageAreas } from './backend';

/** Un almacén en memoria con la forma de `Storage`; con `broken` lanza como en una ventana privada o con los datos bloqueados. */
const memory = (broken = false): NonNullable<StorageAreas['local']> & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  const fail = (): never => {
    throw new DOMException('bloqueado', 'SecurityError');
  };
  return {
    data,
    getItem: (key) => (broken ? fail() : (data.get(key) ?? null)),
    setItem: (key, value) => (broken ? fail() : void data.set(key, value)),
    removeItem: (key) => (broken ? fail() : void data.delete(key)),
  };
};
const areas = (): { local: ReturnType<typeof memory>; session: ReturnType<typeof memory> } & StorageAreas => ({ local: memory(), session: memory() });

describe('configuración del almacén (backend)', () => {
  it('sin nada guardado, los proyectos van en este navegador', () => {
    expect(loadBackend(areas())).toEqual({ kind: 'local' });
  });

  it('guarda la dirección y el nombre en localStorage y el token solo en la pestaña (sessionStorage) por omisión', () => {
    const a = areas();
    const result = saveBackend({ url: 'https://iark.ejemplo.org/', token: ' secreto ', label: ' Oficina ' }, {}, a);
    expect(result).toEqual({ saved: true, tokenIn: 'session' });
    expect(JSON.parse(a.local.data.get(BACKEND_KEY)!)).toEqual({ kind: 'remote', url: 'https://iark.ejemplo.org', label: 'Oficina' });
    // el token no está en localStorage (ni en la configuración ni aparte) y sí en la pestaña
    expect([...a.local.data.values()].join('')).not.toContain('secreto');
    expect(a.session.data.get(`${TOKEN_KEY_PREFIX}https://iark.ejemplo.org`)).toBe('secreto');
    expect(loadBackend(a)).toEqual({ kind: 'remote', url: 'https://iark.ejemplo.org', label: 'Oficina', token: 'secreto', remembered: false });
  });

  it('con «Recordar en este equipo» el token va a localStorage, y solo ahí', () => {
    const a = areas();
    expect(saveBackend({ url: 'http://localhost:8787', token: 'abc' }, { remember: true }, a)).toEqual({ saved: true, tokenIn: 'local' });
    expect(a.local.data.get(`${TOKEN_KEY_PREFIX}http://localhost:8787`)).toBe('abc');
    expect(a.session.data.size).toBe(0);
    expect(loadBackend(a)).toMatchObject({ kind: 'remote', token: 'abc', remembered: true });
    // desmarcar la casilla mueve el token (sin pedirlo otra vez): sale de localStorage
    saveBackend({ url: 'http://localhost:8787' }, { remember: false }, a);
    expect(a.local.data.has(`${TOKEN_KEY_PREFIX}http://localhost:8787`)).toBe(false);
    expect(a.session.data.get(`${TOKEN_KEY_PREFIX}http://localhost:8787`)).toBe('abc');
    expect(loadBackend(a)).toMatchObject({ token: 'abc', remembered: false });
  });

  it('un token solo se lee para la dirección a la que pertenece: nunca viaja a otro servidor', () => {
    const a = areas();
    saveBackend({ url: 'https://uno.example', token: 'del-uno' }, {}, a);
    saveBackend({ url: 'https://dos.example' }, {}, a); // sin token
    expect(loadBackend(a)).toEqual({ kind: 'remote', url: 'https://dos.example' });
    // y un token sin dirección (configuración dañada) tampoco se usa
    a.local.data.set(BACKEND_KEY, JSON.stringify({ kind: 'remote', token: 'x' }));
    expect(loadBackend(a)).toEqual({ kind: 'local' });
  });

  it('volver a este navegador conserva el servidor (y su token) para copiar; olvidarlo lo borra todo', () => {
    const a = areas();
    saveBackend({ url: 'https://iark.ejemplo.org', token: 't', label: 'Oficina' }, {}, a);
    expect(chooseLocalBackend(a)).toBe(true);
    expect(loadBackend(a)).toEqual({ kind: 'local', server: { url: 'https://iark.ejemplo.org', label: 'Oficina', token: 't', remembered: false } });
    // recordar un servidor sin activarlo (para «Copiar a…»)
    saveBackend({ url: 'https://otro.example', token: 'o' }, { active: false }, a);
    expect(loadBackend(a)).toMatchObject({ kind: 'local', server: { url: 'https://otro.example', token: 'o' } });
    forgetBackend(a);
    expect(loadBackend(a)).toEqual({ kind: 'local' });
    expect(a.local.data.size).toBe(0);
    expect(a.session.data.has(`${TOKEN_KEY_PREFIX}https://otro.example`)).toBe(false);
  });

  it('una dirección que no es http(s) se rechaza, y una configuración dañada se ignora', () => {
    expect(() => saveBackend({ url: 'ftp://x' }, {}, areas())).toThrow(/http/);
    expect(() => saveBackend({ url: 'no es una dirección' }, {}, areas())).toThrow(/no es una dirección válida/);
    const a = areas();
    a.local.data.set(BACKEND_KEY, '{no es json');
    expect(loadBackend(a)).toEqual({ kind: 'local' });
    a.local.data.set(BACKEND_KEY, JSON.stringify({ kind: 'remote', url: 'ftp://x' }));
    expect(loadBackend(a)).toEqual({ kind: 'local' });
  });

  it('el puntero «último abierto» es una clave por almacén; el local conserva la de siempre', () => {
    expect(pointerKey({ kind: 'local' })).toBe('iark.projects.last');
    expect(pointerKey({ kind: 'local', server: { url: 'https://x.example' } })).toBe('iark.projects.last');
    expect(pointerKey({ kind: 'remote', url: 'https://x.example' })).toBe('iark.projects.last:https://x.example');
  });

  describe('con el almacenamiento bloqueado (ventana privada, datos del sitio bloqueados)', () => {
    it('leer no lanza: vuelve a este navegador', () => {
      expect(loadBackend({ local: memory(true), session: memory(true) })).toEqual({ kind: 'local' });
      expect(loadBackend({})).toEqual({ kind: 'local' });
    });

    it('guardar lo dice con claridad y no deja nada a medias', () => {
      const blocked = { local: memory(true), session: memory(true) };
      const result = saveBackend({ url: 'https://iark.ejemplo.org', token: 't' }, {}, blocked);
      expect(result).toMatchObject({ saved: false, tokenIn: 'none', problem: expect.stringContaining('token') });
      // la pestaña va, pero la configuración no: tampoco se dice «guardado» y el token queda solo en la pestaña
      const onlySession = { local: memory(true), session: memory() };
      const second = saveBackend({ url: 'https://iark.ejemplo.org', token: 't' }, {}, onlySession);
      expect(second).toMatchObject({ saved: false, problem: expect.stringContaining('configuración') });
      // sin token no hace falta sessionStorage
      expect(saveBackend({ url: 'https://iark.ejemplo.org' }, {}, { local: memory(), session: memory(true) }).saved).toBe(true);
      // y «recordar» con localStorage bloqueado no cae en sessionStorage por su cuenta
      const remembered = saveBackend({ url: 'https://iark.ejemplo.org', token: 't' }, { remember: true }, { local: memory(true), session: memory() });
      expect(remembered).toMatchObject({ saved: false, tokenIn: 'none' });
    });

    it('olvidar y volver a este navegador tampoco lanzan', () => {
      const blocked = { local: memory(true), session: memory(true) };
      expect(() => forgetBackend(blocked)).not.toThrow();
      expect(chooseLocalBackend(blocked)).toBe(true);
    });
  });

  describe('almacenes reales del navegador', () => {
    beforeEach(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
    // lo que `window` tenía antes de que una prueba lo sustituya (propio o heredado del prototipo)
    const original = { localStorage: Object.getOwnPropertyDescriptor(window, 'localStorage'), sessionStorage: Object.getOwnPropertyDescriptor(window, 'sessionStorage') };
    afterEach(() => {
      for (const name of ['localStorage', 'sessionStorage'] as const) {
        const descriptor = original[name];
        if (descriptor) Object.defineProperty(window, name, descriptor);
        else delete (window as unknown as Record<string, unknown>)[name];
      }
    });

    it('usa localStorage y sessionStorage de la página', () => {
      saveBackend({ url: 'https://iark.ejemplo.org', token: 'real' });
      expect(localStorage.getItem(BACKEND_KEY)).toContain('iark.ejemplo.org');
      expect(sessionStorage.getItem(`${TOKEN_KEY_PREFIX}https://iark.ejemplo.org`)).toBe('real');
      expect(localStorage.length).toBe(1);
      expect(loadBackend()).toMatchObject({ kind: 'remote', token: 'real' });
    });

    it('si acceder a las propiedades lanza (SecurityError), la app sigue con los proyectos de este navegador', () => {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get() {
          throw new DOMException('bloqueado', 'SecurityError');
        },
      });
      Object.defineProperty(window, 'sessionStorage', {
        configurable: true,
        get() {
          throw new DOMException('bloqueado', 'SecurityError');
        },
      });
      expect(browserAreas()).toEqual({});
      expect(loadBackend()).toEqual({ kind: 'local' });
      expect(saveBackend({ url: 'https://iark.ejemplo.org' })).toMatchObject({ saved: false });
    });
  });
});
