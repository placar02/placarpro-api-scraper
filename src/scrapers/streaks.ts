import type { StreaksResponse, NormalizedStreaksResponse, FetchStreaksResult } from '../types/streaks';

const BASE_URL = process.env.SOFASCORE_BASE_URL || 'https://www.sofascore.com/api/v1';

export async function fetchStreaks(eventId: string, options: { retryOn403?: boolean } = {}): Promise<FetchStreaksResult> {
  const { retryOn403 = true } = options;
  const url = `${BASE_URL}/event/${eventId}/team-streaks`;

  try {
    const response = await fetch(url);

    if (response.status === 403 && retryOn403) {
      console.log(`[Streaks] Got 403 for ${url}, retrying...`);
      // Retry after a short delay
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return fetchStreaks(eventId, { retryOn403: false });
    }

    if (!response.ok) {
      throw new Error(`Failed to fetch streaks: ${response.statusText} (${response.status})`);
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
  }
}
