import type { AttachmentDiagnostic, AttachmentTextResult } from '@iark/kernel';
import { GRAPHQL_SYNTAX, checkBrackets, reindent } from './reindent';
import { pascalCase } from './shared';

const DEFINITION = /^\s*(?:extend\s+)?(?:type|interface|input|enum|union|scalar|directive|schema|query|mutation|subscription|fragment)\b/m;
const NAMED_DEFINITION = /^(?:extend\s+)?(type|interface|input|enum|union|scalar)\s+([A-Za-z_]\w*)/;
const ROOT_TYPES = new Set(['Query', 'Mutation', 'Subscription']);

export function checkGraphql(text: string): AttachmentDiagnostic[] {
  const found = checkBrackets(text, GRAPHQL_SYNTAX).map((problem): AttachmentDiagnostic => ({ severity: 'error', ...problem }));
  if (found.length === 0 && !DEFINITION.test(text.replace(/^\s*#.*$/gm, ''))) {
    found.push({ severity: 'warning', message: 'No se reconoce ninguna definición (type, input, enum, interface, union, scalar, schema…).' });
  }
  return found;
}

export function reformatGraphql(text: string): AttachmentTextResult {
  const [problem] = checkBrackets(text, GRAPHQL_SYNTAX);
  if (problem) return { ok: false, reason: `${problem.message} (línea ${problem.line}, columna ${problem.column})` };
  return { ok: true, text: reindent(text, GRAPHQL_SYNTAX) };
}

export function summarizeGraphql(text: string): string[] {
  if (checkBrackets(text, GRAPHQL_SYNTAX).length > 0) return [];
  const lines: string[] = [];
  let root: string | undefined;
  for (const line of reindent(text, GRAPHQL_SYNTAX).split('\n')) {
    const definition = NAMED_DEFINITION.exec(line);
    if (definition) {
      root = definition[1] === 'type' && ROOT_TYPES.has(definition[2]) ? definition[2] : undefined;
      if (!root) lines.push(`${definition[1]} ${definition[2]}`);
      continue;
    }
    if (root && /^\S/.test(line)) root = undefined;
    const field = root ? /^ {2}([A-Za-z_]\w*)\s*[(:]/.exec(line) : null;
    if (root && field) lines.push(`${root}.${field[1]}`);
  }
  return lines;
}

export function graphqlTemplate(name: string): string {
  const title = name.replace(/\s+/g, ' ').trim() || pascalCase(name, 'Esquema');
  return `# Esquema GraphQL de ${title}

type Query {
  recurso(id: ID!): Recurso
  recursos(pagina: Int = 1): [Recurso!]!
}

type Mutation {
  crearRecurso(entrada: NuevoRecurso!): Recurso!
}

type Recurso {
  id: ID!
  nombre: String!
}

input NuevoRecurso {
  nombre: String!
}
`;
}
