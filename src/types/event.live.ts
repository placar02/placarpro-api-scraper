export type Country = {
  alpha2: string;
  alpha3: string;
  name: string;
  slug: string;
};

export type Sport = {
  name: string;
  slug: string;
  id: number;
};

export type Category = {
  id: number;
  country: Country;
  name: string;
  slug: string;
  sport: Sport;
  flag: string;
  alpha2: string;
};

export type TeamColors = {
  primary: string;
  secondary: string;
  text: string;
};

export type Team = {
  id: number;
  country: Country;
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
  subTeams: any[];
  teamColors: TeamColors;
};

export type Score = {
  current: number;
  display: number;
  period1: number;
  period2: number;
  normaltime: number;
};

export type Status = {
  code: number;
  description: string;
  type: string;
};

export type RoundInfo = {
  round: number;
};

export type Season = {
  name: string;
  year: string;
  editor: boolean;
  id: number;
};

export type Tournament = {
  name: string;
  slug: string;
  category: Category;
  uniqueTournament?: any;
  priority?: number;
  isGroup?: boolean;
  isLive?: boolean;
  id: number;
};

export type TimeInfo = {
  injuryTime1: number;
  initial: number;
  max: number;
  extra: number;
  currentPeriodStartTimestamp: number;
};

export type EventLive = {
  id: number;
  sourceProvider?: 'sofascore' | 'ogol' | '365scores' | 'aiscore';
  customId: string;
  slug: string;
  startTimestamp: number;
  lastPeriod: string;
  finalResultOnly: boolean;
  feedLocked: boolean;
  isEditor: boolean;
  tournament: Tournament;
  season: Season;
  roundInfo: RoundInfo;
  status: Status;
  homeTeam: Team;
  awayTeam: Team;
  homeScore: Score;
  awayScore: Score;
  time: TimeInfo;
  changes?: {
    changes: string[];
    changeTimestamp: number;
  };
  varInProgress?: {
    homeTeam: boolean;
    awayTeam: boolean;
  };
  hasEventPlayerStatistics?: boolean;
  hasEventPlayerHeatMap?: boolean;
  hasGlobalHighlights?: boolean;
};
