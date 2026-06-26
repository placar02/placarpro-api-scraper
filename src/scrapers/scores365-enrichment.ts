import type { NormalizedEvent } from '../types/event';
import type { EventLive } from '../types/event.live';
import {
  fetch365Event,
  fetch365Graph,
  fetch365Incidents,
  fetch365Lineups,
  fetch365Matches,
  fetch365Odds,
  fetch365Statistics,
  fetch365Streaks,
} from './scores365';

const MAX_TIME_DELTA_SECONDS = 4 * 60 * 60;

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
  if (left.includes(right) || right.includes(left)) return 0.9;

  const leftTokens = new Set(left.split(' ').filter((token) => token.length > 1));
  const rightTokens = new Set(right.split(' ').filter((token) => token.length > 1));
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union ? intersection / union : 0;
}

function eventDateCandidates(event: NormalizedEvent) {
  const timestamp = Number((event as any).startTimestamp ?? event.startTime);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return [new Date().toISOString().slice(0, 10)];

  const baseMs = timestamp * 1000;
  return [...new Set([
    new Date(baseMs).toISOString().slice(0, 10),
    new Date(baseMs - 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    new Date(baseMs + 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  ])];
}

function scoreCandidate(event: NormalizedEvent, candidate: EventLive) {
  const eventHome = event.homeTeam?.name || event.homeTeam?.shortName;
  const eventAway = event.awayTeam?.name || event.awayTeam?.shortName;
  const candidateHome = candidate.homeTeam?.name || candidate.homeTeam?.shortName;
  const candidateAway = candidate.awayTeam?.name || candidate.awayTeam?.shortName;
  const directScore = (tokenScore(eventHome, candidateHome) + tokenScore(eventAway, candidateAway)) / 2;
  const swappedScore = (tokenScore(eventHome, candidateAway) + tokenScore(eventAway, candidateHome)) / 2;
  const teamsScore = Math.max(directScore, swappedScore);
  const eventTimestamp = Number((event as any).startTimestamp ?? event.startTime);
  const candidateTimestamp = Number(candidate.startTimestamp);
  const timeDeltaSeconds = Number.isFinite(eventTimestamp) && Number.isFinite(candidateTimestamp)
    ? Math.abs(eventTimestamp - candidateTimestamp)
    : MAX_TIME_DELTA_SECONDS;
  const timeScore = Math.max(0, 1 - (timeDeltaSeconds / MAX_TIME_DELTA_SECONDS));

  return {
    score: Number(((teamsScore * 0.84) + (timeScore * 0.16)).toFixed(4)),
    teamsScore: Number(teamsScore.toFixed(4)),
    timeScore: Number(timeScore.toFixed(4)),
    timeDeltaSeconds,
    swapped: swappedScore > directScore,
  };
}

async function safeLoad<T>(label: string, loader: () => Promise<T>): Promise<T | null> {
  try {
    return await loader();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[365Scores] Could not fetch ${label}: ${message}`);
    return null;
  }
}

async function findMatching365Event(event: NormalizedEvent) {
  const searchedDates = eventDateCandidates(event);
  const candidates: Array<{ event: EventLive; score: ReturnType<typeof scoreCandidate>; date: string }> = [];
  const scheduleAttempts: any[] = [];

  for (const date of searchedDates) {
    const response = await safeLoad(`matches ${date}`, () => fetch365Matches(date));
    scheduleAttempts.push({
      date,
      status: response?.status,
      events: response?.events?.length || 0,
    });

    for (const candidate of response?.events || []) {
      candidates.push({ event: candidate, score: scoreCandidate(event, candidate), date });
    }
  }

  const ranked = candidates
    .sort((a, b) => b.score.score - a.score.score)
    .slice(0, 8);
  const best = ranked[0];

  return {
    searchedDates,
    scheduleAttempts,
    best,
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

export async function fetch365Enrichment(event: NormalizedEvent) {
  const matchSearch = await findMatching365Event(event);
  const best = matchSearch.best;

  if (!best || best.score.score < 0.62 || best.score.teamsScore < 0.56) {
    return {
      source: '365scores-enrichment',
      available: false,
      reason: 'sem correspondencia confiavel na 365Scores para esta partida',
      matchSearch: {
        searchedDates: matchSearch.searchedDates,
        scheduleAttempts: matchSearch.scheduleAttempts,
        candidates: matchSearch.candidates,
      },
    };
  }

  const scores365EventId = best.event.id;
  const [eventResp, odds, statistics, incidents, lineups, streaks, graph] = await Promise.all([
    safeLoad('event', () => fetch365Event(scores365EventId)),
    safeLoad('odds', () => fetch365Odds(scores365EventId)),
    safeLoad('statistics', () => fetch365Statistics(scores365EventId)),
    safeLoad('incidents', () => fetch365Incidents(scores365EventId)),
    safeLoad('lineups', () => fetch365Lineups(scores365EventId)),
    safeLoad('streaks', () => fetch365Streaks(String(scores365EventId))),
    safeLoad('graph', () => fetch365Graph(scores365EventId)),
  ]);

  return {
    source: '365scores-enrichment',
    available: true,
    scores365EventId,
    matchedEvent: eventResp?.data || best.event,
    raw: eventResp?.raw,
    matchSearch: {
      searchedDates: matchSearch.searchedDates,
      scheduleAttempts: matchSearch.scheduleAttempts,
      selected: {
        date: best.date,
        score: best.score,
      },
      candidates: matchSearch.candidates,
    },
    odds,
    statistics,
    incidents,
    lineups,
    streaks,
    graph,
    dataCoverage: {
      hasOdds: Boolean((odds as any)?.summary?.total_choices),
      hasStatistics: Boolean((statistics as any)?.summary?.total_items),
      hasIncidents: Boolean((incidents as any)?.data?.incidents?.length),
      hasLineups: Boolean((lineups as any)?.data?.home?.players?.length || (lineups as any)?.data?.away?.players?.length),
      hasStreaks: Boolean((streaks as any)?.data?.general?.length || (streaks as any)?.data?.head2head?.length),
      hasGraph: Boolean((graph as any)?.data?.points?.length),
    },
  };
}
