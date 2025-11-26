export interface TeamColors {
  primary: string;
  secondary: string;
  text: string;
}

export interface FieldTranslations {
  nameTranslation?: Record<string, string>;
  shortNameTranslation?: Record<string, string>;
}

export interface Sport {
  name: string;
  slug: string;
  id: number;
}

export interface StandingsTeam {
  name: string;
  slug: string;
  shortName: string;
  gender: string;
  sport: Sport;
  userCount: number;
  nameCode: string;
  disabled: boolean;
  national: boolean;
  type: number;
  id: number;
  teamColors: TeamColors;
  fieldTranslations: FieldTranslations;
}

export interface Promotion {
  text: string;
  id: number;
}

export interface StandingsRow {
  team: StandingsTeam;
  descriptions: string[];
  promotion?: Promotion;
  liveMatchWinnerCodeColumn?: string;
  position: number;
  matches: number;
  wins: number;
  scoresFor: number;
  scoresAgainst: number;
  id: number;
  losses: number;
  draws: number;
  points: number;
  scoreDiffFormatted: string;
}

export interface TieBreakingRule {
  text: string;
  id: number;
}

export interface Standing {
  type: string;
  descriptions: string[];
  tieBreakingRule: TieBreakingRule;
  rows: StandingsRow[];
  id: number;
}

export interface Category {
  name: string;
  slug: string;
  sport: Sport;
  id: number;
  flag: string;
  alpha2: string;
  fieldTranslations: FieldTranslations;
}

export interface UniqueTournament {
  name: string;
  slug: string;
  primaryColorHex: string;
  secondaryColorHex: string;
  category: Category;
  userCount: number;
  hasPerformanceGraphFeature: boolean;
  id: number;
  displayInverseHomeAwayTeams: boolean;
  fieldTranslations: FieldTranslations;
}

export interface Tournament {
  name: string;
  slug: string;
  category: Category;
  uniqueTournament: UniqueTournament;
  priority: number;
  isGroup: boolean;
  isLive: boolean;
  id: number;
  fieldTranslations: FieldTranslations;
}

export interface StandingsApiResponse {
  standings: Array<{
    type: string;
    descriptions: string[];
    tieBreakingRule: TieBreakingRule;
    rows: StandingsRow[];
    id: number;
    tournament: Tournament;
    name: string;
    updatedAtTimestamp: number;
  }>;
}

export interface StandingsData {
  tournamentId: number;
  seasonId: number;
  type: string;
  tournament: {
    name: string;
    slug: string;
    id: number;
  };
  teams: Array<{
    position: number;
    teamId: number;
    teamName: string;
    teamSlug: string;
    matches: number;
    wins: number;
    draws: number;
    losses: number;
    scoresFor: number;
    scoresAgainst: number;
    scoreDiff: number;
    points: number;
    promotion?: {
      text: string;
      id: number;
    };
  }>;
  updatedAt: number;
}
