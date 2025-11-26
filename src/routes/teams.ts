import express from 'express';
import { fetchTeamInfo } from '../scrapers/team-info';

export const teamsRouter = express.Router();

/**
 * @swagger
 * /team/{teamId}:
 *   get:
 *     summary: Obtém informações completas de um time
 *     description: Retorna informações detalhadas de um time, incluindo manager, estádio, cores, etc
 *     tags:
 *       - Team
 *     parameters:
 *       - name: teamId
 *         in: path
 *         description: ID único do time
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
 *         description: Informações do time retornadas com sucesso
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
 *                       type: number
 *                     name:
 *                       type: string
 *                       example: "Chelsea"
 *                     shortName:
 *                       type: string
 *                     fullName:
 *                       type: string
 *                     slug:
 *                       type: string
 *                     nameCode:
 *                       type: string
 *                       example: "CHE"
 *                     gender:
 *                       type: string
 *                       example: "M"
 *                     national:
 *                       type: boolean
 *                     sport:
 *                       type: object
 *                       properties:
 *                         name:
 *                           type: string
 *                         slug:
 *                           type: string
 *                     country:
 *                       type: object
 *                       properties:
 *                         alpha2:
 *                           type: string
 *                         alpha3:
 *                           type: string
 *                         name:
 *                           type: string
 *                     manager:
 *                       type: object
 *                       nullable: true
 *                       properties:
 *                         id:
 *                           type: number
 *                         name:
 *                           type: string
 *                         slug:
 *                           type: string
 *                         country:
 *                           type: string
 *                     venue:
 *                       type: object
 *                       nullable: true
 *                       properties:
 *                         id:
 *                           type: number
 *                         name:
 *                           type: string
 *                         capacity:
 *                           type: number
 *                         city:
 *                           type: string
 *                         coordinates:
 *                           type: object
 *                           properties:
 *                             latitude:
 *                               type: number
 *                             longitude:
 *                               type: number
 *                     colors:
 *                       type: object
 *                       properties:
 *                         primary:
 *                           type: string
 *                         secondary:
 *                           type: string
 *                         text:
 *                           type: string
 *                     tournament:
 *                       type: object
 *                       nullable: true
 *                       properties:
 *                         name:
 *                           type: string
 *                         slug:
 *                           type: string
 *                     userCount:
 *                       type: number
 *                     foundation:
 *                       type: object
 *                       properties:
 *                         timestamp:
 *                           type: number
 *                         year:
 *                           type: number
 *                     pregameForm:
 *                       type: object
 *                       nullable: true
 *                       properties:
 *                         form:
 *                           type: array
 *                           items:
 *                             type: string
 *                             enum: [W, D, L]
 *                         avgRating:
 *                           type: string
 *                         position:
 *                           type: number
 *                         value:
 *                           type: string
 *                     lastUpdated:
 *                       type: number
 *                     image:
 *                       type: string
 *                       example: /team/{teamId}/image
 *                     imageSmall:
 *                       type: string
 *                       example: /team/{teamId}/image/small
 *       400:
 *         description: TeamId inválido
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Informações do time não encontradas
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Erro ao buscar informações do time
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
teamsRouter.get('/:teamId', async (req, res) => {
  const { teamId } = req.params;
  const retryOn403 = req.query.retryOn403 === 'false' ? false : true;

  if (!teamId || teamId == ':teamId') {
    return res.status(400).json({ error: 'teamId is required' });
  }

  try {
    const teamData = await fetchTeamInfo(teamId, { retryOn403 });

    if (!teamData.data) {
      return res.status(404).json({ error: 'Team data not found' });
    }

    // Adicionar URLs de imagem à resposta
    const enhancedData = {
      ...teamData.data,
      image: `/team/${teamId}/image`,
      imageSmall: `/team/${teamId}/image/small`
    };

    return res.status(200).json({ status: 200, data: enhancedData });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('Error in /team/:teamId:', err);
    return res.status(500).json({ error: 'Failed to fetch team info', message });
  }
});
