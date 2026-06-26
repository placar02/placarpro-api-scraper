import { chromium, Browser } from 'playwright';
import type { EventLive } from '../types/event.live';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';
const BASE_URL = process.env.SOFASCORE_BASE_URL || 'https://sofascore.com/api/v1';
const SOFASCORE_PROXY_URL = process.env.SOFASCORE_PROXY_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
const SOFASCORE_BROWSER_CHANNELS = [
  process.env.SOFASCORE_BROWSER_CHANNEL,
  'chrome',
  'msedge',
].filter((channel): channel is string => Boolean(channel));
const FALLBACK_BASE_URLS = [...new Set([
  BASE_URL,
  'https://www.sofascore.com/api/v1',
  'https://api.sofascore.com/api/v1',
  'https://sofascore.com/api/v1',
])];
const SCHEDULE_TIMEOUT_MS = Number(process.env.SOFASCORE_SCHEDULE_TIMEOUT_MS || 4000);
const SCHEDULE_CACHE_TTL_MS = Number(process.env.SOFASCORE_SCHEDULE_CACHE_TTL_MS || 60000);

const scheduleCache = new Map<string, {
  expiresAt: number;
  promise: Promise<ScheduledMatchesResponse>;
}>();

export interface ScheduledMatchesResponse {
  status?: number;
  events?: EventLive[];
  raw?: unknown;
  url?: string;
  attempts?: Array<{ url: string; status?: number; events: number; error?: string }>;
}

async function launchSofascoreBrowser(): Promise<Browser> {
  const launchOptions = {
    proxy: SOFASCORE_PROXY_URL ? { server: SOFASCORE_PROXY_URL } : undefined,
  };

  for (const channel of SOFASCORE_BROWSER_CHANNELS) {
    try {
      return await chromium.launch({ ...launchOptions, channel });
    } catch (error) {
      console.warn(`Could not launch Playwright browser channel "${channel}":`, error);
    }
  }

  return chromium.launch(launchOptions);
}

export async function fetchScheduledMatches(date: string, retryOn403 = true): Promise<ScheduledMatchesResponse> {
  const cacheKey = `${date}:${retryOn403 ? 'retry' : 'no-retry'}:${SOFASCORE_PROXY_URL || 'no-proxy'}`;
  const cached = scheduleCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.promise;
  }

  const promise = fetchScheduledMatchesUncached(date, retryOn403)
    .finally(() => {
      const current = scheduleCache.get(cacheKey);
      if (current?.promise === promise && current.expiresAt <= Date.now()) {
        scheduleCache.delete(cacheKey);
      }
    });

  scheduleCache.set(cacheKey, {
    expiresAt: Date.now() + SCHEDULE_CACHE_TTL_MS,
    promise,
  });

  return promise;
}

async function fetchScheduledMatchesUncached(date: string, retryOn403 = true): Promise<ScheduledMatchesResponse> {
  let browser: Browser | null = null;
  browser = await launchSofascoreBrowser();

  const context = await browser.newContext({
    userAgent: UA,
    extraHTTPHeaders: {
      Origin: 'https://www.sofascore.com',
      Referer: 'https://www.sofascore.com/',
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9,pt-BR;q=0.8,pt;q=0.7',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    },
  });

  const page = await context.newPage();
  const attempts: ScheduledMatchesResponse['attempts'] = [];

  try {
    let bestEmptyResponse: ScheduledMatchesResponse | null = null;

    for (const baseUrl of FALLBACK_BASE_URLS) {
      const url = `${baseUrl}/sport/football/scheduled-events/${date}`;

      try {
        let response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: SCHEDULE_TIMEOUT_MS });

        if (response?.status() === 403 && retryOn403) {
          await page.waitForTimeout(250);
          response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: SCHEDULE_TIMEOUT_MS });
        }

        if (!response) {
          attempts.push({ url, events: 0, error: 'no response' });
          continue;
        }

        const status = response.status();
        if (status !== 200) {
          attempts.push({ url, status, events: 0 });
          continue;
        }

        const data = await response.json() as { events?: EventLive[] };
        const events = Array.isArray(data?.events) ? data.events : [];
        attempts.push({ url, status, events: events.length });

        const result = {
          status,
          raw: data,
          events,
          url,
          attempts,
        };

        if (status === 200 && events.length > 0) {
          return result;
        }

        if (status === 200 && !bestEmptyResponse) {
          bestEmptyResponse = result;
        }
      } catch (err) {
        attempts.push({
          url,
          events: 0,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (bestEmptyResponse) return bestEmptyResponse;

    return { status: attempts[attempts.length - 1]?.status, raw: null, events: [], attempts };
  } finally {
    await browser.close();
  }
}
