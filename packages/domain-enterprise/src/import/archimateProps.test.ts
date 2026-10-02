import { describe, expect, it } from 'vitest';
import {
  normKey,
  parseAmount,
  parseBoolean,
  parseCount,
  parseCriticality,
  parseEndOfLife,
  parseImportance,
  parseLifecycle,
  parseMaturity,
  parseStrategy,
  parseTechnologyKind,
  propertyField,
} from './archimateProps';

describe('propiedades de ArchiMate: nombres', () => {
  it('reconoce los nombres en español e inglés sin distinguir mayúsculas, acentos ni separadores', () => {
    expect(normKey('Fin de soporte')).toBe('findesoporte');
    expect(normKey('Estrategia de modernización')).toBe('estrategiademodernizacion');
    for (const [name, field] of [
      ['Coste anual', 'annualCost'],
      ['annual_cost', 'annualCost'],
      ['AnnualCost', 'annualCost'],
      ['Costo Anual', 'annualCost'],
      ['Número de usuarios', 'users'],
      ['Users', 'users'],
      ['Estrategia', 'strategy'],
      ['T-Model', 'strategy'],
      ['End of support', 'endOfLife'],
      ['EOL', 'endOfLife'],
      ['Fin de soporte', 'endOfLife'],
      ['Ciclo de vida', 'lifecycle'],
      ['Lifecycle', 'lifecycle'],
      ['Madurez', 'maturity'],
      ['Nivel de madurez', 'maturity'],
      ['Importancia estratégica', 'importance'],
      ['Criticidad', 'criticality'],
      ['Business criticality', 'criticality'],
      ['Responsable', 'owner'],
      ['Dueño', 'owner'],
      ['Proveedor', 'vendor'],
      ['Tecnología', 'technology'],
      ['Versión', 'version'],
      ['Externo', 'external'],
      ['URN', 'ref'],
    ] as const) {
      expect(propertyField(name)?.field, name).toBe(field);
    }
  });

  it('los nombres genéricos solo cuentan si el valor se entiende, y lo que no se conoce no es nada', () => {
    expect(propertyField('Estado')).toEqual({ field: 'lifecycle', loose: true });
    expect(propertyField('Status')?.loose).toBe(true);
    expect(propertyField('Tipo')).toEqual({ field: 'kind', loose: true });
    expect(propertyField('Ciclo de vida')?.loose).toBe(false);
    for (const name of ['Centro de coste', 'Cost center', 'Owner email', 'Jira', 'constructor', '__proto__', '']) expect(propertyField(name), name).toBeUndefined();
  });
});

describe('propiedades de ArchiMate: cantidades', () => {
  it('lee importes con moneda y separadores de los dos idiomas', () => {
    const cases: Array<[string, number]> = [
      ['180.000 €', 180000],
      ['180000', 180000],
      ['$210,000', 210000],
      ['1,200,000 USD', 1200000],
      ['1.200.000,50', 1200000.5],
      ['1,200,000.75', 1200000.75],
      ['1 200 000 EUR', 1200000],
      ['12,5', 12.5],
      ['0.500', 0.5],
      ['48k', 48000],
      ['45 mil euros', 45000],
      ['1,2M', 1200000],
      ['$1.2M', 1200000],
      ['2 millones', 2000000],
      ['EUR 90.000', 90000],
      ['1.234', 1234],
    ];
    for (const [text, value] of cases) expect(parseAmount(text), text).toBe(value);
  });

  it('no inventa un importe donde no lo hay o es negativo', () => {
    for (const text of ['muchos', '', '-5', 'n/a', '—']) expect(parseAmount(text), text).toBeUndefined();
  });

  it('los usuarios son enteros', () => {
    expect(parseCount('25.000')).toBe(25000);
    expect(parseCount('1,250,000')).toBe(1250000);
    expect(parseCount('450')).toBe(450);
    expect(parseCount('1.5k')).toBe(1500);
    expect(parseCount('varios')).toBeUndefined();
  });
});

