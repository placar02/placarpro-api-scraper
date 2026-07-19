import { Router } from 'express';
import { fetchEvent } from '../scrapers/event';
import { fetchSofaScoreEnrichment, fetchSofaScoreEnrichmentByProviderEvent } from '../scrapers/sofascore';

export const enrichmentRouter = Router();

/**
 * Diagnostico manual do enriquecimento sem executar o Decision Engine.
 * O ID recebido pertence ao provider principal configurado em SCORES_PROVIDER.
 */
enrichmentRouter.get('/enrichment/sofascore/:eventId', async (req, res) => {
  const { eventId } = req.params;
  if (!eventId || eventId === ':eventId') {
    return res.status(400).json({ ok: false, error: 'eventId is required' });
  }

  try {
    const primaryProvider = process.env.SCORES_PROVIDER || 'sofascore';
    const requestedIdType = String(req.query.idType || 'auto').toLowerCase();
    let eventResponse = requestedIdType === 'sofascore'
      ? await fetchEvent(eventId, { retryOn403: true, provider: 'sofascore' })
      : await fetchEvent(eventId, { retryOn403: true });
    let resolvedFrom = requestedIdType === 'sofascore' ? 'sofascore-id' : 'primary-provider-id';

    if (!eventResponse.data && requestedIdType === 'auto' && primaryProvider !== 'sofascore') {
      eventResponse = await fetchEvent(eventId, { retryOn403: true, provider: 'sofascore' });
      resolvedFrom = 'sofascore-id-fallback';
    }

    if (!eventResponse.data) {
      return res.status(404).json({
        ok: false,
        error: 'Event not found',
        eventId,
        primaryProvider,
        hint: 'Use um ID retornado pela agenda do provider principal ou um ID nativo do SofaScore.',
      });
    }

    const enrichment = resolvedFrom.startsWith('sofascore-id')
      ? await fetchSofaScoreEnrichmentByProviderEvent(eventResponse.data)
      : await fetchSofaScoreEnrichment(eventResponse.data);
    return res.status(200).json({
      ok: enrichment.available,
      primaryProvider,
      resolvedFrom,
      eventId,
      enrichment,
    });
  } catch (error) {
    console.error('[DataEnrichmentRoute]', error);
    return res.status(502).json({
      ok: false,
      error: 'Failed to enrich event with SofaScore',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
