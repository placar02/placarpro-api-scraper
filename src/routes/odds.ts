import { Router } from 'express';
import { fetchOdds } from '../scrapers/odds';

export const oddsRouter = Router();

/**
 * @swagger
 * /odds/{eventId}/{marketId}:
 *   get:
 *     summary: Obtém odds para um evento específico com market ID
 *     description: Retorna as odds (cotações) de apostas para um evento e mercado específicos
 *     tags:
 *       - Odds
 *     parameters:
 *       - name: eventId
 *         in: path
 *         description: ID único do evento
 *         required: true
 *         schema:
 *           type: string
 *       - name: marketId
 *         in: path
 *         description: ID do mercado de apostas
 *         required: true
 *         schema:
 *           type: number
 *     responses:
 *       200:
 *         description: Odds retornadas com sucesso
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: number
 *                   example: 200
 *                 data:
 *                   $ref: '#/components/schemas/OddsData'
 *       400:
 *         description: EventId ou marketId inválido
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Dados de odds não encontrados
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Erro ao buscar dados de odds
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
oddsRouter.get('/odds/:eventId/:marketId', async (req, res) => {
  const { eventId, marketId } = req.params;
  console.log('Received /odds request with eventId:', eventId, 'and marketId:', marketId);
  if (!eventId || eventId == ':eventId' || !marketId || marketId == ':marketId') {
    return res.status(400).json({ error: 'eventId is required' });
  }
  const marketIdNum = parseInt(marketId, 10);

  try {
    const oddsData = await fetchOdds(eventId, marketIdNum);
    if (!oddsData) {
      return res.status(404).json({ error: 'Odds data not found' });
    }
    return res.status(200).json({ status: 200, data: oddsData });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return res.status(500).json({ error: 'Failed to fetch odds data', message });
  }
});

/**
 * @swagger
 * /odds/{eventId}:
 *   get:
 *     summary: Obtém odds para um evento com market ID padrão (1)
 *     description: Retorna as odds (cotações) de apostas para um evento usando o market ID padrão
 *     tags:
 *       - Odds
 *     parameters:
 *       - name: eventId
 *         in: path
 *         description: ID único do evento
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Odds retornadas com sucesso
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: number
 *                   example: 200
 *                 data:
 *                   $ref: '#/components/schemas/OddsData'
 *       400:
 *         description: EventId inválido
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Dados de odds não encontrados
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Erro ao buscar dados de odds
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
oddsRouter.get('/odds/:eventId', async (req, res) => {
  const { eventId } = req.params;
  if (!eventId || eventId == ':eventId') {
    return res.status(400).json({ error: 'eventId is required' });
  }
  const marketIdNum = 1;

  try {
    const oddsData = await fetchOdds(eventId, marketIdNum);
    if (!oddsData) {
      return res.status(404).json({ error: 'Odds data not found' });
    }
    return res.status(200).json({ status: 200, data: oddsData });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return res.status(500).json({ error: 'Failed to fetch odds data', message });
  }
});
