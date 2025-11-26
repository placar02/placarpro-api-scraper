import { Router } from 'express';
import { fetchEvent } from '../scrapers/event';

export const eventRouter = Router();

/**
 * @swagger
 * /event/{eventId}:
 *   get:
 *     summary: Obtém detalhes completos de um evento
 *     description: Retorna todas as informações de um evento esportivo incluindo times, placar, estádio, árbitro, etc
 *     tags:
 *       - Event
 *     parameters:
 *       - name: eventId
 *         in: path
 *         description: ID único do evento
 *         required: true
 *         schema:
 *           type: number
 *       - name: retryOn403
 *         in: query
 *         description: Tenta novamente em caso de erro 403
 *         required: false
 *         schema:
 *           type: boolean
 *           default: true
 *     responses:
 *       200:
 *         description: Detalhes do evento retornados com sucesso
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: number
 *                   example: 200
 *                 data:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: number
 *                       description: ID único do evento
 *                     slug:
 *                       type: string
 *                       description: Identificador único em URL-friendly format
 *                     status:
 *                       type: object
 *                       properties:
 *                         code:
 *                           type: number
 *                         description:
 *                           type: string
 *                         type:
 *                           type: string
 *                     tournament:
 *                       type: object
 *                       properties:
 *                         id:
 *                           type: number
 *                         name:
 *                           type: string
 *                         slug:
 *                           type: string
 *                     season:
 *                       type: object
 *                       properties:
 *                         id:
 *                           type: number
 *                         name:
 *                           type: string
 *                         year:
 *                           type: string
 *                     round:
 *                       type: number
 *                       description: Número da rodada
 *                     homeTeam:
 *                       type: object
 *                       properties:
 *                         id:
 *                           type: number
 *                         name:
 *                           type: string
 *                         slug:
 *                           type: string
 *                         shortName:
 *                           type: string
 *                     awayTeam:
 *                       type: object
 *                       properties:
 *                         id:
 *                           type: number
 *                         name:
 *                           type: string
 *                         slug:
 *                           type: string
 *                         shortName:
 *                           type: string
 *                     score:
 *                       type: object
 *                       properties:
 *                         home:
 *                           type: number
 *                           description: Placar atual do time da casa
 *                         away:
 *                           type: number
 *                           description: Placar atual do time visitante
 *                         homeDisplay:
 *                           type: number
 *                           description: Placar de exibição do time da casa
 *                         awayDisplay:
 *                           type: number
 *                           description: Placar de exibição do time visitante
 *                     venue:
 *                       type: object
 *                       properties:
 *                         id:
 *                           type: number
 *                         name:
 *                           type: string
 *                         slug:
 *                           type: string
 *                         city:
 *                           type: string
 *                         capacity:
 *                           type: number
 *                     referee:
 *                       type: object
 *                       properties:
 *                         id:
 *                           type: number
 *                         name:
 *                           type: string
 *                         slug:
 *                           type: string
 *                     startTime:
 *                       type: number
 *                       description: Timestamp de início do evento
 *                     currentTime:
 *                       type: number
 *                       description: Timestamp atual do evento
 *                     features:
 *                       type: object
 *                       properties:
 *                         hasXg:
 *                           type: boolean
 *                         hasPlayerStats:
 *                           type: boolean
 *                         hasHeatMap:
 *                           type: boolean
 *       400:
 *         description: EventId inválido
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Erro ao buscar evento
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
eventRouter.get('/event/:eventId', async (req, res) => {
  const { eventId } = req.params;
  const retryOn403 = req.query.retryOn403 === 'false' ? false : true;

  if (!eventId || eventId == ':eventId') {
    return res.status(400).json({ error: 'eventId is required' });
  }

  try {
    const eventData = await fetchEvent(eventId, { retryOn403 });

    if (!eventData.data) {
      return res.status(404).json({ error: 'Event not found' });
    }

    return res.status(200).json({ status: 200, data: eventData.data });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('Error in /event/:eventId:', err);
    return res.status(500).json({ error: 'Failed to fetch event', message });
  }
});
