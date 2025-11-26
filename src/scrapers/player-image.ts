const SOFASCORE_IMG_BASE_URL = process.env.SOFASCORE_IMG_BASE_URL || 'https://img.sofascore.com/api/v1';

interface ImageSize {
  size?: 'small' | 'large';
}

export async function fetchPlayerImage(
  playerId: number | string,
  options: ImageSize = {}
): Promise<Response> {
  const { size } = options;

  // Build the URL based on size parameter
  let url = `${SOFASCORE_IMG_BASE_URL}/player/${playerId}/image`;
  if (size === 'small' || size) {
    url += `/${size}`;
  }

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
    console.error('Error fetching player image:', error);
    throw error;
  }
}
