export interface Country {
  alpha2: string;
  alpha3?: string;
  name: string;
  slug: string;
}

export interface Sport {
  id: number;
  slug: string;
  name: string;
}

export interface FieldTranslations {
  nameTranslation?: Record<string, string>;
  shortNameTranslation?: Record<string, string>;
}

export interface Category {
  name: string;
  slug: string;
  sport: Sport;
  id: number;
  country: Country;
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
  hasRounds?: boolean;
  hasPerformanceGraphFeature: boolean;
  id: number;
  country?: Record<string, unknown>;
  hasEventPlayerStatistics?: boolean;
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
  competitionType?: number;
  isLive: boolean;
  id: number;
  fieldTranslations: FieldTranslations;
}

export interface Season {
  name: string;
  year: string;
  editor?: boolean;
  id: number;
}

export interface RoundInfo {
  round: number;
}

export interface Status {
  code: number;
  description: string;
  type: string;
}

export interface VenueCoordinates {
  latitude: number;
  longitude: number;
}

export interface City {
  name: string;
}

export interface Stadium {
  name: string;
  capacity: number;
}

export interface Venue {
  city: City;
  venueCoordinates?: VenueCoordinates;
  hidden: boolean;
  slug: string;
  name: string;
  capacity: number;
  id: number;
  country: Country;
  fieldTranslations: FieldTranslations;
  stadium?: Stadium;
}

export interface Referee {
  name: string;
  slug: string;
  yellowCards?: number;
  redCards?: number;
  yellowRedCards?: number;
  games?: number;
  sport: Sport;
  id: number;
  country: Country;
  fieldTranslations: FieldTranslations;
}

export interface Manager {
  name: string;
  slug: string;
  shortName: string;
  id: number;
  country: Country;
  fieldTranslations: FieldTranslations;
}

export interface TeamColors {
  primary: string;
  secondary: string;
  text: string;
}

export interface Team {
  name: string;
  slug: string;
  shortName: string;
  gender?: string;
  sport: Sport;
  userCount: number;
  manager?: Manager;
  venue?: Venue;
  nameCode: string;
  class?: number;
  disabled: boolean;
  national: boolean;
  type: number;
  id: number;
  country: Country;
  fullName: string;
  subTeams?: Team[];
  teamColors: TeamColors;
  foundationDateTimestamp?: number;
  fieldTranslations: FieldTranslations;
  timeActive?: unknown[];
}

export interface Score {
  current?: number;
  display?: number;
  period1?: number;
  normaltime?: number;
}

export interface TimeInfo {
  currentPeriodStartTimestamp: number;
  initial: number;
  max: number;
  extra?: number;
}

export interface Changes {
  changes: string[];
  changeTimestamp: number;
}

export interface VarInProgress {
  homeTeam: boolean;
  awayTeam: boolean;
}

export interface StatusTime {
  prefix: string;
  initial: number;
  max: number;
  timestamp: number;
  extra?: number;
}

export interface EventData {
  tournament: Tournament;
  season: Season;
  roundInfo?: RoundInfo;
  customId?: string;
  status: Status;
  venue: Venue;
  referee?: Referee;
  homeTeam: Team;
  awayTeam: Team;
  homeScore: Score;
  awayScore: Score;
  time: TimeInfo;
  changes?: Changes;
  hasGlobalHighlights: boolean;
  hasXg: boolean;
  hasEventPlayerStatistics: boolean;
  hasEventPlayerHeatMap: boolean;
  detailId: number;
  crowdsourcingDataDisplayEnabled: boolean;
  id: number;
  defaultPeriodCount: number;
  defaultPeriodLength: number;
  defaultOvertimeLength: number;
  varInProgress: VarInProgress;
  statusTime: StatusTime;
  slug: string;
  currentPeriodStartTimestamp: number;
  startTimestamp: number;
  lastPeriod?: string;
  finalResultOnly: boolean;
  feedLocked: boolean;
  seasonStatisticsType?: string;
  showTotoPromo?: boolean;
  isEditor: boolean;
}

export interface EventApiResponse {
  event: EventData;
}

export interface NormalizedEvent {
  id: number;
  slug: string;
  status: {
    code: number;
    description: string;
    type: string;
  };
  tournament: {
    id: number;
    name: string;
    slug: string;
    uniqueTournament?: {
      id: number;
      name: string;
      slug: string;
    };
  };
  season: {
    id: number;
    name: string;
    year: string;
  };
  round?: number;
  homeTeam: {
    id: number;
    name: string;
    slug: string;
    shortName: string;
    imageUrl?: string;
  };
  awayTeam: {
    id: number;
    name: string;
    slug: string;
    shortName: string;
    imageUrl?: string;
  };
  score: {
    home: number;
    away: number;
    homeDisplay: number;
    awayDisplay: number;
  };
  venue: {
    id: number;
    name: string;
    slug: string;
    city: string;
    capacity: number;
  };
  referee: {
    id: number;
    name: string;
    slug: string;
    yellowCards?: number;
    redCards?: number;
    yellowRedCards?: number;
    games?: number;
    country?: string;
  };
  startTime: number;
  currentTime?: number;
  time?: {
    currentPeriodStartTimestamp?: number;
  };
  features: {
    hasXg: boolean;
    hasPlayerStats: boolean;
    hasHeatMap: boolean;
  };
}
