import { Router } from 'express';
import { fetchSearch } from '../scrapers/search';

export const searchRouter = Router();

/**
 * @swagger
 * /search/teams:
 *   get:
 *     summary: Busca times por query
 *     description: Retorna uma lista de times filtrados pela busca, incluindo informações como ID, nome, país, cores, etc
 *     tags:
 *       - Search
 *     parameters:
 *       - name: q
 *         in: query
 *         description: Termo de busca para filtrar times
 *         required: true
 *         schema:
 *           type: string
 *           example: "Corinthians"
 *       - name: page
 *         in: query
 *         description: Página dos resultados (começa em 0)
 *         required: false
 *         schema:
 *           type: number
 *           default: 0
 *           example: 0
 *       - name: retryOn403
 *         in: query
 *         description: Tenta novamente em caso de erro 403
 *         required: false
 *         schema:
 *           type: boolean
 *           default: true
 *     responses:
 *       200:
 *         description: Resultados da busca retornados com sucesso
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
 *         description: Query obrigatória não fornecida
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Erro ao buscar times
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
searchRouter.get('/search/teams', async (req, res) => {
  const { q, page } = req.query;
  const retryOn403 = req.query.retryOn403 === 'false' ? false : true;

  if (!q || typeof q !== 'string' || q.trim() === '') {
    return res.status(400).json({ error: 'Query parameter q is required' });
  }

  const pageNum = page ? parseInt(page as string, 10) : 0;

  try {
    const searchData = await fetchSearch(q, pageNum, { retryOn403 });

    if (!searchData.data) {
      return res.status(404).json({ error: 'Search results not found' });
    }

    return res.status(200).json({ status: 200, data: searchData.data });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('Error in /search/teams:', err);
    return res.status(500).json({ error: 'Failed to fetch search results', message });
  }
});