describe('propiedades de ArchiMate: fechas', () => {
  it('normaliza el fin de soporte a AAAA-MM o AAAA-MM-DD', () => {
    const cases: Array<[string, string]> = [
      ['2027-06', '2027-06'],
      ['2027-06-30', '2027-06-30'],
      ['2027-06-30T00:00:00Z', '2027-06-30'],
      ['2027/6/3', '2027-06-03'],
      ['31/03/2027', '2027-03-31'],
      ['31-03-2027', '2027-03-31'],
      ['03/31/2027', '2027-03-31'],
      ['05/06/2027', '2027-06-05'],
      ['06/2027', '2027-06'],
      ['diciembre de 2026', '2026-12'],
      ['Diciembre 2026', '2026-12'],
      ['June 2027', '2027-06'],
      ['Apr 2027', '2027-04'],
      ['sept. 2028', '2028-09'],
      ['Jun-2027', '2027-06'],
      ['2027 junio', '2027-06'],
      ['2027', '2027-12'],
    ];
    for (const [text, value] of cases) expect(parseEndOfLife(text), text).toBe(value);
  });

  it('descarta lo que no es una fecha válida', () => {
    for (const text of ['pronto', '2027-13', '2027-02-30', '31/13/2027', '', 'constructor 2027', 'T4 2027']) expect(parseEndOfLife(text), text).toBeUndefined();
  });
});

describe('propiedades de ArchiMate: valores con nombre', () => {
  it('ciclo de vida', () => {
    expect(parseLifecycle('Activo')).toBe('active');
    expect(parseLifecycle('En producción')).toBe('active');
    expect(parseLifecycle('Production')).toBe('active');
    expect(parseLifecycle('En retirada')).toBe('sunset');
    expect(parseLifecycle('Phase out')).toBe('sunset');
    expect(parseLifecycle('Planned')).toBe('planned');
    expect(parseLifecycle('Prevista')).toBe('planned');
    expect(parseLifecycle('Retirada')).toBe('retired');
    expect(parseLifecycle('Decommissioned')).toBe('retired');
    expect(parseLifecycle('Aprobado')).toBeUndefined();
  });

  it('criticidad, estrategia, importancia y tipo de tecnología', () => {
    expect(parseCriticality('Crítica')).toBe('critical');
    expect(parseCriticality('Mission critical')).toBe('critical');
    expect(parseCriticality('Alta')).toBe('high');
    expect(parseCriticality('Medium')).toBe('medium');
    expect(parseCriticality('Baja')).toBe('low');
    expect(parseStrategy('Conservar')).toBe('keep');
    expect(parseStrategy('Invest')).toBe('keep');
    expect(parseStrategy('Migrar')).toBe('migrate');
    expect(parseStrategy('Rehost')).toBe('migrate');
    expect(parseStrategy('Reemplazar')).toBe('replace');
    expect(parseStrategy('Eliminate')).toBe('retire');
    expect(parseStrategy('Pendiente de decidir')).toBeUndefined();
    expect(parseImportance('Diferenciadora')).toBe('differentiating');
    expect(parseImportance('Core')).toBe('core');
    expect(parseImportance('Esencial')).toBe('core');
    expect(parseImportance('Commodity')).toBe('supporting');
    expect(parseImportance('De apoyo')).toBe('supporting');
    expect(parseTechnologyKind('Base de datos')).toBe('database');
    expect(parseTechnologyKind('Infraestructura')).toBe('infrastructure');
    expect(parseTechnologyKind('Servicio')).toBe('service');
  });

  it('madurez de 1 a 5 como número, con texto o con nombre', () => {
    for (const [text, n] of [['4', 4], ['Nivel 3', 3], ['Level 2', 2], ['3/5', 3], ['3 de 5', 3], ['3 of 5', 3], ['3.0', 3], ['Initial', 1], ['Inicial', 1], ['Gestionado', 2], ['Defined', 3], ['Definido', 3], ['Optimizado', 5], ['Optimizing', 5], ['Quantitatively managed', 4]] as const) {
      expect(parseMaturity(text), text).toBe(n);
    }
    for (const text of ['0', '6', '9', 'media', '35', '']) expect(parseMaturity(text), text).toBeUndefined();
  });

  it('booleanos', () => {
    for (const text of ['Sí', 'si', 'true', 'Yes', 'SaaS', 'Externo']) expect(parseBoolean(text), text).toBe(true);
    for (const text of ['No', 'false', 'Interno', 'On-premise']) expect(parseBoolean(text), text).toBe(false);
    expect(parseBoolean('quizá')).toBeUndefined();
  });
});
