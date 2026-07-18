import express from 'express';
import { analyzeEvent } from '../analysis/ai';
import { fetchAiScoreIncidents, fetchAiScoreLineups, fetchAiScoreMatches, fetchAiScoreStatistics, fetchAiScoreStreaks } from '../scrapers/aiscore';
import { fetchIncidents } from '../scrapers/incidents';
import { fetchLineups } from '../scrapers/lineups';
import { fetchScheduledMatches } from '../scrapers/scheduled';
import { fetch365Matches } from '../scrapers/scores365';
import { fetch365Enrichment } from '../scrapers/scores365-enrichment';
import { fetchOgolEventFast, fetchOgolIncidents, fetchOgolLineups, fetchOgolMatches, fetchOgolMatchesFastCached, fetchOgolStatistics, fetchOgolStreaks } from '../scrapers/ogol';
import { fetchStatistics } from '../scrapers/statistics';
import { fetchStreaks } from '../scrapers/streaks';
import type { AnalysisResult, AnalyzeOptions } from '../types/analysis';
import { analysisJobPayload, enqueueAnalysisJob, getAnalysisJob } from '../services/analysis-jobs';
import {
  buildChampionshipPriorityContext,
  CHAMPIONSHIP_PRIORITY_VERSION,
  compareAnalysisRanking,
  getChampionshipPriority,
  profileSelectionScore,
  type ChampionshipPriority,
  type ChampionshipPriorityContext,
} from '../config/championshipPriority';

export const analysisRouter = express.Router();

type BestOfThreeResponse = {
  eventIds: string[];
  bestEventId: string | number;
  bestEntry: AnalysisResult;
  analyses: AnalysisResult[];
};

type BestDailyResponse = {
  date: string;
  requestedEntries: number;
  candidatesChecked: number;
  selectedEventIds: string[];
  bestEntry: AnalysisResult | null;
  entries: AnalysisResult[];
  analyses: AnalysisResult[];
  skipped: Array<{ eventId?: string | number; reason: string; attempts?: number }>;
};

type TournamentAnalysisResponse = {
  tournamentId: string;
  datesChecked: string[];
  requestedEntries: number;
  matchesFound: number;
  candidatesChecked: number;
  selectedEventIds: string[];
  bestEntry: AnalysisResult | null;
  entries: AnalysisResult[];
  analyses: AnalysisResult[];
  skipped: Array<{ eventId?: string | number; reason: string; attempts?: number }>;
  availableTournaments?: Array<{ ids: string[]; name?: string; count: number; sampleEventId?: string | number }>;
  warning?: string;
};

type FullDailyAnalysisResponse = {
  date: string;
  requestedMatches: number;
  matchesFound: number;
  candidatesChecked: number;
  qualifiedMatches: number;
  selectedEventIds: string[];
  selectedEvents: any[];
  bestEntry: AnalysisResult | null;
  entries: Array<AnalysisResult & { dataProfile?: MatchDataProfile }>;
  analyses: Array<AnalysisResult & { dataProfile?: MatchDataProfile }>;
  skipped: Array<{ eventId?: string | number; reason: string; attempts?: number; dataProfile?: MatchDataProfile }>;
  prioritySummary?: {
    version: string;
    candidatesByTier: Record<string, number>;
    selectedByTier: Record<string, number>;
  };
  warning?: string;
};

type CachedAnalysis = {
  expiresAt: number;
  value: AnalysisResult;
};

type CachedFullDaily = {
  expiresAt: number;
  value: FullDailyAnalysisResponse;
};

type CachedMatchesResponse = {
  expiresAt: number;
  value: any;
};

type AnalyzeConcurrencyConfig = {
  concurrency: number;
  timeoutMs: number;
  retries: number;
  cacheTtlMs: number;
};

type MatchDataProfile = {
  eventId: string;
  score: number;
  hasStatistics: boolean;
  statisticsItems: number;
  hasLineupsOrPlayers: boolean;
  lineupPlayers: number;
  hasRecentHistory: boolean;
  recentMatches: number;
  hasIncidents: boolean;
  incidentsApplicable?: boolean;
  incidents: number;
  hasCardsData: boolean;
  hasCornersData: boolean;
  missing: string[];
  dataSources?: string[];
  scores365Attempted?: boolean;
  scores365Matched?: boolean;
  scores365Reason?: string;
  scores365ScheduleAttempts?: any[];
  scores365Candidates?: Array<{
    id?: string | number;
    slug?: string;
    homeTeam?: string;
    awayTeam?: string;
    startTimestamp?: number;
    score?: any;
  }>;
  historySource?: string;
  championshipPriority?: ChampionshipPriority;
};

const analysisEventCache = new Map<string, CachedAnalysis>();
const fullDailyCache = new Map<string, CachedFullDaily>();
const analysisMatchesCache = new Map<string, CachedMatchesResponse>();
const profileCache = new Map<string, { expiresAt: number; value: MatchDataProfile }>();
const profileInFlight = new Map<string, Promise<MatchDataProfile>>();
const MAX_ANALYSIS_EVENT_CACHE_ITEMS = 500;
const MAX_FULL_DAILY_CACHE_ITEMS = 80;

function quickEventResult(event: any, cached?: AnalysisResult | null): AnalysisResult & Record<string, unknown> {
  const homeGoals = Number(event?.homeScore?.current ?? event?.score?.home ?? event?.homeScore ?? 0);
  const awayGoals = Number(event?.awayScore?.current ?? event?.score?.away ?? event?.awayScore ?? 0);
  return {
    eventId: event?.id ?? cached?.eventId ?? 'unknown',
    homeTeam: event?.homeTeam ? { id: event.homeTeam.id, name: event.homeTeam.name, shortName: event.homeTeam.shortName, slug: event.homeTeam.slug, imageUrl: event.homeTeam.imageUrl } : cached?.homeTeam,
    awayTeam: event?.awayTeam ? { id: event.awayTeam.id, name: event.awayTeam.name, shortName: event.awayTeam.shortName, slug: event.awayTeam.slug, imageUrl: event.awayTeam.imageUrl } : cached?.awayTeam,
    tournamentName: event?.tournament?.name || event?.tournamentName || cached?.tournamentName,
    startTimestamp: event?.startTimestamp || event?.startTime || cached?.startTimestamp,
    market: cached?.market || 'pending',
    recommendation: cached?.recommendation || 'Análise completa em processamento',
    confidence: Number(cached?.confidence || 0),
    rationale: cached?.rationale || 'Os dados essenciais já estão disponíveis; estatísticas avançadas e IA estão sendo processadas em segundo plano.',
    score: { home: homeGoals, away: awayGoals },
    goalsScored: { home: homeGoals, away: awayGoals },
    goalsConceded: { home: awayGoals, away: homeGoals },
    homeAdvantage: event?.homeTeam?.name || cached?.homeTeam?.name,
    recentMatches: cached?.meta?.recentMatches || [],
    analysisStatus: cached ? 'cached' : 'processing',
    analysisSource: cached?.analysisSource,
    meta: { ...(cached?.meta || {}), mode: 'fast', cacheHit: Boolean(cached) },
  };
}

function quickDailyResult(date: string, events: any[], limit: number) {
  const entries = events.slice(0, limit).map((event) => quickEventResult(event));
  return {
    date,
    requestedMatches: limit,
    matchesFound: events.length,
    candidatesChecked: entries.length,
    qualifiedMatches: 0,
    selectedEventIds: entries.map((entry) => String(entry.eventId)),
    bestEntry: entries[0] || null,
    entries,
    analyses: entries,
    skipped: [],
    analysisStatus: 'processing',
    warning: 'Dados essenciais disponíveis. A análise completa está sendo processada em segundo plano.',
  };
}

function shouldWait(req: express.Request) {
  return req.query.wait === 'true' || process.env.ANALYSIS_ASYNC_ENABLED === 'false';
}

function sendJob(res: express.Response, key: string, quickResult: unknown, task: () => Promise<unknown>) {
  const job = enqueueAnalysisJob(key, quickResult, task);
  res.status(202).json(analysisJobPayload(job));
}

function parseEventIds(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => parseEventIds(item));
  }

  if (typeof value === 'number') return [String(value)];
  if (typeof value !== 'string') return [];

  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function selectBestEventEntry(analyses: AnalysisResult[]): BestOfThreeResponse {
  const sorted = [...analyses].sort((a, b) => b.confidence - a.confidence);
  const bestEntry = sorted[0];

  return {
    eventIds: analyses.map((analysis) => String(analysis.eventId)),
    bestEventId: bestEntry.eventId,
    bestEntry,
    analyses: sorted,
  };
}

