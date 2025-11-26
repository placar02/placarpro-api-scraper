import type { StandingsApiResponse, StandingsData } from '../types/standings';

const SOFASCORE_BASE_URL = process.env.SOFASCORE_BASE_URL || 'https://www.sofascore.com/api/v1';

interface FetchStandingsOptions {
  ifNoneMatch?: string;
  retryOn403?: boolean;
}

interface StandingsResponse {
  status: number;
  etag?: string;
  data?: StandingsData;
  raw?: StandingsApiResponse;
}

async function tryFetchStandingsFromUrl(
  url: string,
  ifNoneMatch?: string,
  retryOn403?: boolean
): Promise<{ response: Response; data: StandingsApiResponse } | null> {
  try {
    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    };

    if (ifNoneMatch) {
      headers['If-None-Match'] = ifNoneMatch;
    }

    const response = await fetch(url, { headers });

    // Handle 304 Not Modified
    if (response.status === 304) {
      return null;
    }

    if (response.status === 403) {
      if (retryOn403) {
        console.warn(`Received 403 for ${url}. Retrying...`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
        return tryFetchStandingsFromUrl(url, ifNoneMatch, false);
      }
      return null;
    }

    if (!response.ok) {
      console.warn(`HTTP ${response.status} for ${url}`);
      return null;
    }

    const data: StandingsApiResponse = await response.json();
    return { response, data };
  } catch (error) {
    console.warn(`Error fetching from ${url}:`, error);
    return null;
  }
}

export async function fetchStandings(
  tournamentId: number | string,
  seasonId: number | string,
  options: FetchStandingsOptions = {}
): Promise<StandingsResponse> {
  const { ifNoneMatch, retryOn403 = true } = options;

  // Try both URLs: tournament and unique-tournament
  const urls = [
    `${SOFASCORE_BASE_URL}/tournament/${tournamentId}/season/${seasonId}/standings/total`,
    `${SOFASCORE_BASE_URL}/unique-tournament/${tournamentId}/season/${seasonId}/standings/total`,
  ];

  try {
    let result = null;
    let usedUrl = '';

    // Try each URL in order
    for (const url of urls) {
      console.log(`Attempting to fetch standings from: ${url}`);
      result = await tryFetchStandingsFromUrl(url, ifNoneMatch, retryOn403);
      if (result) {
        usedUrl = url;
        console.log(`Successfully fetched standings from: ${url}`);
        break;
      }
    }

    // Handle 304 Not Modified
    if (ifNoneMatch && !result) {
      return {
        status: 304,
        etag: ifNoneMatch,
      };
    }

    if (!result) {
      throw new Error('Failed to fetch standings from both tournament and unique-tournament endpoints');
    }

    const { response, data } = result;
    const etag = response.headers.get('etag') || undefined;

    // Transform the API response to normalized format
    const standings = data.standings[0];
    const normalizedData: StandingsData = {
      tournamentId: Number(tournamentId),
      seasonId: Number(seasonId),
      type: standings.type,
      tournament: {
        name: standings.tournament.name,
        slug: standings.tournament.slug,
        id: standings.tournament.id,
      },
      teams: standings.rows.map((row) => {
        const scoreDiff = row.scoresFor - row.scoresAgainst;
        return {
          position: row.position,
          teamId: row.team.id,
          teamName: row.team.name,
          teamSlug: row.team.slug,
          matches: row.matches,
          wins: row.wins,
          draws: row.draws,
          losses: row.losses,
          scoresFor: row.scoresFor,
          scoresAgainst: row.scoresAgainst,
          scoreDiff,
          points: row.points,
          promotion: row.promotion
            ? {
              text: row.promotion.text,
              id: row.promotion.id,
            }
            : undefined,
        };
      }),
      updatedAt: standings.updatedAtTimestamp,
    };

    return {
      status: 200,
      etag,
      data: normalizedData,
      raw: data,
    };
  } catch (error) {
    console.error('Error fetching standings:', error);
    throw error;
  }
}
