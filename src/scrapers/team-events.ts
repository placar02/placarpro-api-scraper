import type { ApiTeamEventsResponse, NormalizedTeamEventsResponse, FetchTeamEventsResult } from '../types/team-events';

const BASE_URL = process.env.SOFASCORE_BASE_URL || 'https://www.sofascore.com/api/v1';

export async function fetchTeamNextEvents(
  teamId: string,
  pageNum: number = 0,
  options: { retryOn403?: boolean } = {}
): Promise<FetchTeamEventsResult> {
  const { retryOn403 = true } = options;
  const url = `${BASE_URL}/team/${teamId}/events/next/${pageNum}`;

  try {
    const response = await fetch(url);

    if (response.status === 403 && retryOn403) {
      console.log(`[Team Events] Got 403 for ${url}, retrying...`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return fetchTeamNextEvents(teamId, pageNum, { retryOn403: false });
    }

    if (!response.ok) {
      throw new Error(`Failed to fetch team events: ${response.statusText} (${response.status})`);
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
  }
}
