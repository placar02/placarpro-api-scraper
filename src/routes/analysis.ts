import express from 'express';
import { analyzeEvent } from '../analysis/ai';
import { fetchAiScoreIncidents, fetchAiScoreLineups, fetchAiScoreMatches, fetchAiScoreStatistics, fetchAiScoreStreaks } from '../scrapers/aiscore';
import { fetchIncidents } from '../scrapers/incidents';
import { fetchLineups } from '../scrapers/lineups';
import { fetchScheduledMatches } from '../scrapers/scheduled';
import { fetch365Matches } from '../scrapers/scores365';
import { fetch365Enrichment } from '../scrapers/scores365-enrichment';
import { fetchOgolIncidents, fetchOgolLineups, fetchOgolMatches, fetchOgolStatistics, fetchOgolStreaks } from '../scrapers/ogol';
import { fetchStatistics } from '../scrapers/statistics';
import { fetchStreaks } from '../scrapers/streaks';
import type { AnalysisResult, AnalyzeOptions } from '../types/analysis';

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
  skipped: Array<{ eventId?: string | number; reason: string }>;
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
  skipped: Array<{ eventId?: string | number; reason: string }>;
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
  bestEntry: AnalysisResult | null;
  entries: Array<AnalysisResult & { dataProfile?: MatchDataProfile }>;
  analyses: Array<AnalysisResult & { dataProfile?: MatchDataProfile }>;
  skipped: Array<{ eventId?: string | number; reason: string; dataProfile?: MatchDataProfile }>;
  warning?: string;
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
};

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
  const analyses = await Promise.all(eventIds.map((eventId) => analyzeEvent(eventId, options)));
  return selectBestEventEntry(analyses);
}

function isTrue(value: unknown): boolean {
  return value === true || value === 'true';
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
  const recentMatches = Math.max(countRecentMatches(streaks), countRecentMatches(scores365Streaks));
  const incidentCount = Math.max(countIncidents(incidents), countIncidents(scores365Incidents));
  const hasCardsData = incidentsHaveCards(incidents)
    || incidentsHaveCards(scores365Incidents)
    || statHasPattern(statistics, [/card|yellow|red|cartao|cartoes/])
    || statHasPattern(scores365Stats, [/card|yellow|red|cartao|cartoes/]);
  const hasCornersData = statHasPattern(statistics, [/corner|escanteio|corners/])
    || statHasPattern(scores365Stats, [/corner|escanteio|corners/]);
  const missing = [
    statisticsItems > 0 ? null : 'statistics',
    lineupPlayers >= 10 ? null : 'lineups_or_player_pool',
    recentMatches >= 4 ? null : 'recent_history',
    incidentCount > 0 ? null : 'incidents',
    hasCardsData ? null : 'cards',
    hasCornersData ? null : 'corners',
  ].filter(Boolean) as string[];
  const score = [
    statisticsItems > 0 ? 30 : 0,
    lineupPlayers >= 10 ? 25 : lineupPlayers > 0 ? 12 : 0,
    recentMatches >= 8 ? 25 : recentMatches >= 4 ? 16 : recentMatches > 0 ? 8 : 0,
    incidentCount > 0 ? 8 : 0,
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
    hasIncidents: incidentCount > 0,
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
    scores365ScheduleAttempts: Array.isArray(scores365?.matchSearch?.scheduleAttempts)
      ? scores365.matchSearch.scheduleAttempts
      : undefined,
    scores365Candidates: Array.isArray(scores365?.matchSearch?.candidates)
      ? scores365.matchSearch.candidates.slice(0, 5)
      : undefined,
  };
}

