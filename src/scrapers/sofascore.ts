import type { NormalizedEvent } from '../types/event';
import type { EventLive } from '../types/event.live';
import { fetchGraph } from './graph';
import { fetchIncidents } from './incidents';
import { fetchLineups } from './lineups';
import { fetchScheduledMatches } from './scheduled';
import { fetchStatistics } from './statistics';
import { fetchStreaks } from './streaks';

const MAX_TIME_DELTA_SECONDS = 3 * 60 * 60;

function normalizeName(value: unknown) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(fc|sc|cf|ac|club|clube|football|soccer|the)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokenScore(a: unknown, b: unknown) {
  const left = normalizeName(a);
  const right = normalizeName(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return 0.88;

  const leftTokens = new Set(left.split(' ').filter((token) => token.length > 1));
  const rightTokens = new Set(right.split(' ').filter((token) => token.length > 1));
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;

  return union ? intersection / union : 0;
}

function eventDateCandidates(event: NormalizedEvent) {
  const timestamp = Number((event as any).startTimestamp ?? event.startTime);
  if (!Number.isFinite(timestamp)) return [new Date().toISOString().slice(0, 10)];

  const baseMs = timestamp * 1000;
  return [...new Set([
    new Date(baseMs).toISOString().slice(0, 10),
    new Date(baseMs - 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    new Date(baseMs + 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  ])];
}

function scoreCandidate(event: NormalizedEvent, candidate: EventLive) {
  const homeScore = tokenScore(event.homeTeam?.name || event.homeTeam?.shortName, candidate.homeTeam?.name || candidate.homeTeam?.shortName);
  const awayScore = tokenScore(event.awayTeam?.name || event.awayTeam?.shortName, candidate.awayTeam?.name || candidate.awayTeam?.shortName);
  const swappedHomeScore = tokenScore(event.homeTeam?.name || event.homeTeam?.shortName, candidate.awayTeam?.name || candidate.awayTeam?.shortName);
  const swappedAwayScore = tokenScore(event.awayTeam?.name || event.awayTeam?.shortName, candidate.homeTeam?.name || candidate.homeTeam?.shortName);
  const directScore = (homeScore + awayScore) / 2;
  const swappedScore = (swappedHomeScore + swappedAwayScore) / 2;
  const teamsScore = Math.max(directScore, swappedScore);

  const eventTimestamp = Number((event as any).startTimestamp ?? event.startTime);
  const candidateTimestamp = Number(candidate.startTimestamp);
  const timeDeltaSeconds = Number.isFinite(eventTimestamp) && Number.isFinite(candidateTimestamp)
    ? Math.abs(eventTimestamp - candidateTimestamp)
    : MAX_TIME_DELTA_SECONDS;
  const timeScore = Math.max(0, 1 - (timeDeltaSeconds / MAX_TIME_DELTA_SECONDS));

  return {
    score: Number(((teamsScore * 0.82) + (timeScore * 0.18)).toFixed(4)),
    teamsScore: Number(teamsScore.toFixed(4)),
    timeScore: Number(timeScore.toFixed(4)),
    timeDeltaSeconds,
    swapped: swappedScore > directScore,
  };
}

async function findMatchingSofaScoreEvent(event: NormalizedEvent) {
  const searchedDates = eventDateCandidates(event);
  const candidates: Array<{ event: EventLive; score: ReturnType<typeof scoreCandidate>; date: string }> = [];
  const scheduleAttempts: any[] = [];

  for (const date of searchedDates) {
    const response = await fetchScheduledMatches(date, true);
    scheduleAttempts.push({
      date,
      status: response.status,
      url: response.url,
      events: response.events?.length || 0,
      attempts: response.attempts,
    });
    for (const candidate of response.events || []) {
      candidates.push({ event: candidate, score: scoreCandidate(event, candidate), date });
    }
  }

  const ranked = candidates
    .sort((a, b) => b.score.score - a.score.score)
    .slice(0, 8);
  const best = ranked[0];

  return {
    searchedDates,
    best,
    scheduleAttempts,
    candidates: ranked.map((item) => ({
      date: item.date,
      id: item.event.id,
      slug: item.event.slug,
      homeTeam: item.event.homeTeam?.name,
      awayTeam: item.event.awayTeam?.name,
      startTimestamp: item.event.startTimestamp,
      score: item.score,
    })),
  };
}

async function safeLoad<T>(label: string, loader: () => Promise<T>): Promise<T | null> {
  try {
    return await loader();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[SofaScore] Could not fetch ${label}: ${message}`);
    return null;
  }
}

export async function fetchSofaScoreEnrichment(event: NormalizedEvent) {
  const matchSearch = await findMatchingSofaScoreEvent(event);
  const best = matchSearch.best;

  if (!best || best.score.score < 0.62 || best.score.teamsScore < 0.56) {
    return {
      source: 'sofascore-playwright',
      available: false,
      reason: 'sem correspondencia confiavel na SofaScore para esta partida',
      matchSearch: {
        searchedDates: matchSearch.searchedDates,
        scheduleAttempts: matchSearch.scheduleAttempts,
        candidates: matchSearch.candidates,
      },
    };
  }

  const sofaEventId = best.event.id;
  const [statistics, incidents, lineups, streaks, graph] = await Promise.all([
    safeLoad('statistics', () => fetchStatistics(sofaEventId)),
    safeLoad('incidents', () => fetchIncidents(sofaEventId)),
    safeLoad('lineups', () => fetchLineups(sofaEventId)),
    safeLoad('streaks', () => fetchStreaks(String(sofaEventId))),
    safeLoad('graph', () => fetchGraph(sofaEventId)),
  ]);

  return {
    source: 'sofascore-playwright',
    available: true,
    sofaEventId,
    matchedEvent: {
      id: best.event.id,
      slug: best.event.slug,
      status: best.event.status,
      tournament: best.event.tournament,
      season: best.event.season,
      roundInfo: best.event.roundInfo,
      homeTeam: best.event.homeTeam,
      awayTeam: best.event.awayTeam,
      homeScore: best.event.homeScore,
      awayScore: best.event.awayScore,
      time: best.event.time,
      startTimestamp: best.event.startTimestamp,
      hasEventPlayerStatistics: best.event.hasEventPlayerStatistics,
      hasEventPlayerHeatMap: best.event.hasEventPlayerHeatMap,
    },
    matchSearch: {
      searchedDates: matchSearch.searchedDates,
      scheduleAttempts: matchSearch.scheduleAttempts,
      selected: {
        date: best.date,
        score: best.score,
      },
      candidates: matchSearch.candidates,
    },
    statistics,
    incidents,
    lineups,
    streaks,
    graph,
    dataCoverage: {
      hasStatistics: Boolean((statistics as any)?.summary?.total_items),
      hasIncidents: Boolean((incidents as any)?.data?.incidents?.length),
      hasLineups: Boolean((lineups as any)?.data?.home?.players?.length || (lineups as any)?.data?.away?.players?.length),
      hasStreaks: Boolean((streaks as any)?.data?.general?.length || (streaks as any)?.data?.head2head?.length),
      hasGraph: Boolean((graph as any)?.data?.points?.length),
    },
  };
}
