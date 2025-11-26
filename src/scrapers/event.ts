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
  try {
    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    };

    const response = await fetch(url, { headers });

    if (response.status === 403) {
      if (retryOn403) {
        console.warn(`Received 403 for ${url}. Retrying...`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
        return tryFetchEventFromUrl(url, false);
      }
      return null;
    }

    if (!response.ok) {
      console.warn(`HTTP ${response.status} for ${url}`);
      return null;
    }

    const data: EventApiResponse = await response.json();
    return { response, data };
  } catch (error) {
    console.warn(`Error fetching from ${url}:`, error);
    return null;
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
    const event = data.event;

    // Normalize the API response
    const normalizedData: NormalizedEvent = {
      id: event.id,
      slug: event.slug,
      status: {
        code: event.status.code,
        description: event.status.description,
        type: event.status.type,
      },
      tournament: {
        id: event.tournament.id,
        name: event.tournament.name,
        slug: event.tournament.slug,
      },
      season: {
        id: event.season.id,
        name: event.season.name,
        year: event.season.year,
      },
      round: event.roundInfo?.round,
      homeTeam: {
        id: event.homeTeam.id,
        name: event.homeTeam.name,
        slug: event.homeTeam.slug,
        shortName: event.homeTeam.shortName,
      },
      awayTeam: {
        id: event.awayTeam.id,
        name: event.awayTeam.name,
        slug: event.awayTeam.slug,
        shortName: event.awayTeam.shortName,
      },
      score: {
        home: event.homeScore.current ?? 0,
        away: event.awayScore.current ?? 0,
        homeDisplay: event.homeScore.display ?? 0,
        awayDisplay: event.awayScore.display ?? 0,
      },
      venue: {
        id: event.venue.id,
        name: event.venue.name,
        slug: event.venue.slug,
        city: event.venue.city.name,
        capacity: event.venue.capacity,
      },
      referee: event.referee
        ? {
          id: event.referee.id,
          name: event.referee.name,
          slug: event.referee.slug,
        }
        : undefined,
      startTime: event.startTimestamp,
      currentTime: event.statusTime.timestamp,
      features: {
        hasXg: event.hasXg,
        hasPlayerStats: event.hasEventPlayerStatistics,
        hasHeatMap: event.hasEventPlayerHeatMap,
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
