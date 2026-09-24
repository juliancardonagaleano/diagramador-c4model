import { mkdirSync, writeFileSync } from 'node:fs';
import { documentJsonSchema } from '../src/core/model/schema';
import { generationJsonSchema } from '../src/core/ai/generationSchema';

mkdirSync('schema', { recursive: true });
const doc = { $id: 'https://github.com/juliancardonagaleano/diagramador-c4model/schema/c4-document.schema.json', title: 'Documento C4 (diagramador-c4model)', ...documentJsonSchema() };
writeFileSync('schema/c4-document.schema.json', JSON.stringify(doc, null, 2) + '\n');
const gen = { $id: 'https://github.com/juliancardonagaleano/diagramador-c4model/schema/c4-generation.schema.json', title: 'Modelo C4 sin coordenadas (salida de IA)', ...generationJsonSchema() };
writeFileSync('schema/c4-generation.schema.json', JSON.stringify(gen, null, 2) + '\n');
console.log('Esquemas escritos en schema/');
