import { mkdirSync, writeFileSync } from 'node:fs';
import { documentJsonSchema } from '@core/model/schema';
import { generationJsonSchema } from '@core/ai/generationSchema';
import { dataModule } from '@iark/domain-data';
import { enterpriseModule } from '@iark/domain-enterprise';
import { integrationModule } from '@iark/domain-integration';

mkdirSync('schema', { recursive: true });
const doc = { $id: 'https://github.com/juliancardonagaleano/diagramador-c4model/schema/c4-document.schema.json', title: 'Documento C4 (IArk - DIAgrams)', ...documentJsonSchema() };
writeFileSync('schema/c4-document.schema.json', JSON.stringify(doc, null, 2) + '\n');
const gen = { $id: 'https://github.com/juliancardonagaleano/diagramador-c4model/schema/c4-generation.schema.json', title: 'Modelo C4 sin coordenadas (salida de IA)', ...generationJsonSchema() };
writeFileSync('schema/c4-generation.schema.json', JSON.stringify(gen, null, 2) + '\n');

// Esquemas de los demás módulos, a través de su contrato.
const base = 'https://github.com/juliancardonagaleano/diagramador-c4model/schema';
const integrationDoc = { $id: `${base}/integration-document.schema.json`, title: 'Documento de integración (IArk - DIAgrams)', ...(integrationModule.jsonSchema() as object) };
writeFileSync('schema/integration-document.schema.json', JSON.stringify(integrationDoc, null, 2) + '\n');
const integrationGen = { $id: `${base}/integration-generation.schema.json`, title: 'Modelo de integración (salida de IA)', ...(integrationModule.ai!.generationJsonSchema() as object) };
writeFileSync('schema/integration-generation.schema.json', JSON.stringify(integrationGen, null, 2) + '\n');
const dataDoc = { $id: `${base}/data-document.schema.json`, title: 'Documento de datos (IArk - DIAgrams)', ...(dataModule.jsonSchema() as object) };
writeFileSync('schema/data-document.schema.json', JSON.stringify(dataDoc, null, 2) + '\n');
const dataGen = { $id: `${base}/data-generation.schema.json`, title: 'Modelo de datos (salida de IA)', ...(dataModule.ai!.generationJsonSchema() as object) };
writeFileSync('schema/data-generation.schema.json', JSON.stringify(dataGen, null, 2) + '\n');
const enterpriseDoc = { $id: `${base}/enterprise-document.schema.json`, title: 'Documento empresarial (IArk - DIAgrams)', ...(enterpriseModule.jsonSchema() as object) };
writeFileSync('schema/enterprise-document.schema.json', JSON.stringify(enterpriseDoc, null, 2) + '\n');
const enterpriseGen = { $id: `${base}/enterprise-generation.schema.json`, title: 'Modelo empresarial (salida de IA)', ...(enterpriseModule.ai!.generationJsonSchema() as object) };
writeFileSync('schema/enterprise-generation.schema.json', JSON.stringify(enterpriseGen, null, 2) + '\n');
console.log('Esquemas escritos en schema/');
