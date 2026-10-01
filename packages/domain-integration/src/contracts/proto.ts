import type { AttachmentDiagnostic, AttachmentTextResult } from '@iark/kernel';
import { stripBom } from './json';
import { PROTO_SYNTAX, checkBrackets, reindent } from './reindent';
import { pascalCase, slugify } from './shared';

interface Pos {
  line: number;
  column: number;
}

interface Token extends Pos {
  kind: 'ident' | 'number' | 'string' | 'symbol';
  text: string;
  value: string;
}

interface ProtoField {
  name: string;
  type: string;
  label?: string;
  oneof?: string;
  mapKey?: string;
  number: number;
  numberText: string;
  pos: Pos;
  typePos: Pos;
  numberPos: Pos;
  keyPos?: Pos;
}

interface ProtoEnumValue {
  name: string;
  number: number;
  numberText: string;
  pos: Pos;
}

interface ProtoEnum {
  name: string;
  pos: Pos;
  values: ProtoEnumValue[];
  allowAlias: boolean;
}

interface ProtoMessage {
  name: string;
  pos: Pos;
  fields: ProtoField[];
  messages: ProtoMessage[];
  enums: ProtoEnum[];
  reservedRanges: Array<{ from: number; to: number }>;
  reservedNames: string[];
}

interface ProtoRpc {
  name: string;
  pos: Pos;
  request: string;
  response: string;
  requestStream: boolean;
  responseStream: boolean;
  requestPos: Pos;
  responsePos: Pos;
}

interface ProtoService {
  name: string;
  pos: Pos;
  rpcs: ProtoRpc[];
}

interface ProtoFile {
  syntax?: { keyword: string; value: string; pos: Pos; first: boolean };
  packages: Array<{ name: string; pos: Pos }>;
  imports: Array<{ path: string; pos: Pos }>;
  messages: ProtoMessage[];
  enums: ProtoEnum[];
  services: ProtoService[];
}

const MAX_FIELD_NUMBER = 536870911;
const SCALARS = new Set(['double', 'float', 'int32', 'int64', 'uint32', 'uint64', 'sint32', 'sint64', 'fixed32', 'fixed64', 'sfixed32', 'sfixed64', 'bool', 'string', 'bytes']);
const MAP_KEYS = new Set(['int32', 'int64', 'uint32', 'uint64', 'sint32', 'sint64', 'fixed32', 'fixed64', 'sfixed32', 'sfixed64', 'bool', 'string']);
const LABELS = new Set(['repeated', 'optional', 'required']);
const SYMBOLS = '{}()[]<>=;,.:+-/';
const OPENERS = '{([';
const CLOSERS = '})]';

const WELL_KNOWN_FILES: Record<string, string> = {
  Any: 'any',
  Api: 'api',
  Method: 'api',
  Mixin: 'api',
  Duration: 'duration',
  Empty: 'empty',
  FieldMask: 'field_mask',
  SourceContext: 'source_context',
  Struct: 'struct',
  Value: 'struct',
  ListValue: 'struct',
  NullValue: 'struct',
  Timestamp: 'timestamp',
  Type: 'type',
  Field: 'type',
  Enum: 'type',
  EnumValue: 'type',
  Option: 'type',
  DoubleValue: 'wrappers',
  FloatValue: 'wrappers',
  Int64Value: 'wrappers',
  UInt64Value: 'wrappers',
  Int32Value: 'wrappers',
  UInt32Value: 'wrappers',
  BoolValue: 'wrappers',
  StringValue: 'wrappers',
  BytesValue: 'wrappers',
};

