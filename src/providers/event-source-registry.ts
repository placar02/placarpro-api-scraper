export type SportsProvider = 'sofascore' | 'ogol' | '365scores' | 'aiscore';

const sources = new Map<string, { provider: SportsProvider; expiresAt: number }>();
const MAX_EVENT_SOURCES = Math.max(100, Number(process.env.EVENT_SOURCE_CACHE_MAX_ITEMS || 5000));

function pruneSources() {
  const now = Date.now();
  for (const [key, entry] of sources) if (entry.expiresAt <= now) sources.delete(key);
  while (sources.size > MAX_EVENT_SOURCES) sources.delete(sources.keys().next().value as string);
}

export function registerEventSource(events: any[], provider: SportsProvider, ttlMs = 6 * 60 * 60 * 1000) {
  for (const event of events || []) {
    if (!event?.id) continue;
    event.sourceProvider = provider;
    sources.set(String(event.id), { provider, expiresAt: Date.now() + ttlMs });
  }
  pruneSources();
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

const cleanupTimer = setInterval(pruneSources, 5 * 60 * 1000);
cleanupTimer.unref?.();
