import type { ApiTeamResponse, NormalizedTeamResponse, FetchTeamResult } from '../types/team';
import { chromium, Browser } from 'playwright';

const BASE_URL = process.env.SOFASCORE_BASE_URL || 'https://www.sofascore.com/api/v1';
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36";

export async function fetchTeamInfo(teamId: string, options: { retryOn403?: boolean } = {}): Promise<FetchTeamResult> {
  const { retryOn403 = true } = options;
  const url = `${BASE_URL}/team/${teamId}`;

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

    console.log(`[Team Info] Fetching from: ${url}`);

    let response = await page.goto(url, { waitUntil: 'domcontentloaded' });

    if (response && response?.status() === 403 && retryOn403) {
      console.log(`[Team Info] Got 403, waiting and retrying...`);
      await page.waitForTimeout(250);
      response = await page.goto(url, { waitUntil: 'domcontentloaded' });
    }

    if (!response) {
      throw new Error('Failed to fetch team info: No response');
    }

    const status = response.status();

    if (status !== 200) {
      throw new Error(`Failed to fetch team info: HTTP ${status}`);
    }

    const data: ApiTeamResponse = await response.json();
    const team = data.team;

    // Calculate foundation year from timestamp
    const foundationYear = team.foundationDateTimestamp ? new Date(team.foundationDateTimestamp * 1000).getFullYear() : 0;

    const normalized: NormalizedTeamResponse = {
      teamId: team.id,
      name: team.name,
      shortName: team.shortName,
      fullName: team.fullName,
      slug: team.slug,
      nameCode: team.nameCode,
      gender: team.gender,
      national: team.national,
      sport: {
        name: team.sport.name,
        slug: team.sport.slug,
      },
      country: {
        alpha2: team.country.alpha2,
        alpha3: team.country.alpha3,
        name: team.country.name,
      },
      manager: team.manager ? {
        id: team.manager.id,
        name: team.manager.name,
        slug: team.manager.slug,
        country: team.manager.country.name,
      } : null,
      venue: team.venue ? {
        id: team.venue.id,
        name: team.venue.name,
        slug: team.venue.slug,
        capacity: team.venue.capacity,
        city: team.venue.city.name,
        coordinates: {
          latitude: team.venue.venueCoordinates.latitude,
          longitude: team.venue.venueCoordinates.longitude,
        },
      } : null,
      colors: {
        primary: team.teamColors.primary,
        secondary: team.teamColors.secondary,
        text: team.teamColors.text,
      },
      tournament: team.primaryUniqueTournament ? {
        name: team.primaryUniqueTournament.name,
        slug: team.primaryUniqueTournament.slug,
      } : null,
      userCount: team.userCount,
      foundation: {
        timestamp: team.foundationDateTimestamp,
        year: foundationYear,
      },
      pregameForm: data.pregameForm || null,
      lastUpdated: Date.now(),
    };

    return {
      status: 200,
      data: normalized,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[Team Info] Error fetching team info for ${teamId}:`, message);
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
