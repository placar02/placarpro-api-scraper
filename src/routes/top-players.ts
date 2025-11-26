import express from 'express';
import { fetchTopPlayers } from '../scrapers/top-players';

export const topPlayersRouter = express.Router();

/**
 * @swagger
 * /team/{teamId}/top-players:
 *   get:
 *     summary: Obtém top players de um time em um campeonato/temporada
 *     description: Retorna a lista dos melhores jogadores de um time em um campeonato e temporada específicos, ordenados por rating
 *     tags:
 *       - Team
 *     parameters:
 *       - name: teamId
 *         in: path
 *         description: ID único do time
 *         required: true
 *         schema:
 *           type: number
 *       - name: uniqueTournamentId
 *         in: query
 *         description: ID único do campeonato
 *         required: true
 *         schema:
 *           type: number
 *       - name: seasonId
 *         in: query
 *         description: ID da temporada
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
 *         description: Top players retornados com sucesso
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
 *                     tournamentId:
 *                       type: number
 *                     seasonId:
 *                       type: number
 *                     teamId:
 *                       type: number
 *                     topPlayers:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           playerId:
 *                             type: number
 *                           playerName:
 *                             type: string
 *                           playerSlug:
 *                             type: string
 *                           playerPosition:
 *                             type: string
 *                           playerUserCount:
 *                             type: number
 *                           teamId:
 *                             type: number
 *                           teamName:
 *                             type: string
 *                           teamSlug:
 *                             type: string
 *                           rating:
 *                             type: number
 *                             description: Rating médio do jogador
 *                           statisticsId:
 *                             type: number
 *                           statisticsType:
 *                             type: string
 *                           appearances:
 *                             type: number
 *                             description: Número de aparições
 *                           playedEnough:
 *                             type: boolean
 *                             description: Se o jogador jogou o suficiente para estar no ranking
 *                     totalPlayers:
 *                       type: number
 *                     lastUpdated:
 *                       type: number
 *       400:
 *         description: Parâmetros obrigatórios ausentes
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Top players não encontrados
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Erro ao buscar top players
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
topPlayersRouter.get('/:teamId/top-players', async (req, res) => {
  const { teamId } = req.params;
  const { uniqueTournamentId, seasonId } = req.query;
  const retryOn403 = req.query.retryOn403 === 'false' ? false : true;

  if (!teamId || teamId == ':teamId') {
    return res.status(400).json({ error: 'teamId is required' });
  }

  if (!uniqueTournamentId) {
    return res.status(400).json({ error: 'uniqueTournamentId is required' });
  }

  if (!seasonId) {
    return res.status(400).json({ error: 'seasonId is required' });
  }

  try {
    const topPlayersData = await fetchTopPlayers(
      teamId,
      uniqueTournamentId as string,
      seasonId as string,
      { retryOn403 }
    );

    if (!topPlayersData.data) {
      return res.status(404).json({ error: 'Top players not found' });
    }

    return res.status(200).json({ status: 200, data: topPlayersData.data });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('Error in /team/:teamId/top-players:', err);
    return res.status(500).json({ error: 'Failed to fetch top players', message });
  }
});

/**
 * @swagger
 * /team/{teamId}/unique-tournament/{uniqueTournamentId}/season/{seasonId}/top-players:
 *   get:
 *     summary: Obtém top players com parâmetros no path
 *     description: Retorna a lista dos melhores jogadores com todos os parâmetros no path
 *     tags:
 *       - Team
 *     parameters:
 *       - name: teamId
 *         in: path
 *         description: ID único do time
 *         required: true
 *         schema:
 *           type: number
 *       - name: uniqueTournamentId
 *         in: path
 *         description: ID único do campeonato
 *         required: true
 *         schema:
 *           type: number
 *       - name: seasonId
 *         in: path
 *         description: ID da temporada
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
 *         description: Top players retornados com sucesso
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
 *         description: Top players não encontrados
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Erro ao buscar top players
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
topPlayersRouter.get('/:teamId/unique-tournament/:uniqueTournamentId/season/:seasonId/top-players', async (req, res) => {
  const { teamId, uniqueTournamentId, seasonId } = req.params;
  const retryOn403 = req.query.retryOn403 === 'false' ? false : true;

  if (!teamId || teamId == ':teamId') {
    return res.status(400).json({ error: 'teamId is required' });
  }

  if (!uniqueTournamentId || uniqueTournamentId == ':uniqueTournamentId') {
    return res.status(400).json({ error: 'uniqueTournamentId is required' });
  }

  if (!seasonId || seasonId == ':seasonId') {
    return res.status(400).json({ error: 'seasonId is required' });
  }

  try {
    const topPlayersData = await fetchTopPlayers(teamId, uniqueTournamentId, seasonId, { retryOn403 });

    if (!topPlayersData.data) {
      return res.status(404).json({ error: 'Top players not found' });
    }

    return res.status(200).json({ status: 200, data: topPlayersData.data });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('Error in /team/:teamId/unique-tournament/:uniqueTournamentId/season/:seasonId/top-players:', err);
    return res.status(500).json({ error: 'Failed to fetch top players', message });
  }
});
