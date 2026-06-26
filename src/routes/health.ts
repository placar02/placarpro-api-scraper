import { Router } from 'express';
import { envPath } from '../config/env';

export const healthRouter = Router();

/**
 * @swagger
 * /:
 *   get:
 *     summary: Verifica se o servidor está respondendo
 *     description: Retorna uma mensagem de confirmação
 *     tags:
 *       - Health
 *     responses:
 *       200:
 *         description: Servidor operacional
 *         content:
 *           text/plain:
 *             schema:
 *               type: string
 */
healthRouter.get('/', (req, res) => {
  res.send('Hello, World!');
});

/**
 * @swagger
 * /health:
 *   get:
 *     summary: Health check da API
 *     description: Verifica o status de saúde da API
 *     tags:
 *       - Health
 *     responses:
 *       200:
 *         description: API está saudável
 *         content:
 *           text/plain:
 *             schema:
 *               type: string
 */
healthRouter.get('/health', (req, res) => {
  res.status(200).send('OK');
});

healthRouter.get('/health/provider', (req, res) => {
  res.status(200).json({
    ok: true,
    provider: process.env.SCORES_PROVIDER || 'sofascore',
    envPath,
    cwd: process.cwd(),
  });
});