function tokenize(text: string): { tokens: Token[]; problems: AttachmentDiagnostic[] } {
  const source = stripBom(text).replace(/\r\n?/g, '\n');
  const tokens: Token[] = [];
  const problems: AttachmentDiagnostic[] = [];
  const number = /(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/y;
  let i = 0;
  let line = 1;
  let lineStart = 0;

  while (i < source.length) {
    const char = source[i];
    const column = i - lineStart + 1;
    if (char === '\n') {
      i++;
      line++;
      lineStart = i;
    } else if (char === ' ' || char === '\t') {
      i++;
    } else if (source.startsWith('//', i)) {
      while (i < source.length && source[i] !== '\n') i++;
    } else if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      for (; i < stop; i++) {
        if (source[i] === '\n') {
          line++;
          lineStart = i + 1;
        }
      }
    } else if (char === '"' || char === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== char && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
      const closed = source[j] === char;
      const stop = closed ? j + 1 : Math.min(j, source.length);
      tokens.push({ kind: 'string', text: source.slice(i, stop), value: source.slice(i + 1, closed ? j : stop), line, column });
      i = stop;
    } else if (/[A-Za-z_]/.test(char)) {
      let j = i + 1;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j++;
      tokens.push({ kind: 'ident', text: source.slice(i, j), value: source.slice(i, j), line, column });
      i = j;
    } else if (/[0-9]/.test(char) || (char === '.' && /[0-9]/.test(source[i + 1] ?? ''))) {
      number.lastIndex = i;
      const found = number.exec(source)![0];
      tokens.push({ kind: 'number', text: found, value: found, line, column });
      i += found.length;
    } else if (SYMBOLS.includes(char)) {
      tokens.push({ kind: 'symbol', text: char, value: char, line, column });
      i++;
    } else {
      problems.push({ severity: 'error', message: `Carácter inesperado «${char}».`, line, column });
      i++;
    }
  }
  return { tokens, problems };
}

function numberValue(text: string): number {
  if (/^0[xX]/.test(text)) return parseInt(text, 16);
  if (/^0[0-7]+$/.test(text)) return parseInt(text, 8);
  return /^\d+$/.test(text) ? Number(text) : Number.NaN;
}

