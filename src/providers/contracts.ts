import type { NormalizedEvent } from '../types/event';

export type DatasetStatus = 'available' | 'empty' | 'failed' | 'disabled';

export type DatasetProvenance = {
  source: string;
  status: DatasetStatus;
  endpoint?: string;
  durationMs?: number;
  records?: number;
  error?: string;
};

export type NormalizedMetric = {
  key: string;
  name: string;
  period: string;
  group: string;
  home?: number;
  away?: number;
  homeLabel?: string;
  awayLabel?: string;
  source: string;
};

export type NormalizedRecentForm = {
  played: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
  avgGoalsFor: number;
  avgGoalsAgainst: number;
  over25Rate: number;
  bttsRate: number;
  cleanSheetRate: number;
  gamesWithoutScoring: number;
  goalDifference: number;
  pointsRate: number;
  homePerformance: { played: number; wins: number; draws: number; losses: number };
  awayPerformance: { played: number; wins: number; draws: number; losses: number };
  events: Array<Record<string, unknown>>;
  samples?: Record<'last5' | 'last10' | 'last15', Omit<NormalizedRecentForm, 'samples'>>;
};

export type NormalizedTeamEnrichment = {
  id?: number | string;
  name?: string;
  profile?: Record<string, unknown>;
  recentForm?: NormalizedRecentForm;
  seasonStatistics?: Record<string, unknown>;
  topPlayers: Array<Record<string, unknown>>;
  squad: Array<Record<string, unknown>>;
  missingPlayers: Array<Record<string, unknown>>;
};

export type NormalizedMatchEnrichment = {
  provider: string;
  available: boolean;
  providerEventId?: number | string;
  reason?: string;
  matchedEvent?: Record<string, unknown>;
  metrics: NormalizedMetric[];
  lineups: {
    confirmed: boolean;
    home: { starters: Array<Record<string, unknown>>; substitutes: Array<Record<string, unknown>> };
    away: { starters: Array<Record<string, unknown>>; substitutes: Array<Record<string, unknown>> };
  };
  incidents: Array<Record<string, unknown>>;
  shots: Array<Record<string, unknown>>;
  playerStatistics: Array<Record<string, unknown>>;
  averagePositions: Array<Record<string, unknown>>;
  bestPlayers: Array<Record<string, unknown>>;
  odds?: Record<string, unknown>;
  streaks?: Record<string, unknown>;
  pregameForm?: Record<string, unknown>;
  headToHead?: NormalizedRecentForm;
  teams: { home: NormalizedTeamEnrichment; away: NormalizedTeamEnrichment };
  competition?: { standings?: Record<string, unknown>; home?: Record<string, unknown>; away?: Record<string, unknown> };
  context: {
    referee?: Record<string, unknown>;
    venue?: Record<string, unknown>;
    weather?: Record<string, unknown>;
    round?: unknown;
    attendance?: unknown;
    country?: unknown;
    importance?: unknown;
    phase?: unknown;
  };
  graph?: Record<string, unknown>;
  raw?: Record<string, unknown>;
  provenance: Record<string, DatasetProvenance>;
  collectedAt: string;
};

export interface DataEnrichmentProvider {
  id: string;
  enabled(): boolean;
  enrich(event: NormalizedEvent): Promise<NormalizedMatchEnrichment>;
}
