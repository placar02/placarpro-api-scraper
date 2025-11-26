import type { ApiTeamEventsResponse, NormalizedTeamEventsResponse, FetchTeamEventsResult } from '../types/team-events';
import { chromium, Browser } from 'playwright';

const BASE_URL = process.env.SOFASCORE_BASE_URL || 'https://www.sofascore.com/api/v1';
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36";

export async function fetchTeamNextEvents(
  teamId: string,
  pageNum: number = 0,
  options: { retryOn403?: boolean } = {}
): Promise<FetchTeamEventsResult> {
  const { retryOn403 = true } = options;
  const url = `${BASE_URL}/team/${teamId}/events/next/${pageNum}`;

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

    console.log(`[Team Events] Fetching from: ${url}`);

    let response = await page.goto(url, { waitUntil: 'domcontentloaded' });

    if (response && response?.status() === 403 && retryOn403) {
      console.log(`[Team Events] Got 403, waiting and retrying...`);
      await page.waitForTimeout(250);
      response = await page.goto(url, { waitUntil: 'domcontentloaded' });
    }

    if (!response) {
      throw new Error('Failed to fetch team events: No response');
    }

    const status = response.status();

    if (status !== 200) {
      throw new Error(`Failed to fetch team events: HTTP ${status}`);
    }

    const data: ApiTeamEventsResponse = await response.json();

    const normalized: NormalizedTeamEventsResponse = {
      teamId,
      events: data.events.map((event) => {
        const startDate = new Date(event.startTimestamp * 1000).toISOString();

        return {
          eventId: event.id,
          customId: event.customId,
          startTimestamp: event.startTimestamp,
          startDate,
          tournament: {
            id: event.tournament.id,
            name: event.tournament.name,
            slug: event.tournament.slug,
            priority: event.tournament.priority,
          },
          season: {
            name: event.season.name,
            year: event.season.year,
          },
          round: event.roundInfo.round,
          roundName: event.roundInfo.name,
          homeTeam: {
            id: event.homeTeam.id,
            name: event.homeTeam.name,
            slug: event.homeTeam.slug,
            nameCode: event.homeTeam.nameCode,
          },
          awayTeam: {
            id: event.awayTeam.id,
            name: event.awayTeam.name,
            slug: event.awayTeam.slug,
            nameCode: event.awayTeam.nameCode,
          },
          status: event.status.type,
          slug: event.slug,
        };
      }),
      hasNextPage: data.hasNextPage,
      totalEvents: data.events.length,
      lastUpdated: Date.now(),
    };

    return {
      status: 200,
      data: normalized,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[Team Events] Error fetching team events for ${teamId}:`, message);
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
