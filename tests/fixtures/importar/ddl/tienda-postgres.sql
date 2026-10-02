--
-- PostgreSQL database dump (esquema de la tienda en línea)
--

SET statement_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;

CREATE SCHEMA tienda;
CREATE SCHEMA analitica;

COMMENT ON SCHEMA tienda IS 'Datos operacionales de la tienda en línea';

/* ───────── tablas ───────── */

CREATE TABLE tienda.clientes (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    email character varying(255) NOT NULL,
    nombre text NOT NULL,
    telefono character varying(20),
    pais character(2) DEFAULT 'ES'::bpchar NOT NULL,
    creado_en timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT clientes_email_check CHECK ((position('@' in email) > 1))
);

CREATE TABLE tienda.direcciones (
    id bigint NOT NULL,
    cliente_id uuid NOT NULL,
    calle text NOT NULL,
    ciudad text NOT NULL,
    codigo_postal character varying(10),
    principal boolean DEFAULT false NOT NULL
);

CREATE TABLE tienda.perfiles (
    cliente_id uuid NOT NULL,
    preferencias jsonb,
    boletin boolean DEFAULT false
);

CREATE TABLE tienda.categorias (
    id integer NOT NULL,
    nombre text NOT NULL,
    padre_id integer
);

CREATE TABLE tienda.productos (
    id integer NOT NULL,
    sku character varying(32) NOT NULL,
    nombre text NOT NULL,
    categoria_id integer,
    precio numeric(12,2) NOT NULL,
    etiquetas text[],
    activo boolean DEFAULT true NOT NULL
);

CREATE TABLE tienda.pedidos (
    id bigint NOT NULL,
    cliente_id uuid NOT NULL,
    direccion_id bigint,
    estado character varying(20) DEFAULT 'nuevo'::character varying NOT NULL,
    total numeric(12,2) NOT NULL,
    creado_en timestamp without time zone DEFAULT now() NOT NULL
);

CREATE TABLE tienda.pedido_lineas (
    pedido_id bigint NOT NULL,
    linea integer NOT NULL,
    producto_id integer NOT NULL,
    cantidad integer NOT NULL,
    precio_unitario numeric(12,2) NOT NULL
);

CREATE TABLE tienda.pagos (
    id bigint NOT NULL,
    pedido_id bigint NOT NULL,
    metodo character varying(20) NOT NULL,
    importe numeric(12,2) NOT NULL,
    pagado_en timestamp with time zone
);

CREATE UNLOGGED TABLE IF NOT EXISTS analitica.cache_resumen (
    clave text,
    valor jsonb
);

CREATE SEQUENCE tienda.pedidos_id_seq START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;

COMMENT ON TABLE tienda.clientes IS 'Personas que compran en la tienda';
COMMENT ON COLUMN tienda.clientes.email IS 'Correo con el que inicia sesión';
COMMENT ON TABLE tienda.pedidos IS 'Un pedido por compra; sus líneas están en pedido_lineas';
COMMENT ON COLUMN tienda.pedidos.estado IS 'nuevo, pagado, enviado o cancelado';

/* ───────── vistas ───────── */

CREATE VIEW analitica.ventas_por_cliente AS
 SELECT c.id AS cliente_id,
    c.pais,
    count(DISTINCT p.id) AS pedidos,
    sum(p.total) AS total_gastado,
    max(p.creado_en) AS ultimo_pedido
   FROM (tienda.clientes c
     LEFT JOIN tienda.pedidos p ON ((p.cliente_id = c.id)))
  GROUP BY c.id, c.pais;

CREATE MATERIALIZED VIEW analitica.productos_top AS
 WITH ventas AS (
         SELECT l.producto_id,
            sum(l.cantidad) AS unidades
           FROM tienda.pedido_lineas l
          GROUP BY l.producto_id
        )
 SELECT pr.id,
    pr.nombre,
    v.unidades
   FROM (ventas v
     JOIN tienda.productos pr ON ((pr.id = v.producto_id)))
  ORDER BY v.unidades DESC
 LIMIT 20
  WITH NO DATA;