class Parser {
  readonly problems: AttachmentDiagnostic[] = [];
  readonly file: ProtoFile = { packages: [], imports: [], messages: [], enums: [], services: [] };
  private index = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): ProtoFile {
    let statements = 0;
    while (this.peek()) {
      const before = this.index;
      const token = this.peek()!;
      if (this.isSymbol(';') || this.isSymbol('}')) {
        this.index++;
      } else if (token.kind !== 'ident') {
        this.fail(`Sentencia no reconocida «${token.text}».`, token);
        this.skipStatement();
      } else {
        this.topLevel(token, statements === 0);
        statements++;
      }
      if (this.index === before) this.index++;
    }
    return this.file;
  }

  private topLevel(token: Token, first: boolean): void {
    switch (token.text) {
      case 'syntax':
      case 'edition':
        return this.parseSyntax(first);
      case 'package':
        return this.parsePackage();
      case 'import':
        return this.parseImport();
      case 'option':
        this.skipStatement();
        return;
      case 'message':
        this.file.messages.push(this.parseMessage());
        return;
      case 'enum':
        this.file.enums.push(this.parseEnum());
        return;
      case 'service':
        return this.parseService();
      case 'extend':
        this.index++;
        while (this.peek() && !this.isSymbol('{') && !this.isSymbol(';')) this.index++;
        if (this.isSymbol('{')) this.skipBlock();
        return;
      default:
        this.fail(`Sentencia no reconocida «${token.text}»: se esperaba syntax, package, import, option, message, enum o service.`, token);
        this.skipStatement();
    }
  }

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.index + offset];
  }

  private isSymbol(symbol: string, offset = 0): boolean {
    const token = this.peek(offset);
    return token?.kind === 'symbol' && token.text === symbol;
  }

  private isIdent(word?: string, offset = 0): boolean {
    const token = this.peek(offset);
    return token?.kind === 'ident' && (word === undefined || token.text === word);
  }

  private fail(message: string, at: Pos): void {
    this.problems.push({ severity: 'error', message, line: at.line, column: at.column });
  }

  /** Para lo que falta al final de una sentencia: se señala el final del último token, no el siguiente (que suele estar en otra línea). */
  private failAfterPrevious(message: string): void {
    const previous = this.tokens[this.index - 1];
    const next = this.peek();
    if (previous && (!next || next.line > previous.line)) this.fail(message, { line: previous.line, column: previous.column + previous.text.length });
    else if (next) this.fail(message, next);
    else this.problems.push({ severity: 'error', message });
  }

  private found(): string {
    const token = this.peek();
    return token ? `«${token.text}»` : 'el final del archivo';
  }

  private expectSymbol(symbol: string): boolean {
    if (this.isSymbol(symbol)) {
      this.index++;
      return true;
    }
    this.failAfterPrevious(`Se esperaba «${symbol}» y se encontró ${this.found()}.`);
    return false;
  }

  private expectIdent(what: string): Token | undefined {
    if (this.isIdent()) return this.tokens[this.index++];
    this.failAfterPrevious(`Se esperaba ${what} y se encontró ${this.found()}.`);
    return undefined;
  }

  private skipStatement(): Token[] {
    const consumed: Token[] = [];
    let depth = 0;
    for (let token = this.peek(); token; token = this.peek()) {
      if (token.kind === 'symbol') {
        if (OPENERS.includes(token.text)) depth++;
        else if (CLOSERS.includes(token.text)) {
          if (depth === 0) return consumed;
          depth--;
        } else if (token.text === ';' && depth === 0) {
          this.index++;
          consumed.push(token);
          return consumed;
        }
      }
      consumed.push(token);
      this.index++;
    }
    return consumed;
  }

  private skipBlock(): void {
    let depth = 0;
    for (let token = this.peek(); token; token = this.peek()) {
      this.index++;
      if (token.kind !== 'symbol') continue;
      if (token.text === '{') depth++;
      else if (token.text === '}' && --depth <= 0) return;
    }
  }

  private skipBracketed(): void {
    let depth = 0;
    for (let token = this.peek(); token; token = this.peek()) {
      this.index++;
      if (token.kind !== 'symbol') continue;
      if (OPENERS.includes(token.text)) depth++;
      else if (CLOSERS.includes(token.text) && --depth <= 0) return;
    }
  }

  private parseSyntax(first: boolean): void {
    const keyword = this.tokens[this.index++];
    if (!this.expectSymbol('=')) return void this.skipStatement();
    const value = this.peek();
    if (value?.kind !== 'string') {
      this.fail(`Se esperaba una cadena (p. ej. "proto3") y se encontró ${this.found()}.`, value ?? keyword);
      return void this.skipStatement();
    }
    this.index++;
    this.expectSymbol(';');
    this.file.syntax ??= { keyword: keyword.text, value: value.value, pos: keyword, first };
  }

  private parseName(what: string): { text: string; pos: Pos } | undefined {
    const start = this.peek();
    let text = '';
    if (this.isSymbol('.')) {
      text = '.';
      this.index++;
    }
    const head = this.expectIdent(what);
    if (!head) return undefined;
    text += head.text;
    while (this.isSymbol('.') && this.isIdent(undefined, 1)) {
      this.index++;
      text += `.${this.tokens[this.index++].text}`;
    }
    return { text, pos: start ?? head };
  }

  private parsePackage(): void {
    const keyword = this.tokens[this.index++];
    const name = this.parseName('el nombre del paquete');
    if (name) this.file.packages.push({ name: name.text, pos: keyword });
    else this.skipStatement();
    this.expectSymbol(';');
  }

  private parseImport(): void {
    const keyword = this.tokens[this.index++];
    if (this.isIdent('public') || this.isIdent('weak')) this.index++;
    const path = this.peek();
    if (path?.kind !== 'string') {
      this.failAfterPrevious(`Se esperaba la ruta del import entre comillas y se encontró ${this.found()}.`);
      return void this.skipStatement();
    }
    this.index++;
    this.expectSymbol(';');
    this.file.imports.push({ path: path.value, pos: keyword });
  }

  private parseSignedNumber(): { value: number; text: string; pos: Pos } | undefined {
    const start = this.peek();
    const negative = this.isSymbol('-');
    if (negative) this.index++;
    const token = this.peek();
    if (token?.kind !== 'number') {
      this.failAfterPrevious(`Se esperaba un número y se encontró ${this.found()}.`);
      return undefined;
    }
    this.index++;
    const value = numberValue(token.text);
    return { value: negative ? -value : value, text: `${negative ? '-' : ''}${token.text}`, pos: start ?? token };
  }

  private parseMessage(): ProtoMessage {
    const keyword = this.tokens[this.index++];
    const name = this.expectIdent('el nombre del mensaje');
    const message: ProtoMessage = { name: name?.text ?? '', pos: name ?? keyword, fields: [], messages: [], enums: [], reservedRanges: [], reservedNames: [] };
    if (!this.expectSymbol('{')) {
      this.skipStatement();
      return message;
    }
    this.parseMessageBody(message, undefined);
    return message;
  }

  private parseMessageBody(message: ProtoMessage, oneof: string | undefined): void {
    for (;;) {
      const token = this.peek();
      if (!token) return;
      const before = this.index;
      if (this.isSymbol('}')) {
        this.index++;
        return;
      }
      if (this.isSymbol(';')) {
        this.index++;
      } else if (token.kind === 'symbol' && token.text === '.' && this.isIdent(undefined, 1)) {
        this.parseField(message, oneof);
      } else if (token.kind !== 'ident') {
        this.fail(`Elemento inesperado «${token.text}».`, token);
        this.skipStatement();
      } else if (token.text === 'message' && this.isIdent(undefined, 1) && !oneof) {
        message.messages.push(this.parseMessage());
      } else if (token.text === 'enum' && this.isIdent(undefined, 1) && !oneof) {
        message.enums.push(this.parseEnum());
      } else if (token.text === 'oneof' && this.isIdent(undefined, 1) && !oneof) {
        this.parseOneof(message);
      } else if (token.text === 'reserved' && !oneof && (this.peek(1)?.kind === 'string' || this.peek(1)?.kind === 'number' || this.isIdent(undefined, 1))) {
        this.parseReserved(message);
      } else if ((token.text === 'option' && (this.isIdent(undefined, 1) || this.isSymbol('(', 1))) || (token.text === 'extensions' && this.peek(1)?.kind === 'number')) {
        this.skipStatement();
      } else if (token.text === 'extend' && !oneof) {
        this.index++;
        while (this.peek() && !this.isSymbol('{') && !this.isSymbol(';')) this.index++;
        if (this.isSymbol('{')) this.skipBlock();
      } else {
        this.parseField(message, oneof);
      }
      if (this.index === before) this.index++;
    }
  }

  private parseOneof(message: ProtoMessage): void {
    this.index++;
    const name = this.expectIdent('el nombre del oneof');
    if (!this.expectSymbol('{')) return void this.skipStatement();
    this.parseMessageBody(message, name?.text ?? '');
  }

  private parseReserved(message: ProtoMessage): void {
    this.index++;
    for (;;) {
      const token = this.peek();
      if (token?.kind === 'string' || token?.kind === 'ident') {
        this.index++;
        message.reservedNames.push(token.value);
      } else {
        const from = this.parseSignedNumber();
        if (!from) return void this.skipStatement();
        let to = from.value;
        if (this.isIdent('to')) {
          this.index++;
          if (this.isIdent('max')) {
            this.index++;
            to = MAX_FIELD_NUMBER;
          } else {
            const end = this.parseSignedNumber();
            if (!end) return void this.skipStatement();
            to = end.value;
          }
        }
        message.reservedRanges.push({ from: from.value, to });
      }
      if (this.isSymbol(',')) this.index++;
      else break;
    }
    this.expectSymbol(';');
  }

  private parseField(message: ProtoMessage, oneof: string | undefined): void {
    let label: string | undefined;
    const first = this.peek()!;
    if (!oneof && LABELS.has(first.text) && (this.isIdent(undefined, 1) || this.isSymbol('.', 1))) {
      label = first.text;
      this.index++;
    }

    let mapKey: string | undefined;
    let keyPos: Pos | undefined;
    let type: { text: string; pos: Pos } | undefined;
    if (this.isIdent('map') && this.isSymbol('<', 1)) {
      this.index += 2;
      const key = this.expectIdent('el tipo de la clave del map');
      if (!key || !this.expectSymbol(',')) return void this.skipStatement();
      mapKey = key.text;
      keyPos = key;
      type = this.parseName('el tipo del valor del map');
      if (!type || !this.expectSymbol('>')) return void this.skipStatement();
    } else {
      type = this.parseName('el tipo del campo');
      if (!type) return void this.skipStatement();
    }

    const name = this.expectIdent('el nombre del campo');
    if (!name || !this.expectSymbol('=')) return void this.skipStatement();
    const number = this.parseSignedNumber();
    if (!number) return void this.skipStatement();
    if (this.isSymbol('[')) this.skipBracketed();
    this.expectSymbol(';');
    message.fields.push({
      name: name.text,
      type: type.text,
      label,
      oneof,
      mapKey,
      number: number.value,
      numberText: number.text,
      pos: name,
      typePos: type.pos,
      numberPos: number.pos,
      keyPos,
    });
  }

  private parseEnum(): ProtoEnum {
    const keyword = this.tokens[this.index++];
    const name = this.expectIdent('el nombre del enum');
    const result: ProtoEnum = { name: name?.text ?? '', pos: name ?? keyword, values: [], allowAlias: false };
    if (!this.expectSymbol('{')) {
      this.skipStatement();
      return result;
    }
    for (;;) {
      const token = this.peek();
      if (!token) return result;
      const before = this.index;
      if (this.isSymbol('}')) {
        this.index++;
        return result;
      }
      if (this.isSymbol(';')) {
        this.index++;
      } else if (token.kind !== 'ident') {
        this.fail(`Elemento inesperado «${token.text}».`, token);
        this.skipStatement();
      } else if (token.text === 'option' || token.text === 'reserved') {
        const statement = this.skipStatement();
        if (token.text === 'option' && statement.map((item) => item.text).join(' ') === 'option allow_alias = true ;') result.allowAlias = true;
      } else {
        this.index++;
        const value = this.expectSymbol('=') ? this.parseSignedNumber() : undefined;
        if (!value) {
          this.skipStatement();
        } else {
          if (this.isSymbol('[')) this.skipBracketed();
          this.expectSymbol(';');
          result.values.push({ name: token.text, number: value.value, numberText: value.text, pos: token });
        }
      }
      if (this.index === before) this.index++;
    }
  }

  private parseService(): void {
    const keyword = this.tokens[this.index++];
    const name = this.expectIdent('el nombre del servicio');
    const service: ProtoService = { name: name?.text ?? '', pos: name ?? keyword, rpcs: [] };
    this.file.services.push(service);
    if (!this.expectSymbol('{')) return void this.skipStatement();
    for (;;) {
      const token = this.peek();
      if (!token) return;
      const before = this.index;
      if (this.isSymbol('}')) {
        this.index++;
        return;
      }
      if (this.isSymbol(';')) {
        this.index++;
      } else if (this.isIdent('rpc')) {
        this.parseRpc(service);
      } else if (this.isIdent('option')) {
        this.skipStatement();
      } else {
        this.fail(`Se esperaba «rpc» u «option» dentro del servicio y se encontró «${token.text}».`, token);
        this.skipStatement();
      }
      if (this.index === before) this.index++;
    }
  }

  private parseRpc(service: ProtoService): void {
    this.index++;
    const name = this.expectIdent('el nombre del rpc');
    if (!name || !this.expectSymbol('(')) return void this.skipStatement();
    const request = this.parseRpcType();
    if (!request || !this.expectSymbol(')')) return void this.skipStatement();
    if (!this.isIdent('returns')) {
      this.failAfterPrevious(`Se esperaba «returns» y se encontró ${this.found()}.`);
      return void this.skipStatement();
    }
    this.index++;
    if (!this.expectSymbol('(')) return void this.skipStatement();
    const response = this.parseRpcType();
    if (!response || !this.expectSymbol(')')) return void this.skipStatement();
    if (this.isSymbol('{')) {
      this.skipBlock();
      if (this.isSymbol(';')) this.index++;
    } else {
      this.expectSymbol(';');
    }
    service.rpcs.push({
      name: name.text,
      pos: name,
      request: request.type,
      response: response.type,
      requestStream: request.stream,
      responseStream: response.stream,
      requestPos: request.pos,
      responsePos: response.pos,
    });
  }

  private parseRpcType(): { type: string; stream: boolean; pos: Pos } | undefined {
    let stream = false;
    if (this.isIdent('stream') && (this.isIdent(undefined, 1) || this.isSymbol('.', 1))) {
      stream = true;
      this.index++;
    }
    const name = this.parseName('el tipo del mensaje');
    return name ? { type: name.text, stream, pos: name.pos } : undefined;
  }
}

