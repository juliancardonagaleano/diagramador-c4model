import { ModuleRegistry } from '@iark/kernel';
import { c4Module } from '@iark/domain-c4';
import { dataModule } from '@iark/domain-data';
import { integrationModule } from '@iark/domain-integration';

/** Módulo que se usa cuando no se indica `--module`. */
export const DEFAULT_MODULE = 'c4';

/** Módulos que trae esta instalación del CLI. Las demás especialidades se añaden aquí al incorporarse a la suite. */
export function createDefaultRegistry(): ModuleRegistry {
  return new ModuleRegistry().register(c4Module).register(integrationModule).register(dataModule);
}
