import { chromium, Browser } from 'playwright';
import type { EventLive } from '../types/event.live';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';
const BASE_URL = process.env.SOFASCORE_BASE_URL || 'https://sofascore.com/api/v1';

export interface ScheduledMatchesResponse {
  status?: number;
  events?: EventLive[];
  raw?: unknown;
}

export async function fetchScheduledMatches(date: string, retryOn403 = true): Promise<ScheduledMatchesResponse> {
  let browser: Browser | null = null;
  browser = await chromium.launch();

  const context = await browser.newContext({
    userAgent: UA,
    extraHTTPHeaders: {
      Origin: 'http://sofascore.com',
      Referer: 'http://sofascore.com/',
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  const page = await context.newPage();
  const url = `${BASE_URL}/sport/football/scheduled-events/${date}`;

  try {
    let response = await page.goto(url, { waitUntil: 'domcontentloaded' });

    if (response?.status() === 403 && retryOn403) {
      await page.waitForTimeout(250);
      response = await page.goto(url, { waitUntil: 'domcontentloaded' });
    }

    if (!response) {
      throw new Error('Erro ao obter resposta dos jogos agendados.');
    }

    const status = response.status();
    const data = await response.json() as { events?: EventLive[] };

    return {
      status,
      raw: data,
      events: Array.isArray(data?.events) ? data.events : [],
    };
  } finally {
    await browser.close();
  }
}