function parseProto(text: string): { file: ProtoFile; problems: AttachmentDiagnostic[] } {
  const { tokens, problems } = tokenize(text);
  const parser = new Parser(tokens);
  const file = parser.parse();
  return { file, problems: [...problems, ...parser.problems] };
}

function collectTypes(file: ProtoFile): Set<string> {
  const prefix = file.packages[0]?.name ?? '';
  const types = new Set<string>();
  const qualify = (scope: string, name: string): string => (scope ? `${scope}.${name}` : name);
  const visit = (message: ProtoMessage, scope: string): void => {
    const fqn = qualify(scope, message.name);
    types.add(fqn);
    for (const nested of message.messages) visit(nested, fqn);
    for (const item of message.enums) types.add(qualify(fqn, item.name));
  };
  for (const message of file.messages) visit(message, prefix);
  for (const item of file.enums) types.add(qualify(prefix, item.name));
  return types;
}

class Analysis {
  readonly diagnostics: AttachmentDiagnostic[] = [];
  private readonly types: Set<string>;
  private readonly prefix: string;
  private readonly proto3: boolean;

  constructor(private readonly file: ProtoFile) {
    this.types = collectTypes(file);
    this.prefix = file.packages[0]?.name ?? '';
    this.proto3 = file.syntax?.keyword === 'syntax' && file.syntax.value === 'proto3';
  }

