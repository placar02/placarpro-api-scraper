import { Router } from 'express';
import { fetchLineups } from '../scrapers/lineups';
import { fetchAiScoreLineups } from '../scrapers/aiscore';
import { fetch365Lineups } from '../scrapers/scores365';
import { fetchOgolLineups } from '../scrapers/ogol';

export const lineupsRouter = Router();

/**
 * GET /event/:eventId/lineups
 */
lineupsRouter.get('/event/:eventId/lineups', async (req, res) => {
  const { eventId } = req.params;
  if (!eventId || eventId === ':eventId') {
    return res.status(400).json({ error: 'eventId is required' });
  }

  try {
    const data = process.env.SCORES_PROVIDER === '365scores'
      ? await fetch365Lineups(eventId)
      : process.env.SCORES_PROVIDER === 'ogol'
        ? await fetchOgolLineups(eventId)
      : process.env.SCORES_PROVIDER === 'aiscore'
        ? await fetchAiScoreLineups(eventId)
        : await fetchLineups(eventId);
    if (data.status === 200 && data.data) {
      // Optionally enrich player/team images here; for now return normalized data
      return res.status(200).json({ status: 200, data: data.data });
    }

    if (data.status === 404) {
      return res.status(404).json({ error: 'Lineups not found' });
    }

    return res.status(500).json({ error: 'Failed to fetch lineups' });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('Error in /event/:eventId/lineups:', err);
    return res.status(500).json({ error: 'Failed to fetch lineups', message });
  }
});
