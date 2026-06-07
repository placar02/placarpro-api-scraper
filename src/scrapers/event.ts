import { chromium, Browser } from 'playwright';
import type { EventApiResponse, NormalizedEvent } from '../types/event';

const SOFASCORE_BASE_URL = process.env.SOFASCORE_BASE_URL || 'https://www.sofascore.com/api/v1';

interface FetchEventOptions {
  retryOn403?: boolean;
}

interface EventResponse {
  status: number;
  data?: NormalizedEvent;
  raw?: EventApiResponse;
}

async function tryFetchEventFromUrl(
  url: string,
  retryOn403?: boolean
): Promise<{ response: Response; data: EventApiResponse } | null> {
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch();
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      extraHTTPHeaders: {
        Origin: 'http://sofascore.com',
        Referer: 'http://sofascore.com/',
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    const page = await context.newPage();
    let response = await page.goto(url, { waitUntil: 'domcontentloaded' });

    if (response?.status() === 403) {
      if (retryOn403) {
        console.warn(`Received 403 for ${url}. Retrying...`);
        await page.waitForTimeout(250);
        response = await page.goto(url, { waitUntil: 'domcontentloaded' });
      }
    }

    if (!response || response.status() !== 200) {
      console.warn(`HTTP ${response?.status() ?? 'no response'} for ${url}`);
      return null;
    }

    const data: EventApiResponse = await response.json();
    return { response, data };
  } catch (error) {
    console.warn(`Error fetching from ${url}:`, error);
    return null;
  } finally {
    if (browser) await browser.close();
  }
}

export async function fetchEvent(
  eventId: number | string,
  options: FetchEventOptions = {}
): Promise<EventResponse> {
  const { retryOn403 = true } = options;

  if (!eventId) {
    throw new Error('Event ID is required');
  }

  const url = `${SOFASCORE_BASE_URL}/event/${eventId}`;

  try {
    console.log(`Fetching event from: ${url}`);
    const result = await tryFetchEventFromUrl(url, retryOn403);

    if (!result) {
      throw new Error('Failed to fetch event');
    }

    const { response, data } = result;

    // Verificar se data.event existe, caso contrário, usar data diretamente
    const event = data.event || data;

    if (!event || !event.id) {
      console.error('Invalid event data structure:', data);
      throw new Error('Invalid event data structure received from API');
    }

    // Normalize the API response with safe access to optional fields
    const normalizedData: NormalizedEvent = {
      id: event.id,
      slug: event.slug || '',
      status: {
        code: event.status?.code ?? 0,
        description: event.status?.description || '',
        type: event.status?.type || 'notstarted',
      },
      tournament: {
        id: event.tournament?.id ?? 0,
        name: event.tournament?.name || '',
        slug: event.tournament?.slug || '',
      },
      season: {
        id: event.season?.id ?? 0,
        name: event.season?.name || '',
        year: event.season?.year || '',
      },
      round: event.roundInfo?.round,
      homeTeam: {
        id: event.homeTeam?.id ?? 0,
        name: event.homeTeam?.name || '',
        slug: event.homeTeam?.slug || '',
        shortName: event.homeTeam?.shortName || event.homeTeam?.name || '',
      },
      awayTeam: {
        id: event.awayTeam?.id ?? 0,
        name: event.awayTeam?.name || '',
        slug: event.awayTeam?.slug || '',
        shortName: event.awayTeam?.shortName || event.awayTeam?.name || '',
      },
      score: {
        home: event.homeScore?.current ?? 0,
        away: event.awayScore?.current ?? 0,
        homeDisplay: event.homeScore?.display ?? 0,
        awayDisplay: event.awayScore?.display ?? 0,
      },
      venue: event.venue ? {
        id: event.venue.id ?? 0,
        name: event.venue.name || event.homeTeam?.venue?.name || 'Unknown',
        slug: event.venue.slug || '',
        city: event.venue.city?.name || event.homeTeam?.venue?.city?.name || '',
        capacity: event.venue.capacity ?? event.homeTeam?.venue?.capacity ?? 0,
      } : {
        id: event.homeTeam?.venue?.id ?? 0,
        name: event.homeTeam?.venue?.name || 'Unknown',
        slug: event.homeTeam?.venue?.slug || '',
        city: event.homeTeam?.venue?.city?.name || '',
        capacity: event.homeTeam?.venue?.capacity ?? 0,
      },
      referee: event.referee
        ? {
          id: event.referee.id ?? 0,
          name: event.referee.name || 'Unknown',
          slug: event.referee.slug || '',
        }
        : {
          id: 0,
          name: 'Unknown',
          slug: 'unknown',
        },
      startTime: event.startTimestamp ?? 0,
      currentTime: event.statusTime?.timestamp || event.time?.currentPeriodStartTimestamp,
      time: event.time ? {
        currentPeriodStartTimestamp: event.time.currentPeriodStartTimestamp
      } : undefined,
      features: {
        hasXg: event.hasXg ?? false,
        hasPlayerStats: event.hasEventPlayerStatistics ?? false,
        hasHeatMap: event.hasEventPlayerHeatMap ?? false,
      },
    };

    return {
      status: 200,
      data: normalizedData,
      raw: data,
    };
  } catch (error) {
    console.error('Error fetching event:', error);
    throw error;
  }
}
