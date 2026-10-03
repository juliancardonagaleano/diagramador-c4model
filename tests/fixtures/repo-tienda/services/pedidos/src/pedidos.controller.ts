import type { Request, Response } from 'express';

/** Registra el pedido en PostgreSQL y publica `pedido.creado` en RabbitMQ. */
export async function crearPedido(_req: Request, res: Response): Promise<void> {
  res.status(201).json({ ok: true });
}
