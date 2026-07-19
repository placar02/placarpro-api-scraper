import { chromium, type Browser } from 'playwright';

type CacheEntry = { expiresAt: number; promise: Promise<SofaApiResult> };
export type SofaApiResult = { data: any; endpoint: string; durationMs: number };

const cache = new Map<string, CacheEntry>();
let circuitFailures = 0;
let circuitOpenUntil = 0;
let browserPromise: Promise<Browser> | null = null;
let browserIdleTimer: NodeJS.Timeout | null = null;
const bases = () => [...new Set([
  process.env.SOFASCORE_BASE_URL || 'https://www.sofascore.com/api/v1',
  'https://api.sofascore.com/api/v1',
  'https://www.sofascore.com/api/v1',
])];

function prune() {
  if (cache.size <= 500) return;
  const now = Date.now();
  for (const [key, item] of cache) if (item.expiresAt <= now) cache.delete(key);
  while (cache.size > 500) cache.delete(cache.keys().next().value as string);
}

async function getBrowser() {
  if (!browserPromise) {
    const proxyServer = process.env.SOFASCORE_PROXY_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
    const launchOptions = { proxy: proxyServer ? { server: proxyServer } : undefined };
    const channels = [process.env.SOFASCORE_BROWSER_CHANNEL, 'chrome', 'msedge'].filter(Boolean) as string[];
    browserPromise = (async () => {
      for (const channel of channels) {
        try {
          return await chromium.launch({ ...launchOptions, channel });
        } catch {
          // Continue to the bundled Chromium fallback.
        }
      }
      return chromium.launch(launchOptions);
    })();
    browserPromise.then((browser) => browser.on('disconnected', () => { browserPromise = null; })).catch(() => { browserPromise = null; });
  }
  if (browserIdleTimer) clearTimeout(browserIdleTimer);
  browserIdleTimer = setTimeout(async () => {
    const pending = browserPromise;
    browserPromise = null;
    if (pending) await pending.then((browser) => browser.close()).catch(() => undefined);
  }, Number(process.env.SOFASCORE_BROWSER_IDLE_TIMEOUT_MS || 120000));
  browserIdleTimer.unref?.();
  return browserPromise;
}

async function requestWithBrowser(endpoint: string, started: number): Promise<SofaApiResult> {
  const browser = await getBrowser();
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
    extraHTTPHeaders: {
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      Origin: 'https://www.sofascore.com',
      Referer: 'https://www.sofascore.com/',
    },
  });
  try {
    const response = await page.goto(endpoint, {
      waitUntil: 'domcontentloaded',
      timeout: Number(process.env.SOFASCORE_ENRICHMENT_BROWSER_TIMEOUT_MS || 15000),
    });
    if (!response?.ok()) throw new Error(`HTTP ${response?.status() || 'sem resposta'}`);
    return { data: await response.json(), endpoint, durationMs: Date.now() - started };
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function requestUncached(path: string): Promise<SofaApiResult> {
  if (circuitOpenUntil > Date.now()) {
    throw new Error(`SofaScore temporariamente indisponivel ate ${new Date(circuitOpenUntil).toISOString()}`);
  }
  const started = Date.now();
  const errors: string[] = [];
  const browserErrors: string[] = [];
  for (const base of bases()) {
    const endpoint = `${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(process.env.SOFASCORE_ENRICHMENT_REQUEST_TIMEOUT_MS || 8000));
    try {
      const response = await fetch(endpoint, {
        signal: controller.signal,
        headers: {
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
          Origin: 'https://www.sofascore.com',
          Referer: 'https://www.sofascore.com/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
        },
      });
      if (!response.ok) {
        errors.push(`${response.status} ${endpoint}`);
        continue;
      }
      const data = await response.json();
      circuitFailures = 0;
      circuitOpenUntil = 0;
      return { data, endpoint, durationMs: Date.now() - started };
    } catch (error) {
      errors.push(`${endpoint}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timeout);
    }
  }
  if (process.env.SOFASCORE_ENRICHMENT_BROWSER_FALLBACK !== 'false') {
    for (const base of bases()) {
      const endpoint = `${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
      try {
        const result = await requestWithBrowser(endpoint, started);
        circuitFailures = 0;
        circuitOpenUntil = 0;
        return result;
      } catch (error) {
        const message = `browser ${endpoint}: ${error instanceof Error ? error.message : String(error)}`;
        browserErrors.push(message);
        errors.push(message);
      }
    }
  }
  const message = errors.join(' | ') || `SofaScore indisponivel para ${path}`;
  const availabilityErrors = browserErrors.length ? browserErrors.join(' | ') : message;
  if (/\b(403|429|5\d\d)\b|abort|fetch failed|econn/i.test(availabilityErrors)) {
    circuitFailures += 1;
    if (circuitFailures >= Number(process.env.SOFASCORE_ENRICHMENT_CIRCUIT_FAILURES || 3)) {
      circuitOpenUntil = Date.now() + Number(process.env.SOFASCORE_ENRICHMENT_CIRCUIT_RESET_MS || 300000);
    }
  }
  throw new Error(message);
}

export function fetchSofaApi(path: string, ttlMs = Number(process.env.SOFASCORE_ENRICHMENT_CACHE_TTL_MS || 900000)) {
  const key = path.replace(/^\//, '');
  const current = cache.get(key);
  if (current && current.expiresAt > Date.now()) return current.promise;
  const promise = requestUncached(key);
  const failureTtlMs = Number(process.env.SOFASCORE_ENRICHMENT_FAILURE_CACHE_TTL_MS || 60000);
  promise.catch(() => {
    const entry = cache.get(key);
    if (entry?.promise === promise) entry.expiresAt = Date.now() + Math.max(1000, failureTtlMs);
  });
  cache.set(key, { expiresAt: Date.now() + Math.max(1000, ttlMs), promise });
  prune();
  return promise;
}

export async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const current = index++;
      results[current] = await mapper(items[current]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length || 1) }, () => worker()));
  return results;
}
