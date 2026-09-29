import { describe, expect, it } from 'vitest';
import { toMermaid } from '../../export/mermaid/toMermaid';
import { sampleDocument } from '../../model/sample';
import { validateDocument } from '../../model/schema';
import { fromMermaid, looksLikeMermaid, MermaidImportError } from './fromMermaid';

const C4 = `C4Container
  title Banca en línea
  Person(cliente, "Cliente", "Titular de cuentas")
  System_Ext(correo, "Sistema de correo", "Envía avisos")
  System_Boundary(banca, "Banca en línea") {
    Container(web, "App web", "React", "Interfaz")
    ContainerDb(bd, "Base de datos", "PostgreSQL", "Cuentas")
    Container_Boundary(api, "API") {
      Component(ctl, "Controlador", "Express")
    }
  }
  Rel(cliente, web, "Usa", "HTTPS")
  Rel_D(web, bd, "Lee y escribe", "SQL")
  BiRel(web, correo, "Avisa")
  UpdateLayoutConfig($c4ShapeInRow="3")
`;

describe('fromMermaid: C4 nativo', () => {
  const { document, warnings } = fromMermaid(C4);
  const byId = (id: string) => document.model.elements.find((e) => e.id === id)!;

  it('importa elementos, jerarquía y forma', () => {
    expect(document.workspace.name).toBe('Banca en línea');
    expect(byId('cliente').type).toBe('person');
    expect(byId('correo')).toMatchObject({ type: 'softwareSystem', external: true });
    expect(byId('banca').type).toBe('softwareSystem');
    expect(byId('web')).toMatchObject({ type: 'container', parentId: 'banca', technology: 'React', description: 'Interfaz' });
    expect(byId('bd')).toMatchObject({ shape: 'database', parentId: 'banca' });
    expect(byId('api')).toMatchObject({ type: 'container', parentId: 'banca' });
    expect(byId('ctl')).toMatchObject({ type: 'component', parentId: 'api' });
  });

  it('importa relaciones (BiRel en ambos sentidos) y crea vistas válidas', () => {
    const rels = document.model.relationships;
    expect(rels.find((r) => r.sourceId === 'cliente' && r.targetId === 'web')).toMatchObject({ description: 'Usa', technology: 'HTTPS' });
    expect(rels.filter((r) => [r.sourceId, r.targetId].includes('correo'))).toHaveLength(2);
    expect(document.views.length).toBeGreaterThan(0);
    expect(validateDocument(document).ok).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('avisa de lo que no entiende y de referencias rotas', () => {
    const r = fromMermaid('C4Context\n  System(a, "A")\n  Rel(a, fantasma, "x")\n  Cosa rara');
    expect(r.warnings.some((w) => w.includes('fantasma'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('Cosa rara'))).toBe(true);
  });
});

describe('fromMermaid: flowchart', () => {
  it('nodos, formas, etiquetas y cadenas', () => {
    const { document } = fromMermaid(`flowchart LR
      U(("Usuario")) --> W[Web<br/>React]
      W -->|SQL| DB[(Base de datos)]
      W -- cola --> Q([Mensajes]) & X
      A & B --> C
    `);
    const el = (n: string) => document.model.elements.find((e) => e.name === n || e.id === n.toLowerCase())!;
    expect(el('Web')).toMatchObject({ description: 'React' });
    expect(el('Base de datos').shape).toBe('database');
    expect(el('Mensajes').shape).toBe('queue');
    const rel = (s: string, t: string) => document.model.relationships.find((r) => r.sourceId === s && r.targetId === t);
    expect(rel('w', 'db')?.description).toBe('SQL');
    expect(rel('w', 'q')?.description).toBe('cola');
    expect(rel('w', 'x')).toBeDefined();
    expect(rel('a', 'c')).toBeDefined();
    expect(rel('b', 'c')).toBeDefined();
  });

  it('subgraph anidados pasan a sistema › contenedor › componente', () => {
    const { document } = fromMermaid(`graph TD
      subgraph Banca
        subgraph API
          ctl[Controlador]
        end
        web[Web]
      end
      cli[Cliente] --> web
      web --> ctl
    `);
    const byId = (id: string) => document.model.elements.find((e) => e.id === id)!;
    expect(byId('banca').type).toBe('softwareSystem');
    expect(byId('api')).toMatchObject({ type: 'container', parentId: 'banca' });
    expect(byId('ctl')).toMatchObject({ type: 'component', parentId: 'api' });
    expect(byId('web')).toMatchObject({ type: 'container', parentId: 'banca' });
    expect(byId('cli').type).toBe('softwareSystem');
    expect(validateDocument(document).ok).toBe(true);
  });
});

describe('fromMermaid: sequence y ER', () => {
  it('sequenceDiagram', () => {
    const { document, warnings } = fromMermaid(`sequenceDiagram
      actor U as Usuario
      participant API
      U->>+API: Pide datos
      API-->>-U: Respuesta
      U->>API: Pide datos
      Note over U,API: nota
      loop cada minuto
        API->>DB: Consulta
      end
    `);
    expect(document.model.elements.find((e) => e.id === 'u')).toMatchObject({ type: 'person', name: 'Usuario' });
    expect(document.model.elements.find((e) => e.id === 'db')?.type).toBe('softwareSystem');
    // el mensaje repetido no duplica la relación
    expect(document.model.relationships.filter((r) => r.description === 'Pide datos')).toHaveLength(1);
    expect(document.model.relationships).toHaveLength(3);
    expect(warnings).toEqual([]);
  });

  it('erDiagram', () => {
    const { document } = fromMermaid(`erDiagram
      CLIENTE ||--o{ PEDIDO : realiza
      CLIENTE {
        int id PK
        string nombre
      }
      PEDIDO
    `);
    const cliente = document.model.elements.find((e) => e.id === 'cliente')!;
    expect(cliente.shape).toBe('database');
    expect(cliente.description).toContain('int id PK');
    expect(document.model.relationships[0].description).toBe('realiza (1 → 0..*)');
  });
});

describe('fromMermaid: entrada', () => {
  it('acepta bloques ```mermaid, frontmatter y comentarios', () => {
    const { document } = fromMermaid('Texto\n```mermaid\n---\ntitle: Mi sistema\n---\n%% comentario\nflowchart LR\n A --> B\n```\n');
    expect(document.workspace.name).toBe('Mi sistema');
    expect(document.model.relationships).toHaveLength(1);
  });

  it('rechaza tipos no soportados y textos vacíos', () => {
    expect(() => fromMermaid('pie title x\n "a": 1')).toThrow(MermaidImportError);
    expect(() => fromMermaid('   ')).toThrow(MermaidImportError);
    expect(() => fromMermaid('flowchart LR\n')).toThrow(/ningún elemento/);
  });

  it('looksLikeMermaid', () => {
    expect(looksLikeMermaid('flowchart TD\nA-->B')).toBe(true);
    expect(looksLikeMermaid('workspace { }')).toBe(false);
    expect(looksLikeMermaid('<mxfile/>')).toBe(false);
  });
});

describe('toMermaid', () => {
  it('exporta C4 nativo que vuelve a importarse con los mismos elementos', () => {
    const view = sampleDocument.views.find((v) => v.type === 'container')!;
    const text = toMermaid(sampleDocument, { viewId: view.id });
    expect(text.startsWith('C4Container')).toBe(true);
    expect(text).toContain('System_Boundary(');
    const back = fromMermaid(text);
    expect(back.warnings).toEqual([]);
    const names = back.document.model.elements.map((e) => e.name).sort();
    expect(names).toEqual(expect.arrayContaining(sampleDocument.model.elements.filter((e) => e.type === 'container').map((e) => e.name)));
  });

  it('exporta flowchart e importa de vuelta', () => {
    const text = toMermaid(sampleDocument, { format: 'flowchart' });
    expect(text).toContain('flowchart TB');
    const back = fromMermaid(text);
    expect(validateDocument(back.document).ok).toBe(true);
    expect(back.document.model.relationships.length).toBeGreaterThan(0);
  });

  it('falla con una vista inexistente', () => {
    expect(() => toMermaid(sampleDocument, { viewId: 'nada' })).toThrow(/No existe/);
  });
});