CREATE VIEW analitica.generador AS
 SELECT g AS n FROM generate_series(1, 100) g;

/* ───────── funciones e índices ───────── */

CREATE FUNCTION tienda.total_pedido(p_id bigint) RETURNS numeric
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN (SELECT sum(cantidad * precio_unitario) FROM tienda.pedido_lineas WHERE pedido_id = p_id);
END;
$$;

ALTER TABLE tienda.clientes OWNER TO tienda_admin;

--
-- Restricciones
--

ALTER TABLE ONLY tienda.clientes
    ADD CONSTRAINT clientes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY tienda.clientes
    ADD CONSTRAINT clientes_email_key UNIQUE (email);

ALTER TABLE ONLY tienda.direcciones
    ADD CONSTRAINT direcciones_pkey PRIMARY KEY (id);

ALTER TABLE ONLY tienda.perfiles
    ADD CONSTRAINT perfiles_pkey PRIMARY KEY (cliente_id);

ALTER TABLE ONLY tienda.categorias
    ADD CONSTRAINT categorias_pkey PRIMARY KEY (id);

ALTER TABLE ONLY tienda.productos
    ADD CONSTRAINT productos_pkey PRIMARY KEY (id);

ALTER TABLE ONLY tienda.productos
    ADD CONSTRAINT productos_sku_key UNIQUE (sku);

ALTER TABLE ONLY tienda.pedidos
    ADD CONSTRAINT pedidos_pkey PRIMARY KEY (id);

ALTER TABLE ONLY tienda.pedido_lineas
    ADD CONSTRAINT pedido_lineas_pkey PRIMARY KEY (pedido_id, linea);

ALTER TABLE ONLY tienda.pagos
    ADD CONSTRAINT pagos_pkey PRIMARY KEY (id);

ALTER TABLE ONLY tienda.pagos
    ADD CONSTRAINT pagos_pedido_id_key UNIQUE (pedido_id);

CREATE INDEX idx_pedidos_cliente ON tienda.pedidos USING btree (cliente_id);
CREATE INDEX idx_lineas_producto ON tienda.pedido_lineas USING btree (producto_id);

ALTER TABLE ONLY tienda.direcciones
    ADD CONSTRAINT direcciones_cliente_fk FOREIGN KEY (cliente_id) REFERENCES tienda.clientes(id) ON DELETE CASCADE;

ALTER TABLE ONLY tienda.perfiles
    ADD CONSTRAINT perfiles_cliente_fk FOREIGN KEY (cliente_id) REFERENCES tienda.clientes(id);

ALTER TABLE ONLY tienda.categorias
    ADD CONSTRAINT categorias_padre_fk FOREIGN KEY (padre_id) REFERENCES tienda.categorias(id);

ALTER TABLE ONLY tienda.productos
    ADD CONSTRAINT productos_categoria_fk FOREIGN KEY (categoria_id) REFERENCES tienda.categorias(id);

ALTER TABLE ONLY tienda.pedidos
    ADD CONSTRAINT pedidos_cliente_fk FOREIGN KEY (cliente_id) REFERENCES tienda.clientes(id);

ALTER TABLE ONLY tienda.pedidos
    ADD CONSTRAINT pedidos_direccion_fk FOREIGN KEY (direccion_id) REFERENCES tienda.direcciones(id);

ALTER TABLE ONLY tienda.pedido_lineas
    ADD CONSTRAINT lineas_pedido_fk FOREIGN KEY (pedido_id) REFERENCES tienda.pedidos(id) ON DELETE CASCADE;

ALTER TABLE ONLY tienda.pedido_lineas
    ADD CONSTRAINT lineas_producto_fk FOREIGN KEY (producto_id) REFERENCES tienda.productos(id);

ALTER TABLE ONLY tienda.pagos
    ADD CONSTRAINT pagos_pedido_fk FOREIGN KEY (pedido_id) REFERENCES tienda.pedidos(id);

GRANT SELECT ON ALL TABLES IN SCHEMA analitica TO lectura_bi;
