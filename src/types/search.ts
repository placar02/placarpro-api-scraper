export interface Country {
  alpha2: string;
  name: string;
  slug: string;
}

export interface Sport {
  id: number;
  slug: string;
  name: string;
}

export interface TeamColors {
  primary: string;
  secondary: string;
  text: string;
}

export interface FieldTranslations {
  nameTranslation?: Record<string, string>;
  shortNameTranslation?: Record<string, string>;
}

export interface TeamEntity {
  id: number;
  name: string;
  nameCode: string;
  slug: string;
  national: boolean;
  sport: Sport;
  userCount: number;
  teamColors: TeamColors;
  type: number;
  gender?: string;
  country: Country;
  fieldTranslations: FieldTranslations;
}

export interface SearchResult {
  entity: TeamEntity;
  score: number;
  type: string;
}

export interface SearchApiResponse {
  results: SearchResult[];
}

export interface NormalizedTeam {
  id: number;
  name: string;
  nameCode: string;
  slug: string;
  national: boolean;
  sport: {
    id: number;
    slug: string;
    name: string;
  };
  userCount: number;
  teamColors: {
    primary: string;
    secondary: string;
    text: string;
  };
  type: number;
  gender?: string;
  country: {
    alpha2: string;
    name: string;
    slug: string;
  };
  fieldTranslations: {
    nameTranslation?: Record<string, string>;
    shortNameTranslation?: Record<string, string>;
  };
  searchScore: number;
}

export interface SearchData {
  query: string;
  page: number;
  results: NormalizedTeam[];
  totalResults: number;
}
