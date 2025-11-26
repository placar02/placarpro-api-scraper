const SOFASCORE_BASE_URL = process.env.SOFASCORE_BASE_URL || 'https://www.sofascore.com/api/v1';

interface TryFetchResult<T> {
  response: Response;
  data: T;
}

async function tryFetchLineupsFromUrl<T>(url: string, retryOn403 = true): Promise<TryFetchResult<T> | null> {
  try {
    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    };

    const response = await fetch(url, { headers });

    if (response.status === 403) {
      if (retryOn403) {
        console.warn(`Received 403 for ${url}. Retrying...`);
        await new Promise((r) => setTimeout(r, 1500));
        return tryFetchLineupsFromUrl(url, false);
      }
      return null;
    }

    if (!response.ok) {
      console.warn(`HTTP ${response.status} for ${url}`);
      return null;
    }

    const data = (await response.json()) as T;
    return { response, data };
  } catch (err) {
    console.warn(`Error fetching lineups from ${url}:`, err);
    return null;
  }
}

export async function fetchLineups(eventId: number | string): Promise<{ status: number; data?: any; raw?: any }> {
  const url = `${SOFASCORE_BASE_URL}/event/${eventId}/lineups`;
  try {
    const result = await tryFetchLineupsFromUrl<any>(url, true);
    if (!result) {
      return { status: 404 };
    }

    // Normalize minimal useful structure
    const { data } = result;

    const normalizeSide = (side: any) => {
      if (!side) return null;
      return {
        formation: side.formation,
        playerColor: side.playerColor || null,
        goalkeeperColor: side.goalkeeperColor || null,
        supportStaff: side.supportStaff || [],
        missingPlayers: side.missingPlayers || [],
        players: (side.players || []).map((p: any) => ({
          avgRating: p.avgRating,
          player: p.player,
          teamId: p.teamId,
          shirtNumber: p.shirtNumber ?? p.jerseyNumber,
          position: p.position,
          substitute: p.substitute,
          captain: p.captain || false,
          // Add image routes for player
          image: p.player?.id ? `/player/${p.player.id}/image` : null,
          imageSmall: p.player?.id ? `/player/${p.player.id}/image/small` : null,
        })),
      };
    };

    const normalized = {
      confirmed: Boolean(data.confirmed),
      home: normalizeSide(data.home),
      away: normalizeSide(data.away),
      statisticalVersion: data.statisticalVersion ?? null,
      raw: data,
    };

    return { status: 200, data: normalized, raw: data };
  } catch (err) {
    console.error('Error in fetchLineups:', err);
    return { status: 500 };
  }
}
