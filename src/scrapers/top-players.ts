import type { ApiTopPlayersResponse, NormalizedTopPlayersResponse, FetchTopPlayersResult } from '../types/top-players';
import { chromium, Browser } from 'playwright';

const BASE_URL = process.env.SOFASCORE_BASE_URL || 'https://www.sofascore.com/api/v1';
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36";

export async function fetchTopPlayers(
  teamId: string,
  uniqueTournamentId: string,
  seasonId: string,
  options: { retryOn403?: boolean } = {}
): Promise<FetchTopPlayersResult> {
  const { retryOn403 = true } = options;
  const url = `${BASE_URL}/team/${teamId}/unique-tournament/${uniqueTournamentId}/season/${seasonId}/top-players/overall`;

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

    console.log(`[Top Players] Fetching from: ${url}`);

    let response = await page.goto(url, { waitUntil: 'domcontentloaded' });

    if (response && response?.status() === 403 && retryOn403) {
      console.log(`[Top Players] Got 403, waiting and retrying...`);
      await page.waitForTimeout(250);
      response = await page.goto(url, { waitUntil: 'domcontentloaded' });
    }

    if (!response) {
      throw new Error('Failed to fetch top players: No response');
    }

    const status = response.status();

    if (status !== 200) {
      throw new Error(`Failed to fetch top players: HTTP ${status}`);
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
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}
