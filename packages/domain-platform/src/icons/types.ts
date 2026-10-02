import type { ResourceKind } from '../types';

/** Tipo de elemento al que encaja un icono: los de recurso y las redes de nivel superior (una VPC o una red virtual). */
export type IconKind = ResourceKind | 'network';

/**
 * Icono de un servicio de un proveedor de nube: trazos SVG dibujados en una caja de 16 × 16 (`M`, `L`, `C`, `A`, `Z`…), sin
 * relleno, que el lienzo, el SVG y el `.drawio` pintan con el color de acento del paquete sobre una ficha blanca.
 */
export interface IconDef {
  /** Nombre del servicio tal como se ofrece en el selector («Amazon RDS»). */
  label: string;
  /** Trazados (atributo `d`) de una caja de 16 × 16. */
  paths: string[];
  /** Tipos de recurso que suele implementar: si el recurso no indica el servicio, y solo uno del paquete encaja con su tipo, se sugiere. */
  kinds?: IconKind[];
  /** Palabras que, en la tecnología del recurso («PostgreSQL», «Redis»…), identifican el servicio. */
  keywords?: string[];
}

/**
 * Paquete de iconos de un proveedor. `provider` es la clave que escribe `Resource.provider` («aws», «azure», «gcp»…); varios
 * paquetes pueden ser del mismo proveedor y se superponen en el orden en que se registran (o aparecen en el documento): el
 * último sustituye, servicio a servicio, a los anteriores. Así un paquete con los iconos oficiales (si se tiene licencia
 * para usarlos) reemplaza a los propios sin tocar el documento.
 */
export interface IconPack {
  id: string;
  name: string;
  provider: string;
  /** Color de acento (`#rrggbb`): el del borde y los trazos de la ficha (AWS naranja, Azure azul). */
  color: string;
  /** Otros nombres con los que un documento puede escribir el proveedor («amazon web services»). */
  aliases?: string[];
  /** Servicios por clave («rds», «sql-database»). */
  icons: Record<string, IconDef>;
}