async function analyzeBestOfThree(eventIds: string[], options: AnalyzeOptions): Promise<BestOfThreeResponse> {
  const concurrency = Math.max(1, Number(process.env.ANALYSIS_CONCURRENCY || 1));
  const { analyses, skipped } = await analyzeWithConcurrency(
    eventIds,
    options,
    concurrency,
    Number(process.env.ANALYSIS_TIMEOUT_MS || 180000),
    Number(process.env.ANALYSIS_RETRIES || 1),
    Number(process.env.ANALYSIS_CACHE_TTL_MS || 15 * 60 * 1000),
  );
  if (analyses.length === 0) {
    throw new Error(skipped.map((item) => `${item.eventId}: ${item.reason}`).join('; ') || 'Nenhuma analise foi concluida.');
  }
  return selectBestEventEntry(analyses);
}

function isTrue(value: unknown): boolean {
  return value === true || value === 'true';
}

function optionalNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function getTodayDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.MATCHES_TIMEZONE || 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function addDays(dateKey: string, days: number) {
  const date = new Date(`${dateKey}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function parsePositiveInt(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function getEventTimestamp(event: any) {
  return Number(event?.startTimestamp || event?.startTime || event?.matchTime || 0);
}

function getStatusType(event: any) {
  return String(event?.status?.type || '').toLowerCase();
}

function isFinished(event: any) {
  return ['finished', 'ended', 'final', 'afterextra', 'afterpenalties', 'canceled', 'cancelled', 'postponed', 'abandoned', 'interrupted']
    .includes(getStatusType(event));
}

function isLive(event: any) {
  return ['inprogress', 'live'].includes(getStatusType(event));
}

function getTournamentIds(event: any) {
  return [
    event?.tournament?.id,
    event?.tournament?.uniqueTournament?.id,
    event?.uniqueTournament?.id,
    event?.competition?.id,
    event?.competitionId,
  ]
    .filter((value) => value !== null && value !== undefined && value !== '')
    .map((value) => String(value));
}

function summarizeAvailableTournaments(events: any[]) {
  const map = new Map<string, { ids: string[]; name?: string; count: number; sampleEventId?: string | number }>();

  for (const event of events) {
    const ids = getTournamentIds(event);
    if (!ids.length) continue;

    const key = ids.join('|');
    const current = map.get(key) || {
      ids,
      name: event?.tournament?.name || event?.competition?.name,
      count: 0,
      sampleEventId: event?.id,
    };
    current.count += 1;
    map.set(key, current);
  }

  return [...map.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);
}

function eventCompletenessScore(event: any) {
  let score = 0;
  if (event?.id) score += 20;
  if (event?.homeTeam?.name && event?.awayTeam?.name) score += 20;
  if (event?.tournament?.name) score += 12;
  if (event?.season?.id) score += 10;
  if (getEventTimestamp(event)) score += 8;
  if (event?.homeScore || event?.score) score += 6;
  if (event?.hasEventPlayerStatistics || event?.features?.hasPlayerStats) score += 10;
  if (event?.status?.type) score += 6;
  if (!isFinished(event)) score += 8;
  if (isLive(event)) score += 6;
  return score;
}

function dailyProfileRankingScore(
  item: { event: any; profile: MatchDataProfile },
  strictMarkets: boolean,
  context: ChampionshipPriorityContext,
) {
  const fullDataBonus = isFullDataProfile(item.profile, strictMarkets) ? 10 : 0;
  const priority = item.profile.championshipPriority || getChampionshipPriority(item.event, context);
  return profileSelectionScore(item.profile.score, priority, fullDataBonus > 0);
}

async function safeLoad<T>(loader: () => Promise<T>): Promise<T | null> {
  try {
    return await loader();
  } catch {
    return null;
  }
}

function normalizeDataText(value: unknown) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function countStatisticsItems(statistics: any) {
  return Number(statistics?.summary?.total_items || 0);
}

function countLineupPlayers(lineups: any) {
  const data = lineups?.data || lineups;
  return Number(data?.home?.players?.length || 0) + Number(data?.away?.players?.length || 0);
}

function countRecentMatches(streaks: any) {
  const data = streaks?.data || streaks;
  return Number(data?.home?.length || 0) + Number(data?.away?.length || 0) + Number(data?.head2head?.length || 0);
}

function ogolContext(statistics: any) {
  return statistics?.context || statistics?.raw?.context || {};
}

function countOgolHistoricalEvidence(statistics: any) {
  const facts = ogolContext(statistics)?.seasonFacts || {};
  const evidenceForSide = (side: any) => {
    const matches = Number(side?.matches || 0);
    if (matches > 0) return matches;
    if (side?.form || String(side?.text || '').trim().length > 40) return 4;
    return 0;
  };
  return evidenceForSide(facts.home) + evidenceForSide(facts.away);
}

function ogolRefereeHasCards(statistics: any) {
  const referee = ogolContext(statistics)?.referee;
  return Number(referee?.cardsAverage || 0) > 0
    || Number(referee?.yellowCards || 0) > 0
    || Number(referee?.redCards || 0) > 0;
}

function countIncidents(incidents: any) {
  const items = incidents?.data?.incidents || incidents?.incidents;
  return Array.isArray(items) ? items.length : 0;
}

function statHasPattern(statistics: any, patterns: RegExp[]) {
  const groups = Object.values(statistics?.by_period?.ALL?.groups_by_name || {});
  const items = groups.flatMap((group: any) => Array.isArray(group.items) ? group.items : []);

  return items.some((item: any) => {
    const text = normalizeDataText(`${item.name || ''} ${item.key || ''}`);
    return patterns.some((pattern) => pattern.test(text));
  });
}

function incidentsHaveCards(incidents: any) {
  const items = incidents?.data?.incidents || incidents?.incidents;
  if (!Array.isArray(items)) return false;
  return items.some((incident: any) => /card|yellow|red|cartao|cartoes/.test(normalizeDataText(`${incident.type || ''} ${incident.class || ''} ${incident.incidentType || ''}`)));
}

async function inspectMatchData(eventId: string, event?: any): Promise<MatchDataProfile> {
  const isAiScoreProvider = process.env.SCORES_PROVIDER === 'aiscore';
  const isOgolProvider = process.env.SCORES_PROVIDER === 'ogol';
  const [statistics, lineups, streaks, incidents] = await Promise.all([
    safeLoad(() => isAiScoreProvider ? fetchAiScoreStatistics(eventId) : isOgolProvider ? fetchOgolStatistics(eventId) : fetchStatistics(eventId)),
    safeLoad(() => isAiScoreProvider ? fetchAiScoreLineups(eventId) : isOgolProvider ? fetchOgolLineups(eventId) : fetchLineups(eventId)),
    safeLoad(() => isAiScoreProvider ? fetchAiScoreStreaks(eventId) : isOgolProvider ? fetchOgolStreaks(eventId) : fetchStreaks(eventId)),
    safeLoad(() => isAiScoreProvider ? fetchAiScoreIncidents(eventId) : isOgolProvider ? fetchOgolIncidents(eventId) : fetchIncidents(eventId)),
  ]);
  const needs365Scores = isAiScoreProvider && event && (
    countStatisticsItems(statistics) === 0
    || countLineupPlayers(lineups) < 10
    || countRecentMatches(streaks) < 4
    || countIncidents(incidents) === 0
    || !incidentsHaveCards(incidents)
    || !statHasPattern(statistics, [/corner|escanteio|corners/])
  );
  const scores365 = needs365Scores
    ? await safeLoad(() => fetch365Enrichment(event))
    : null;
  const scores365Stats = scores365?.available ? scores365.statistics : null;
  const scores365Lineups = scores365?.available ? scores365.lineups : null;
  const scores365Streaks = scores365?.available ? scores365.streaks : null;
  const scores365Incidents = scores365?.available ? scores365.incidents : null;

  const statisticsItems = Math.max(countStatisticsItems(statistics), countStatisticsItems(scores365Stats));
  const lineupPlayers = Math.max(countLineupPlayers(lineups), countLineupPlayers(scores365Lineups));
  const arrayRecentMatches = Math.max(countRecentMatches(streaks), countRecentMatches(scores365Streaks));
  const historicalEvidence = isOgolProvider ? countOgolHistoricalEvidence(statistics) : 0;
  const recentMatches = Math.max(arrayRecentMatches, historicalEvidence);
  const incidentCount = Math.max(countIncidents(incidents), countIncidents(scores365Incidents));
  const statusType = normalizeDataText(event?.status?.type);
  const incidentsApplicable = ['live', 'inprogress', 'finished', 'afterpenalties', 'afterextra'].includes(statusType);
  const hasCardsData = incidentsHaveCards(incidents)
    || incidentsHaveCards(scores365Incidents)
    || statHasPattern(statistics, [/card|yellow|red|cartao|cartoes/])
    || statHasPattern(scores365Stats, [/card|yellow|red|cartao|cartoes/])
    || (isOgolProvider && ogolRefereeHasCards(statistics));
  const hasCornersData = statHasPattern(statistics, [/corner|escanteio|corners/])
    || statHasPattern(scores365Stats, [/corner|escanteio|corners/]);
  const missing = [
    statisticsItems > 0 ? null : 'statistics',
    lineupPlayers >= 10 ? null : 'lineups_or_player_pool',
    recentMatches >= 4 ? null : 'recent_history',
    !incidentsApplicable || incidentCount > 0 ? null : 'incidents',
    hasCardsData ? null : 'cards',
    hasCornersData ? null : 'corners',
  ].filter(Boolean) as string[];
  const score = [
    statisticsItems > 0 ? 30 : 0,
    lineupPlayers >= 10 ? 25 : lineupPlayers > 0 ? 12 : 0,
    recentMatches >= 8 ? 25 : recentMatches >= 4 ? 16 : recentMatches > 0 ? 8 : 0,
    !incidentsApplicable || incidentCount > 0 ? 8 : 0,
    hasCardsData ? 6 : 0,
    hasCornersData ? 6 : 0,
  ].reduce((total, value) => total + value, 0);

  return {
    eventId,
    score,
    hasStatistics: statisticsItems > 0,
    statisticsItems,
    hasLineupsOrPlayers: lineupPlayers >= 10,
    lineupPlayers,
    hasRecentHistory: recentMatches >= 4,
    recentMatches,
    hasIncidents: !incidentsApplicable || incidentCount > 0,
    incidentsApplicable,
    incidents: incidentCount,
    hasCardsData,
    hasCornersData,
    missing,
    dataSources: [
      process.env.SCORES_PROVIDER || 'sofascore',
      scores365?.available ? '365scores' : null,
    ].filter(Boolean) as string[],
    scores365Attempted: Boolean(needs365Scores),
    scores365Matched: Boolean(scores365?.available),
    scores365Reason: scores365
      ? scores365.available
        ? 'matched'
        : scores365.reason || '365scores unavailable'
      : needs365Scores
        ? '365scores fetch failed'
        : 'not_attempted: primary provider already had enough data for this profile',
    historySource: arrayRecentMatches > 0
      ? 'match_list'
      : historicalEvidence > 0
        ? 'ogol_season_facts'
        : 'unavailable',
    scores365ScheduleAttempts: Array.isArray(scores365?.matchSearch?.scheduleAttempts)
      ? scores365.matchSearch.scheduleAttempts
      : undefined,
    scores365Candidates: Array.isArray(scores365?.matchSearch?.candidates)
      ? scores365.matchSearch.candidates.slice(0, 5)
      : undefined,
  };
}

function inspectMatchDataCached(eventId: string, event?: any): Promise<MatchDataProfile> {
  const key = `${process.env.SCORES_PROVIDER || 'sofascore'}:${eventId}`;
  const cached = profileCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.value);
  if (cached) profileCache.delete(key);

  const running = profileInFlight.get(key);
  if (running) return running;

  const promise = inspectMatchData(eventId, event)
    .then((profile) => {
      const configuredTtl = Number(process.env.PROFILE_INSPECTION_CACHE_TTL_MS || 15 * 60 * 1000);
      const ttlMs = profile.score > 0 ? configuredTtl : Math.min(configuredTtl, 60 * 1000);
      profileCache.set(key, { expiresAt: Date.now() + Math.max(1000, ttlMs), value: profile });
      pruneCache(profileCache, 500);
      return profile;
    })
    .finally(() => profileInFlight.delete(key));
  profileInFlight.set(key, promise);
  return promise;
}

function buildFailedProfile(eventId: string, reason: string): MatchDataProfile {
  return {
    eventId,
    score: 0,
    hasStatistics: false,
    statisticsItems: 0,
    hasLineupsOrPlayers: false,
    lineupPlayers: 0,
    hasRecentHistory: false,
    recentMatches: 0,
    hasIncidents: false,
    incidentsApplicable: true,
    incidents: 0,
    hasCardsData: false,
    hasCornersData: false,
    missing: ['profile_inspection'],
    dataSources: [process.env.SCORES_PROVIDER || 'sofascore'],
    scores365Attempted: false,
    scores365Matched: false,
    scores365Reason: reason,
    historySource: 'unavailable',
  };
}

async function inspectProfilesWithConcurrency(events: any[], concurrency = 2, timeoutMs = 0, totalBudgetMs = 0) {
  const profiles: Array<{ event: any; profile: MatchDataProfile }> = [];
  let index = 0;
  const deadline = totalBudgetMs > 0 ? Date.now() + totalBudgetMs : 0;

  async function worker() {
    while (index < events.length) {
      const currentIndex = index;
      index += 1;
      const event = events[currentIndex];
      const eventId = String(event.id);
      const remainingMs = deadline ? deadline - Date.now() : timeoutMs;
      if (deadline && remainingMs <= 0) {
        profiles[currentIndex] = {
          event,
          profile: buildFailedProfile(eventId, `Profile inspection budget of ${totalBudgetMs}ms exhausted`),
        };
        continue;
      }

      try {
        profiles[currentIndex] = {
          event,
          profile: await withTimeout(
            inspectMatchDataCached(eventId, event),
            deadline && timeoutMs > 0 ? Math.min(timeoutMs, remainingMs) : timeoutMs,
            `Profile inspection ${eventId}`
          ),
        };
      } catch (err) {
        const reason = formatAttemptError(err);
        console.warn(`Inspecao de perfil falhou para o evento ${eventId}: ${reason}`);
        profiles[currentIndex] = {
          event,
          profile: buildFailedProfile(eventId, reason),
        };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));
  return profiles.filter(Boolean);
}

function isFullDataProfile(profile: MatchDataProfile, strictMarkets: boolean) {
  const hasCoreData = profile.hasStatistics && profile.hasLineupsOrPlayers && profile.hasRecentHistory;
  if (!strictMarkets) return hasCoreData;
  return hasCoreData && profile.hasCardsData && profile.hasCornersData;
}

async function fetchMatchesForAnalysisDay(date: string, mode: string) {
  const provider = process.env.SCORES_PROVIDER;
  const cacheKey = `${provider || 'sofascore'}:${date}:${mode}`;
  const cached = analysisMatchesCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (cached) analysisMatchesCache.delete(cacheKey);

  const value = await (async () => {
    if (provider === '365scores') return fetch365Matches(date);
    if (provider === 'ogol') return fetchOgolMatches(date);
    if (provider === 'aiscore') return fetchAiScoreMatches(date);
    if (mode === 'live') {
      const { fetchLiveMatches } = await import('../scrapers/live');
      return fetchLiveMatches({ retryOn403: true });
    }
    return fetchScheduledMatches(date, true);
  })();

  const defaultTtl = mode === 'live' ? 15_000 : 120_000;
  const ttlMs = Math.max(0, Number(process.env.ANALYSIS_MATCHES_CACHE_TTL_MS || defaultTtl));
  if (ttlMs > 0) {
    analysisMatchesCache.set(cacheKey, { expiresAt: Date.now() + ttlMs, value });
    pruneCache(analysisMatchesCache, 100);
  }

  return value;
}

function filterMatchesForMode(events: any[], mode: string) {
  const filtered = events
    .filter((event) => event?.id && !isFinished(event))
    .filter((event) => {
      if (mode === 'live') return isLive(event);
      if (mode === 'all') return true;
      return !isLive(event);
    });
  const unique = new Map<string, any>();

  for (const event of filtered) {
    const home = normalizeDataText(event?.homeTeam?.name).replace(/[^a-z0-9]+/g, ' ').trim();
    const away = normalizeDataText(event?.awayTeam?.name).replace(/[^a-z0-9]+/g, ' ').trim();
    const timestamp = getEventTimestamp(event);
    const key = home && away && timestamp ? `${home}|${away}|${timestamp}` : `id:${event.id}`;
    const current = unique.get(key);
    if (!current || eventCompletenessScore(event) > eventCompletenessScore(current)) unique.set(key, event);
  }

  return [...unique.values()]
    .sort((a, b) => {
      const scoreDelta = eventCompletenessScore(b) - eventCompletenessScore(a);
      if (scoreDelta !== 0) return scoreDelta;
      return getEventTimestamp(a) - getEventTimestamp(b);
    });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return promise;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timeout after ${timeoutMs}ms`)), timeoutMs);
    promise
      .then(resolve, reject)
      .finally(() => clearTimeout(timer));
  });
}