  private add(severity: AttachmentDiagnostic['severity'], message: string, at?: Pos): void {
    this.diagnostics.push(at ? { severity, message, line: at.line, column: at.column } : { severity, message });
  }

  run(): AttachmentDiagnostic[] {
    const { file } = this;
    this.checkHeader();
    this.checkScopeNames(file.messages, file.enums, file.services);
    this.checkEnumScope(file.enums);
    for (const message of file.messages) this.checkMessage(message, this.prefix, message.name);
    for (const item of file.enums) this.checkEnum(item, item.name);
    for (const service of file.services) this.checkService(service);
    return this.diagnostics;
  }

  private checkHeader(): void {
    const { syntax, packages, imports } = this.file;
    if (!syntax) {
      this.add('warning', 'Falta la declaración «syntax»: sin ella se asume proto2. Usa syntax = "proto3";.');
    } else {
      if (!syntax.first) this.add('error', `«${syntax.keyword}» debe ser la primera sentencia del archivo (después de los comentarios).`, syntax.pos);
      if (syntax.keyword === 'syntax') {
        if (syntax.value === 'proto2') this.add('info', 'proto2 funciona con gRPC, pero se recomienda proto3.', syntax.pos);
        else if (syntax.value !== 'proto3') this.add('error', `«syntax» debe ser "proto2" o "proto3" y es "${syntax.value}".`, syntax.pos);
      }
    }
    if (packages.length === 0) this.add('warning', 'Falta «package»: se recomienda declararlo para evitar colisiones de nombres.');
    for (const duplicate of packages.slice(1)) this.add('error', `«package» ya está declarado en la línea ${packages[0].pos.line}.`, duplicate.pos);
    const seen = new Map<string, Pos>();
    for (const item of imports) {
      const previous = seen.get(item.path);
      if (previous) this.add('warning', `El import "${item.path}" está repetido (ya aparece en la línea ${previous.line}).`, item.pos);
      else seen.set(item.path, item.pos);
    }
  }

