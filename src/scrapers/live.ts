import { chromium, Browser } from "playwright";
import type { FetchLiveMatchesOptions } from "../utils/options";
import type { EventLive } from "../types/event.live";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36";
const SOFASCORE_BASE_URL = process.env.SOFASCORE_BASE_URL || "https://api.sofascore.com/api/v1";
const API_URL = `${SOFASCORE_BASE_URL}/sport/football/events/live`;

export interface LiveMatchesResponse {
  events?: EventLive[];
  [key: string]: unknown;
}

export async function fetchLiveMatches(options: FetchLiveMatchesOptions = {}): Promise<LiveMatchesResponse> {
  const { ifNoneMatch, retryOn403 = true } = options;
  let browser: Browser | null = null;
  browser = await chromium.launch();
  const context = await browser.newContext({
    userAgent: UA,
    extraHTTPHeaders: {
      'Origin': 'http://sofascore.com',
      'Referer': 'http://sofascore.com/',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      ...(ifNoneMatch ? { 'If-None-Match': ifNoneMatch } : {}),
    },
  });

  const page = await context.newPage();

  let response = await page.goto(API_URL, { waitUntil: 'domcontentloaded' });

  if (response && response?.status() === 403 && retryOn403) {
    await page.waitForTimeout(250);
    response = await page.goto(API_URL, { waitUntil: 'domcontentloaded' });
  }

  if (!response) {
    throw new Error("Erro ao ao obter resposta as partidas ao vivo. ⚠️");
  }

  const status = response.status();

  const headers = response.headers();
  const etag = headers['etag'] || null;

  if (status === 304) {
    await browser.close();
    return { status, etag };
  }

  try {
    const data = (await response.json()) as { events: EventLive[] };
    const events = Array.isArray(data?.events) ? data.events : [];
    return { status, etag, raw: data, events };
  } catch (error) {
    const text = await response.text();
    return { status, etag, raw: text };
  } finally {
    await browser.close();
  }
}