function pruneCache<K, V>(cache: Map<K, V>, maxItems: number) {
  while (cache.size > maxItems) {
    const firstKey = cache.keys().next().value;
    if (firstKey === undefined) break;
    cache.delete(firstKey);
  }
}

function analysisCacheKey(eventId: string | number, options: AnalyzeOptions) {
  return JSON.stringify({
    eventId: String(eventId),
    useLLM: options.useLLM !== false,
    useLLMExplanation: options.useLLMExplanation !== false,
    explainRejected: Boolean(options.explainRejected),
    includeOdds: Boolean(options.includeOdds),
    useOddsFallback: Boolean(options.useOddsFallback),
    includeEnrichment: options.includeEnrichment !== false,
    requireRealOdds: Boolean(options.requireRealOdds),
    minimumExpectedValue: options.minimumExpectedValue,
    provider: process.env.SCORES_PROVIDER || 'sofascore',
  });
}

function getCachedAnalysis(eventId: string | number, options: AnalyzeOptions) {
  const cacheKey = analysisCacheKey(eventId, options);
  const cached = analysisEventCache.get(cacheKey);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    analysisEventCache.delete(cacheKey);
    return null;
  }
  return cached.value;
}

function setCachedAnalysis(eventId: string | number, options: AnalyzeOptions, value: AnalysisResult, ttlMs: number) {
  if (!ttlMs || ttlMs <= 0) return;
  analysisEventCache.set(analysisCacheKey(eventId, options), {
    expiresAt: Date.now() + ttlMs,
    value,
  });
  pruneCache(analysisEventCache, MAX_ANALYSIS_EVENT_CACHE_ITEMS);
}

