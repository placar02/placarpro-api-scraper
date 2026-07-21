import type { NormalizedEvent } from '../types/event';
import type { EventLive } from '../types/event.live';
import type {
  DataEnrichmentProvider,
  DatasetProvenance,
  NormalizedMatchEnrichment,
  NormalizedMetric,
  NormalizedRecentForm,
  NormalizedTeamEnrichment,
} from '../providers/contracts';
import { fetchSofaApi, mapWithConcurrency } from '../providers/sofascore-client';
import { fetchScheduledMatches } from './scheduled';

const MAX_TIME_DELTA_SECONDS = 3 * 60 * 60;
const enrichmentCache = new Map<string, { expiresAt: number; promise: Promise<NormalizedMatchEnrichment> }>();

function normalizeName(value: unknown) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(fc|sc|cf|ac|club|clube|football|soccer|the)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function finite(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const parsed = Number(String(value).replace(',', '.').replace(/[^\d.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function tokenScore(leftValue: unknown, rightValue: unknown) {
  const left = normalizeName(leftValue);
  const right = normalizeName(rightValue);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return 0.88;
  const a = new Set(left.split(' ').filter((token) => token.length > 1));
  const b = new Set(right.split(' ').filter((token) => token.length > 1));
  const intersection = [...a].filter((token) => b.has(token)).length;
  const union = new Set([...a, ...b]).size;
  return union ? intersection / union : 0;
}

function eventDateCandidates(event: NormalizedEvent) {
  const timestamp = Number((event as any).startTimestamp ?? event.startTime);
  if (!Number.isFinite(timestamp)) return [new Date().toISOString().slice(0, 10)];
  const baseMs = timestamp * 1000;
  return [...new Set([
    new Date(baseMs).toISOString().slice(0, 10),
    new Date(baseMs - 86400000).toISOString().slice(0, 10),
    new Date(baseMs + 86400000).toISOString().slice(0, 10),
  ])];
}

export function scoreSofaScoreCandidate(event: NormalizedEvent, candidate: EventLive) {
  const home = tokenScore(event.homeTeam?.name || event.homeTeam?.shortName, candidate.homeTeam?.name || candidate.homeTeam?.shortName);
  const away = tokenScore(event.awayTeam?.name || event.awayTeam?.shortName, candidate.awayTeam?.name || candidate.awayTeam?.shortName);
  const swappedHome = tokenScore(event.homeTeam?.name || event.homeTeam?.shortName, candidate.awayTeam?.name || candidate.awayTeam?.shortName);
  const swappedAway = tokenScore(event.awayTeam?.name || event.awayTeam?.shortName, candidate.homeTeam?.name || candidate.homeTeam?.shortName);
  const directScore = (home + away) / 2;
  const swappedScore = (swappedHome + swappedAway) / 2;
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
  const responses = await Promise.all(searchedDates.map(async (date) => ({
    date,
    response: await fetchSofaApi(`sport/football/scheduled-events/${date}`, 60000)
      .then((result) => ({ status: 200, url: result.endpoint, events: result.data?.events || [] }))
      .catch(() => fetchScheduledMatches(date, true, false))
      .catch((error) => ({ events: [], error: error instanceof Error ? error.message : String(error) })),
  })));
  const candidates = responses.flatMap(({ date, response }) => (response.events || []).map((candidate: any) => ({
    event: candidate,
    score: scoreSofaScoreCandidate(event, candidate),
    date,
  })));
  const ranked = candidates.sort((a, b) => b.score.score - a.score.score).slice(0, 8);
  return {
    searchedDates,
    best: ranked[0],
    scheduleAttempts: responses.map(({ date, response }) => ({
      date,
      status: (response as any).status,
      url: (response as any).url,
      events: response.events?.length || 0,
      attempts: (response as any).attempts,
      error: (response as any).error,
    })),
    candidates: ranked.map((item) => ({
      date: item.date,
      id: item.event.id,
      homeTeam: item.event.homeTeam?.name,
      awayTeam: item.event.awayTeam?.name,
      startTimestamp: item.event.startTimestamp,
      score: item.score,
    })),
  };
}

function recordCount(data: any) {
  if (!data) return 0;
  if (Array.isArray(data)) return data.length;
  for (const key of ['events', 'incidents', 'shotmap', 'players', 'rows', 'statistics']) {
    if (Array.isArray(data?.[key])) return data[key].length;
  }
  return Object.keys(data).length;
}

function metricsFromStatistics(data: any): NormalizedMetric[] {
  const periods = Array.isArray(data?.statistics) ? data.statistics : [];
  return periods.flatMap((period: any) => (period?.groups || []).flatMap((group: any) => (
    group?.statisticsItems || []
  ).map((item: any) => ({
    key: String(item.key || normalizeName(item.name).replace(/\s+/g, '_')),
    name: String(item.name || item.key || 'Metrica'),
    period: String(period.period || 'ALL'),
    group: String(group.groupName || 'Match overview'),
    home: finite(item.homeValue ?? item.home),
    away: finite(item.awayValue ?? item.away),
    homeLabel: item.home !== undefined ? String(item.home) : undefined,
    awayLabel: item.away !== undefined ? String(item.away) : undefined,
    source: 'sofascore',
  }))));
}

function normalizePlayer(entry: any) {
  const player = entry?.player || entry;
  return {
    id: player?.id,
    name: player?.name || player?.shortName,
    shortName: player?.shortName,
    position: player?.position,
    shirtNumber: entry?.shirtNumber || player?.jerseyNumber,
    substitute: Boolean(entry?.substitute),
    captain: Boolean(entry?.captain),
    statistics: entry?.statistics || player?.statistics,
    reason: entry?.reason || entry?.description,
    source: 'sofascore',
  };
}

function lineupSide(data: any, side: 'home' | 'away') {
  const sideData = data?.[side] || {};
  const players = Array.isArray(sideData.players) ? sideData.players : [];
  return {
    starters: players.filter((item: any) => !item.substitute).map(normalizePlayer),
    substitutes: players.filter((item: any) => item.substitute).map(normalizePlayer),
  };
}

function missingPlayers(data: any, side: 'home' | 'away') {
  const values = data?.[side]?.missingPlayers || data?.[`${side}MissingPlayers`] || [];
  return Array.isArray(values) ? values.map(normalizePlayer) : [];
}

function normalizeEventSummary(event: any) {
  return {
    id: event?.id,
    startTimestamp: event?.startTimestamp,
    tournament: event?.tournament?.name,
    round: event?.roundInfo?.round,
    homeTeam: { id: event?.homeTeam?.id, name: event?.homeTeam?.name },
    awayTeam: { id: event?.awayTeam?.id, name: event?.awayTeam?.name },
    homeScore: finite(event?.homeScore?.current ?? event?.homeScore?.normaltime),
    awayScore: finite(event?.awayScore?.current ?? event?.awayScore?.normaltime),
    status: event?.status?.type,
  };
}

function emptyPerformance() {
  return { played: 0, wins: 0, draws: 0, losses: 0 };
}

export function aggregateSofaScoreForm(payload: any, teamId?: number | string, includeSamples = true): NormalizedRecentForm {
  const events = (Array.isArray(payload) ? payload : payload?.events || []).filter((event: any) => {
    const status = String(event?.status?.type || '').toLowerCase();
    return /finished|afterextra|afterpenalties/.test(status)
      && finite(event?.homeScore?.current ?? event?.homeScore?.normaltime) !== undefined
      && finite(event?.awayScore?.current ?? event?.awayScore?.normaltime) !== undefined;
  }).slice(0, 20);
  let wins = 0; let draws = 0; let losses = 0; let goalsFor = 0; let goalsAgainst = 0; let over25 = 0; let btts = 0; let cleanSheets = 0; let withoutScoring = 0;
  const homePerformance = emptyPerformance();
  const awayPerformance = emptyPerformance();
  for (const event of events) {
    const isHome = String(event?.homeTeam?.id) === String(teamId) || (!teamId && true);
    const homeGoals = finite(event?.homeScore?.current ?? event?.homeScore?.normaltime) || 0;
    const awayGoals = finite(event?.awayScore?.current ?? event?.awayScore?.normaltime) || 0;
    const own = isHome ? homeGoals : awayGoals;
    const opponent = isHome ? awayGoals : homeGoals;
    const performance = isHome ? homePerformance : awayPerformance;
    performance.played += 1;
    goalsFor += own; goalsAgainst += opponent;
    if (own > opponent) { wins += 1; performance.wins += 1; }
    else if (own === opponent) { draws += 1; performance.draws += 1; }
    else { losses += 1; performance.losses += 1; }
    if (homeGoals + awayGoals > 2.5) over25 += 1;
    if (homeGoals > 0 && awayGoals > 0) btts += 1;
    if (opponent === 0) cleanSheets += 1;
    if (own === 0) withoutScoring += 1;
  }
  const played = events.length;
  const result: NormalizedRecentForm = {
    played, wins, draws, losses, goalsFor, goalsAgainst,
    avgGoalsFor: played ? Number((goalsFor / played).toFixed(2)) : 0,
    avgGoalsAgainst: played ? Number((goalsAgainst / played).toFixed(2)) : 0,
    over25Rate: played ? Number(((over25 / played) * 100).toFixed(1)) : 0,
    bttsRate: played ? Number(((btts / played) * 100).toFixed(1)) : 0,
    cleanSheetRate: played ? Number(((cleanSheets / played) * 100).toFixed(1)) : 0,
    gamesWithoutScoring: withoutScoring,
    goalDifference: goalsFor - goalsAgainst,
    pointsRate: played ? Number((((wins * 3 + draws) / (played * 3)) * 100).toFixed(1)) : 0,
    homePerformance,
    awayPerformance,
    events: events.map(normalizeEventSummary),
  };
  if (includeSamples) {
    result.samples = {
      last5: aggregateSofaScoreForm(events.slice(0, 5), teamId, false),
      last10: aggregateSofaScoreForm(events.slice(0, 10), teamId, false),
      last15: aggregateSofaScoreForm(events.slice(0, 15), teamId, false),
    };
  }
  return result;
}

function topPlayers(data: any) {
  const groups = data?.topPlayers && typeof data.topPlayers === 'object' ? Object.values(data.topPlayers) : [];
  const entries = groups.flatMap((group) => Array.isArray(group) ? group : []);
  const unique = new Map<string, Record<string, unknown>>();
  for (const entry of entries) {
    const player = normalizePlayer(entry);
    const key = String(player.id || player.name || unique.size);
    if (!unique.has(key)) unique.set(key, { ...player, statistics: entry?.statistics, playedEnough: entry?.playedEnough });
  }
  return [...unique.values()].slice(0, 25);
}

function squad(data: any) {
  const players = data?.players || data?.teamPlayers || [];
  return Array.isArray(players) ? players.map(normalizePlayer).slice(0, 50) : [];
}

function standingsContext(data: any, homeId: unknown, awayId: unknown) {
  const standings = Array.isArray(data?.standings) ? data.standings : [];
  const rows = standings.flatMap((standing: any) => standing?.rows || []);
  const normalizeRow = (row: any) => row ? {
    position: row.position,
    teamId: row.team?.id,
    teamName: row.team?.name,
    matches: row.matches,
    wins: row.wins,
    draws: row.draws,
    losses: row.losses,
    goalsFor: row.scoresFor,
    goalsAgainst: row.scoresAgainst,
    points: row.points,
  } : undefined;
  return {
    standings: { totalTeams: rows.length, updatedAt: standings[0]?.updatedAtTimestamp },
    home: normalizeRow(rows.find((row: any) => String(row?.team?.id) === String(homeId))),
    away: normalizeRow(rows.find((row: any) => String(row?.team?.id) === String(awayId))),
  };
}

function teamEnrichment(id: unknown, name: unknown, profile: any, recent: any, season: any, top: any, players: any, missing: any[]): NormalizedTeamEnrichment {
  return {
    id: id as any,
    name: String(name || ''),
    profile: profile?.team || profile || undefined,
    recentForm: aggregateSofaScoreForm(recent, id as any),
    seasonStatistics: season?.statistics || season || undefined,
    topPlayers: topPlayers(top),
    squad: squad(players),
    missingPlayers: missing,
  };
}

type Loaded = { data: any; provenance: DatasetProvenance };

async function loadDataset(key: string, path: string): Promise<[string, Loaded]> {
  try {
    const result = await fetchSofaApi(path);
    const records = recordCount(result.data);
    return [key, {
      data: result.data,
      provenance: { source: 'sofascore', status: records ? 'available' : 'empty', endpoint: result.endpoint, durationMs: result.durationMs, records },
    }];
  } catch (error) {
    return [key, { data: null, provenance: { source: 'sofascore', status: 'failed', error: error instanceof Error ? error.message : String(error) } }];
  }
}

async function fetchSofaScoreEnrichmentUncached(
  event: NormalizedEvent,
  providerEvent?: EventLive,
): Promise<NormalizedMatchEnrichment> {
  const matchSearch = providerEvent
    ? {
      searchedDates: eventDateCandidates(event),
      best: { event: providerEvent, score: scoreSofaScoreCandidate(event, providerEvent), date: eventDateCandidates(event)[0] },
      scheduleAttempts: [],
      candidates: [{
        date: eventDateCandidates(event)[0],
        id: providerEvent.id,
        homeTeam: providerEvent.homeTeam?.name,
        awayTeam: providerEvent.awayTeam?.name,
        startTimestamp: providerEvent.startTimestamp,
        score: { score: 1, teamsScore: 1, timeScore: 1, timeDeltaSeconds: 0, swapped: false },
      }],
    }
    : await findMatchingSofaScoreEvent(event);
  const best = matchSearch.best;
  const empty = {
    metrics: [],
    lineups: { confirmed: false, home: { starters: [], substitutes: [] }, away: { starters: [], substitutes: [] } },
    incidents: [], shots: [], playerStatistics: [], averagePositions: [], bestPlayers: [],
    teams: {
      home: { topPlayers: [], squad: [], missingPlayers: [] },
      away: { topPlayers: [], squad: [], missingPlayers: [] },
    },
    context: {}, provenance: {}, collectedAt: new Date().toISOString(),
  } as Omit<NormalizedMatchEnrichment, 'provider' | 'available'>;
  if (!best || best.score.score < 0.62 || best.score.teamsScore < 0.56) {
    return {
      provider: 'sofascore', available: false,
      reason: 'sem correspondencia confiavel na SofaScore para esta partida',
      ...empty,
      provenance: {
        schedule: { source: 'sofascore', status: 'empty', records: matchSearch.candidates.length, error: 'match confidence below threshold' },
      },
      matchedEvent: { matchSearch },
    };
  }

  const matched = best.event;
  const eventId = matched.id;
  const homeId = matched.homeTeam?.id;
  const awayId = matched.awayTeam?.id;
  const tournamentId = matched.tournament?.uniqueTournament?.id || matched.tournament?.id;
  const seasonId = matched.season?.id;
  const paths: Array<[string, string]> = [
    ['event', `event/${eventId}`],
    ['statistics', `event/${eventId}/statistics`],
    ['incidents', `event/${eventId}/incidents`],
    ['lineups', `event/${eventId}/lineups`],
    ['streaks', `event/${eventId}/streaks`],
    ['graph', `event/${eventId}/graph`],
    ['headToHead', `event/${eventId}/h2h/0/events`],
    ['pregameForm', `event/${eventId}/pregame-form`],
    ['shotmap', `event/${eventId}/shotmap`],
    ['averagePositions', `event/${eventId}/average-positions`],
    ['bestPlayers', `event/${eventId}/best-players/summary`],
    ['homeProfile', `team/${homeId}`],
    ['awayProfile', `team/${awayId}`],
    ['homeRecent', `team/${homeId}/events/last/0`],
    ['awayRecent', `team/${awayId}/events/last/0`],
    ['homeSquad', `team/${homeId}/players`],
    ['awaySquad', `team/${awayId}/players`],
  ];
  if (tournamentId && seasonId) {
    paths.push(
      ['standings', `unique-tournament/${tournamentId}/season/${seasonId}/standings/total`],
      ['homeSeason', `team/${homeId}/unique-tournament/${tournamentId}/season/${seasonId}/statistics/overall`],
      ['awaySeason', `team/${awayId}/unique-tournament/${tournamentId}/season/${seasonId}/statistics/overall`],
      ['homeTopPlayers', `team/${homeId}/unique-tournament/${tournamentId}/season/${seasonId}/top-players/overall`],
      ['awayTopPlayers', `team/${awayId}/unique-tournament/${tournamentId}/season/${seasonId}/top-players/overall`],
    );
  }
  const loadedEntries = await mapWithConcurrency(paths, Number(process.env.SOFASCORE_ENRICHMENT_CONCURRENCY || 5), ([key, path]) => loadDataset(key, path));
  const loaded = Object.fromEntries(loadedEntries) as Record<string, Loaded>;
  const value = (key: string) => loaded[key]?.data;
  const lineupsData = value('lineups') || {};
  const eventData = value('event')?.event || value('event') || matched;
  const homeLineup = lineupSide(lineupsData, 'home');
  const awayLineup = lineupSide(lineupsData, 'away');
  const homeMissing = missingPlayers(lineupsData, 'home');
  const awayMissing = missingPlayers(lineupsData, 'away');
  const incidents = value('incidents')?.incidents || [];
  const shots = value('shotmap')?.shotmap || value('shotmap')?.shots || [];
  const players = [...homeLineup.starters, ...homeLineup.substitutes, ...awayLineup.starters, ...awayLineup.substitutes]
    .filter((player: any) => player.statistics);
  const averagePositions = value('averagePositions')?.averagePositions || value('averagePositions')?.players || [];
  const matchBestPlayers = value('bestPlayers')?.topPlayers || value('bestPlayers')?.players || [];
  const competition = standingsContext(value('standings'), homeId, awayId);
  const provenance = Object.fromEntries(Object.entries(loaded).map(([key, item]) => [key, item.provenance]));
  provenance.schedule = { source: 'sofascore', status: 'available', records: matchSearch.candidates.length };
  const result: NormalizedMatchEnrichment = {
    provider: 'sofascore', available: true, providerEventId: eventId,
    matchedEvent: { ...normalizeEventSummary(matched), matchScore: best.score, search: matchSearch },
    metrics: metricsFromStatistics(value('statistics')),
    lineups: {
      confirmed: Boolean(lineupsData?.confirmed || lineupsData?.home?.confirmed || lineupsData?.away?.confirmed),
      home: homeLineup,
      away: awayLineup,
    },
    incidents: Array.isArray(incidents) ? incidents.slice(0, 150).map((item: any) => ({ ...item, source: 'sofascore' })) : [],
    shots: Array.isArray(shots) ? shots.slice(0, 150).map((item: any) => ({ ...item, source: 'sofascore' })) : [],
    playerStatistics: players,
    averagePositions: Array.isArray(averagePositions) ? averagePositions.slice(0, 60).map((item: any) => ({ ...item, source: 'sofascore' })) : [],
    bestPlayers: Array.isArray(matchBestPlayers) ? matchBestPlayers.slice(0, 30).map((item: any) => ({ ...item, source: 'sofascore' })) : [],
    streaks: value('streaks') || undefined,
    pregameForm: value('pregameForm') || undefined,
    headToHead: aggregateSofaScoreForm(value('headToHead'), homeId),
    teams: {
      home: teamEnrichment(homeId, matched.homeTeam?.name, value('homeProfile'), value('homeRecent'), value('homeSeason'), value('homeTopPlayers'), value('homeSquad'), homeMissing),
      away: teamEnrichment(awayId, matched.awayTeam?.name, value('awayProfile'), value('awayRecent'), value('awaySeason'), value('awayTopPlayers'), value('awaySquad'), awayMissing),
    },
    competition,
    context: {
      referee: eventData?.referee ? { id: eventData.referee.id, name: eventData.referee.name, country: eventData.referee.country?.name, source: 'sofascore' } : undefined,
      venue: eventData?.venue ? { id: eventData.venue.id, name: eventData.venue.name, city: eventData.venue.city?.name, capacity: eventData.venue.capacity, source: 'sofascore' } : undefined,
      weather: eventData?.weatherReport || eventData?.weather || undefined,
      round: eventData?.roundInfo?.round,
      attendance: eventData?.attendance,
      country: eventData?.venue?.country?.name || eventData?.tournament?.category?.country?.name,
      importance: eventData?.roundInfo?.name || eventData?.roundInfo?.slug,
      phase: eventData?.tournament?.name,
    },
    graph: value('graph')?.graph || value('graph') || undefined,
    provenance,
    collectedAt: new Date().toISOString(),
  };
  console.info('[DataEnrichment]', JSON.stringify({
    provider: 'sofascore', eventId: event.id, providerEventId: eventId,
    datasets: Object.fromEntries(Object.entries(provenance).map(([key, item]) => [key, item.status])),
    metrics: result.metrics.length,
    homeRecent: result.teams.home.recentForm?.played || 0,
    awayRecent: result.teams.away.recentForm?.played || 0,
    players: result.playerStatistics.length,
  }));
  return result;
}

export function sofaScoreEnrichmentEnabled() {
  return process.env.SOFASCORE_ENRICHMENT_ENABLED !== 'false';
}

export function fetchSofaScoreEnrichment(event: NormalizedEvent) {
  if (!sofaScoreEnrichmentEnabled()) {
    return Promise.resolve({
      provider: 'sofascore', available: false, reason: 'provider desativado', metrics: [],
      lineups: { confirmed: false, home: { starters: [], substitutes: [] }, away: { starters: [], substitutes: [] } },
      incidents: [], shots: [], playerStatistics: [], averagePositions: [], bestPlayers: [],
      teams: { home: { topPlayers: [], squad: [], missingPlayers: [] }, away: { topPlayers: [], squad: [], missingPlayers: [] } },
      context: {}, provenance: { provider: { source: 'sofascore', status: 'disabled' } }, collectedAt: new Date().toISOString(),
    } as NormalizedMatchEnrichment);
  }
  const key = `${event.id}:${(event as any).startTimestamp || event.startTime || ''}`;
  const cached = enrichmentCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  const promise = fetchSofaScoreEnrichmentUncached(event).catch((error) => {
    enrichmentCache.delete(key);
    return {
      provider: 'sofascore', available: false, reason: error instanceof Error ? error.message : String(error), metrics: [],
      lineups: { confirmed: false, home: { starters: [], substitutes: [] }, away: { starters: [], substitutes: [] } },
      incidents: [], shots: [], playerStatistics: [], averagePositions: [], bestPlayers: [],
      teams: { home: { topPlayers: [], squad: [], missingPlayers: [] }, away: { topPlayers: [], squad: [], missingPlayers: [] } },
      context: {}, provenance: { provider: { source: 'sofascore', status: 'failed', error: error instanceof Error ? error.message : String(error) } }, collectedAt: new Date().toISOString(),
    } as NormalizedMatchEnrichment;
  });
  enrichmentCache.set(key, { expiresAt: Date.now() + Number(process.env.SOFASCORE_ENRICHMENT_CACHE_TTL_MS || 900000), promise });
  return promise;
}

export function fetchSofaScoreEnrichmentByProviderEvent(event: NormalizedEvent) {
  if (!sofaScoreEnrichmentEnabled()) return fetchSofaScoreEnrichment(event);
  const providerEvent = {
    ...(event as any),
    startTimestamp: Number((event as any).startTimestamp ?? event.startTime),
  } as EventLive;
  const key = `provider:${event.id}:${providerEvent.startTimestamp || ''}`;
  const cached = enrichmentCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  const promise = fetchSofaScoreEnrichmentUncached(event, providerEvent).catch((error) => ({
    provider: 'sofascore', available: false, providerEventId: event.id,
    reason: error instanceof Error ? error.message : String(error), metrics: [],
    lineups: { confirmed: false, home: { starters: [], substitutes: [] }, away: { starters: [], substitutes: [] } },
    incidents: [], shots: [], playerStatistics: [], averagePositions: [], bestPlayers: [],
    teams: { home: { topPlayers: [], squad: [], missingPlayers: [] }, away: { topPlayers: [], squad: [], missingPlayers: [] } },
    context: {}, provenance: { provider: { source: 'sofascore', status: 'failed', error: error instanceof Error ? error.message : String(error) } },
    collectedAt: new Date().toISOString(),
  } as NormalizedMatchEnrichment));
  enrichmentCache.set(key, { expiresAt: Date.now() + Number(process.env.SOFASCORE_ENRICHMENT_CACHE_TTL_MS || 900000), promise });
  return promise;
}

export const sofaScoreProvider: DataEnrichmentProvider = {
  id: 'sofascore',
  enabled: sofaScoreEnrichmentEnabled,
  enrich: fetchSofaScoreEnrichment,
};
