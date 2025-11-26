import type { ApiTopPlayersResponse, NormalizedTopPlayersResponse, FetchTopPlayersResult } from '../types/top-players';

const BASE_URL = process.env.SOFASCORE_BASE_URL || 'https://www.sofascore.com/api/v1';

export async function fetchTopPlayers(
  teamId: string,
  uniqueTournamentId: string,
  seasonId: string,
  options: { retryOn403?: boolean } = {}
): Promise<FetchTopPlayersResult> {
  const { retryOn403 = true } = options;
  const url = `${BASE_URL}/team/${teamId}/unique-tournament/${uniqueTournamentId}/season/${seasonId}/top-players/overall`;

  try {
    const response = await fetch(url);

    if (response.status === 403 && retryOn403) {
      console.log(`[Top Players] Got 403 for ${url}, retrying...`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return fetchTopPlayers(teamId, uniqueTournamentId, seasonId, { retryOn403: false });
    }

    if (!response.ok) {
      throw new Error(`Failed to fetch top players: ${response.statusText} (${response.status})`);
    }

    const data: ApiTopPlayersResponse = await response.json();

    // Pega apenas a lista de rating (conforme solicitado)
    const ratingPlayers = data.topPlayers.rating || [];

    const normalized: NormalizedTopPlayersResponse = {
      tournamentId: parseInt(uniqueTournamentId),
      seasonId: parseInt(seasonId),
      teamId: parseInt(teamId),
      topPlayers: ratingPlayers.map((entry) => ({
        playerId: entry.player.id,
        playerName: entry.player.name,
        playerSlug: entry.player.slug,
        playerPosition: entry.player.position,
        playerUserCount: entry.player.userCount,
        teamId: entry.team.id,
        teamName: entry.team.name,
        teamSlug: entry.team.slug,
        rating: entry.statistics.rating,
        statisticsId: entry.statistics.id,
        statisticsType: entry.statistics.type,
        appearances: entry.statistics.appearances,
        playedEnough: entry.playedEnough,
      })),
      totalPlayers: ratingPlayers.length,
      lastUpdated: Date.now(),
    };

    return {
      status: 200,
      data: normalized,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(
      `[Top Players] Error fetching top players for team ${teamId}, tournament ${uniqueTournamentId}, season ${seasonId}:`,
      message
    );
    return {
      status: 500,
      error: message,
    };
  }
}
