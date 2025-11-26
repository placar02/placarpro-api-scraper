const SOFASCORE_IMG_BASE_URL = process.env.SOFASCORE_IMG_BASE_URL || 'https://img.sofascore.com/api/v1';

export type ImageType = 'team' | 'player' | 'tournament' | 'league' | 'country';
export type ImageSize = 'small' | 'large';

interface FetchImageOptions {
  size?: ImageSize;
}

/**
 * Fetches an image from SofaScore API for various entity types
 * @param type - Type of entity (team, player, tournament, league, country)
 * @param id - Entity ID
 * @param options - Options object with optional size parameter (small or large, default is large)
 * @returns Response object with image data
 */
export async function fetchImage(
  type: ImageType,
  id: number | string,
  options: FetchImageOptions = {}
): Promise<Response> {
  const { size = 'large' } = options;

  // Validate size parameter
  if (size !== 'small' && size !== 'large') {
    throw new Error(`Invalid image size: ${size}. Must be 'small' or 'large'`);
  }

  // Build the URL based on type and size
  // Only append size if it's 'small', otherwise use default (large)
  const url = size === 'small'
    ? `${SOFASCORE_IMG_BASE_URL}/${type}/${id}/image/small`
    : `${SOFASCORE_IMG_BASE_URL}/${type}/${id}/image`;

  try {
    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    };

    const response = await fetch(url, { headers });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return response;
  } catch (error) {
    console.error(`Error fetching ${type} image for ID ${id}:`, error);
    throw error;
  }
}

/**
 * Legacy function for backwards compatibility - fetches team image
 * @deprecated Use fetchImage('team', teamId, options) instead
 */
export async function fetchTeamImage(
  teamId: number | string,
  options: FetchImageOptions = {}
): Promise<Response> {
  return fetchImage('team', teamId, options);
}

/**
 * Legacy function for backwards compatibility - fetches player image
 * @deprecated Use fetchImage('player', playerId, options) instead
 */
export async function fetchPlayerImage(
  playerId: number | string,
  options: FetchImageOptions = {}
): Promise<Response> {
  return fetchImage('player', playerId, options);
}
