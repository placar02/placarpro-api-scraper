import express from 'express';
import { fetchTeamNextEvents } from '../scrapers/team-events';

export const teamEventsRouter = express.Router();

/**
 * @swagger
 * /team/{teamId}/events/next:
 *   get:
 *     summary: Obtém próximos eventos de um time
 *     description: Retorna a lista de próximos eventos de um time, paginado
 *     tags:
 *       - Team
 *     parameters:
 *       - name: teamId
 *         in: path
 *         description: ID único do time
 *         required: true
 *         schema:
 *           type: number
 *       - name: page
 *         in: query
 *         description: Número da página (padrão 0)
 *         required: false
 *         schema:
 *           type: number
 *           default: 0
 *       - name: retryOn403
 *         in: query
 *         description: Tenta novamente em caso de erro 403
 *         required: false
 *         schema:
 *           type: boolean
 *           default: true
 *     responses:
 *       200:
 *         description: Próximos eventos retornados com sucesso
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
 *                     teamId:
 *                       type: string
 *                     events:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           eventId:
 *                             type: number
 *                           customId:
 *                             type: string
 *                           startTimestamp:
 *                             type: number
 *                           startDate:
 *                             type: string
 *                             format: date-time
 *                           tournament:
 *                             type: object
 *                             properties:
 *                               id:
 *                                 type: number
 *                               name:
 *                                 type: string
 *                               slug:
 *                                 type: string
 *                               priority:
 *                                 type: number
 *                           season:
 *                             type: object
 *                             properties:
 *                               name:
 *                                 type: string
 *                               year:
 *                                 type: string
 *                           round:
 *                             type: number
 *                           roundName:
 *                             type: string
 *                           homeTeam:
 *                             type: object
 *                             properties:
 *                               id:
 *                                 type: number
 *                               name:
 *                                 type: string
 *                               slug:
 *                                 type: string
 *                               nameCode:
 *                                 type: string
 *                           awayTeam:
 *                             type: object
 *                             properties:
 *                               id:
 *                                 type: number
 *                               name:
 *                                 type: string
 *                               slug:
 *                                 type: string
 *                               nameCode:
 *                                 type: string
 *                           status:
 *                             type: string
 *                             enum: [notstarted, inprogress, finished, postponed, cancelled]
 *                           slug:
 *                             type: string
 *                     hasNextPage:
 *                       type: boolean
 *                     totalEvents:
 *                       type: number
 *                     lastUpdated:
 *                       type: number
 *       400:
 *         description: TeamId inválido
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Eventos não encontrados
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Erro ao buscar próximos eventos
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
teamEventsRouter.get('/:teamId/events/next', async (req, res) => {
  const { teamId } = req.params;
  const page = parseInt(req.query.page as string, 10) || 0;
  const retryOn403 = req.query.retryOn403 === 'false' ? false : true;

  if (!teamId || teamId == ':teamId') {
    return res.status(400).json({ error: 'teamId is required' });
  }

  try {
    const eventsData = await fetchTeamNextEvents(teamId, page, { retryOn403 });

    if (!eventsData.data) {
      return res.status(404).json({ error: 'Team events not found' });
    }

    return res.status(200).json({ status: 200, data: eventsData.data });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('Error in /team/:teamId/events/next:', err);
    return res.status(500).json({ error: 'Failed to fetch team events', message });
  }
});

/**
 * @swagger
 * /team/{teamId}/events/next/{page}:
 *   get:
 *     summary: Obtém próximos eventos de um time com página específica
 *     description: Retorna a lista paginada de próximos eventos de um time
 *     tags:
 *       - Team
 *     parameters:
 *       - name: teamId
 *         in: path
 *         description: ID único do time
 *         required: true
 *         schema:
 *           type: number
 *       - name: page
 *         in: path
 *         description: Número da página
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
 *         description: Próximos eventos retornados com sucesso
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
 *         description: Parâmetros inválidos
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Eventos não encontrados
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Erro ao buscar próximos eventos
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
teamEventsRouter.get('/:teamId/events/next/:page', async (req, res) => {
  const { teamId, page: pageStr } = req.params;
  const retryOn403 = req.query.retryOn403 === 'false' ? false : true;

  if (!teamId || teamId == ':teamId') {
    return res.status(400).json({ error: 'teamId is required' });
  }

  if (!pageStr || pageStr == ':page') {
    return res.status(400).json({ error: 'page is required' });
  }

  const page = parseInt(pageStr, 10);
  if (isNaN(page) || page < 0) {
    return res.status(400).json({ error: 'page must be a non-negative integer' });
  }

  try {
    const eventsData = await fetchTeamNextEvents(teamId, page, { retryOn403 });

    if (!eventsData.data) {
      return res.status(404).json({ error: 'Team events not found' });
    }

    return res.status(200).json({ status: 200, data: eventsData.data });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('Error in /team/:teamId/events/next/:page:', err);
    return res.status(500).json({ error: 'Failed to fetch team events', message });
  }
});
