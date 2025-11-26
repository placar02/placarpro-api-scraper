export interface Sport {
  name: string;
  slug: string;
  id: number;
}

export interface Country {
  alpha2: string;
  alpha3: string;
  name: string;
  slug: string;
}

export interface TeamColors {
  primary: string;
  secondary: string;
  text: string;
}

export interface SimpleTeam {
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
  country: Country;
  teamColors: TeamColors;
}

export interface EventStatus {
  code: number;
  description: string;
  type: string;
}

export interface RoundInfo {
  round: number;
  name?: string;
  slug?: string;
  cupRoundType?: number;
}

export interface TournamentCategory {
  name: string;
  slug: string;
  sport: Sport;
  id: number;
  country: Record<string, unknown>;
  flag?: string;
  alpha2?: string;
}

export interface UniqueTournament {
  name: string;
  slug: string;
  primaryColorHex: string;
  secondaryColorHex: string;
  category: TournamentCategory;
  userCount: number;
  hasPerformanceGraphFeature: boolean;
  id: number;
  country: Record<string, unknown>;
  hasEventPlayerStatistics?: boolean;
  displayInverseHomeAwayTeams: boolean;
}

export interface Tournament {
  name: string;
  slug: string;
  category: TournamentCategory;
  uniqueTournament: UniqueTournament;
  priority: number;
  isGroup?: boolean;
  isLive?: boolean;
  id: number;
}

export interface Season {
  name: string;
  year: string;
  editor: boolean;
  id: number;
}

export interface ApiEvent {
  tournament: Tournament;
  season: Season;
  roundInfo: RoundInfo;
  customId: string;
  status: EventStatus;
  homeTeam: SimpleTeam;
  awayTeam: SimpleTeam;
  homeScore: Record<string, unknown>;
  awayScore: Record<string, unknown>;
  time: Record<string, unknown>;
  changes: {
    changeTimestamp: number;
  };
  hasGlobalHighlights: boolean;
  detailId: number;
  crowdsourcingDataDisplayEnabled: boolean;
  id: number;
  varInProgress?: {
    homeTeam: boolean;
    awayTeam: boolean;
  };
  slug: string;
  startTimestamp: number;
  finalResultOnly: boolean;
  feedLocked: boolean;
  isEditor: boolean;
  coverage?: number;
}

export interface ApiTeamEventsResponse {
  events: ApiEvent[];
  hasNextPage: boolean;
}

export interface NormalizedTeamEvent {
  eventId: number;
  customId: string;
  startTimestamp: number;
  startDate: string;
  tournament: {
    id: number;
    name: string;
    slug: string;
    priority: number;
  };
  season: {
    name: string;
    year: string;
  };
  round: number;
  roundName?: string;
  homeTeam: {
    id: number;
    name: string;
    slug: string;
    nameCode: string;
  };
  awayTeam: {
    id: number;
    name: string;
    slug: string;
    nameCode: string;
  };
  status: string;
  slug: string;
}

export interface NormalizedTeamEventsResponse {
  teamId: string;
  events: NormalizedTeamEvent[];
  hasNextPage: boolean;
  totalEvents: number;
  lastUpdated: number;
}

export interface FetchTeamEventsResult {
  status: number;
  data?: NormalizedTeamEventsResponse;
  error?: string;
}
