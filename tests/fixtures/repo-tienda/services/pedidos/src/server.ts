import express from 'express';
import { crearPedido } from './pedidos.controller';

const app = express();
app.use(express.json());
app.post('/pedidos', crearPedido);
app.listen(3000);
