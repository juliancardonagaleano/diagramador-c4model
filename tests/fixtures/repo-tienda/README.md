# Tienda en línea

Plataforma de comercio electrónico formada por tres piezas:

- **web**: la tienda que ve el cliente (React, servida por nginx).
- **pedidos**: servicio REST (Node.js, Express) que registra los pedidos en PostgreSQL y publica el evento
  `pedido.creado` en RabbitMQ.
- **facturacion**: servicio (Java, Spring Boot) que consume `pedido.creado`, emite la factura y cobra con la
  pasarela de pagos externa (Stripe) por HTTPS.

Las tres piezas se despliegan en Kubernetes; en local se levantan con `docker compose up`.
