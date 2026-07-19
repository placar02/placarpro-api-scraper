import { Router } from 'express';
import { fetchOdds } from '../scrapers/odds';
import { fetchAiScoreOdds } from '../scrapers/aiscore';
import { fetch365Odds } from '../scrapers/scores365';
import { fetchOgolOdds } from '../scrapers/ogol';
import { betanoOddsEnabled, fetchBetanoOddsForMatch } from '../scrapers/betano-odds';

export const oddsRouter = Router();

oddsRouter.get('/real-odds/betano', async (req, res) => {
  if (!betanoOddsEnabled()) {
    return res.status(503).json({ status: 503, source: 'betano', error: 'Provider Betano desativado.' });
  }
  const home = String(req.query.home || '').trim();
  const away = String(req.query.away || '').trim();
  const startTimestamp = Number(req.query.startTimestamp);
  if (!home || !away) return res.status(400).json({ error: 'home e away sao obrigatorios.' });
  try {
    const data = await fetchBetanoOddsForMatch({
      homeTeam: { name: home },
      awayTeam: { name: away },
      startTimestamp: Number.isFinite(startTimestamp) ? startTimestamp : undefined,
    });
    if (!data) return res.status(404).json({ status: 404, source: 'betano', error: 'Partida ou odds nao encontradas.' });
    return res.json({ status: 200, source: 'betano', data });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(503).json({ status: 503, source: 'betano', error: message });
  }
});

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
    const oddsData = process.env.SCORES_PROVIDER === '365scores'
      ? await fetch365Odds(eventId)
      : process.env.SCORES_PROVIDER === 'ogol'
        ? await fetchOgolOdds(eventId)
      : process.env.SCORES_PROVIDER === 'aiscore'
        ? await fetchAiScoreOdds(eventId)
        : await fetchOdds(eventId, marketIdNum);
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
    const oddsData = process.env.SCORES_PROVIDER === '365scores'
      ? await fetch365Odds(eventId)
      : process.env.SCORES_PROVIDER === 'ogol'
        ? await fetchOgolOdds(eventId)
      : process.env.SCORES_PROVIDER === 'aiscore'
        ? await fetchAiScoreOdds(eventId)
        : await fetchOdds(eventId, marketIdNum);
    if (!oddsData) {
      return res.status(404).json({ error: 'Odds data not found' });
    }
    return res.status(200).json({ status: 200, data: oddsData });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return res.status(500).json({ error: 'Failed to fetch odds data', message });
  }
});