function fullDailyCacheKey(date: string, options: AnalyzeOptions, config: Record<string, unknown>) {
  return JSON.stringify({
    date,
    options: {
      useLLM: options.useLLM !== false,
      includeOdds: Boolean(options.includeOdds),
      useOddsFallback: Boolean(options.useOddsFallback),
      includeEnrichment: options.includeEnrichment !== false,
      requireRealOdds: Boolean(options.requireRealOdds),
      minimumExpectedValue: options.minimumExpectedValue,
    },
    config,
    provider: process.env.SCORES_PROVIDER || 'sofascore',
    championshipPriorityVersion: CHAMPIONSHIP_PRIORITY_VERSION,
  });
}

function getCachedFullDaily(cacheKey: string) {
  const cached = fullDailyCache.get(cacheKey);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    fullDailyCache.delete(cacheKey);
    return null;
  }
  return cached.value;
}

function setCachedFullDaily(cacheKey: string, value: FullDailyAnalysisResponse, ttlMs: number) {
  if (!ttlMs || ttlMs <= 0) return;
  fullDailyCache.set(cacheKey, {
    expiresAt: Date.now() + ttlMs,
    value,
  });
  pruneCache(fullDailyCache, MAX_FULL_DAILY_CACHE_ITEMS);
}

function formatAttemptError(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

async function analyzeEventResilient(eventId: string, options: AnalyzeOptions, config: AnalyzeConcurrencyConfig) {
  const cached = getCachedAnalysis(eventId, options);
  if (cached) {
    return { analysis: { ...cached, meta: { ...(cached.meta || {}), cacheHit: true } }, attempts: 0 };
  }

  let lastError = 'Analysis failed';
  const maxAttempts = Math.max(1, config.retries + 1);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const analysis = await withTimeout(
        analyzeEvent(eventId, options),
        config.timeoutMs,
        `Analysis ${eventId}`
      );

      if (analysis?.recommendation && Number(analysis.confidence || 0) > 0) {
        setCachedAnalysis(eventId, options, analysis, config.cacheTtlMs);
        return { analysis, attempts: attempt };
      }

      return {
        skipped: {
          eventId,
          reason: 'Analysis returned no usable recommendation',
          attempts: attempt,
        },
      };
    } catch (err) {
      lastError = formatAttemptError(err);
      console.warn(`Analise individual falhou para o evento ${eventId} (tentativa ${attempt}/${maxAttempts}): ${lastError}`);
    }
  }

  return {
    skipped: {
      eventId,
      reason: lastError,
      attempts: maxAttempts,
    },
  };
}

async function analyzeWithConcurrency(eventIds: string[], options: AnalyzeOptions, concurrency = 2, timeoutMs = 0, retries = 0, cacheTtlMs = 0) {
  const analyses: AnalysisResult[] = [];
  const skipped: Array<{ eventId?: string | number; reason: string; attempts?: number }> = [];
  let index = 0;
  const config = {
    concurrency: Math.max(1, concurrency),
    timeoutMs,
    retries: Math.max(0, retries),
    cacheTtlMs,
  };

  async function worker() {
    while (index < eventIds.length) {
      const currentIndex = index;
      index += 1;
      const eventId = eventIds[currentIndex];

      const result = await analyzeEventResilient(eventId, options, config);
      if (result.analysis) analyses.push(result.analysis);
      if (result.skipped) skipped.push(result.skipped);
    }
  }

  await Promise.all(Array.from({ length: config.concurrency }, () => worker()));
  return { analyses, skipped };
}

async function analyzeBatchWithSingleExplanation(eventIds: string[], options: AnalyzeOptions, concurrency: number, timeoutMs: number, cacheTtlMs = 0) {
  const batch = await analyzeWithConcurrency(eventIds, { ...options, useLLMExplanation: false }, concurrency, timeoutMs, 0, cacheTtlMs);
  const ranked = batch.analyses.sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0));
  const best = ranked.find((analysis) => Number(analysis.confidence || 0) > 0);
  if (!best || options.useLLM === false || options.useLLMExplanation === false) return { ...batch, analyses: ranked };
  try {
    const explained = await withTimeout(
      analyzeEvent(best.eventId, { ...options, useLLMExplanation: true }),
      Number(process.env.FULL_DAILY_EXPLANATION_TIMEOUT_MS || 12000),
      `Explanation ${best.eventId}`,
    );
    return { ...batch, analyses: ranked.map((analysis) => String(analysis.eventId) === String(explained.eventId) ? explained : analysis) };
  } catch (error) {
    console.warn(`Explicacao do lote ignorada por latencia: ${formatAttemptError(error)}`);
    return { ...batch, analyses: ranked };
  }
}

async function analyzeBestDaily(date: string, options: AnalyzeOptions, config: { limit: number; maxCandidates: number; mode: string }): Promise<BestDailyResponse> {
  const matchesResponse: any = await fetchMatchesForAnalysisDay(date, config.mode);
  const events = Array.isArray(matchesResponse?.events)
    ? matchesResponse.events
    : Array.isArray(matchesResponse?.data)
      ? matchesResponse.data
      : [];
  const candidates = filterMatchesForMode(events, config.mode).slice(0, config.maxCandidates);
  const eventIds = candidates.map((event) => String(event.id)).filter(Boolean);
  const { analyses, skipped } = await analyzeWithConcurrency(eventIds, options, 2);
  const sorted = analyses.sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0));
  const entries = sorted.slice(0, config.limit);

  return {
    date,
    requestedEntries: config.limit,
    candidatesChecked: candidates.length,
    selectedEventIds: entries.map((analysis) => String(analysis.eventId)),
    bestEntry: entries[0] || null,
    entries,
    analyses: sorted,
    skipped,
  };
}

