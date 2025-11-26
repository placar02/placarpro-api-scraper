import type { SearchApiResponse, SearchData, NormalizedTeam } from '../types/search';

const SOFASCORE_BASE_URL = process.env.SOFASCORE_BASE_URL || 'https://www.sofascore.com/api/v1';

interface FetchSearchOptions {
  retryOn403?: boolean;
}

interface SearchResponse {
  status: number;
  data?: SearchData;
  raw?: SearchApiResponse;
}

async function tryFetchSearchFromUrl(
  url: string,
  retryOn403?: boolean
): Promise<{ response: Response; data: SearchApiResponse } | null> {
  try {
    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    };

    const response = await fetch(url, { headers });

    if (response.status === 403) {
      if (retryOn403) {
        console.warn(`Received 403 for ${url}. Retrying...`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
        return tryFetchSearchFromUrl(url, false);
      }
      return null;
    }

    if (!response.ok) {
      console.warn(`HTTP ${response.status} for ${url}`);
      return null;
    }

    const data: SearchApiResponse = await response.json();
    return { response, data };
  } catch (error) {
    console.warn(`Error fetching from ${url}:`, error);
    return null;
  }
}

export async function fetchSearch(
  query: string,
  page: number = 0,
  options: FetchSearchOptions = {}
): Promise<SearchResponse> {
  const { retryOn403 = true } = options;

  if (!query || query.trim() === '') {
    throw new Error('Search query is required');
  }

  const url = `${SOFASCORE_BASE_URL}/search/teams?q=${encodeURIComponent(query)}&page=${page}`;

  try {
    console.log(`Fetching search results from: ${url}`);
    const result = await tryFetchSearchFromUrl(url, retryOn403);

    if (!result) {
      throw new Error('Failed to fetch search results');
    }

    const { response, data } = result;

    // Normalize the API response
    const normalizedResults: NormalizedTeam[] = data.results.map((result) => ({
      id: result.entity.id,
      name: result.entity.name,
      nameCode: result.entity.nameCode,
      slug: result.entity.slug,
      national: result.entity.national,
      sport: {
        id: result.entity.sport.id,
        slug: result.entity.sport.slug,
        name: result.entity.sport.name,
      },
      userCount: result.entity.userCount,
      teamColors: {
        primary: result.entity.teamColors.primary,
        secondary: result.entity.teamColors.secondary,
        text: result.entity.teamColors.text,
      },
      type: result.entity.type,
      gender: result.entity.gender,
      country: {
        alpha2: result.entity.country.alpha2,
        name: result.entity.country.name,
        slug: result.entity.country.slug,
      },
      fieldTranslations: {
        nameTranslation: result.entity.fieldTranslations.nameTranslation,
        shortNameTranslation: result.entity.fieldTranslations.shortNameTranslation,
      },
      searchScore: result.score,
    }));

    const normalizedData: SearchData = {
      query,
      page,
      results: normalizedResults,
      totalResults: data.results.length,
    };

    return {
      status: 200,
      data: normalizedData,
      raw: data,
    };
  } catch (error) {
    console.error('Error fetching search results:', error);
    throw error;
  }
}
