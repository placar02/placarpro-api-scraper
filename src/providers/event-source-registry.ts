export type SportsProvider = 'sofascore' | 'ogol' | '365scores' | 'aiscore';

const sources = new Map<string, { provider: SportsProvider; expiresAt: number }>();

export function registerEventSource(events: any[], provider: SportsProvider, ttlMs = 6 * 60 * 60 * 1000) {
  for (const event of events || []) {
    if (!event?.id) continue;
    event.sourceProvider = provider;
    sources.set(String(event.id), { provider, expiresAt: Date.now() + ttlMs });
  }
}

export function resolveEventSource(eventId: number | string) {
  const current = sources.get(String(eventId));
  if (!current) return undefined;
  if (current.expiresAt <= Date.now()) {
    sources.delete(String(eventId));
    return undefined;
  }
  return current.provider;
}
