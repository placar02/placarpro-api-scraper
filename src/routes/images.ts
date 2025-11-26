import { Router } from 'express';
import { fetchImage } from '../scrapers/images';

export const imagesRouter = Router();

/**
 * @swagger
 * /team/{teamId}/image:
 *   get:
 *     summary: Obtém a imagem do time (tamanho grande)
 *     description: Retorna a imagem em alta resolução do time
 *     tags:
 *       - Images
 *     parameters:
 *       - name: teamId
 *         in: path
 *         description: ID único do time
 *         required: true
 *         example: 1957
 *         schema:
 *           type: number
 *     responses:
 *       200:
 *         description: Imagem do time retornada com sucesso
 *         content:
 *           image/png:
 *             schema:
 *               type: string
 *               format: binary
 *       400:
 *         description: TeamId inválido
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Imagem do time não encontrada
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Erro ao buscar imagem do time
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
imagesRouter.get('/team/:teamId/image', async (req, res) => {
  const { teamId } = req.params;

  if (!teamId || teamId == ':teamId') {
    return res.status(400).json({ error: 'teamId is required' });
  }

  try {
    const imageResponse = await fetchImage('team', teamId);
    const imageBuffer = await imageResponse.arrayBuffer();

    res.setHeader('Content-Type', imageResponse.headers.get('content-type') || 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');

    return res.send(Buffer.from(imageBuffer));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('Error in /team/:teamId/image:', err);
    return res.status(500).json({ error: 'Failed to fetch team image', message });
  }
});

/**
 * @swagger
 * /team/{teamId}/image/small:
 *   get:
 *     summary: Obtém a imagem pequena do time
 *     description: Retorna a imagem em baixa resolução do time
 *     tags:
 *       - Images
 *     parameters:
 *       - name: teamId
 *         in: path
 *         description: ID único do time
 *         required: true
 *         example: 1957
 *         schema:
 *           type: number
 *     responses:
 *       200:
 *         description: Imagem pequena do time retornada com sucesso
 *         content:
 *           image/png:
 *             schema:
 *               type: string
 *               format: binary
 *       400:
 *         description: TeamId inválido
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Imagem do time não encontrada
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Erro ao buscar imagem do time
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
imagesRouter.get('/team/:teamId/image/small', async (req, res) => {
  const { teamId } = req.params;

  if (!teamId || teamId == ':teamId') {
    return res.status(400).json({ error: 'teamId is required' });
  }

  try {
    const imageResponse = await fetchImage('team', teamId, { size: 'small' });
    const imageBuffer = await imageResponse.arrayBuffer();

    res.setHeader('Content-Type', imageResponse.headers.get('content-type') || 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');

    return res.send(Buffer.from(imageBuffer));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('Error in /team/:teamId/image/small:', err);
    return res.status(500).json({ error: 'Failed to fetch team image', message });
  }
});

/**
 * @swagger
 * /player/{playerId}/image:
 *   get:
 *     summary: Obtém a imagem do jogador (tamanho grande)
 *     description: Retorna a imagem em alta resolução do jogador
 *     tags:
 *       - Images
 *     parameters:
 *       - name: playerId
 *         in: path
 *         description: ID único do jogador
 *         required: true
 *         example: 750
 *         schema:
 *           type: number
 *     responses:
 *       200:
 *         description: Imagem do jogador retornada com sucesso
 *         content:
 *           image/png:
 *             schema:
 *               type: string
 *               format: binary
 *       400:
 *         description: PlayerId inválido
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Imagem do jogador não encontrada
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Erro ao buscar imagem do jogador
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
imagesRouter.get('/player/:playerId/image', async (req, res) => {
  const { playerId } = req.params;

  if (!playerId || playerId == ':playerId') {
    return res.status(400).json({ error: 'playerId is required' });
  }

  try {
    const imageResponse = await fetchImage('player', playerId);
    const imageBuffer = await imageResponse.arrayBuffer();

    res.setHeader('Content-Type', imageResponse.headers.get('content-type') || 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');

    return res.send(Buffer.from(imageBuffer));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('Error in /player/:playerId/image:', err);
    return res.status(500).json({ error: 'Failed to fetch player image', message });
  }
});

/**
 * @swagger
 * /player/{playerId}/image/small:
 *   get:
 *     summary: Obtém a imagem pequena do jogador
 *     description: Retorna a imagem em baixa resolução do jogador
 *     tags:
 *       - Images
 *     parameters:
 *       - name: playerId
 *         in: path
 *         description: ID único do jogador
 *         required: true
 *         example: 750
 *         schema:
 *           type: number
 *     responses:
 *       200:
 *         description: Imagem pequena do jogador retornada com sucesso
 *         content:
 *           image/png:
 *             schema:
 *               type: string
 *               format: binary
 *       400:
 *         description: PlayerId inválido
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Imagem do jogador não encontrada
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Erro ao buscar imagem do jogador
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
imagesRouter.get('/player/:playerId/image/small', async (req, res) => {
  const { playerId } = req.params;

  if (!playerId || playerId == ':playerId') {
    return res.status(400).json({ error: 'playerId is required' });
  }

  try {
    const imageResponse = await fetchImage('player', playerId, { size: 'small' });
    const imageBuffer = await imageResponse.arrayBuffer();

    res.setHeader('Content-Type', imageResponse.headers.get('content-type') || 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');

    return res.send(Buffer.from(imageBuffer));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('Error in /player/:playerId/image/small:', err);
    return res.status(500).json({ error: 'Failed to fetch player image', message });
  }
});