async function analyzeFullDaily(date: string, options: AnalyzeOptions, config: { limit: number; maxCandidates: number; profileCandidateLimit: number; mode: string; strictMarkets: boolean; strictFull: boolean; analysisConcurrency: number; analysisTimeoutMs: number; analysisRetries: number; analysisCacheTtlMs: number; fullDailyCacheTtlMs: number; profileTimeoutMs: number; profileBudgetMs: number }): Promise<FullDailyAnalysisResponse> {
  const cacheKey = fullDailyCacheKey(date, options, config);
  const cached = getCachedFullDaily(cacheKey);
  if (cached) {
    return {
      ...cached,
      warning: cached.warning
        ? `${cached.warning} Resultado servido do cache.`
        : 'Resultado servido do cache.',
    };
  }

  const matchesResponse: any = await fetchMatchesForAnalysisDay(date, config.mode);
  const events = Array.isArray(matchesResponse?.events)
    ? matchesResponse.events
    : Array.isArray(matchesResponse?.data)
      ? matchesResponse.data
      : [];
  const matches = filterMatchesForMode(events, config.mode);
  const priorityContext = buildChampionshipPriorityContext(matches);
  const profileCandidateLimit = Math.max(config.limit, config.profileCandidateLimit);
  const candidateEvents = [...matches]
    .sort((a, b) => (
      getChampionshipPriority(b, priorityContext).score - getChampionshipPriority(a, priorityContext).score
      || eventCompletenessScore(b) - eventCompletenessScore(a)
      || getEventTimestamp(a) - getEventTimestamp(b)
    ))
    .slice(0, Math.min(config.maxCandidates, profileCandidateLimit));
  const ogolConcurrency = Math.max(1, Number(process.env.OGOL_ANALYSIS_CONCURRENCY || 1));
  const providerConcurrency = process.env.SCORES_PROVIDER === 'ogol' ? ogolConcurrency : 2;
  const concurrency = Math.max(1, Math.min(config.analysisConcurrency, providerConcurrency));
  const inspectedProfiles = await inspectProfilesWithConcurrency(candidateEvents, concurrency, config.profileTimeoutMs, config.profileBudgetMs);
  const profiles = inspectedProfiles.map((item) => ({
    ...item,
    profile: {
      ...item.profile,
      championshipPriority: getChampionshipPriority(item.event, priorityContext),
    },
  }));
  const qualified = profiles
    .filter((item) => isFullDataProfile(item.profile, config.strictMarkets))
    .sort((a, b) => dailyProfileRankingScore(b, config.strictMarkets, priorityContext) - dailyProfileRankingScore(a, config.strictMarkets, priorityContext));
  const rankedProfiles = profiles
    .filter((item) => item.profile.score > 0 && !item.profile.missing.includes('profile_inspection'))
    .sort((a, b) => (
      dailyProfileRankingScore(b, config.strictMarkets, priorityContext) - dailyProfileRankingScore(a, config.strictMarkets, priorityContext)
      || eventCompletenessScore(b.event) - eventCompletenessScore(a.event)
    ));
  const selected = config.strictFull
    ? qualified.slice(0, config.limit)
    : rankedProfiles.slice(0, config.limit);
  const eventIds = selected.map((item) => String(item.event.id));
  const { analyses: statisticalAnalyses, skipped } = await analyzeWithConcurrency(
    eventIds,
    { ...options, useLLMExplanation: false },
    concurrency,
    config.analysisTimeoutMs,
    config.analysisRetries,
    config.analysisCacheTtlMs
  );
  const selectedEventById = new Map(selected.map((item) => [String(item.event.id), item.event]));
  const rankedStatistical = statisticalAnalyses
    .map((analysis) => {
      const event = selectedEventById.get(String(analysis.eventId)) || {};
      return {
        ...analysis,
        championshipPriority: getChampionshipPriority({
          ...event,
          tournamentName: analysis.tournamentName || event?.tournamentName,
          homeTeam: analysis.homeTeam || event?.homeTeam,
          awayTeam: analysis.awayTeam || event?.awayTeam,
        }, priorityContext),
      };
    })
    .sort(compareAnalysisRanking);
  const bestStatistical = rankedStatistical.find((analysis) => Number(analysis.confidence || 0) > 0)
    || (options.explainRejected ? rankedStatistical[0] : undefined);
  let analyses = rankedStatistical;
  if (bestStatistical && options.useLLM !== false && options.useLLMExplanation !== false) {
    try {
      const explained = await withTimeout(
        analyzeEvent(bestStatistical.eventId, { ...options, useLLMExplanation: true }),
        Number(process.env.FULL_DAILY_EXPLANATION_TIMEOUT_MS || 15000),
        `Explanation ${bestStatistical.eventId}`,
      );
      analyses = rankedStatistical.map((analysis) => String(analysis.eventId) === String(explained.eventId)
        ? { ...explained, championshipPriority: analysis.championshipPriority }
        : analysis);
    } catch (error) {
      console.warn(`Explicacao da melhor entrada ignorada por latencia: ${formatAttemptError(error)}`);
    }
  }
  const profileById = new Map(selected.map((item) => [String(item.event.id), {
    ...item.profile,
    selectionScore: dailyProfileRankingScore(item, config.strictMarkets, priorityContext),
  }]));
  const analysesWithProfiles = analyses
    .map((analysis) => ({
      ...analysis,
      dataProfile: profileById.get(String(analysis.eventId)),
    }))
    .sort(compareAnalysisRanking);
  const entries = analysesWithProfiles.slice(0, config.limit);
  const skippedByProfile = [
    ...profiles
      .filter((item) => !selected.some((selectedItem) => String(selectedItem.event.id) === String(item.event.id)))
      .map((item) => ({
        eventId: item.event.id,
        reason: `Dados insuficientes: ${item.profile.missing.join(', ') || 'unknown'}`,
        dataProfile: item.profile,
      })),
    ...skipped.map((item) => ({
      ...item,
      dataProfile: item.eventId ? profileById.get(String(item.eventId)) : undefined,
    })),
  ];
  const warning = qualified.length < config.limit
    ? config.strictFull
      ? `Foram encontradas apenas ${entries.length} partidas 100% completas para o criterio atual.`
      : `Nao havia ${config.limit} partidas 100% completas. A rota retornou as ${entries.length} partidas com mais dados reais disponiveis e informa os campos ausentes em dataProfile.missing.`
    : undefined;
  const countByTier = (items: Array<{ championshipPriority?: ChampionshipPriority }>) => items.reduce<Record<string, number>>((counts, item) => {
    const tier = String(item.championshipPriority?.tier || 3);
    counts[tier] = (counts[tier] || 0) + 1;
    return counts;
  }, { 1: 0, 2: 0, 3: 0 });

  const result = {
    date,
    requestedMatches: config.limit,
    matchesFound: matches.length,
    candidatesChecked: candidateEvents.length,
    qualifiedMatches: qualified.length,
    selectedEventIds: selected.map((item) => String(item.event.id)),
    selectedEvents: selected.map((item) => ({
      ...item.event,
      championshipPriority: item.profile.championshipPriority,
    })),
    bestEntry: entries[0] || null,
    entries,
    analyses: analysesWithProfiles,
    skipped: skippedByProfile,
    prioritySummary: {
      version: CHAMPIONSHIP_PRIORITY_VERSION,
      candidatesByTier: countByTier(candidateEvents.map((event) => ({
        championshipPriority: getChampionshipPriority(event, priorityContext),
      }))),
      selectedByTier: countByTier(selected.map((item) => ({
        championshipPriority: item.profile.championshipPriority,
      }))),
    },
    warning,
  };
  setCachedFullDaily(cacheKey, result, config.fullDailyCacheTtlMs);
  return result;
}

async function analyzeTournament(tournamentId: string, options: AnalyzeOptions, config: { date: string; limit: number; maxCandidates: number; mode: string; daysAhead: number; analysisConcurrency: number; analysisTimeoutMs: number }): Promise<TournamentAnalysisResponse> {
  const datesChecked = Array.from({ length: config.daysAhead + 1 }, (_, index) => addDays(config.date, index));
  const allEvents: any[] = [];

  for (const date of datesChecked) {
    const matchesResponse: any = await fetchMatchesForAnalysisDay(date, config.mode);
    const events = Array.isArray(matchesResponse?.events)
      ? matchesResponse.events
      : Array.isArray(matchesResponse?.data)
        ? matchesResponse.data
        : [];

    allEvents.push(...events);
  }

  const uniqueEvents = [...new Map(allEvents.map((event) => [String(event.id), event])).values()];
  const tournamentEvents = uniqueEvents.filter((event) => getTournamentIds(event).includes(String(tournamentId)));
  const candidates = filterMatchesForMode(tournamentEvents, config.mode).slice(0, config.maxCandidates);
  const eventIds = candidates.map((event) => String(event.id)).filter(Boolean);
  const { analyses, skipped } = await analyzeBatchWithSingleExplanation(
    eventIds,
    options,
    config.analysisConcurrency,
    config.analysisTimeoutMs,
  );
  const sorted = analyses.sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0));
  const entries = sorted.slice(0, config.limit);

  return {
    tournamentId,
    datesChecked,
    requestedEntries: config.limit,
    matchesFound: tournamentEvents.length,
    candidatesChecked: candidates.length,
    selectedEventIds: entries.map((analysis) => String(analysis.eventId)),
    bestEntry: entries[0] || null,
    entries,
    analyses: sorted,
    skipped,
    availableTournaments: tournamentEvents.length === 0
      ? summarizeAvailableTournaments(uniqueEvents)
      : undefined,
    warning: tournamentEvents.length === 0
      ? `Nenhuma partida encontrada para tournamentId=${tournamentId}. Use um dos ids em availableTournaments para a data consultada.`
      : undefined,
  };
}

function tournamentName(event: any) {
  return String(event?.tournament?.name || event?.competition?.name || '').trim();
}

async function analyzeTournamentByName(name: string, options: AnalyzeOptions, config: { date: string; limit: number; maxCandidates: number; mode: string; daysAhead: number; analysisConcurrency: number; analysisTimeoutMs: number }) {
  const datesChecked = Array.from({ length: config.daysAhead + 1 }, (_, index) => addDays(config.date, index));
  const allEvents: any[] = [];
  for (const date of datesChecked) {
    const response: any = await fetchMatchesForAnalysisDay(date, config.mode);
    allEvents.push(...(Array.isArray(response?.events) ? response.events : response?.data || []));
  }
  const uniqueEvents = [...new Map(allEvents.map((event) => [String(event.id), event])).values()];
  const tournamentEvents = uniqueEvents
    .map((event) => ({ event, score: matchNameScore(name, tournamentName(event)) }))
    .filter((item) => item.score >= 38)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.event);
  const candidates = filterMatchesForMode(tournamentEvents, config.mode).slice(0, config.maxCandidates);
  const { analyses, skipped } = await analyzeBatchWithSingleExplanation(candidates.map((event) => String(event.id)), options, config.analysisConcurrency, config.analysisTimeoutMs);
  const sorted = analyses.sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0));
  const entries = sorted.slice(0, config.limit);
  return {
    tournamentId: getTournamentIds(tournamentEvents[0])[0] || name,
    tournamentName: tournamentName(tournamentEvents[0]) || name,
    datesChecked,
    requestedEntries: config.limit,
    matchesFound: tournamentEvents.length,
    candidatesChecked: candidates.length,
    selectedEventIds: entries.map((analysis) => String(analysis.eventId)),
    bestEntry: entries[0] || null,
    entries,
    analyses: sorted,
    skipped,
    availableTournaments: tournamentEvents.length ? undefined : summarizeAvailableTournaments(uniqueEvents),
    warning: tournamentEvents.length ? undefined : `Nenhuma partida encontrada para o campeonato "${name}" no período consultado.`,
  };
}

