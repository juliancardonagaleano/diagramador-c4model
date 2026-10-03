CREATE TABLE pedidos (
  id          UUID PRIMARY KEY,
  cliente_id  UUID NOT NULL,
  total       NUMERIC(12, 2) NOT NULL,
  creado_en   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE lineas_pedido (
  pedido_id   UUID NOT NULL REFERENCES pedidos (id),
  producto_id UUID NOT NULL,
  cantidad    INTEGER NOT NULL
);