  private checkScopeNames(messages: ProtoMessage[], enums: ProtoEnum[], services: ProtoService[]): void {
    const seen = new Map<string, Pos>();
    for (const item of [...messages, ...enums, ...services]) {
      if (!item.name) continue;
      const previous = seen.get(item.name);
      if (previous) this.add('error', `El nombre «${item.name}» ya está declarado en este ámbito (línea ${previous.line}).`, item.pos);
      else seen.set(item.name, item.pos);
    }
  }

  /** Los valores de un enum comparten ámbito con los del resto de enums de su mismo nivel. */
  private checkEnumScope(enums: ProtoEnum[]): void {
    const seen = new Map<string, { owner: string; line: number }>();
    for (const item of enums) {
      for (const value of item.values) {
        const previous = seen.get(value.name);
        if (!previous) {
          seen.set(value.name, { owner: item.name, line: value.pos.line });
        } else if (previous.owner !== item.name) {
          this.add('error', `El valor «${value.name}» del enum «${item.name}» ya existe en el enum «${previous.owner}» (línea ${previous.line}): los valores de enum comparten ámbito.`, value.pos);
        }
      }
    }
  }

  private checkEnum(item: ProtoEnum, path: string): void {
    if (item.values.length === 0) this.add('error', `El enum «${path}» no tiene valores.`, item.pos);
    const first = item.values[0];
    if (this.proto3 && first && first.number !== 0) {
      this.add('error', `En proto3 el primer valor de un enum debe ser 0 y «${first.name}» (enum «${path}») vale ${first.numberText}.`, first.pos);
    }
    const names = new Map<string, Pos>();
    const numbers = new Map<number, ProtoEnumValue>();
    for (const value of item.values) {
      const sameName = names.get(value.name);
      if (sameName) this.add('error', `El valor «${value.name}» del enum «${path}» está repetido (línea ${sameName.line}).`, value.pos);
      else names.set(value.name, value.pos);
      if (Number.isNaN(value.number)) {
        this.add('error', `El valor de «${value.name}» (enum «${path}») debe ser un entero.`, value.pos);
        continue;
      }
      const sameNumber = numbers.get(value.number);
      if (sameNumber && !item.allowAlias) {
        this.add('error', `El valor ${value.numberText} del enum «${path}» ya lo usa «${sameNumber.name}» (línea ${sameNumber.pos.line}); activa «option allow_alias = true;» si es intencionado.`, value.pos);
      } else if (!sameNumber) {
        numbers.set(value.number, value);
      }
    }
  }

