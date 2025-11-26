import { Router } from 'express';
import { fetchStatistics } from '../scrapers/statistics';
import { fetchStandings } from '../scrapers/standings';
import { fetchIncidents } from '../scrapers/incidents';
import { fetchGraph } from '../scrapers/graph';
import { fetchStreaks } from '../scrapers/streaks';

export const eventsRouter = Router();

/**
 * @swagger
 * /event/{eventId}/statistics:
 *   get:
 *     summary: Obtém estatísticas de um evento
 *     description: Retorna as estatísticas completas de um evento esportivo (posse, chutes, escanteios, etc)
 *     tags:
 *       - Events
 *     parameters:
 *       - name: eventId
 *         in: path
 *         description: ID único do evento
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Estatísticas retornadas com sucesso
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
 *                     homeTeam:
 *                       type: object
 *                       properties:
 *                         image:
 *                           type: string
 *                           example: /team/{teamId}/image
 *                         imageSmall:
 *                           type: string
 *                           example: /team/{teamId}/image/small
 *                     awayTeam:
 *                       type: object
 *                       properties:
 *                         image:
 *                           type: string
 *                           example: /team/{teamId}/image
 *                         imageSmall:
 *                           type: string
 *                           example: /team/{teamId}/image/small
 *                     players:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           image:
 *                             type: string
 *                             example: /player/{playerId}/image
 *                           imageSmall:
 *                             type: string
 *                             example: /player/{playerId}/image/small
 *       400:
 *         description: EventId inválido
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Dados de estatísticas não encontrados
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Erro ao buscar dados de estatísticas
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
eventsRouter.get('/event/:eventId/statistics', async (req, res) => {
  const { eventId } = req.params;
  if (!eventId || eventId == ':eventId') {
    return res.status(400).json({ error: 'eventId is required' });
  }
  try {
    const statisticsData = await fetchStatistics(eventId);
    if (!statisticsData) {
      return res.status(404).json({ error: 'Statistics data not found' });
    }

    // Adicionar URLs de imagem ao resposta
    const enhancedData = {
      ...statisticsData,
      homeTeam: {
        ...statisticsData.homeTeam,
        image: `/team/${statisticsData.homeTeam?.id}/image`,
        imageSmall: `/team/${statisticsData.homeTeam?.id}/image/small`
      },
      awayTeam: {
        ...statisticsData.awayTeam,
        image: `/team/${statisticsData.awayTeam?.id}/image`,
        imageSmall: `/team/${statisticsData.awayTeam?.id}/image/small`
      },
      players: statisticsData.players?.map((player: any) => ({
        ...player,
        image: `/player/${player.id}/image`,
        imageSmall: `/player/${player.id}/image/small`
      }))
    };

    return res.status(200).json({ status: 200, data: enhancedData });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return res.status(500).json({ error: 'Failed to fetch statistics data', message });
  }
});

/**
 * @swagger
 * /event/{eventId}/incidents:
 *   get:
 *     summary: Obtém os incidentes de um evento
 *     description: Retorna todos os incidentes de um evento (gols, cartões, substituições, etc)
 *     tags:
 *       - Events
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
 *         description: Incidentes retornados com sucesso
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
 *       400:
 *         description: EventId inválido
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Incidentes não encontrados
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Erro ao buscar incidentes
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
eventsRouter.get('/event/:eventId/incidents', async (req, res) => {
  const { eventId } = req.params;
  const retryOn403 = req.query.retryOn403 === 'false' ? false : true;

  if (!eventId || eventId == ':eventId') {
    return res.status(400).json({ error: 'eventId is required' });
  }

  try {
    const incidentsData = await fetchIncidents(eventId, { retryOn403 });

    if (!incidentsData.data) {
      return res.status(404).json({ error: 'Incidents data not found' });
    }

    return res.status(200).json({ status: 200, data: incidentsData.data });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('Error in /event/:eventId/incidents:', err);
    return res.status(500).json({ error: 'Failed to fetch incidents data', message });
  }
});

/**
 * @swagger
 * /event/{eventId}/graph:
 *   get:
 *     summary: Obtém o gráfico de momentos (performance graph) de um evento
 *     description: Retorna os pontos do gráfico de performance ao longo do jogo, mostrando a vantagem de cada time por minuto
 *     tags:
 *       - Events
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
 *         description: Gráfico retornado com sucesso
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
 *       400:
 *         description: EventId inválido
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Gráfico não encontrado
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Erro ao buscar gráfico
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
eventsRouter.get('/event/:eventId/graph', async (req, res) => {
  const { eventId } = req.params;
  const retryOn403 = req.query.retryOn403 === 'false' ? false : true;

  if (!eventId || eventId == ':eventId') {
    return res.status(400).json({ error: 'eventId is required' });
  }

  try {
    const graphData = await fetchGraph(eventId, { retryOn403 });

    if (!graphData.data) {
      return res.status(404).json({ error: 'Graph data not found' });
    }

    return res.status(200).json({ status: 200, data: graphData.data });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('Error in /event/:eventId/graph:', err);
    return res.status(500).json({ error: 'Failed to fetch graph data', message });
  }
});

/**
 * @swagger
 * /event/{eventId}/streaks:
 *   get:
 *     summary: Obtém as sequências de um evento
 *     description: Retorna as sequências gerais e de confronto direto de um evento (vitórias, derrotas, gols, cartões, etc)
 *     tags:
 *       - Events
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
 *         description: Sequências retornadas com sucesso
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
 *       400:
 *         description: EventId inválido
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Sequências não encontradas
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Erro ao buscar sequências
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
eventsRouter.get('/event/:eventId/streaks', async (req, res) => {
  const { eventId } = req.params;
  const retryOn403 = req.query.retryOn403 === 'false' ? false : true;

  if (!eventId || eventId == ':eventId') {
    return res.status(400).json({ error: 'eventId is required' });
  }

  try {
    const streaksData = await fetchStreaks(eventId, { retryOn403 });

    if (!streaksData.data) {
      return res.status(404).json({ error: 'Streaks data not found' });
    }

    return res.status(200).json({ status: 200, data: streaksData.data });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('Error in /event/:eventId/streaks:', err);
    return res.status(500).json({ error: 'Failed to fetch streaks data', message });
  }
});
