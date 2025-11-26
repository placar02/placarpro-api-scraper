import { Router } from 'express';
import { fetchLiveMatches } from '../scrapers/live';
import type { LiveMatchesResponse } from '../scrapers/live';

export const matchesRouter = Router();

/**
 * @swagger
 * /live-matches:
 *   get:
 *     summary: Obtém partidas ao vivo
 *     description: Retorna a lista de partidas em andamento com suporte a cache via ETag
 *     tags:
 *       - Matches
 *     parameters:
 *       - name: retryOn403
 *         in: query
 *         description: Tenta novamente em caso de erro 403
 *         required: false
 *         schema:
 *           type: boolean
 *           default: true
 *       - name: If-None-Match
 *         in: header
 *         description: ETag para validar cache (retorna 304 se não modificado)
 *         required: false
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Partidas ao vivo retornadas com sucesso
 *         headers:
 *           ETag:
 *             schema:
 *               type: string
 *             description: Identificador para cache
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: number
 *                   example: 200
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/LiveMatch'
 *       304:
 *         description: Dados não modificados (cache válido)
 *       500:
 *         description: Erro ao buscar partidas ao vivo
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
matchesRouter.get('/live-matches', async (req, res) => {
  const ifNoneMatch = req.header('if-none-match') || undefined;
  const retryOn403 = req.query.retryOn403 === 'false' ? false : true;

  try {
    const result: LiveMatchesResponse = await fetchLiveMatches({ ifNoneMatch, retryOn403 });

    if (result.status === 304) {
      if (result.etag) res.setHeader('ETag', result.etag as string);
      return res.sendStatus(304);
    }

    if (result.etag) {
      res.setHeader('ETag', result.etag as string);
    }

    const payload = result.events ?? (result as any).raw ?? {};

    return res.status(200).json({ status: result.status ?? 200, data: payload });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('Error in /live-matches:', err);
    return res.status(500).json({ error: 'Failed to fetch live matches', message });
  }
});