  private checkMessage(message: ProtoMessage, scope: string, path: string): void {
    const fqn = scope ? `${scope}.${message.name}` : message.name;
    this.checkScopeNames(message.messages, message.enums, []);
    this.checkEnumScope(message.enums);

    const byName = new Map<string, ProtoField>();
    const byNumber = new Map<number, ProtoField>();
    for (const field of message.fields) {
      const where = `${path}.${field.name}`;
      const sameName = byName.get(field.name);
      if (sameName) this.add('error', `El campo «${where}» está repetido (línea ${sameName.pos.line}).`, field.pos);
      else byName.set(field.name, field);

      if (field.label === 'required' && this.proto3) this.add('error', `«${where}»: en proto3 no existe «required»; usa un campo normal u «optional».`, field.pos);
      if (field.mapKey !== undefined && !MAP_KEYS.has(field.mapKey)) {
        this.add('error', `«${where}»: «${field.mapKey}» no puede ser clave de un map (solo enteros, bool y string).`, field.keyPos);
      }

      this.checkFieldNumber(message, field, where, byNumber);
      if (message.reservedNames.includes(field.name)) this.add('error', `El nombre «${field.name}» está reservado (reserved) en «${path}».`, field.pos);
      this.checkFieldType(field, fqn, where);
    }
    for (const nested of message.messages) this.checkMessage(nested, fqn, `${path}.${nested.name}`);
    for (const item of message.enums) this.checkEnum(item, `${path}.${item.name}`);
  }

  private checkFieldNumber(message: ProtoMessage, field: ProtoField, where: string, byNumber: Map<number, ProtoField>): void {
    const { number } = field;
    if (!Number.isInteger(number)) {
      this.add('error', `El número de campo de «${where}» debe ser un entero (es ${field.numberText}).`, field.numberPos);
      return;
    }
    if (number < 1 || number > MAX_FIELD_NUMBER) {
      this.add('error', `El número de campo ${field.numberText} de «${where}» está fuera del rango permitido (1 a ${MAX_FIELD_NUMBER}).`, field.numberPos);
    } else if (number >= 19000 && number <= 19999) {
      this.add('error', `El número de campo ${number} de «${where}» está en el rango 19000-19999, reservado para la implementación de Protocol Buffers.`, field.numberPos);
    }
    const previous = byNumber.get(number);
    if (previous) {
      this.add('error', `El número de campo ${number} de «${where}» ya lo usa «${previous.name}» (línea ${previous.pos.line}).`, field.numberPos);
    } else {
      byNumber.set(number, field);
    }
    if (message.reservedRanges.some((range) => number >= range.from && number <= range.to)) {
      this.add('error', `El número de campo ${number} de «${where}» está reservado (reserved) en «${message.name}».`, field.numberPos);
    }
  }

  private checkFieldType(field: ProtoField, scope: string, where: string): void {
    const wellKnown = this.wellKnownIssue(field.type);
    if (wellKnown) {
      this.add('warning', wellKnown, field.typePos);
    } else if (!this.resolves(field.type, scope) && this.file.imports.length === 0 && !isWellKnown(field.type)) {
      this.add('error', `El tipo «${field.type}» de «${where}» no está declarado en este archivo.`, field.typePos);
    }
  }

