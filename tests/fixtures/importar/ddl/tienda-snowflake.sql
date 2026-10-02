-- Almacén analítico de la tienda en Snowflake
CREATE OR REPLACE SCHEMA analitica COMMENT = 'Capa analítica';

CREATE OR REPLACE TABLE analitica.dim_cliente (
    cliente_key NUMBER(38,0) AUTOINCREMENT START 1 INCREMENT 1 NOT NULL,
    cliente_id VARCHAR(36) NOT NULL COMMENT 'Id en el sistema operacional',
    email VARCHAR(255),
    pais VARCHAR(2),
    atributos VARIANT,
    cargado_en TIMESTAMP_NTZ(9) DEFAULT CURRENT_TIMESTAMP(),
    CONSTRAINT pk_dim_cliente PRIMARY KEY (cliente_key),
    CONSTRAINT uq_dim_cliente UNIQUE (cliente_id)
) COMMENT = 'Una fila por cliente' CLUSTER BY (pais);

CREATE OR REPLACE TRANSIENT TABLE IF NOT EXISTS analitica.stg_pedidos (
    pedido_id NUMBER(19,0) NOT NULL,
    cliente_id VARCHAR(36),
    total NUMBER(12,2),
    creado_en TIMESTAMP_NTZ
);

CREATE OR REPLACE TABLE analitica.fact_ventas (
    venta_key NUMBER AUTOINCREMENT,
    cliente_key NUMBER(38,0) NOT NULL REFERENCES analitica.dim_cliente (cliente_key),
    fecha DATE NOT NULL,
    importe NUMBER(12,2),
    PRIMARY KEY (venta_key)
);

CREATE OR REPLACE TABLE analitica.ventas_mes AS
SELECT DATE_TRUNC('month', f.fecha) AS mes, SUM(f.importe) AS importe
FROM analitica.fact_ventas f
GROUP BY 1;

CREATE OR REPLACE SECURE VIEW analitica.v_clientes_activos
  COMMENT = 'Clientes con compras'
AS
SELECT d.cliente_key, d.email
FROM analitica.dim_cliente d
JOIN analitica.fact_ventas f ON f.cliente_key = d.cliente_key;

CREATE OR REPLACE DYNAMIC TABLE analitica.ventas_dia
  TARGET_LAG = '1 hour'
  WAREHOUSE = transformacion
  AS
  SELECT fecha, SUM(importe) AS importe FROM analitica.fact_ventas GROUP BY fecha;

CREATE OR REPLACE STAGE analitica.carga_s3 URL = 's3://tienda/carga/';
