import { chromium, Browser } from 'playwright';
import { fetch365Event } from './scores365';
import type { EventApiResponse, NormalizedEvent } from '../types/event';

const SOFASCORE_BASE_URL = process.env.SOFASCORE_BASE_URL || 'https://www.sofascore.com/api/v1';
const SOFASCORE_FALLBACK_BASE_URLS = [
  SOFASCORE_BASE_URL,
  'https://api.sofascore.com/api/v1',
  'https://www.sofascore.com/api/v1',
].filter((url, index, urls) => urls.indexOf(url) === index);
const SOFASCORE_PROXY_URL =
  process.env.SOFASCORE_PROXY_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
const SOFASCORE_BROWSER_CHANNELS = [
  process.env.SOFASCORE_BROWSER_CHANNEL,
  'chrome',
  'msedge',
].filter((channel): channel is string => Boolean(channel));

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const BROWSER_HEADERS = {
  Origin: 'https://www.sofascore.com',
  Referer: 'https://www.sofascore.com/',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9,pt-BR;q=0.8,pt;q=0.7',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
};

interface FetchEventOptions {
  retryOn403?: boolean;
}

interface EventResponse {
  status: number;
  data?: NormalizedEvent;
  raw?: EventApiResponse;
}

export class SofaScoreBlockedError extends Error {
  code = 'SOFASCORE_BLOCKED';
  status = 502;
  attempts: string[];

  constructor(eventId: number | string, attempts: string[]) {
    super(
      `SofaScore blocked event ${eventId} after ${attempts.length} attempt(s): ${attempts.join(', ')}. ` +
      'Configure SOFASCORE_PROXY_URL with a working residential/mobile proxy or use another network.'
    );
    this.name = 'SofaScoreBlockedError';
    this.attempts = attempts;
  }
}

interface FetchAttemptResult {
  status: number;
  data: EventApiResponse;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function tryFetchEventWithFetch(
  url: string,
  retryOn403?: boolean
): Promise<FetchAttemptResult | null> {
  const headers = {
    ...BROWSER_HEADERS,
    'User-Agent': USER_AGENT,
  };

  let response = await fetch(url, { headers });

  if (response.status === 403 && retryOn403) {
    console.warn(`Received 403 for ${url} using fetch. Retrying...`);
    await sleep(1500);
    response = await fetch(url, { headers });
  }

  if (!response.ok) {
    console.warn(`HTTP ${response.status} for ${url} using fetch`);
    return null;
  }

  const data = (await response.json()) as EventApiResponse;
  return { status: response.status, data };
}

async function tryFetchEventFromUrl(
  url: string,
  retryOn403?: boolean
): Promise<FetchAttemptResult | null> {
  const directResult = await tryFetchEventWithFetch(url, retryOn403).catch((error) => {
    console.warn(`Fetch failed for ${url}:`, error);
    return null;
  });

  if (directResult) {
    return directResult;
  }

  let browser: Browser | null = null;
  try {
    browser = await launchSofascoreBrowser();
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      extraHTTPHeaders: BROWSER_HEADERS,
    });

    const page = await context.newPage();

    // Prime the session cookies before hitting the JSON API.
    await page.goto('https://www.sofascore.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    }).catch(() => undefined);

    let browserFetchResult = await page.evaluate(async (apiUrl) => {
      const response = await fetch(apiUrl, {
        credentials: 'include',
        headers: {
          Accept: 'application/json, text/plain, */*',
        },
      });
      const text = await response.text();

      return {
        ok: response.ok,
        status: response.status,
        text,
      };
    }, url);

    if (browserFetchResult.status === 403) {
      if (retryOn403) {
        console.warn(`Received 403 for ${url} using Playwright. Retrying...`);
        await page.waitForTimeout(1500);
        browserFetchResult = await page.evaluate(async (apiUrl) => {
          const response = await fetch(apiUrl, {
            credentials: 'include',
            headers: {
              Accept: 'application/json, text/plain, */*',
            },
          });
          const text = await response.text();

          return {
            ok: response.ok,
            status: response.status,
            text,
          };
        }, url);
      }
    }

    if (!browserFetchResult.ok) {
      console.warn(`HTTP ${browserFetchResult.status} for ${url}`);
      return null;
    }

    const data = JSON.parse(browserFetchResult.text) as EventApiResponse;
    return { status: browserFetchResult.status, data };
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
  if (process.env.SCORES_PROVIDER === '365scores') {
    return fetch365Event(eventId) as Promise<EventResponse>;
  }

  const { retryOn403 = true } = options;

  if (!eventId) {
    throw new Error('Event ID is required');
  }

  try {
    const attempts: string[] = [];
    let result: FetchAttemptResult | null = null;

    for (const baseUrl of SOFASCORE_FALLBACK_BASE_URLS) {
      const url = `${baseUrl}/event/${eventId}`;
      attempts.push(url);
      console.log(`Fetching event from: ${url}`);

      result = await tryFetchEventFromUrl(url, retryOn403);

      if (result) {
        break;
      }
    }

    if (!result) {
      throw new SofaScoreBlockedError(eventId, attempts);
    }

    const { status, data } = result;

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
        uniqueTournament: event.tournament?.uniqueTournament
          ? {
            id: event.tournament.uniqueTournament.id ?? 0,
            name: event.tournament.uniqueTournament.name || '',
            slug: event.tournament.uniqueTournament.slug || '',
          }
          : undefined,
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
          yellowCards: event.referee.yellowCards,
          redCards: event.referee.redCards,
          yellowRedCards: event.referee.yellowRedCards,
          games: event.referee.games,
          country: event.referee.country?.name,
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
      status,
      data: normalizedData,
      raw: data,
    };
  } catch (error) {
    console.error('Error fetching event:', error);
    throw error;
  }
}