async function inspectProfilesWithConcurrency(events: any[], concurrency = 2) {
  const profiles: Array<{ event: any; profile: MatchDataProfile }> = [];
  let index = 0;

  async function worker() {
    while (index < events.length) {
      const currentIndex = index;
      index += 1;
      const event = events[currentIndex];
      profiles[currentIndex] = {
        event,
        profile: await inspectMatchData(String(event.id), event),
      };
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
  if (provider === '365scores') return fetch365Matches(date);
  if (provider === 'ogol') return fetchOgolMatches(date);
  if (provider === 'aiscore') return fetchAiScoreMatches(date);
  if (mode === 'live') {
    const { fetchLiveMatches } = await import('../scrapers/live');
    return fetchLiveMatches({ retryOn403: true });
  }
  return fetchScheduledMatches(date, true);
}

function filterMatchesForMode(events: any[], mode: string) {
  return events
    .filter((event) => event?.id && !isFinished(event))
    .filter((event) => {
      if (mode === 'live') return isLive(event);
      if (mode === 'all') return true;
      return !isLive(event);
    })
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

async function analyzeWithConcurrency(eventIds: string[], options: AnalyzeOptions, concurrency = 2, timeoutMs = 0) {
  const analyses: AnalysisResult[] = [];
  const skipped: Array<{ eventId?: string | number; reason: string }> = [];
  let index = 0;

  async function worker() {
    while (index < eventIds.length) {
      const currentIndex = index;
      index += 1;
      const eventId = eventIds[currentIndex];

      try {
        const analysis = await withTimeout(
          analyzeEvent(eventId, options),
          timeoutMs,
          `Analysis ${eventId}`
        );
        if (analysis?.recommendation && analysis.confidence > 0) {
          analyses.push(analysis);
        } else {
          skipped.push({ eventId, reason: 'Analysis returned no usable recommendation' });
        }
      } catch (err) {
        skipped.push({ eventId, reason: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));
  return { analyses, skipped };
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

async function analyzeFullDaily(date: string, options: AnalyzeOptions, config: { limit: number; maxCandidates: number; mode: string; strictMarkets: boolean; strictFull: boolean }): Promise<FullDailyAnalysisResponse> {
  const matchesResponse: any = await fetchMatchesForAnalysisDay(date, config.mode);
  const events = Array.isArray(matchesResponse?.events)
    ? matchesResponse.events
    : Array.isArray(matchesResponse?.data)
      ? matchesResponse.data
      : [];
  const matches = filterMatchesForMode(events, config.mode);
  const candidateEvents = matches.slice(0, config.maxCandidates);
  const profiles = await inspectProfilesWithConcurrency(candidateEvents, 2);
  const qualified = profiles
    .filter((item) => isFullDataProfile(item.profile, config.strictMarkets))
    .sort((a, b) => b.profile.score - a.profile.score || eventCompletenessScore(b.event) - eventCompletenessScore(a.event));
  const rankedProfiles = [...profiles]
    .sort((a, b) => b.profile.score - a.profile.score || eventCompletenessScore(b.event) - eventCompletenessScore(a.event));
  const selected = config.strictFull
    ? qualified.slice(0, config.limit)
    : [
      ...qualified,
      ...rankedProfiles.filter((item) => !qualified.some((qualifiedItem) => String(qualifiedItem.event.id) === String(item.event.id))),
    ].slice(0, config.limit);
  const eventIds = selected.map((item) => String(item.event.id));
  const { analyses, skipped } = await analyzeWithConcurrency(eventIds, options, 2);
  const profileById = new Map(selected.map((item) => [String(item.event.id), item.profile]));
  const analysesWithProfiles = analyses
    .map((analysis) => ({
      ...analysis,
      dataProfile: profileById.get(String(analysis.eventId)),
    }))
    .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0));
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

  return {
    date,
    requestedMatches: config.limit,
    matchesFound: matches.length,
    candidatesChecked: candidateEvents.length,
    qualifiedMatches: qualified.length,
    selectedEventIds: entries.map((analysis) => String(analysis.eventId)),
    bestEntry: entries[0] || null,
    entries,
    analyses: analysesWithProfiles,
    skipped: skippedByProfile,
    warning,
  };
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
  const { analyses, skipped } = await analyzeWithConcurrency(
    eventIds,
    options,
    config.analysisConcurrency,
    config.analysisTimeoutMs
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
    const mode = ['prelive', 'live', 'all'].includes(String(req.query.mode || '').toLowerCase())
      ? String(req.query.mode).toLowerCase()
      : 'prelive';
    const strictMarkets = isTrue(req.query.strictMarkets);
    const strictFull = isTrue(req.query.strictFull);

    const result = await analyzeFullDaily(date, {
      useLLM: req.query.useLLM !== 'false',
      includeOdds: isTrue(req.query.includeOdds),
      useOddsFallback: isTrue(req.query.useOddsFallback),
    }, { limit, maxCandidates, mode, strictMarkets, strictFull });

    res.json({ ok: true, result });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error('Full daily analysis error', error.stack || error.message);
    res.status(500).json({ ok: false, error: String(err) });
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

    const result = await analyzeTournament(tournamentId, {
      useLLM: req.query.useLLM !== 'false',
      includeOdds: isTrue(req.query.includeOdds),
      useOddsFallback: isTrue(req.query.useOddsFallback),
      includeEnrichment: isTrue(req.query.includeEnrichment),
    }, { date, limit, maxCandidates, mode, daysAhead, analysisConcurrency, analysisTimeoutMs });

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
      includeOdds: isTrue(req.query.includeOdds),
      useOddsFallback: isTrue(req.query.useOddsFallback),
      includeEnrichment: req.query.includeEnrichment !== 'false',
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
    const resolved = await resolveAnalysisEventByTeams(req);
    if ('error' in resolved) {
      res.status(resolved.status).json({ ok: false, ...resolved });
      return;
    }

    const result = await analyzeEvent(resolved.eventId, {
      useLLM: req.query.useLLM !== 'false',
      includeOdds: isTrue(req.query.includeOdds),
      useOddsFallback: isTrue(req.query.useOddsFallback),
      includeEnrichment: req.query.includeEnrichment !== 'false',
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

      const result = await analyzeBestOfThree(eventIds, {
        useLLM: req.query.useLLM !== 'false',
        includeOdds: isTrue(req.query.includeOdds),
        useOddsFallback: isTrue(req.query.useOddsFallback),
        includeEnrichment: req.query.includeEnrichment !== 'false',
      });

      res.json({ ok: true, result });
      return;
    }

    const result = await analyzeEvent(eventId, {
      useLLM: req.query.useLLM !== 'false',
      includeOdds: isTrue(req.query.includeOdds),
      useOddsFallback: isTrue(req.query.useOddsFallback),
      includeEnrichment: req.query.includeEnrichment !== 'false',
    });

    res.json({ ok: true, result });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error('Analysis error', error.stack || error.message);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

export default analysisRouter;
