import type { AttachmentDiagnostic, AttachmentTextResult } from '@iark/kernel';
import { XMLBuilder, XMLParser, XMLValidator } from 'fast-xml-parser';
import { stripBom } from './json';
import { pascalCase, slugify } from './shared';

const ROOTS = ['definitions', 'description'];

const XML_MESSAGES: Array<[RegExp, (match: RegExpExecArray) => string]> = [
  [/^Closing tag '(.+)' has not been opened\.$/, (m) => `la etiqueta de cierre «</${m[1]}>» no tiene su apertura`],
  [/^Unclosed tag '(.+)'\.$/, (m) => `la etiqueta «<${m[1]}>» no se cierra`],
  [/^Expected closing tag '(.+)' \(opened in line (\d+), col (\d+)\) instead of closing tag '(.+)'\.$/, (m) => `se esperaba «</${m[1]}>» (abierta en la línea ${m[2]}, columna ${m[3]}) y se encontró «</${m[4]}>»`],
  [/^Attribute '(.+)' is repeated\.$/, (m) => `el atributo «${m[1]}» está repetido`],
  [/^Attribute '(.+)' is without value\.$/, (m) => `el atributo «${m[1]}» no tiene valor`],
  [/^Attributes for '(.+)' have open quote\.$/, (m) => `los atributos de «${m[1]}» tienen una comilla sin cerrar`],
  [/^char '(.+)' is not expected\.$/, (m) => `carácter inesperado «${m[1]}»`],
  [/^Multiple possible root nodes found\.$/, () => 'hay más de un elemento raíz'],
  [/^Start tag expected\.$/, () => 'se esperaba una etiqueta de apertura'],
  [/^Extra text at the end$/, () => 'hay texto sobrante al final del documento'],
];

function describeXmlError(message: string): string {
  for (const [pattern, translate] of XML_MESSAGES) {
    const match = pattern.exec(message);
    if (match) return translate(match);
  }
  return message;
}

export function checkWsdl(text: string): AttachmentDiagnostic[] {
  const source = stripBom(text);
  const result = XMLValidator.validate(source);
  if (result !== true) {
    const { msg, line, col } = result.err;
    return [{ severity: 'error', message: `XML mal formado: ${describeXmlError(msg)}.`, line, column: col }];
  }
  const root = rootName(source);
  if (root && !ROOTS.includes(root)) {
    return [{ severity: 'warning', message: `La raíz es «${root}»: un WSDL empieza por «definitions» (WSDL 1.1) o «description» (WSDL 2.0).`, line: 1, column: 1 }];
  }
  return [];
}

function parse(source: string): Record<string, unknown> | undefined {
  try {
    return new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true }).parse(source) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function rootName(source: string): string | undefined {
  return Object.keys(parse(source) ?? {}).find((key) => !key.startsWith('?'));
}

export function reformatWsdl(text: string): AttachmentTextResult {
  const source = stripBom(text);
  const result = XMLValidator.validate(source);
  if (result !== true) return { ok: false, reason: `XML mal formado: ${describeXmlError(result.err.msg)} (línea ${result.err.line}, columna ${result.err.col})` };
  const options = { ignoreAttributes: false, attributeNamePrefix: '@_', preserveOrder: true, commentPropName: '#comment', cdataPropName: '#cdata', trimValues: true, parseTagValue: false, parseAttributeValue: false, processEntities: false };
  try {
    const tree = new XMLParser(options).parse(source);
    const built = new XMLBuilder({ ...options, format: true, indentBy: '  ', suppressEmptyNode: true }).build(tree) as string;
    return { ok: true, text: `${built.trim()}\n` };
  } catch (error) {
    return { ok: false, reason: `No se pudo reescribir el XML: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function asList(value: unknown): unknown[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function names(value: unknown): string[] {
  return asList(value).flatMap((item) => {
    const name = (item as Record<string, unknown> | null)?.['@_name'];
    return typeof name === 'string' ? [name] : [];
  });
}

export function summarizeWsdl(text: string): string[] {
  const root = parse(stripBom(text));
  const definitions = (root?.definitions ?? root?.description) as Record<string, unknown> | undefined;
  if (!definitions || typeof definitions !== 'object') return [];
  const lines: string[] = [];
  for (const service of names(definitions.service)) lines.push(`servicio ${service}`);
  for (const portType of asList(definitions.portType ?? definitions.interface) as Array<Record<string, unknown>>) {
    const interfaceName = typeof portType?.['@_name'] === 'string' ? portType['@_name'] : '?';
    for (const operation of names(portType?.operation)) lines.push(`${interfaceName}.${operation}`);
  }
  return lines;
}

export function wsdlTemplate(name: string): string {
  const service = pascalCase(name, 'Servicio');
  const namespace = `http://example.com/${slugify(name, 'servicio')}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<definitions name="${service}" targetNamespace="${namespace}" xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:tns="${namespace}" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/">
  <types>
    <xsd:schema targetNamespace="${namespace}">
      <xsd:element name="ObtenerRequest">
        <xsd:complexType>
          <xsd:sequence>
            <xsd:element name="id" type="xsd:string"/>
          </xsd:sequence>
        </xsd:complexType>
      </xsd:element>
      <xsd:element name="ObtenerResponse">
        <xsd:complexType>
          <xsd:sequence>
            <xsd:element name="estado" type="xsd:string"/>
          </xsd:sequence>
        </xsd:complexType>
      </xsd:element>
    </xsd:schema>
  </types>
  <message name="ObtenerRequest">
    <part name="parameters" element="tns:ObtenerRequest"/>
  </message>
  <message name="ObtenerResponse">
    <part name="parameters" element="tns:ObtenerResponse"/>
  </message>
  <portType name="${service}PortType">
    <operation name="Obtener">
      <input message="tns:ObtenerRequest"/>
      <output message="tns:ObtenerResponse"/>
    </operation>
  </portType>
  <binding name="${service}Binding" type="tns:${service}PortType">
    <soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
    <operation name="Obtener">
      <soap:operation soapAction="${namespace}/Obtener"/>
      <input>
        <soap:body use="literal"/>
      </input>
      <output>
        <soap:body use="literal"/>
      </output>
    </operation>
  </binding>
  <service name="${service}">
    <port name="${service}Port" binding="tns:${service}Binding">
      <soap:address location="https://api.example.com/${slugify(name, 'servicio')}"/>
    </port>
  </service>
</definitions>
`;
}
