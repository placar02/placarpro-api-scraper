import type { StreaksResponse, NormalizedStreaksResponse, FetchStreaksResult } from '../types/streaks';
import { chromium, Browser } from 'playwright';

const BASE_URL = process.env.SOFASCORE_BASE_URL || 'https://www.sofascore.com/api/v1';
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36";

export async function fetchStreaks(eventId: string, options: { retryOn403?: boolean } = {}): Promise<FetchStreaksResult> {
  const { retryOn403 = true } = options;
  const url = `${BASE_URL}/event/${eventId}/team-streaks`;

  let browser: Browser | null = null;

  try {
    browser = await chromium.launch();
    const context = await browser.newContext({
      userAgent: UA,
      extraHTTPHeaders: {
        'Origin': 'http://sofascore.com',
        'Referer': 'http://sofascore.com/',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    const page = await context.newPage();

    console.log(`[Streaks] Fetching from: ${url}`);

    let response = await page.goto(url, { waitUntil: 'domcontentloaded' });

    if (response && response?.status() === 403 && retryOn403) {
      console.log(`[Streaks] Got 403, waiting and retrying...`);
      await page.waitForTimeout(250);
      response = await page.goto(url, { waitUntil: 'domcontentloaded' });
    }

    if (!response) {
      throw new Error('Failed to fetch streaks: No response');
    }

    const status = response.status();

    if (status !== 200) {
      throw new Error(`Failed to fetch streaks: HTTP ${status}`);
    }

    const data: StreaksResponse = await response.json();

    const normalized: NormalizedStreaksResponse = {
      eventId,
      general: data.general || [],
      head2head: data.head2head || [],
      lastUpdated: Date.now(),
    };

    return {
      status: 200,
      data: normalized,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[Streaks] Error fetching streaks for event ${eventId}:`, message);
    return {
      status: 500,
      error: message,
    };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}