function validateThreeEventIds(eventIds: string[]) {
  if (eventIds.length !== 3) {
    return `Informe exatamente 3 IDs de evento. Recebidos: ${eventIds.length}.`;
  }

  return null;
}

function teamName(event: any, side: 'home' | 'away') {
  return String(event?.[`${side}Team`]?.name || event?.[side]?.name || '').trim();
}

function splitMatchQuery(value: unknown) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return {};

  const parts = text.split(/\s+(?:x|vs|v)\.?\s+/i).map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return { home: parts[0], away: parts.slice(1).join(' ') };
  }

  return { q: text };
}

function matchNameScore(expected: string, actual: string) {
  const left = normalizeDataText(expected);
  const right = normalizeDataText(actual);
  if (!left || !right) return 0;
  if (left === right) return 50;
  if (right.includes(left) || left.includes(right)) return 38;

  const tokens = left.split(/\s+/).filter((token) => token.length > 2);
  if (!tokens.length) return 0;
  const hits = tokens.filter((token) => right.includes(token)).length;
  return Math.floor((hits / tokens.length) * 28);
}

function scoreEventNameMatch(event: any, params: { home?: string; away?: string; q?: string }) {
  const home = teamName(event, 'home');
  const away = teamName(event, 'away');
  const requestedHome = String(params.home || '').trim();
  const requestedAway = String(params.away || '').trim();
  const requestedQuery = String(params.q || '').trim();

  if (requestedHome && requestedAway) {
    const direct = matchNameScore(requestedHome, home) + matchNameScore(requestedAway, away);
    const reversed = matchNameScore(requestedHome, away) + matchNameScore(requestedAway, home) - 10;
    return Math.max(direct, reversed);
  }

  if (requestedQuery) {
    const normalizedQuery = normalizeDataText(requestedQuery);
    const combined = normalizeDataText(`${home} ${away}`);
    if (combined.includes(normalizedQuery)) return 80;

    const tokens = normalizedQuery.split(/\s+/).filter((token) => token.length > 2);
    if (!tokens.length) return 0;
    const hits = tokens.filter((token) => combined.includes(token)).length;
    return Math.floor((hits / tokens.length) * 60);
  }

  return 0;
}

