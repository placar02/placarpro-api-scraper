import type { NormalizedEvent } from '../types/event';
import type { EventLive } from '../types/event.live';
import type {
  DataEnrichmentProvider,
  DatasetProvenance,
  NormalizedMatchEnrichment,
  NormalizedMetric,
  NormalizedRecentForm,
} from '../providers/contracts';
import { eventDateCandidates, scoreProviderCandidate } from '../providers/match-correlation';
import {
  fetchOgolEvent,
  fetchOgolIncidents,
  fetchOgolLineups,
  fetchOgolMatches,
  fetchOgolOdds,
  fetchOgolStatistics,
  fetchOgolStreaks,
} from './ogol';

type Loaded = { data: any; provenance: DatasetProvenance };
const cache = new Map<string, { expiresAt: number; promise: Promise<NormalizedMatchEnrichment> }>();

function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`OGOL enrichment timeout after ${timeoutMs}ms`)), timeoutMs);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function finite(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const parsed = Number(String(value).replace(',', '.').replace(/[^\d.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function safeLoad(key: string, loader: () => Promise<any>): Promise<[string, Loaded]> {
  const started = Date.now();
  try {
    const data = await loader();
    const records = Number(data?.summary?.total_items || data?.data?.incidents?.length
      || data?.data?.home?.players?.length + data?.data?.away?.players?.length || (data ? 1 : 0));
    return [key, { data, provenance: { source: 'ogol', status: records ? 'available' : 'empty', durationMs: Date.now() - started, records } }];
  } catch (error) {
    return [key, { data: null, provenance: { source: 'ogol', status: 'failed', durationMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) } }];
  }
}

async function findMatchingOgolEvent(event: NormalizedEvent) {
  const attempts: any[] = [];
  const candidates: Array<{ event: EventLive; date: string; score: ReturnType<typeof scoreProviderCandidate> }> = [];
  for (const date of eventDateCandidates(event)) {
    try {
      const response = await withTimeout(fetchOgolMatches(date), Number(process.env.OGOL_ENRICHMENT_MATCH_TIMEOUT_MS || 20000));
      attempts.push({ date, status: response.status, events: response.events?.length || 0 });
      for (const candidate of response.events || []) candidates.push({ event: candidate, date, score: scoreProviderCandidate(event, candidate) });
      if (candidates.some((candidate) => candidate.score.score >= 0.86 && candidate.score.teamsScore >= 0.8)) break;
    } catch (error) {
      attempts.push({ date, status: 503, events: 0, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const ranked = candidates.sort((a, b) => b.score.score - a.score.score).slice(0, 8);
  return { best: ranked[0], attempts, candidates: ranked.map((item) => ({ id: item.event.id, date: item.date, homeTeam: item.event.homeTeam?.name, awayTeam: item.event.awayTeam?.name, score: item.score })) };
}

function metricsFromOgol(statistics: any): NormalizedMetric[] {
  const periods = Object.values(statistics?.by_period || {}) as any[];
  return periods.flatMap((period) => Object.values(period?.groups_by_name || {}).flatMap((group: any) => (
    group?.items || []
  ).map((item: any) => ({
    key: String(item.key || item.name || 'metric'), name: String(item.name || item.key || 'Metrica'),
    period: String(period.period || 'ALL'), group: String(group.group_name || 'OGOL'),
    home: finite(item.home ?? item.homeValue), away: finite(item.away ?? item.awayValue),
    homeLabel: item.home !== undefined ? String(item.home) : undefined,
    awayLabel: item.away !== undefined ? String(item.away) : undefined, source: 'ogol',
  }))));
}

function normalizedPlayer(entry: any) {
  const player = entry?.player || entry;
  return {
    id: player?.id, name: player?.name || player?.shortName, shortName: player?.shortName,
    position: entry?.position || player?.position, shirtNumber: entry?.shirtNumber,
    substitute: Boolean(entry?.substitute), captain: Boolean(entry?.captain),
    statistics: entry?.stats || entry?.statistics, source: 'ogol',
  };
}

function formFromMatches(matches: any[], subjectId?: unknown, includeSamples = true): NormalizedRecentForm {
  const values = (Array.isArray(matches) ? matches : []).slice(0, 20);
  let wins = 0; let draws = 0; let losses = 0; let goalsFor = 0; let goalsAgainst = 0; let over = 0; let btts = 0; let clean = 0; let withoutScoring = 0;
  const homePerformance = { played: 0, wins: 0, draws: 0, losses: 0 };
  const awayPerformance = { played: 0, wins: 0, draws: 0, losses: 0 };
  const events: Array<Record<string, unknown>> = [];
  for (const match of values) {
    const homeGoals = finite(match.homeScore?.current ?? match.homeScore) ?? 0;
    const awayGoals = finite(match.awayScore?.current ?? match.awayScore) ?? 0;
    const isHome = match.subjectSide ? match.subjectSide === 'home' : String(match.homeTeam?.id) === String(subjectId);
    const own = isHome ? homeGoals : awayGoals;
    const opponent = isHome ? awayGoals : homeGoals;
    const split = isHome ? homePerformance : awayPerformance;
    split.played += 1; goalsFor += own; goalsAgainst += opponent;
    if (own > opponent) { wins += 1; split.wins += 1; } else if (own === opponent) { draws += 1; split.draws += 1; } else { losses += 1; split.losses += 1; }
    if (homeGoals + awayGoals > 2.5) over += 1;
    if (homeGoals > 0 && awayGoals > 0) btts += 1;
    if (opponent === 0) clean += 1;
    if (own === 0) withoutScoring += 1;
    events.push({ ...match, source: 'ogol' });
  }
  const played = values.length;
  const result: NormalizedRecentForm = {
    played, wins, draws, losses, goalsFor, goalsAgainst,
    avgGoalsFor: played ? Number((goalsFor / played).toFixed(2)) : 0,
    avgGoalsAgainst: played ? Number((goalsAgainst / played).toFixed(2)) : 0,
    over25Rate: played ? Number((over * 100 / played).toFixed(1)) : 0,
    bttsRate: played ? Number((btts * 100 / played).toFixed(1)) : 0,
    cleanSheetRate: played ? Number((clean * 100 / played).toFixed(1)) : 0,
    gamesWithoutScoring: withoutScoring,
    goalDifference: goalsFor - goalsAgainst,
    pointsRate: played ? Number((((wins * 3 + draws) / (played * 3)) * 100).toFixed(1)) : 0,
    homePerformance, awayPerformance, events,
  };
  if (includeSamples) {
    result.samples = {
      last5: formFromMatches(values.slice(0, 5), subjectId, false),
      last10: formFromMatches(values.slice(0, 10), subjectId, false),
      last15: formFromMatches(values.slice(0, 15), subjectId, false),
    };
  }
  return result;
}

function empty(reason: string, provenance: Record<string, DatasetProvenance> = {}): NormalizedMatchEnrichment {
  return {
    provider: 'ogol', available: false, reason, metrics: [],
    lineups: { confirmed: false, home: { starters: [], substitutes: [] }, away: { starters: [], substitutes: [] } },
    incidents: [], shots: [], playerStatistics: [], averagePositions: [], bestPlayers: [],
    teams: { home: { topPlayers: [], squad: [], missingPlayers: [] }, away: { topPlayers: [], squad: [], missingPlayers: [] } },
    context: {}, provenance, collectedAt: new Date().toISOString(),
  };
}

async function fetchOgolEnrichmentUncached(event: NormalizedEvent): Promise<NormalizedMatchEnrichment> {
  const search = await findMatchingOgolEvent(event);
  if (!search.best || search.best.score.score < 0.62 || search.best.score.teamsScore < 0.56) {
    return { ...empty('sem correspondencia confiavel no OGOL', { schedule: { source: 'ogol', status: 'empty', records: search.candidates.length } }), matchedEvent: { search } };
  }
  const matched = search.best.event;
  const entries = await Promise.all([
    safeLoad('event', () => fetchOgolEvent(matched.id)),
    safeLoad('statistics', () => fetchOgolStatistics(matched.id)),
    safeLoad('incidents', () => fetchOgolIncidents(matched.id)),
    safeLoad('lineups', () => fetchOgolLineups(matched.id)),
    safeLoad('streaks', () => fetchOgolStreaks(String(matched.id))),
    safeLoad('odds', () => fetchOgolOdds(matched.id)),
  ]);
  const loaded = Object.fromEntries(entries) as Record<string, Loaded>;
  const statistics = loaded.statistics?.data;
  const lineups = loaded.lineups?.data?.data || {};
  const streaks = loaded.streaks?.data?.data || {};
  const eventData = loaded.event?.data?.data || matched;
  const side = (name: 'home' | 'away') => {
    const players = lineups?.[name]?.players || [];
    return {
      starters: players.filter((item: any) => !item.substitute).map(normalizedPlayer),
      substitutes: players.filter((item: any) => item.substitute).map(normalizedPlayer),
    };
  };
  const homeLineup = side('home'); const awayLineup = side('away');
  const playerStatistics = [...homeLineup.starters, ...homeLineup.substitutes, ...awayLineup.starters, ...awayLineup.substitutes].filter((player: any) => player.statistics);
  const provenance = Object.fromEntries(Object.entries(loaded).map(([key, item]) => [key, item.provenance]));
  provenance.schedule = { source: 'ogol', status: 'available', records: search.candidates.length };
  const context = statistics?.context || {};
  return {
    provider: 'ogol', available: true, providerEventId: matched.id,
    matchedEvent: { id: matched.id, homeTeam: matched.homeTeam, awayTeam: matched.awayTeam, startTimestamp: matched.startTimestamp, matchScore: search.best.score, search },
    metrics: metricsFromOgol(statistics),
    lineups: { confirmed: Boolean(lineups.confirmed), home: homeLineup, away: awayLineup },
    incidents: (loaded.incidents?.data?.data?.incidents || []).map((item: any) => ({ ...item, source: 'ogol' })),
    shots: [], playerStatistics, averagePositions: [], bestPlayers: playerStatistics.slice(0, 30),
    odds: loaded.odds?.data || undefined,
    headToHead: formFromMatches(streaks.head2head || [], matched.homeTeam?.id),
    teams: {
      home: { id: matched.homeTeam?.id, name: matched.homeTeam?.name, recentForm: formFromMatches(streaks.home || [], matched.homeTeam?.id), seasonStatistics: context?.seasonFacts?.home, topPlayers: playerStatistics.slice(0, 15), squad: [...homeLineup.starters, ...homeLineup.substitutes], missingPlayers: (lineups?.home?.missingPlayers || []).map(normalizedPlayer) },
      away: { id: matched.awayTeam?.id, name: matched.awayTeam?.name, recentForm: formFromMatches(streaks.away || [], matched.awayTeam?.id), seasonStatistics: context?.seasonFacts?.away, topPlayers: playerStatistics.slice(15, 30), squad: [...awayLineup.starters, ...awayLineup.substitutes], missingPlayers: (lineups?.away?.missingPlayers || []).map(normalizedPlayer) },
    },
    competition: context?.competitionTable,
    context: {
      referee: context?.referee,
      venue: eventData?.venue,
      weather: context?.weather,
      round: eventData?.round,
      attendance: context?.deepAnalysis?.match?.attendance || context?.attendance,
      country: eventData?.tournament?.category?.country?.name,
      importance: context?.teamNeeds,
      phase: eventData?.tournament?.name,
    },
    streaks, provenance, collectedAt: new Date().toISOString(),
    raw: { event: loaded.event?.data, statistics, incidents: loaded.incidents?.data, lineups: loaded.lineups?.data, streaks: loaded.streaks?.data },
  };
}

export function fetchOgolEnrichment(event: NormalizedEvent): Promise<NormalizedMatchEnrichment> {
  const key = `${event.id}:${(event as any).startTimestamp ?? event.startTime ?? ''}`;
  const current = cache.get(key);
  if (current && current.expiresAt > Date.now()) return current.promise;
  const promise = fetchOgolEnrichmentUncached(event);
  cache.set(key, {
    expiresAt: Date.now() + Number(process.env.OGOL_ENRICHMENT_CACHE_TTL_MS || 900000),
    promise,
  });
  promise.catch(() => {
    const entry = cache.get(key);
    if (entry?.promise === promise) entry.expiresAt = Date.now() + 60000;
  });
  return promise;
}

export function ogolEnrichmentEnabled() {
  return process.env.OGOL_ENRICHMENT_ENABLED !== 'false';
}

export const ogolProvider: DataEnrichmentProvider = {
  id: 'ogol', enabled: ogolEnrichmentEnabled, enrich: fetchOgolEnrichment,
};
