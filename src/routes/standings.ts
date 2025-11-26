import { Router } from 'express';
import { fetchStandings } from '../scrapers/standings';

export const standingsRouter = Router();

/**
 * @swagger
 * /standings/{tournamentId}/{seasonId}:
 *   get:
 *     summary: Obtém a classificação de um campeonato
 *     description: Retorna a tabela de classificação (standings) completa de um campeonato em uma determinada temporada
 *     tags:
 *       - Standings
 *     parameters:
 *       - name: tournamentId
 *         in: path
 *         description: ID único do torneio
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
 *         description: Classificação retornada com sucesso
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
 *         description: Dados de classificação não encontrados
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Erro ao buscar dados de classificação
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
standingsRouter.get('/standings/:tournamentId/:seasonId', async (req, res) => {
  const { tournamentId, seasonId } = req.params;
  const retryOn403 = req.query.retryOn403 === 'false' ? false : true;

  if (!tournamentId || tournamentId == ':tournamentId' || !seasonId || seasonId == ':seasonId') {
    return res.status(400).json({ error: 'tournamentId and seasonId are required' });
  }

  try {
    const standingsData = await fetchStandings(tournamentId, seasonId, { retryOn403 });

    if (standingsData.status === 304) {
      return res.sendStatus(304);
    }

    if (!standingsData.data) {
      return res.status(404).json({ error: 'Standings data not found' });
    }

    // Adicionar URLs de imagem dos times à resposta
    const enhancedData = {
      ...standingsData.data,
      teams: standingsData.data.teams?.map((team: any) => ({
        ...team,
        image: `/team/${team.teamId}/image`,
        imageSmall: `/team/${team.teamId}/image/small`
      })) || []
    };

    return res.status(200).json({ status: 200, data: enhancedData });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('Error in /standings:', err);
    return res.status(500).json({ error: 'Failed to fetch standings data', message });
  }
});
