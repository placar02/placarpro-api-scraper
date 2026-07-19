import type { NormalizedEvent } from '../types/event';
import type { DataEnrichmentProvider, NormalizedMatchEnrichment } from './contracts';
import { sofaScoreProvider } from '../scrapers/sofascore';
import { ogolProvider } from '../scrapers/ogol-enrichment';

const providers: DataEnrichmentProvider[] = [sofaScoreProvider, ogolProvider];

export async function collectSupplementalEnrichment(event: NormalizedEvent) {
  const primary = String(event.sourceProvider || process.env.SCORES_PROVIDER || 'sofascore').toLowerCase();
  const active = providers.filter((provider) => provider.enabled() && provider.id !== primary);
  const results = await Promise.all(active.map(async (provider) => {
    const started = Date.now();
    try {
      const result = await provider.enrich(event);
      console.info('[DataProvider]', JSON.stringify({
        eventId: event.id,
        provider: provider.id,
        available: result.available,
        durationMs: Date.now() - started,
        reason: result.reason,
      }));
      return result;
    } catch (error) {
      console.warn('[DataProvider]', JSON.stringify({
        eventId: event.id,
        provider: provider.id,
        available: false,
        durationMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      }));
      return null;
    }
  }));
  return results.filter((result): result is NormalizedMatchEnrichment => Boolean(result));
}
