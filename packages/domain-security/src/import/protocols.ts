/**
 * Cifrado en tránsito que se deduce del nombre de un protocolo: `true` si es de los que van cifrados (HTTPS, TLS, mTLS, AMQPS,
 * SFTP…), `false` si es texto claro sin ambigüedad (HTTP, FTP, Telnet, LDAP) y `undefined` si no se puede saber (TCP, gRPC, Kafka…).
 */
export function encryptionOf(protocol: string | undefined): boolean | undefined {
  if (!protocol) return undefined;
  if (/\b(https|tls|ssl|mtls|amqps|mqtts|sftp|ssh|wss|ldaps|smtps|grpcs|ftps)\b/i.test(protocol)) return true;
  if (/^\s*(http|ftp|telnet|ldap)\s*$/i.test(protocol)) return false;
  return undefined;
}
