import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { toDrawio } from '../../export/drawio/toDrawio';
import { autoLayoutDocument } from '../../layout/elkLayout';
import { sampleDocument } from '../../model/sample';
import { validateDocument } from '../../model/schema';
import type { C4Document } from '../../model/types';
import { fromDrawio } from '../drawio/fromDrawio';
import { DslImportError, fromStructurizrDsl, type IncludeResolver } from './fromStructurizrDsl';

const wrap = (model: string, views = ''): string => `workspace "T" {\n  model {\n${model}\n  }\n${views ? `  views {\n${views}\n  }\n` : ''}}\n`;
const byName = (doc: C4Document, name: string) => doc.model.elements.find((e) => e.name === name)!;
const viewOf = (doc: C4Document, id: string) => doc.views.find((v) => v.id === id)!;
const ids = (view: { elements: Array<{ id: string }> }) => view.elements.map((e) => e.id).sort();
/** Los avisos sin el que anuncia las vistas por defecto (irrelevante en las pruebas de DSL sin bloque views). */
const quiet = (warnings: string[]) => warnings.filter((w) => !/vistas por defecto/.test(w));

describe('fromStructurizrDsl: modelo', () => {
  it('importa el DSL mínimo de "Getting Started" (incluso con un identificador igual a una palabra clave)', () => {
    const { document, warnings } = fromStructurizrDsl(`
workspace "Getting Started" "This is a model of my software system." {
    model {
        user = person "User" "A user of my software system."
        softwareSystem = softwareSystem "Software System" "My software system."
        user -> softwareSystem "Uses"
    }
    views {
        systemContext softwareSystem "SystemContext" "An example of a System Context diagram." {
            include *
            autoLayout
        }
        styles {
            element "Software System" { background #1168bd color #ffffff }
            element "Person" { shape person background #08427b color #ffffff }
        }
    }
}`);
    expect(quiet(warnings)).toEqual([]);
    expect(document.workspace).toEqual({ name: 'Getting Started', description: 'This is a model of my software system.' });
    expect(document.model.elements).toEqual([
      { id: 'user', type: 'person', name: 'User', description: 'A user of my software system.' },
      { id: 'softwareSystem', type: 'softwareSystem', name: 'Software System', description: 'My software system.' },
    ]); // los colores canónicos de C4 no se guardan como color propio
    expect(document.model.relationships).toEqual([{ id: 'user--softwareSystem', sourceId: 'user', targetId: 'softwareSystem', description: 'Uses' }]);
    expect(document.views).toMatchObject([
      { id: 'SystemContext', type: 'systemContext', scopeId: 'softwareSystem', description: 'An example of a System Context diagram.', layout: { direction: 'DOWN' } },
    ]);
    expect(ids(document.views[0])).toEqual(['softwareSystem', 'user']);
  });

  it('examples/banca.dsl equivale al documento de ejemplo (mismos elementos, relaciones y vistas)', () => {
    const { document, warnings } = fromStructurizrDsl(readFileSync('examples/banca.dsl', 'utf8'));
    expect(quiet(warnings)).toEqual([]);
    expect(validateDocument(document).ok).toBe(true);
    const name = (doc: C4Document) => new Map(doc.model.elements.map((e) => [e.id, e.name]));
    const got = name(document);
    const want = name(sampleDocument);

    expect(document.model.elements).toHaveLength(sampleDocument.model.elements.length);
    for (const original of sampleDocument.model.elements) {
      const e = byName(document, original.name);
      expect({ ...e, id: '', parentId: e.parentId ? got.get(e.parentId) : undefined }).toEqual({
        ...original,
        id: '',
        parentId: original.parentId ? want.get(original.parentId) : undefined,
        ...(e.tags ? { tags: e.tags } : {}), // las etiquetas del DSL ("Database", "Existing System"…) se conservan
      });
    }
    const relations = (doc: C4Document, n: Map<string, string>) =>
      doc.model.relationships.map((r) => [n.get(r.sourceId), n.get(r.targetId), r.description, r.technology].join('|')).sort();
    expect(relations(document, got)).toEqual(relations(sampleDocument, want));

    for (const original of sampleDocument.views) {
      const v = viewOf(document, original.id);
      expect([v.type, v.title, got.get(v.scopeId!)]).toEqual([original.type, original.title, want.get(original.scopeId!)]);
      expect(v.elements.map((e) => got.get(e.id)).sort()).toEqual(original.elements.map((e) => want.get(e.id)).sort());
    }
    expect(document.views.map((v) => v.layout?.direction)).toEqual(['DOWN', 'RIGHT', 'RIGHT']);
  });

  it('identificadores jerárquicos: mismo nombre corto en dos sistemas, referencias calificadas y por ámbito', () => {
    const { document, warnings } = fromStructurizrDsl(`
workspace "H" {
  !identifiers hierarchical
  model {
    a = softwareSystem "A" {
      web = container "Web" "" "React"
      db = container "DB" "" "PostgreSQL" "Database"
      web -> db "Lee"
    }
    b = softwareSystem "B" {
      db = container "DB" "" "MySQL"
    }
    a.web -> b.db "Sincroniza" "SQL"
  }
}`);
    expect(quiet(warnings)).toEqual([]);
    expect(document.model.elements.map((e) => e.id)).toEqual(['a', 'web', 'db', 'b', 'db-2']);
    expect(document.model.elements.find((e) => e.technology === 'MySQL')).toMatchObject({ id: 'db-2', parentId: 'b' });
    expect(document.model.relationships.map((r) => [r.sourceId, r.targetId, r.description])).toEqual([
      ['web', 'db', 'Lee'],
      ['web', 'db-2', 'Sincroniza'],
    ]);
  });

  it('relaciones: dentro de un elemento (-> y this), adelantadas, con identificador, etiquetas; rechaza duplicadas, propias y rotas', () => {
    const { document, warnings } = fromStructurizrDsl(
      wrap(`
    u = person "U"
    s = softwareSystem "S" {
      -> ext "Usa la API" "HTTPS"
      this -> u "Notifica"
    }
    early = u -> s "Antes de definir" "" "Tag1, Tag2"
    u -> later "Adelantada"
    later = softwareSystem "Later"
    u -> u "Yo"
    u -> s "Antes de definir" "" "Tag1, Tag2"
    u -> nada "Rota"
    ext = softwareSystem "Ext"`),
    );
    expect(document.model.relationships).toEqual([
      { id: 's--ext', sourceId: 's', targetId: 'ext', description: 'Usa la API', technology: 'HTTPS' },
      { id: 's--u', sourceId: 's', targetId: 'u', description: 'Notifica' },
      { id: 'early', sourceId: 'u', targetId: 's', description: 'Antes de definir', tags: ['Tag1', 'Tag2'] },
      { id: 'u--later', sourceId: 'u', targetId: 'later', description: 'Adelantada' },
    ]);
    expect(warnings.join('\n')).toMatch(/no puede relacionarse consigo mismo/);
    expect(warnings.join('\n')).toMatch(/relación duplicada/);
    expect(warnings.join('\n')).toMatch(/«nada», que no es un elemento conocido/);
    expect(quiet(warnings)).toHaveLength(3);
  });

  it('atributos en el bloque del elemento (tags, description, technology) y los que no se importan se avisan agrupados', () => {
    const { document, warnings } = fromStructurizrDsl(
      wrap(`
    s = softwareSystem "S" "Desc" "Tag1,Tag2" {
      tags "Tag3"
      description "Nueva descripción"
      url "https://ejemplo.com"
      properties {
        dueño equipo-a
      }
      c = container "C" {
        technology "Go"
        url "https://ejemplo.com/c"
      }
    }`),
    );
    expect(byName(document, 'S')).toMatchObject({ description: 'Nueva descripción', tags: ['Tag1', 'Tag2', 'Tag3'] });
    expect(byName(document, 'C').technology).toBe('Go');
    expect(quiet(warnings)).toEqual([
      expect.stringMatching(/Se ignoraron 2 sentencias «url» \(no soportada; la primera, en línea 7\)/),
      expect.stringMatching(/Se ignoró 1 sentencia «properties»/),
    ]);
  });

  it('group y enterprise solo aportan su contenido', () => {
    const { document, warnings } = fromStructurizrDsl(
      wrap(`
    enterprise "Corp" {
      g = group "Grupo" {
        p = person "P"
      }
      s = softwareSystem "S" {
        group "Interno" {
          c = container "C"
        }
      }
    }`),
    );
    expect(quiet(warnings)).toEqual([]);
    expect(document.model.elements.map((e) => [e.name, e.parentId])).toEqual([['P', undefined], ['S', undefined], ['C', 's']]);
  });

  it('los estilos por etiqueta se convierten en forma, color propio y "externo"', () => {
    const { document, warnings } = fromStructurizrDsl(
      wrap(
        `
    a = softwareSystem "A" "" "External"
    b = softwareSystem "B" "" "Existing System"
    c = softwareSystem "C" "" "Custom"
    d = softwareSystem "D" "" "Tri"
    x = softwareSystem "X" "" "TagA,TagB"
    g = softwareSystem "G" "" "Grey"
    s = softwareSystem "S" {
      db = container "DB" "" "PG" "Database"
      q = container "Q" "" "Kafka" "Queue"
      w = container "W" "" "JS" "Browser"
      m = container "M" "" "Swift" "Mobile"
      k = container "K" "" "X" "Canon"
    }
    p = person "P" "" "Roundy"`,
        `
    styles {
      element "Custom" { background #ff8800 }
      element "Tri" { background #0f0 }
      element "TagA" { background #ff0000 }
      element "TagB" { background #0000ff }
      element "Grey" { background #999999 }
      element "Database" { shape Cylinder }
      element "Queue" { shape pipe }
      element "Browser" { shape webbrowser }
      element "Mobile" { shape mobiledevicelandscape }
      element "Canon" { background #438dd5 }
      element "Roundy" { shape cylinder }
    }`,
      ),
    );
    expect(warnings).toEqual([expect.stringMatching(/no define vistas/)]);
    const el = (n: string) => byName(document, n);
    expect(el('A').external).toBe(true);
    expect(el('B').external).toBe(true);
    expect(el('C')).toMatchObject({ color: '#ff8800' });
    expect(el('D').color).toBe('#00ff00'); // #rgb se expande
    expect(el('X').color).toBe('#0000ff'); // gana la última etiqueta
    expect(el('G')).toMatchObject({ external: true });
    expect(el('G').color).toBeUndefined();
    expect([el('DB').shape, el('Q').shape, el('W').shape, el('M').shape]).toEqual(['database', 'queue', 'browser', 'mobile']);
    expect(el('K').color).toBeUndefined(); // el color canónico del contenedor no es un color propio
    expect(el('P').shape).toBeUndefined(); // una persona no cambia de forma
  });

  it('no importa despliegue, vistas dinámicas ni !docs, pero lo avisa y deja un documento válido', () => {
    const { document, warnings } = fromStructurizrDsl(`
workspace "U" {
  !docs docs
  model {
    u = person "U"
    s = softwareSystem "S"
    u -> s "Uses"
    live = deploymentEnvironment "Live" {
      node = deploymentNode "Servidor" {
        softwareSystemInstance s
      }
    }
  }
  views {
    systemContext s "ctx" { include * }
    dynamic s "dyn" {
      u -> s "1"
    }
    deployment s "Live" "dep" { include * }
  }
}`);
    expect(validateDocument(document).ok).toBe(true);
    expect(document.model.elements.map((e) => e.name)).toEqual(['U', 'S']);
    expect(document.model.relationships).toHaveLength(1); // la flecha de la vista dinámica no es una relación del modelo
    expect(document.views.map((v) => v.id)).toEqual(['ctx']);
    const text = warnings.join('\n');
    expect(text).toMatch(/«!docs»/);
    expect(text).toMatch(/«despliegue \(deploymentEnvironment/);
    expect(text).toMatch(/«vista dynamic»/);
    expect(text).toMatch(/«vista deployment»/);
  });

  it('un elemento en un sitio imposible (contenedor suelto, persona dentro de un sistema…) se omite con su contenido y se avisa', () => {
    const { document, warnings } = fromStructurizrDsl(
      wrap(`
    c = container "Huérfano"
    s = softwareSystem "S" {
      p = person "Persona dentro"
      k = component "Componente en sistema"
      ok = container "Ok" {
        comp = component "Comp"
      }
    }
    ct = container "Contenedor fuera" {
      x = component "X"
    }`),
    );
    expect(document.model.elements.map((e) => e.name)).toEqual(['S', 'Ok', 'Comp']);
    const text = warnings.join('\n');
    expect(text).toMatch(/«Huérfano» \(container\) no puede estar fuera de un softwareSystem/);
    expect(text).toMatch(/«Persona dentro» \(person\) no puede estar dentro de «S» \(softwareSystem\)/);
    expect(text).toMatch(/«Componente en sistema» \(component\) no puede estar dentro de «S»/);
    expect(text).toMatch(/«Contenedor fuera» \(container\) no puede estar fuera/);
    expect(text).not.toMatch(/«X»/); // el contenido de lo omitido no genera más avisos
  });

  it('constantes (!const) y ${NOMBRE}, también antes del workspace; avisa de las no definidas', () => {
    const { document, warnings } = fromStructurizrDsl(`
!const OWNER "Banca"
workspace "\${OWNER}" {
  !const TECH "Kotlin"
  model {
    s = softwareSystem "Sistema de \${OWNER}" {
      c = container "API" "" "\${TECH}"
    }
    x = softwareSystem "\${NOPE}"
  }
}`);
    expect(document.workspace.name).toBe('Banca');
    expect(byName(document, 'Sistema de Banca')).toBeDefined();
    expect(byName(document, 'API').technology).toBe('Kotlin');
    expect(byName(document, '${NOPE}')).toBeDefined();
    expect(quiet(warnings)).toEqual([expect.stringMatching(/la constante «NOPE» no está definida/)]);
  });

  it('el nombre del documento: opción > workspace > nombre alternativo > "Diagrama C4"', () => {
    const named = 'workspace "W" { model { s = softwareSystem "S" } }';
    const unnamed = 'workspace { model { s = softwareSystem "S" } }';
    expect(fromStructurizrDsl(named, { name: 'X', fallbackName: 'F' }).document.workspace.name).toBe('X');
    expect(fromStructurizrDsl(named, { fallbackName: 'F' }).document.workspace.name).toBe('W');
    expect(fromStructurizrDsl(unnamed, { fallbackName: 'F' }).document.workspace.name).toBe('F');
    expect(fromStructurizrDsl(unnamed).document.workspace.name).toBe('Diagrama C4');
  });

  it('un identificador llamado __proto__ o constructor no rompe ni contamina nada', () => {
    const { document } = fromStructurizrDsl(wrap(`
    __proto__ = person "P"
    constructor = softwareSystem "S"
    __proto__ -> constructor "usa"`));
    expect(document.model.relationships).toHaveLength(1);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('fromStructurizrDsl: vistas', () => {
  const model = `
    u = person "U"
    a = softwareSystem "A" {
      web = container "Web" "" "JS"
      api = container "API" "" "Go"
    }
    b = softwareSystem "B" "" "External"
    c = softwareSystem "C"
    u -> web "Usa"
    web -> api "Llama"
    api -> b "Consulta"
    c -> u "Avisa"`;
  const views = (body: string) => fromStructurizrDsl(wrap(model, body));

  it('include * sigue la semántica de C4 de cada nivel y el alcance no es un nodo de las vistas de contenedores', () => {
    const { document, warnings } = views(`
    container a "k1" { include * }
    systemContext a "k2" { include * }
    systemLandscape "k3" { include * }`);
    expect(quiet(warnings)).toEqual([]);
    expect(ids(viewOf(document, 'k1'))).toEqual(['api', 'b', 'u', 'web']);
    expect(viewOf(document, 'k1')).toMatchObject({ type: 'container', scopeId: 'a' });
    expect(ids(viewOf(document, 'k2'))).toEqual(['a', 'b', 'u']);
    expect(ids(viewOf(document, 'k3'))).toEqual(['a', 'b', 'c', 'u']);
    expect(viewOf(document, 'k3')).toMatchObject({ type: 'systemContext', title: 'Panorama de sistemas' });
    expect(viewOf(document, 'k3').scopeId).toBeUndefined();
  });

  it('include/exclude con identificadores, ->x->, x->, ->x y element.tag/type/parent', () => {
    const { document, warnings } = views(`
    container a "explicit" { include web api }
    systemLandscape "around" { include ->u-> }
    systemLandscape "out" { include u-> }
    systemLandscape "in" { include ->web }
    systemLandscape "exclude" {
      include *
      exclude c
    }
    systemLandscape "props" { include element.type==Person element.tag==External }
    systemLandscape "notag" { include element.tag!=Person,External,Container }
    container a "children" {
      include element.parent==a
      exclude api
    }
    container a "scope" { include a web }`);
    expect(quiet(warnings)).toEqual([]);
    expect(ids(viewOf(document, 'explicit'))).toEqual(['api', 'web']);
    expect(ids(viewOf(document, 'around'))).toEqual(['c', 'u', 'web']);
    expect(ids(viewOf(document, 'out'))).toEqual(['u', 'web']);
    expect(ids(viewOf(document, 'in'))).toEqual(['u', 'web']);
    expect(ids(viewOf(document, 'exclude'))).toEqual(['a', 'b', 'u']);
    expect(ids(viewOf(document, 'props'))).toEqual(['b', 'u']);
    expect(ids(viewOf(document, 'notag'))).toEqual(['a', 'c']);
    expect(ids(viewOf(document, 'children'))).toEqual(['web']);
    expect(ids(viewOf(document, 'scope'))).toEqual(['web']); // aunque se incluya, el alcance no es un nodo de su propia vista
  });

  it('autoLayout: direcciones y separaciones; título y descripción; claves repetidas o ausentes generan ids únicos', () => {
    const { document } = views(`
    container a "l1" {
      include *
      autoLayout rl 200 100
    }
    container a "l2" {
      include *
      autolayout bt
    }
    container a "dup" "Descripción del argumento" {
      include *
      title "Mi título"
    }
    container a "dup" {
      include *
      description "Otra descripción"
    }
    systemContext a { include * }
    systemContext a { include * }`);
    expect(viewOf(document, 'l1').layout).toEqual({ direction: 'LEFT', layerSpacing: 200, spacing: 100 });
    expect(viewOf(document, 'l2').layout).toEqual({ direction: 'UP' });
    expect(viewOf(document, 'dup')).toMatchObject({ title: 'Mi título', description: 'Descripción del argumento' });
    expect(viewOf(document, 'dup-2')).toMatchObject({ title: 'Contenedores - A', description: 'Otra descripción' });
    expect(document.views.slice(4).map((v) => v.id)).toEqual(['systemcontext-a', 'systemcontext-a-2']);
  });

  it('avisa de alcances inválidos, vistas sin include y expresiones que no entiende, sin perder el resto', () => {
    const { document, warnings } = views(`
    systemContext nope "bad1" { include * }
    systemContext web "bad2" { include * }
    container a "vacia" { }
    container a "raras" {
      include relationship==*
      include "?!"
      include *
    }
    systemContext a "ok" { include * }`);
    expect(document.views.map((v) => v.id)).toEqual(['vacia', 'raras', 'ok']);
    const text = warnings.join('\n');
    expect(text).toMatch(/el alcance «nope» de la vista no es un elemento conocido/);
    expect(text).toMatch(/el alcance de una vista systemContext debe ser un softwareSystem, pero «Web» es un container/);
    expect(text).toMatch(/la vista no incluye ningún elemento/);
    expect(text).toMatch(/expresiones de relaciones/);
    expect(text).toMatch(/la expresión «\?!» no corresponde a ningún elemento/);
    expect(ids(viewOf(document, 'raras'))).toEqual(['api', 'b', 'u', 'web']);
  });

  it('un contexto de sistema cuyo include o exclude deja fuera su propio sistema lo recupera, con aviso', () => {
    const { document, warnings } = views(`
    systemContext a "solo-otros" { include u }
    systemContext a "sin-alcance" {
      include *
      exclude a
    }
    systemContext a "completo" { include * }`);
    expect(ids(viewOf(document, 'solo-otros'))).toEqual(['a', 'u']);
    expect(viewOf(document, 'solo-otros').elements[0].id).toBe('a');
    expect(ids(viewOf(document, 'sin-alcance'))).toContain('a');
    expect(viewOf(document, 'completo').elements.filter((e) => e.id === 'a')).toHaveLength(1);
    expect(warnings.filter((w) => /no incluía su alcance «A»/.test(w))).toHaveLength(2);
    expect(validateDocument(document).ok).toBe(true);
  });

  it('sin vistas en el DSL se crean las de por defecto (contexto, contenedores y componentes)', () => {
    const { document, warnings } = fromStructurizrDsl(
      wrap(`
    u = person "U"
    s = softwareSystem "S" {
      c = container "C" {
        k = component "K"
      }
      d = container "D"
    }
    u -> c "Usa"
    c -> k "Contiene"`),
    );
    expect(warnings).toEqual([expect.stringMatching(/se crearon las vistas por defecto/)]);
    expect(document.views.map((v) => [v.type, v.scopeId])).toEqual([
      ['systemContext', 's'],
      ['container', 's'],
      ['component', 'c'],
    ]);
    expect(ids(document.views[1])).toEqual(['c', 'd', 'u']);

    const flat = fromStructurizrDsl(wrap('a = softwareSystem "A"\nb = softwareSystem "B"\na -> b "Usa"')).document;
    expect(flat.views).toHaveLength(1);
    expect(flat.views[0]).toMatchObject({ type: 'systemContext' });
    expect(ids(flat.views[0])).toEqual(['a', 'b']);

    // También cuando el bloque views solo tiene vistas que no se pueden importar.
    const onlyDynamic = fromStructurizrDsl(wrap('a = softwareSystem "A"', 'dynamic a "d" { }'));
    expect(onlyDynamic.document.views).toHaveLength(1);
    expect(onlyDynamic.warnings.join('\n')).toMatch(/«vista dynamic»/);
  });
});

describe('fromStructurizrDsl: sintaxis', () => {
  const source = `# comentario
// otro comentario
/* bloque
   multilínea */
workspace "Tok" "Con \\"comillas\\" dentro" { # comentario en línea
  model
  {
    p = person "P" \\
        "Descripción continuada"
    s = softwareSystem "S" """Línea 1
Línea 2"""
    p -> s "Usa" # nota al final
    x = softwareSystem "a -> b"
  }
  views {
    systemLandscape "l" { include * }
    styles { element "Person" { background #fff } }
  }
}
`;

  it('comentarios (# // /* */), líneas continuadas, cadenas con comillas y """, y { en su propia línea', () => {
    const { document, warnings } = fromStructurizrDsl(source);
    expect(quiet(warnings)).toEqual([]);
    expect(document.workspace.description).toBe('Con "comillas" dentro');
    expect(byName(document, 'P').description).toBe('Descripción continuada');
    expect(byName(document, 'S').description).toBe('Línea 1\nLínea 2');
    expect(byName(document, 'a -> b')).toBeDefined(); // una flecha entrecomillada es texto
    expect(document.model.relationships).toMatchObject([{ description: 'Usa' }]);
    expect(byName(document, 'P').color).toBe('#ffffff'); // "#fff" es un color, no un comentario
  });

  it('acepta CRLF y BOM inicial, con el mismo resultado', () => {
    const lf = fromStructurizrDsl(source).document;
    const crlf = fromStructurizrDsl('﻿' + source.replace(/\n/g, '\r\n')).document;
    expect(crlf).toEqual(lf);
  });

  it('las llaves pueden ir en la misma línea que el contenido', () => {
    const { document } = fromStructurizrDsl('workspace "W" { model { s = softwareSystem "S" { c = container "C" } } views { container s "v" { include * } } }');
    expect(document.model.elements.map((e) => e.name)).toEqual(['S', 'C']);
    expect(ids(viewOf(document, 'v'))).toEqual(['c']);
  });

  it('errores con la línea: sin workspace, sin elementos, llaves desparejadas, cadenas y comentarios sin cerrar', () => {
    const fails = (text: string, message: RegExp) => {
      expect(() => fromStructurizrDsl(text)).toThrow(DslImportError);
      expect(() => fromStructurizrDsl(text)).toThrow(message);
    };
    fails('', /«workspace/);
    fails('   \n# solo un comentario\n', /«workspace/);
    fails('model { }', /«workspace/);
    fails('workspace "x" { model { } }', /ningún elemento/);
    fails('workspace extends "base.dsl" { }', /workspace extends/);
    fails('workspace "x" {\n model {\n', /línea 2: falta cerrar el bloque/);
    fails('workspace "x" { }\n\n}', /línea 3: hay un "}" sin bloque abierto/);
    fails('workspace "x\n', /línea 1: cadena sin cerrar/);
    fails('workspace "x" {\n  /* nunca se cierra\n}', /línea 2: comentario \/\* sin cerrar/);
    fails('workspace "x" { model { s = softwareSystem """abierto } }', /bloque de texto/);
    fails('{'.repeat(80), /demasiado anidados/);
  });

  it('un bloque de otro archivo con error lo indica', () => {
    const resolveInclude: IncludeResolver = () => ({ file: 'dir/roto.dsl', text: 'a = person "sin cerrar\n' });
    expect(() => fromStructurizrDsl('workspace "x" { model { !include roto.dsl } }', { file: 'dir/main.dsl', resolveInclude })).toThrow(/roto\.dsl, línea 1: cadena sin cerrar/);
  });
});

describe('fromStructurizrDsl: !include', () => {
  const files: Record<string, string> = {
    'dir/main.dsl': 'workspace "Inc" {\n  model {\n    !include model.dsl\n    u -> s "Usa"\n  }\n  views { systemContext s "c" { include * } }\n}',
    'dir/model.dsl': 's = softwareSystem "S"\n!include people.dsl',
    'dir/people.dsl': 'u = person "U"',
  };
  const resolveInclude: IncludeResolver = (target, from) => {
    const file = `${from ? from.replace(/[^/]*$/, '') : ''}${target}`;
    return file in files ? { file, text: files[file] } : undefined;
  };

  it('incluye archivos anidados como si su contenido estuviera escrito en ese punto', () => {
    const { document, warnings } = fromStructurizrDsl(files['dir/main.dsl'], { file: 'dir/main.dsl', resolveInclude });
    expect(quiet(warnings)).toEqual([]);
    expect(document.model.elements.map((e) => e.name)).toEqual(['S', 'U']);
    expect(document.model.relationships).toMatchObject([{ sourceId: 'u', targetId: 's', description: 'Usa' }]);
  });

  it('sin resolvedor, con archivos que faltan o con ciclos: avisa y sigue', () => {
    const noResolver = fromStructurizrDsl('workspace "x" { model { s = softwareSystem "S"\n !include model.dsl } }');
    expect(noResolver.document.model.elements).toHaveLength(1);
    expect(quiet(noResolver.warnings)).toEqual([expect.stringMatching(/!include «model\.dsl» no se puede resolver aquí/)]);

    const missing = fromStructurizrDsl('workspace "x" { model { s = softwareSystem "S"\n !include nada.dsl } }', { file: 'dir/main.dsl', resolveInclude });
    expect(quiet(missing.warnings)).toEqual([expect.stringMatching(/no se pudo leer el !include «nada\.dsl»/)]);

    const cyc: Record<string, string> = { 'a.dsl': '!include b.dsl', 'b.dsl': '!include a.dsl\nx = person "X"' };
    const cycle = fromStructurizrDsl('workspace "x" { model { s = softwareSystem "S"\n !include b.dsl } }', {
      file: 'a.dsl',
      resolveInclude: (t) => (t in cyc ? { file: t, text: cyc[t] } : undefined),
    });
    expect(cycle.document.model.elements.map((e) => e.name)).toEqual(['S', 'X']);
    expect(quiet(cycle.warnings)).toEqual([expect.stringMatching(/se incluye a sí mismo \(ciclo\)/)]);
  });

  it('limita la profundidad de los !include', () => {
    const chain = (t: string) => {
      const n = Number(/f(\d+)/.exec(t)?.[1] ?? -1);
      return n >= 0 ? { file: t, text: `!include f${n + 1}.dsl\nx${n} = person "X${n}"` } : undefined;
    };
    const { document, warnings } = fromStructurizrDsl('workspace "x" { model { s = softwareSystem "S"\n !include f0.dsl } }', { resolveInclude: chain });
    expect(document.model.elements.length).toBeLessThan(20);
    expect(warnings.join('\n')).toMatch(/demasiados !include anidados/);
  });
});

describe('fromStructurizrDsl: con el resto de la herramienta', () => {
  it('el DSL importado se coloca con autolayout, se exporta a .drawio y se vuelve a importar sin perder nada', async () => {
    const { document } = fromStructurizrDsl(readFileSync('examples/banca.dsl', 'utf8'));
    expect(document.views.flatMap((v) => v.elements).every((e) => e.x === undefined)).toBe(true); // el DSL no tiene coordenadas
    const laid = await autoLayoutDocument(document);
    expect(laid.views.flatMap((v) => v.elements).every((e) => typeof e.x === 'number')).toBe(true);

    const back = await fromDrawio(toDrawio(laid));
    expect(back.warnings).toEqual([]);
    const summary = (doc: C4Document) => doc.model.elements.map((e) => [e.id, e.type, e.name, e.parentId, e.external ?? false].join('|')).sort();
    expect(summary(back.document)).toEqual(summary(laid)); // el .drawio ordena los elementos por su aparición en las páginas
    expect(back.document.model.relationships).toHaveLength(laid.model.relationships.length);
    expect(back.document.views.map((v) => [v.id, v.type, v.scopeId])).toEqual(laid.views.map((v) => [v.id, v.type, v.scopeId]));
  });
});