  private checkService(service: ProtoService): void {
    if (service.rpcs.length === 0) this.add('warning', `El servicio «${service.name}» no declara ningún rpc.`, service.pos);
    const names = new Map<string, Pos>();
    for (const rpc of service.rpcs) {
      const previous = names.get(rpc.name);
      if (previous) this.add('error', `El rpc «${service.name}.${rpc.name}» está repetido (línea ${previous.line}).`, rpc.pos);
      else names.set(rpc.name, rpc.pos);
      this.checkRpcType(rpc.request, rpc.requestPos, `la petición de «${service.name}.${rpc.name}»`);
      this.checkRpcType(rpc.response, rpc.responsePos, `la respuesta de «${service.name}.${rpc.name}»`);
    }
  }

  private checkRpcType(type: string, at: Pos, role: string): void {
    const wellKnown = this.wellKnownIssue(type);
    if (wellKnown) {
      this.add('warning', wellKnown, at);
    } else if (!this.resolves(type, this.prefix) && !isWellKnown(type)) {
      if (this.file.imports.length > 0) this.add('info', `El tipo «${type}» (${role}) no está declarado en este archivo: se asume que viene de un import y no se puede verificar.`, at);
      else this.add('error', `El tipo «${type}» (${role}) no está declarado en este archivo.`, at);
    }
  }

  private wellKnownIssue(type: string): string | undefined {
    if (!isWellKnown(type)) return undefined;
    const file = WELL_KNOWN_FILES[type.replace(/^\./, '').slice('google.protobuf.'.length)];
    if (!file) return undefined;
    const path = `google/protobuf/${file}.proto`;
    return this.file.imports.some((item) => item.path === path) ? undefined : `El tipo «${type}» necesita «import "${path}";».`;
  }

  private resolves(name: string, scope: string): boolean {
    if (SCALARS.has(name)) return true;
    if (name.startsWith('.')) return this.types.has(name.slice(1));
    for (let current = scope; ; ) {
      if (this.types.has(current ? `${current}.${name}` : name)) return true;
      if (!current) return false;
      const cut = current.lastIndexOf('.');
      current = cut === -1 ? '' : current.slice(0, cut);
    }
  }
}

function isWellKnown(type: string): boolean {
  return type.replace(/^\./, '').startsWith('google.protobuf.');
}

export function checkProto(text: string): AttachmentDiagnostic[] {
  const brackets = checkBrackets(text, PROTO_SYNTAX).map((problem): AttachmentDiagnostic => ({ severity: 'error', ...problem }));
  const { file, problems } = parseProto(text);
  const found = [...brackets, ...problems];
  if (brackets.length === 0) found.push(...new Analysis(file).run());
  return found;
}

export function reformatProto(text: string): AttachmentTextResult {
  const [problem] = checkBrackets(text, PROTO_SYNTAX);
  if (problem) return { ok: false, reason: `${problem.message} (línea ${problem.line}, columna ${problem.column})` };
  return { ok: true, text: reindent(text, PROTO_SYNTAX) };
}

export function summarizeProto(text: string): string[] {
  const { file } = parseProto(text);
  const lines: string[] = [];
  for (const service of file.services) {
    for (const rpc of service.rpcs) {
      const kind = rpc.requestStream ? (rpc.responseStream ? 'bidi' : 'client-stream') : rpc.responseStream ? 'server-stream' : 'unary';
      lines.push(`${service.name}.${rpc.name} (${kind})`);
    }
  }
  let count = 0;
  const visit = (messages: ProtoMessage[]): void => {
    for (const message of messages) {
      count++;
      visit(message.messages);
    }
  };
  visit(file.messages);
  if (count > 0) lines.push(`${count} ${count === 1 ? 'mensaje' : 'mensajes'}`);
  return lines;
}

export function protoTemplate(name: string): string {
  const segment = slugify(name, 'servicio').replace(/-/g, '_');
  const pkg = /^[0-9]/.test(segment) ? `_${segment}` : segment;
  let service = pascalCase(name, 'Servicio');
  if (['ObtenerRequest', 'ListarRequest', 'Recurso'].includes(service)) service = `${service}Service`;
  const title = name.replace(/\s+/g, ' ').trim() || 'Servicio';
  return `syntax = "proto3";

package com.example.${pkg}.v1;

// Contrato gRPC de ${title}.
service ${service} {
  rpc Obtener (ObtenerRequest) returns (Recurso);
  rpc Listar (ListarRequest) returns (stream Recurso);
}

message ObtenerRequest {
  string id = 1;
}

message ListarRequest {
  int32 pagina = 1;
  int32 tamano = 2;
}

message Recurso {
  string id = 1;
  string nombre = 2;
}
`;
}