async function resolveAnalysisEventByTeams(req: express.Request) {
  const parsedMatch = splitMatchQuery(req.query.match || req.query.q);
  const params = {
    home: String(req.query.home || req.query.homeTeam || parsedMatch.home || '').trim(),
    away: String(req.query.away || req.query.awayTeam || parsedMatch.away || '').trim(),
    q: String(parsedMatch.q || '').trim(),
  };

  if ((!params.home || !params.away) && !params.q) {
    return {
      error: 'Informe home e away, ou match/q. Ex: /analysis?home=Japao&away=Suecia',
      status: 400,
    };
  }

  const date = typeof req.query.date === 'string' && req.query.date ? req.query.date : getTodayDate();
  const mode = ['prelive', 'live', 'all'].includes(String(req.query.mode || '').toLowerCase())
    ? String(req.query.mode).toLowerCase()
    : 'all';
  const matchesResponse: any = await fetchMatchesForAnalysisDay(date, mode);
  const events = Array.isArray(matchesResponse?.events)
    ? matchesResponse.events
    : Array.isArray(matchesResponse?.data)
      ? matchesResponse.data
      : [];

  const ranked = events
    .map((event) => ({
      event,
      score: scoreEventNameMatch(event, params),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || getEventTimestamp(a.event) - getEventTimestamp(b.event));
  const best = ranked[0];
  const candidates = ranked.slice(0, 8).map((item) => ({
    id: item.event.id,
    homeTeam: teamName(item.event, 'home'),
    awayTeam: teamName(item.event, 'away'),
    score: item.score,
    status: item.event?.status,
    startTimestamp: getEventTimestamp(item.event),
  }));

  if (!best || best.score < 55) {
    return {
      error: 'Partida nao encontrada na agenda do provider para os nomes informados.',
      status: 404,
      date,
      provider: process.env.SCORES_PROVIDER || 'sofascore',
      candidates,
    };
  }

  return {
    eventId: String(best.event.id),
    date,
    provider: process.env.SCORES_PROVIDER || 'sofascore',
    matchedEvent: candidates[0],
    candidates,
  };
}

/**
 * @swagger
 * /analysis/best-of-three:
 *   get:
 *     summary: Compara 3 eventos e retorna a melhor entrada
 *     tags:
 *       - Analysis
 *     parameters:
 *       - name: eventIds
 *         in: query
 *         description: Três IDs de evento separados por vírgula
 *         required: true
 *         schema:
 *           type: string
 *           example: "123,456,789"
 *       - name: useLLM
 *         in: query
 *         description: Use false para pular a análise com IA
 *         required: false
 *         schema:
 *           type: boolean
 *           default: true
 *     responses:
 *       200:
 *         description: Melhor entrada entre os 3 eventos
 *       400:
 *         description: Quantidade de IDs inválida
 */
// GET /analysis/best-of-three?eventIds=123,456,789
// You can also send repeated params: /analysis/best-of-three?eventIds=123&eventIds=456&eventIds=789
// Use ?useLLM=false only when you want to skip the AI analysis.
analysisRouter.get('/analysis/best-of-three', async (req, res) => {
  try {
    const eventIds = parseEventIds(req.query.eventIds);
    const validationError = validateThreeEventIds(eventIds);

    if (validationError) {
      res.status(400).json({ ok: false, error: validationError });
      return;
    }

    const result = await analyzeBestOfThree(eventIds, {
      useLLM: req.query.useLLM !== 'false',
      includeOdds: isTrue(req.query.includeOdds),
      useOddsFallback: isTrue(req.query.useOddsFallback),
    });

    res.json({ ok: true, result });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error('Best-of-three analysis error', error.stack || error.message);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

/**
 * @swagger
 * /analysis/best-of-three:
 *   post:
 *     summary: Compara 3 eventos e retorna a melhor entrada
 *     tags:
 *       - Analysis
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - eventIds
 *             properties:
 *               eventIds:
 *                 type: array
 *                 minItems: 3
 *                 maxItems: 3
 *                 items:
 *                   type: string
 *                 example: ["123", "456", "789"]
 *               useLLM:
 *                 type: boolean
 *                 default: true
 *     responses:
 *       200:
 *         description: Melhor entrada entre os 3 eventos
 *       400:
 *         description: Quantidade de IDs inválida
 */
// POST /analysis/best-of-three
// Body: { "eventIds": ["123", "456", "789"], "useLLM": false }
analysisRouter.post('/analysis/best-of-three', async (req, res) => {
  try {
    const eventIds = parseEventIds(req.body?.eventIds);
    const validationError = validateThreeEventIds(eventIds);

    if (validationError) {
      res.status(400).json({ ok: false, error: validationError });
      return;
    }

    const result = await analyzeBestOfThree(eventIds, {
      useLLM: req.body?.useLLM !== false,
      includeOdds: isTrue(req.body?.includeOdds),
      useOddsFallback: isTrue(req.body?.useOddsFallback),
    });

    res.json({ ok: true, result });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error('Best-of-three analysis error', error.stack || error.message);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// GET /analysis/best-daily?date=2026-06-22&limit=4&maxCandidates=8&mode=prelive
// Retorna as melhores entradas do dia analisando partidas com mais dados disponiveis.
analysisRouter.get('/analysis/best-daily', async (req, res) => {
  try {
    const date = typeof req.query.date === 'string' && req.query.date ? req.query.date : getTodayDate();
    const limit = parsePositiveInt(req.query.limit, 4, 4, 10);
    const maxCandidates = parsePositiveInt(req.query.maxCandidates, Math.max(8, limit), limit, 20);
    const mode = ['prelive', 'live', 'all'].includes(String(req.query.mode || '').toLowerCase())
      ? String(req.query.mode).toLowerCase()
      : 'prelive';

    const result = await analyzeBestDaily(date, {
      useLLM: req.query.useLLM !== 'false',
      includeOdds: isTrue(req.query.includeOdds),
      useOddsFallback: isTrue(req.query.useOddsFallback),
    }, { limit, maxCandidates, mode });

    res.json({ ok: true, result });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error('Best daily analysis error', error.stack || error.message);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// GET /analysis/full-daily?date=2026-06-23&limit=5&maxCandidates=20&mode=prelive
// Analisa as principais partidas do dia priorizando somente jogos com dados reais fortes.
analysisRouter.get('/analysis/full-daily', async (req, res) => {
  try {
    const date = typeof req.query.date === 'string' && req.query.date ? req.query.date : getTodayDate();
    const limit = parsePositiveInt(req.query.limit, 5, 5, 10);
    const maxCandidates = parsePositiveInt(req.query.maxCandidates, Math.max(20, limit), limit, 40);
    const profileCandidateLimit = parsePositiveInt(
      req.query.profileCandidateLimit,
      Number(process.env.FULL_DAILY_PROFILE_CANDIDATE_LIMIT || Math.min(maxCandidates, 15)),
      limit,
      40
    );
    const mode = ['prelive', 'live', 'all'].includes(String(req.query.mode || '').toLowerCase())
      ? String(req.query.mode).toLowerCase()
      : 'prelive';
    const strictMarkets = isTrue(req.query.strictMarkets);
    const strictFull = isTrue(req.query.strictFull);
    const defaultConcurrency = process.env.SCORES_PROVIDER === 'ogol'
      ? parsePositiveInt(process.env.OGOL_ANALYSIS_CONCURRENCY, 1, 1, 4)
      : 2;
    const analysisConcurrency = parsePositiveInt(req.query.analysisConcurrency, defaultConcurrency, 1, 4);
    const analysisTimeoutMs = parsePositiveInt(
      req.query.analysisTimeoutMs,
      Number(process.env.FULL_DAILY_ANALYSIS_TIMEOUT_MS || 120000),
      10000,
      180000
    );
    const analysisRetries = parsePositiveInt(
      req.query.analysisRetries,
      Number(process.env.FULL_DAILY_ANALYSIS_RETRIES || 0),
      0,
      3
    );
    const analysisCacheTtlMs = parsePositiveInt(
      req.query.analysisCacheTtlMs,
      Number(process.env.FULL_DAILY_ANALYSIS_CACHE_TTL_MS || 900000),
      0,
      86400000
    );
    const fullDailyCacheTtlMs = parsePositiveInt(
      req.query.fullDailyCacheTtlMs,
      Number(process.env.FULL_DAILY_RESPONSE_CACHE_TTL_MS || 300000),
      0,
      86400000
    );
    const profileTimeoutMs = parsePositiveInt(
      req.query.profileTimeoutMs,
      Number(process.env.FULL_DAILY_PROFILE_TIMEOUT_MS || 120000),
      5000,
      120000
    );
    const profileBudgetMs = parsePositiveInt(
      req.query.profileBudgetMs,
      Number(process.env.FULL_DAILY_PROFILE_BUDGET_MS || 180000),
      30000,
      300000
    );

    const options = {
      useLLM: req.query.useLLM !== 'false',
      useLLMExplanation: req.query.useLLMExplanation !== 'false',
      explainRejected: req.query.explainRejected !== 'false',
      includeOdds: isTrue(req.query.includeOdds),
      useOddsFallback: isTrue(req.query.useOddsFallback),
      includeEnrichment: req.query.includeEnrichment !== 'false',
      requireRealOdds: isTrue(req.query.requireRealOdds),
      minimumExpectedValue: optionalNumber(req.query.minimumExpectedValue),
    };
    const config = {
      limit,
      maxCandidates,
      profileCandidateLimit,
      mode,
      strictMarkets,
      strictFull,
      analysisConcurrency,
      analysisTimeoutMs,
      analysisRetries,
      analysisCacheTtlMs,
      fullDailyCacheTtlMs,
      profileTimeoutMs,
      profileBudgetMs,
    };

    const cacheKey = fullDailyCacheKey(date, options, config);
    const cached = getCachedFullDaily(cacheKey);
    if (cached) {
      res.json({ ok: true, mode: 'complete', cache: true, result: cached });
      return;
    }
    if (!shouldWait(req)) {
      const matchesResponse: any = process.env.SCORES_PROVIDER === 'ogol'
        ? await fetchOgolMatchesFastCached(date)
        : { events: [] };
      const events = filterMatchesForMode(
        Array.isArray(matchesResponse?.events) ? matchesResponse.events : matchesResponse?.data || [],
        mode,
      );
      sendJob(res, `full-daily:${cacheKey}`, quickDailyResult(date, events, limit), () => analyzeFullDaily(date, options, config));
      return;
    }

    const result = await analyzeFullDaily(date, options, config);

    res.json({ ok: true, mode: 'complete', cache: false, result });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error('Full daily analysis error', error.stack || error.message);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// Backward-compatible alias for older clients.
analysisRouter.get('/analysis/daily', (req, res) => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query)) {
    if (Array.isArray(value)) {
      for (const item of value) query.append(key, String(item));
    } else if (value !== undefined) {
      query.set(key, String(value));
    }
  }
  res.redirect(307, `/analysis/full-daily${query ? `?${query}` : ''}`);
});

analysisRouter.get('/analysis/tournament', async (req, res) => {
  try {
    const name = String(req.query.name || '').trim();
    if (name.length < 2) {
      res.status(400).json({ ok: false, error: 'Informe o nome do campeonato.' });
      return;
    }
    const date = typeof req.query.date === 'string' && req.query.date ? req.query.date : getTodayDate();
    const limit = parsePositiveInt(req.query.limit, 4, 1, 10);
    const config = {
      date,
      limit,
      maxCandidates: parsePositiveInt(req.query.maxCandidates, Math.max(4, limit), limit, 12),
      daysAhead: parsePositiveInt(req.query.daysAhead, 2, 0, 14),
      analysisConcurrency: parsePositiveInt(req.query.analysisConcurrency, 1, 1, 4),
      analysisTimeoutMs: parsePositiveInt(req.query.analysisTimeoutMs, 90000, 10000, 180000),
      mode: ['prelive', 'live', 'all'].includes(String(req.query.mode || '').toLowerCase()) ? String(req.query.mode).toLowerCase() : 'prelive',
    };
    const options = {
      useLLM: req.query.useLLM !== 'false',
      useLLMExplanation: req.query.useLLMExplanation !== 'false',
      explainRejected: req.query.explainRejected === 'true',
      includeOdds: false,
      useOddsFallback: false,
      includeEnrichment: isTrue(req.query.includeEnrichment),
    };
    if (!shouldWait(req)) {
      const cached: any = process.env.SCORES_PROVIDER === 'ogol' ? await fetchOgolMatchesFastCached(date) : { events: [] };
      const events = filterMatchesForMode(cached.events || [], config.mode)
        .filter((event) => matchNameScore(name, tournamentName(event)) >= 38);
      const quick = { ...quickDailyResult(date, events, limit), tournamentName: name, datesChecked: [date] };
      sendJob(res, `tournament-name:${normalizeDataText(name)}:${JSON.stringify(config)}:${analysisCacheKey('all', options)}`, quick, () => analyzeTournamentByName(name, options, config));
      return;
    }
    res.json({ ok: true, result: await analyzeTournamentByName(name, options, config) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /analysis/tournament/:tournamentId?date=2026-06-22&limit=4&daysAhead=2
// Analisa as melhores partidas encontradas para um campeonato/torneio.
analysisRouter.get('/analysis/tournament/:tournamentId', async (req, res) => {
  try {
    const tournamentId = String(req.params.tournamentId || '').trim();
    if (!tournamentId || tournamentId === ':tournamentId') {
      res.status(400).json({ ok: false, error: 'tournamentId is required' });
      return;
    }

    const date = typeof req.query.date === 'string' && req.query.date ? req.query.date : getTodayDate();
    const limit = parsePositiveInt(req.query.limit, 4, 1, 10);
    const maxCandidates = parsePositiveInt(req.query.maxCandidates, Math.max(4, limit), limit, 12);
    const daysAhead = parsePositiveInt(req.query.daysAhead, 2, 0, 14);
    const analysisConcurrency = parsePositiveInt(req.query.analysisConcurrency, 1, 1, 4);
    const analysisTimeoutMs = parsePositiveInt(req.query.analysisTimeoutMs, 90000, 10000, 180000);
    const mode = ['prelive', 'live', 'all'].includes(String(req.query.mode || '').toLowerCase())
      ? String(req.query.mode).toLowerCase()
      : 'prelive';

    const options = {
      useLLM: req.query.useLLM !== 'false',
      useLLMExplanation: req.query.useLLMExplanation !== 'false',
      explainRejected: req.query.explainRejected === 'true',
      includeOdds: isTrue(req.query.includeOdds),
      useOddsFallback: isTrue(req.query.useOddsFallback),
      includeEnrichment: isTrue(req.query.includeEnrichment),
    };
    const config = { date, limit, maxCandidates, mode, daysAhead, analysisConcurrency, analysisTimeoutMs };
    if (!shouldWait(req)) {
      const matchesResponse: any = process.env.SCORES_PROVIDER === 'ogol'
        ? await fetchOgolMatchesFastCached(date)
        : { events: [] };
      const allEvents = Array.isArray(matchesResponse?.events) ? matchesResponse.events : matchesResponse?.data || [];
      const events = filterMatchesForMode(allEvents, mode).filter((event) => getTournamentIds(event).includes(tournamentId));
      const quick = { ...quickDailyResult(date, events, limit), tournamentId, datesChecked: [date] };
      sendJob(res, `tournament:${tournamentId}:${JSON.stringify(config)}:${analysisCacheKey('all', options)}`, quick, () => analyzeTournament(tournamentId, options, config));
      return;
    }
    const result = await analyzeTournament(tournamentId, options, config);

    res.json({ ok: true, result });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error('Tournament analysis error', error.stack || error.message);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// GET /analysis?home=Japao&away=Suecia
// GET /analysis?match=Japao x Suecia
// Resolve a partida pela agenda do provider atual e executa a analise no evento encontrado.
analysisRouter.get('/analysis', async (req, res) => {
  try {
    const resolved = await resolveAnalysisEventByTeams(req);
    if ('error' in resolved) {
      res.status(resolved.status).json({ ok: false, ...resolved });
      return;
    }

    const result = await analyzeEvent(resolved.eventId, {
      useLLM: req.query.useLLM !== 'false',
      useLLMExplanation: req.query.useLLMExplanation !== 'false',
      explainRejected: req.query.explainRejected === 'true',
      includeOdds: isTrue(req.query.includeOdds),
      useOddsFallback: isTrue(req.query.useOddsFallback),
      includeEnrichment: req.query.includeEnrichment !== 'false',
      requireRealOdds: isTrue(req.query.requireRealOdds),
      minimumExpectedValue: optionalNumber(req.query.minimumExpectedValue),
    });

    res.json({
      ok: true,
      resolved,
      result,
    });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error('Analysis by team names error', error.stack || error.message);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// GET /analysis/by-teams?home=Japao&away=Suecia
analysisRouter.get('/analysis/by-teams', async (req, res) => {
  try {
    const options = {
      useLLM: req.query.useLLM !== 'false',
      useLLMExplanation: req.query.useLLMExplanation !== 'false',
      explainRejected: req.query.explainRejected === 'true',
      includeOdds: isTrue(req.query.includeOdds),
      useOddsFallback: isTrue(req.query.useOddsFallback),
      includeEnrichment: req.query.includeEnrichment !== 'false',
      requireRealOdds: isTrue(req.query.requireRealOdds),
      minimumExpectedValue: optionalNumber(req.query.minimumExpectedValue),
    };
    if (!shouldWait(req)) {
      const query = { ...req.query };
      const date = typeof query.date === 'string' && query.date ? query.date : getTodayDate();
      const parsedMatch = splitMatchQuery(query.match || query.q);
      const search = {
        home: String(query.home || query.homeTeam || parsedMatch.home || '').trim(),
        away: String(query.away || query.awayTeam || parsedMatch.away || '').trim(),
        q: String(parsedMatch.q || '').trim(),
      };
      if ((!search.home || !search.away) && !search.q) {
        res.status(400).json({ ok: false, error: 'Informe os dois times da partida.' });
        return;
      }

      const cachedMatches: any = process.env.SCORES_PROVIDER === 'ogol'
        ? await fetchOgolMatchesFastCached(date)
        : { events: [] };
      const cachedEvent = (cachedMatches.events || [])
        .map((event: any) => ({ event, score: scoreEventNameMatch(event, search) }))
        .filter((item: any) => item.score >= 55)
        .sort((a: any, b: any) => b.score - a.score)[0]?.event;
      const quick = cachedEvent
        ? quickEventResult(cachedEvent)
        : {
          ...quickEventResult({ id: 'localizando', homeTeam: { name: search.home }, awayTeam: { name: search.away } }),
          rationale: 'Localizando a partida e preparando a análise completa em segundo plano.',
        };
      const jobKey = `teams:${date}:${normalizeDataText(search.home)}:${normalizeDataText(search.away)}:${normalizeDataText(search.q)}:${analysisCacheKey('resolved', options)}`;
      sendJob(res, jobKey, quick, async () => {
        const resolved = cachedEvent
          ? { eventId: String(cachedEvent.id), event: cachedEvent, score: 100, candidates: [] }
          : await resolveAnalysisEventByTeams({ query } as unknown as express.Request);
        if ('error' in resolved) throw new Error(resolved.error);
        return analyzeEvent(resolved.eventId, options);
      });
      return;
    }

    const resolved = await resolveAnalysisEventByTeams(req);
    if ('error' in resolved) {
      res.status(resolved.status).json({ ok: false, ...resolved });
      return;
    }
    const cached = getCachedAnalysis(resolved.eventId, options);
    if (cached) {
      res.json({ ok: true, mode: 'complete', cache: true, resolved, result: cached });
      return;
    }
    const result = await analyzeEvent(resolved.eventId, options);

    res.json({
      ok: true,
      resolved,
      result,
    });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error('Analysis by team names error', error.stack || error.message);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// GET /analysis/123/456/789
// Analisa 3 partidas e retorna a melhor entrada entre elas.
analysisRouter.get('/analysis/:eventId1/:eventId2/:eventId3', async (req, res) => {
  try {
    const eventIds = [req.params.eventId1, req.params.eventId2, req.params.eventId3]
      .map((eventId) => String(eventId || '').trim())
      .filter(Boolean);
    const validationError = validateThreeEventIds(eventIds);

    if (validationError) {
      res.status(400).json({ ok: false, error: validationError });
      return;
    }

    const result = await analyzeBestOfThree(eventIds, {
      useLLM: req.query.useLLM !== 'false',
      includeOdds: isTrue(req.query.includeOdds),
      useOddsFallback: isTrue(req.query.useOddsFallback),
      includeEnrichment: req.query.includeEnrichment !== 'false',
    });

    res.json({ ok: true, result });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error('Three-path analysis error', error.stack || error.message);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

analysisRouter.get('/analysis/jobs/:jobId', (req, res) => {
  const job = getAnalysisJob(String(req.params.jobId || ''));
  if (!job) {
    res.status(404).json({ ok: false, error: 'Job de análise não encontrado ou expirado.' });
    return;
  }
  res.json(analysisJobPayload(job));
});

// GET /analysis/:eventId
// GET /analysis/123,456,789 also works and returns the best entry between 3 events.
// Use ?useLLM=false only when you want to skip the AI analysis.
analysisRouter.get('/analysis/:eventId', async (req, res) => {
  try {
    const { eventId } = req.params;
    const eventIds = parseEventIds(eventId);

    if (eventIds.length > 1) {
      const validationError = validateThreeEventIds(eventIds);

      if (validationError) {
        res.status(400).json({ ok: false, error: validationError });
        return;
      }

      const options = {
        useLLM: req.query.useLLM !== 'false',
        useLLMExplanation: req.query.useLLMExplanation !== 'false',
        explainRejected: req.query.explainRejected === 'true',
        includeOdds: isTrue(req.query.includeOdds),
        useOddsFallback: isTrue(req.query.useOddsFallback),
        includeEnrichment: req.query.includeEnrichment !== 'false',
      };
      if (!shouldWait(req)) {
        const fastEvents = process.env.SCORES_PROVIDER === 'ogol'
          ? await Promise.all(eventIds.map((id) => fetchOgolEventFast(id).catch(() => null)))
          : eventIds.map((id) => ({ id }));
        const entries = fastEvents.map((event, index) => quickEventResult(event || { id: eventIds[index] }));
        const quickResult = { eventIds, bestEventId: entries[0]?.eventId, bestEntry: entries[0] || null, entries, analyses: entries, analysisStatus: 'processing' };
        const key = `events:${analysisCacheKey(eventIds.join(','), options)}`;
        sendJob(res, key, quickResult, () => analyzeBestOfThree(eventIds, options));
        return;
      }
      const result = await analyzeBestOfThree(eventIds, options);

      res.json({ ok: true, result });
      return;
    }

    const options = {
      useLLM: req.query.useLLM !== 'false',
      useLLMExplanation: req.query.useLLMExplanation !== 'false',
      explainRejected: req.query.explainRejected === 'true',
      includeOdds: isTrue(req.query.includeOdds),
      useOddsFallback: isTrue(req.query.useOddsFallback),
      includeEnrichment: req.query.includeEnrichment !== 'false',
      requireRealOdds: isTrue(req.query.requireRealOdds),
      minimumExpectedValue: optionalNumber(req.query.minimumExpectedValue),
    };
    const cached = getCachedAnalysis(eventId, options);
    if (cached) {
      res.json({ ok: true, mode: 'complete', cache: true, result: cached });
      return;
    }
    if (!shouldWait(req)) {
      const fastEvent = process.env.SCORES_PROVIDER === 'ogol'
        ? await fetchOgolEventFast(eventId).catch(() => null)
        : null;
      const quick = quickEventResult(fastEvent || { id: eventId });
      sendJob(res, `event:${analysisCacheKey(eventId, options)}`, quick, async () => {
        const result = await analyzeEvent(eventId, options);
        if (result?.recommendation && Number(result.confidence || 0) > 0) {
          setCachedAnalysis(eventId, options, result, Number(process.env.ANALYSIS_CACHE_TTL_MS || 900000));
        }
        return result;
      });
      return;
    }
    const result = await analyzeEvent(eventId, options);

    res.json({ ok: true, result });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error('Analysis error', error.stack || error.message);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

export default analysisRouter;
