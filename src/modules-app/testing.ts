import { readFileSync } from 'node:fs';
import { c4Module } from '@iark/domain-c4';
import { dataModule } from '@iark/domain-data';
import { enterpriseModule } from '@iark/domain-enterprise';
import { integrationModule } from '@iark/domain-integration';
import { platformModule } from '@iark/domain-platform';
import { securityModule } from '@iark/domain-security';
import { WorkbenchController, type ModuleSource } from './controller';

/** Utilidades de las pruebas del banco de trabajo (Node): los mismos módulos y ejemplos que carga la app, sin Vite. */
export const example = (file: string): string => readFileSync(new URL(`../../examples/${file}`, import.meta.url), 'utf8');

export const SOURCES: ModuleSource[] = [
  { id: 'integration', label: 'Integración', load: async () => integrationModule, example: async () => example('pedidos-integracion.json') },
  { id: 'data', label: 'Datos', load: async () => dataModule, example: async () => example('ventas-datos.json') },
  { id: 'enterprise', label: 'Empresarial', load: async () => enterpriseModule, example: async () => example('empresa-arquitectura.json') },
  { id: 'platform', label: 'Plataforma', load: async () => platformModule, example: async () => example('plataforma-ejemplo.json') },
  { id: 'security', label: 'Seguridad', load: async () => securityModule, example: async () => example('seguridad-ejemplo.json') },
];

export const newController = (): WorkbenchController => new WorkbenchController(SOURCES, { renderDelay: 0 });

export { c4Module, securityModule, dataModule, integrationModule, platformModule, enterpriseModule };
