import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import protobuf, { type Root } from 'protobufjs';
import vm from 'node:vm';
import type { NormalizedEvent } from '../types/event';
import type { EventLive } from '../types/event.live';

const WEB_URL = process.env.AISCORE_WEB_URL || 'https://www.aiscore.com/football';
const API_BASE_URL = process.env.AISCORE_API_BASE_URL || 'https://api.aiscore.com/v1/web/api';
const STATIC_SCHEMA_SCRIPT = process.env.AISCORE_SCHEMA_SCRIPT || 'https://static.aiscore.com/_nuxt/5464e69.js';
const LANG = process.env.AISCORE_LANG || '2';
const SPORT_ID = process.env.AISCORE_SPORT_ID || '1';
const TIMEZONE_OFFSET = process.env.AISCORE_TIMEZONE_OFFSET || '-03:00';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const REQUEST_TIMEOUT_MS = Number(process.env.AISCORE_REQUEST_TIMEOUT_MS || 30000);

type AiScoreDecoded = Record<string, any>;

let browserPromise: Promise<Browser> | null = null;
let contextPromise: Promise<BrowserContext> | null = null;
let pagePromise: Promise<Page> | null = null;
let rootPromise: Promise<Root> | null = null;

function toSlug(value?: string) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function toDateKey(date?: string) {
  if (date && /^\d{8}$/.test(date)) return date;
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) return date.replace(/-/g, '');

  const current = date ? new Date(`${date}T00:00:00`) : new Date();
  const yyyy = current.getFullYear();
  const mm = String(current.getMonth() + 1).padStart(2, '0');
  const dd = String(current.getDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

function numberOrZero(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeStatus(match: any) {
  const statusId = Number(match?.statusId || match?.matchStatus || 0);
  if ([1, 13].includes(statusId)) {
    return { code: 0, description: 'Programado', type: 'notstarted' };
  }
  if ([8, 9, 12].includes(statusId)) {
    return { code: 100, description: 'Finalizado', type: 'finished' };
  }
  return { code: 6, description: 'Em andamento', type: 'inprogress' };
}

function getAiScoreLiveMinute(match: any) {
  const explicit = Number(
    match?.minute
    || match?.matchMinute
    || match?.gameTime
    || match?.currentTime
    || match?.timePlayed
    || match?.time
    || 0
  );
  if (Number.isFinite(explicit) && explicit > 0 && explicit <= 130) return explicit;

  const status = normalizeStatus(match);
  const startTime = numberOrZero(match?.matchTime);
  if (status.type !== 'inprogress' || !startTime) return 0;

  const elapsed = Math.floor((Date.now() / 1000 - startTime) / 60);
  if (!Number.isFinite(elapsed) || elapsed <= 0) return 1;
  return Math.min(elapsed, 130);
}

function buildMaps(raw: AiScoreDecoded) {
  const byId = (items?: any[]) => new Map((items || []).map((item) => [String(item.id || item.cid || item.sid), item]));
  return {
    competitions: byId(raw.competitions),
    teams: byId(raw.teams),
    seasons: byId(raw.seasons),
    stages: byId(raw.stages),
    venues: byId(raw.venues),
    countries: byId(raw.countries),
  };
}

function mergeById<T extends Record<string, any>>(value: T | undefined, map: Map<string, any>): T {
  if (!value) return {} as T;
  const mapped = map.get(String(value.id || value.cid || value.sid)) || {};
  return { ...mapped, ...value };
}

function getName(value: any, fallback = '') {
  return value?.name || value?.shortName || value?.nameEn || value?.title || fallback;
}

function normalizeMatch(match: any, raw: AiScoreDecoded): NormalizedEvent {
  const maps = buildMaps(raw);
  const competition = mergeById(match.competition, maps.competitions);
  const season = mergeById(match.season, maps.seasons);
  const home = mergeById(match.homeTeam, maps.teams);
  const away = mergeById(match.awayTeam, maps.teams);
  const venue = mergeById(match.venue, maps.venues);
  const referee = match.referee || {};
  const eventId = match.id || match.mid || '';
  const homeName = getName(home, 'Casa');
  const awayName = getName(away, 'Fora');
  const liveMinute = getAiScoreLiveMinute(match);

  return {
    id: eventId,
    slug: `${toSlug(homeName)}-${toSlug(awayName)}-${eventId}`,
    status: normalizeStatus(match),
    tournament: {
      id: competition.cid || competition.id || 0,
      name: getName(competition),
      slug: toSlug(getName(competition)),
    },
    season: {
      id: season.sid || season.id || match.season?.sid || match.season?.id || competition.cid || competition.id || 0,
      name: getName(season) || String(season.year || ''),
      year: String(season.year || ''),
    },
    round: numberOrZero(match.roundNum),
    homeTeam: {
      id: home.id || 0,
      name: homeName,
      slug: toSlug(homeName),
      shortName: home.shortName || homeName,
    },
    awayTeam: {
      id: away.id || 0,
      name: awayName,
      slug: toSlug(awayName),
      shortName: away.shortName || awayName,
    },
    score: {
      home: numberOrZero(match.homeScore),
      away: numberOrZero(match.awayScore),
      homeDisplay: numberOrZero(match.homeScore),
      awayDisplay: numberOrZero(match.awayScore),
    },
    venue: {
      id: venue.id || 0,
      name: getName(venue, 'Unknown'),
      slug: toSlug(getName(venue)),
      city: venue.city || '',
      capacity: numberOrZero(venue.capacity),
    },
    referee: {
      id: referee.id || 0,
      name: getName(referee, 'Unknown'),
      slug: toSlug(getName(referee)),
      country: referee.country,
    },
    startTime: numberOrZero(match.matchTime),
    currentTime: liveMinute || undefined,
    liveMinute: liveMinute || undefined,
    providerStatus: {
      statusId: Number(match?.statusId || 0),
      matchStatus: Number(match?.matchStatus || 0),
    },
    features: {
      hasXg: false,
      hasPlayerStats: true,
      hasHeatMap: false,
    },
  };
}

function toSofaLikeEvent(match: any, raw: AiScoreDecoded): EventLive {
  const event = normalizeMatch(match, raw);
  const liveMinute = getAiScoreLiveMinute(match);
  return {
    id: event.id as any,
    customId: String(event.id),
    slug: event.slug,
    startTimestamp: event.startTime,
    lastPeriod: '',
    finalResultOnly: false,
    feedLocked: false,
    isEditor: false,
    tournament: {
      name: event.tournament.name,
      slug: event.tournament.slug,
      id: event.tournament.id,
      category: {} as any,
    },
    season: {
      id: event.season.id,
      name: event.season.name,
      year: event.season.year,
      editor: false,
    },
    roundInfo: { round: event.round ?? 0 },
    status: event.status,
    homeTeam: event.homeTeam as any,
    awayTeam: event.awayTeam as any,
    homeScore: {
      current: event.score.home,
      display: event.score.homeDisplay,
      period1: 0,
      period2: 0,
      normaltime: event.score.home,
    },
    awayScore: {
      current: event.score.away,
      display: event.score.awayDisplay,
      period1: 0,
      period2: 0,
      normaltime: event.score.away,
    },
    time: {
      injuryTime1: 0,
      initial: 0,
      max: 90,
      extra: 0,
      currentPeriodStartTimestamp: event.status.type === 'inprogress' ? event.startTime : 0,
      current: liveMinute,
    },
    liveMinute,
    currentTime: liveMinute,
    providerStatus: {
      statusId: Number(match?.statusId || 0),
      matchStatus: Number(match?.matchStatus || 0),
    },
    hasEventPlayerStatistics: true,
    hasEventPlayerHeatMap: false,
    hasGlobalHighlights: false,
  };
}

async function getBrowser() {
  browserPromise ||= chromium.launch({ headless: true });
  return browserPromise;
}

async function getPage() {
  if (!contextPromise) {
    contextPromise = getBrowser().then((browser) =>
      browser.newContext({
        userAgent: USER_AGENT,
        extraHTTPHeaders: {
          Accept: 'application/octet-stream, application/json, text/plain, */*',
          'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
          Referer: 'https://www.aiscore.com/',
        },
      })
    );
  }

  if (!pagePromise) {
    pagePromise = contextPromise.then(async (context) => {
      const page = await context.newPage();
      await page.goto(WEB_URL, { waitUntil: 'domcontentloaded', timeout: REQUEST_TIMEOUT_MS }).catch(() => undefined);
      await page.waitForTimeout(1000);
      return page;
    });
  }

  return pagePromise;
}

async function extractSchemaFromBundle(scriptUrl: string) {
  const text = await (await fetch(scriptUrl)).text();
  let captured: any;
  vm.runInNewContext(text, {
    window: {
      webpackJsonp: {
        push(payload: any) {
          captured = payload;
        },
      },
    },
  });

  const modules = captured?.[1];
  const moduleEntries = (Array.isArray(modules)
    ? modules.map((fn, index) => [index, fn])
    : Object.entries(modules || {})).filter((entry: any) => entry?.[1]);

  for (const [, moduleFn] of moduleEntries as Array<[string | number, any]>) {
    if (!String(moduleFn).includes('java_package') || !String(moduleFn).includes('onescore')) continue;
    const module = { exports: {} as any };
    moduleFn.call(module.exports, module, module.exports, () => ({}));
    return module.exports;
  }

  throw new Error('AiScore protobuf schema not found in bundle.');
}

async function getRoot() {
  rootPromise ||= extractSchemaFromBundle(STATIC_SCHEMA_SCRIPT).then((schema) => protobuf.Root.fromJSON(schema));
  return rootPromise;
}

async function fetchBinary(path: string) {
  const page = await getPage();
  const url = `${API_BASE_URL}${path}`;
  const result = await page.evaluate(
    async ({ apiUrl, timeoutMs }) => {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(apiUrl, {
          credentials: 'include',
          signal: controller.signal,
        });
        const buffer = await response.arrayBuffer();
        return {
          ok: response.ok,
          status: response.status,
          bytes: Array.from(new Uint8Array(buffer)),
        };
      } finally {
        window.clearTimeout(timeout);
      }
    },
    { apiUrl: url, timeoutMs: REQUEST_TIMEOUT_MS }
  );

  if (!result.ok) {
    throw new Error(`AiScore HTTP ${result.status} for ${url}`);
  }

  return Uint8Array.from(result.bytes);
}

async function fetchDecoded(path: string, typeName: string): Promise<AiScoreDecoded> {
  const root = await getRoot();
  const responseType = root.lookupType('onescore.app.v1.Response');
  const payloadType = root.lookupType(typeName);
  const wrapped = responseType.decode(await fetchBinary(path)) as any;
  const payload = wrapped.data || new Uint8Array();
  return payloadType.toObject(payloadType.decode(payload), {
    longs: String,
    enums: String,
    defaults: false,
    arrays: true,
    objects: true,
  }) as AiScoreDecoded;
}

async function fetchMatchList(date?: string) {
  const path = date
    ? `/matches?lang=${LANG}&sport_id=${SPORT_ID}&date=${toDateKey(date)}&tz=${encodeURIComponent(TIMEZONE_OFFSET)}`
    : `/today/matches?sid=${SPORT_ID}&tz=${encodeURIComponent(TIMEZONE_OFFSET)}&lang=${LANG}`;
  return fetchDecoded(path, 'onescore.app.v1.Matches');
}

export async function fetchAiScoreMatches(date?: string) {
  const raw = await fetchMatchList(date);
  return {
    status: 200,
    raw,
    events: Array.isArray(raw.matches) ? raw.matches.map((match) => toSofaLikeEvent(match, raw)) : [],
  };
}

export async function fetchAiScoreEvent(eventId: number | string) {
  const raw = await fetchDecoded(
    `/match/data?lang=${LANG}&match_id=${eventId}&tz=${encodeURIComponent(TIMEZONE_OFFSET)}`,
    'onescore.app.v1.WebMatchData'
  );
  const match = raw.match || raw.data?.match || raw.matches?.[0];
  const matchId = String(match?.id || match?.mid || '');

  if (!matchId || matchId !== String(eventId)) {
    const list = await fetchMatchList();
    const listedMatch = (list.matches || []).find((item: any) => String(item.id || item.mid) === String(eventId));
    if (!listedMatch) return { status: 404, raw: { requestedEventId: eventId, match, raw } };
    return { status: 200, data: normalizeMatch(listedMatch, list), raw: { match: listedMatch, list } };
  }

  return {
    status: 200,
    data: normalizeMatch(match, raw),
    raw,
  };
}

function createStatItem(key: string, name: string, homeValue: unknown, awayValue: unknown) {
  const home = numberOrZero(homeValue);
  const away = numberOrZero(awayValue);
  return {
    key,
    name,
    compare_code: home === away ? 0 : home > away ? 1 : 2,
    statistics_type: 'positive',
    value_type: 'team',
    render_type: 1,
    home: { label: String(home), value: home, total: home },
    away: { label: String(away), value: away, total: away },
  };
}

function normalizeStatsItems(raw: any) {
  const candidates = [
    raw?.stats,
    raw?.items,
    raw?.incidents,
    raw?.statsList,
    raw?.matchStats,
  ].find((value) => Array.isArray(value)) || [];

  return candidates
    .map((item: any, index: number) => createStatItem(
      item.key || item.type || `stat_${index + 1}`,
      item.name || item.title || item.typeName || `Estatistica ${index + 1}`,
      item.home || item.homeValue || item.homeScore || item.value?.home,
      item.away || item.awayValue || item.awayScore || item.value?.away
    ))
    .filter((item: any) => item.home.value || item.away.value);
}

function buildPlayerMap(raw: any): Map<string, any> {
  return new Map<string, any>((raw?.players || []).map((player: any) => [String(player.id), player]));
}

function normalizeAiScorePlayer(lineupItem: any, playerMap: Map<string, any>, substitute = false) {
  const player = playerMap.get(String(lineupItem?.player?.id)) || lineupItem?.player || lineupItem || {};
  const rating = Number(lineupItem?.rating);

  return {
    avgRating: Number.isFinite(rating) && rating > 0 ? rating : undefined,
    player: {
      id: player.id,
      name: player.name,
      slug: player.slug || toSlug(player.name),
      shortName: player.name,
      position: lineupItem?.position || player.position,
    },
    teamId: lineupItem?.team?.id || lineupItem?.teamId || player.teamId || player.team?.id,
    shirtNumber: lineupItem?.shirtNumber || player.shirtNumber,
    position: lineupItem?.position || player.position,
    substitute,
    captain: Boolean(lineupItem?.captain),
    age: player.age,
    height: player.height,
    marketValue: player.marketValue,
    intMarketValue: player.intMarketValue,
    detailedPositions: player.detailedPositions,
    hasStats: Boolean(player.hasStats),
    stats: player.stats,
  };
}

function normalizeAiScoreInjuries(items: any[] | undefined, playerMap: Map<string, any>) {
  return (items || []).map((item) => {
    const player = playerMap.get(String(item?.player?.id)) || item?.player || {};
    return {
      player: {
        id: player.id,
        name: player.name,
        slug: player.slug || toSlug(player.name),
      },
      reason: item.reason,
      type: item.type,
      injuryId: item.injuryId,
    };
  });
}

function normalizeAiScoreLineupData(raw: any) {
  const playerMap = buildPlayerMap(raw);
  const homeTeamId = raw?.lineup?.home?.[0]?.team?.id
    || raw?.lineupTeamInfo?.[0]?.team?.id
    || raw?.homeTeam?.id
    || raw?.match?.homeTeam?.id;
  const awayTeamId = raw?.lineup?.away?.[0]?.team?.id
    || raw?.lineupTeamInfo?.[1]?.team?.id
    || raw?.awayTeam?.id
    || raw?.match?.awayTeam?.id;
  const rawPlayers = Array.isArray(raw?.players) ? raw.players : [];
  const playersByTeam = (teamId: unknown) => rawPlayers
    .filter((player: any) => String(player.teamId || player.team?.id || player.team?.tid || '') === String(teamId))
    .map((player: any) => normalizeAiScorePlayer(player, playerMap, true));
  const homePlayers = (raw?.lineup?.home || []).length
    ? (raw?.lineup?.home || []).map((item: any) => normalizeAiScorePlayer(item, playerMap))
    : playersByTeam(homeTeamId);
  const awayPlayers = (raw?.lineup?.away || []).length
    ? (raw?.lineup?.away || []).map((item: any) => normalizeAiScorePlayer(item, playerMap))
    : playersByTeam(awayTeamId);

  return {
    confirmed: Boolean(homePlayers.length || awayPlayers.length),
    source: 'aiscore',
    home: {
      team: raw?.lineup?.home?.[0]?.team,
      formation: raw?.lineupTeamInfo?.[0]?.formation,
      players: homePlayers,
      missingPlayers: normalizeAiScoreInjuries(raw?.playersInjury?.homeInjury, playerMap),
      squadSummary: raw?.lineupTeamInfo?.[0]?.extraData,
    },
    away: {
      team: raw?.lineup?.away?.[0]?.team,
      formation: raw?.lineupTeamInfo?.[1]?.formation,
      players: awayPlayers,
      missingPlayers: normalizeAiScoreInjuries(raw?.playersInjury?.awayInjury, playerMap),
      squadSummary: raw?.lineupTeamInfo?.[1]?.extraData,
    },
    bestPlayers: raw?.bestPlayers || [],
    totalPlayers: raw?.players?.length || homePlayers.length + awayPlayers.length,
    rawPlayerPoolAvailable: rawPlayers.length > 0,
  };
}

export async function fetchAiScoreStatistics(eventId: number | string) {
  const raw = await fetchDecoded(`/match/stats?match_id=${eventId}&lang=${LANG}`, 'onescore.app.v1.MatchIncidentStats');
  const items = normalizeStatsItems(raw);

  return {
    event_id: eventId,
    source: 'aiscore',
    by_period: {
      ALL: {
        period: 'ALL',
        groups_by_name: {
          'AiScore Team Stats': {
            group_name: 'AiScore Team Stats',
            items,
            total_items: items.length,
          },
        },
        group_order: ['AiScore Team Stats'],
        total_groups: 1,
        total_items: items.length,
      },
    },
    summary: {
      periods: ['ALL'],
      total_groups: 1,
      total_items: items.length,
      source: 'aiscore',
    },
    raw,
  };
}

export async function fetchAiScoreLineups(eventId: number | string) {
  const raw = await fetchDecoded(`/match/lineups?match_id=${eventId}&lang=${LANG}`, 'onescore.app.v1.MatchLineup');
  const data = normalizeAiScoreLineupData(raw);

  return {
    status: 200,
    raw,
    data,
  };
}

export async function fetchAiScoreIncidents(eventId: number | string) {
  const raw = await fetchDecoded(
    `/match/incidents?match_id=${eventId}&lang=${LANG}&last_id=`,
    'onescore.app.v1.MatchIncidents'
  );
  return {
    status: 200,
    raw,
    data: {
      eventId,
      source: 'aiscore',
      incidents: raw.incidents || raw.items || [],
    },
  };
}

export async function fetchAiScoreOdds(eventId: number | string) {
  const raw = await fetchDecoded(`/match/odds_list?match_id=${eventId}&code=`, 'onescore.app.v1.MatchOdds');
  const markets = raw.markets || raw.items || raw.odds || [];
  return {
    eventId,
    event_id: eventId,
    source: 'aiscore',
    summary: {
      total_markets: markets.length,
      total_choices: markets.reduce((total: number, market: any) => total + (market.choices || market.odds || []).length, 0),
    },
    markets_by_group: {
      aiscore: {
        group_name: 'AiScore',
        markets,
      },
    },
    raw,
  };
}

export async function fetchAiScoreGraph(eventId: number | string) {
  return {
    status: 200,
    raw: {},
    data: {
      eventId,
      source: 'aiscore',
      points: [],
      periodTime: 45,
      overtimeLength: 0,
      periodCount: 2,
      summary: { totalMinutes: 0, minValue: 0, maxValue: 0, averageValue: 0 },
    },
  };
}

export async function fetchAiScoreStreaks(eventId: string) {
  const raw = await fetchDecoded(`/match/history?match_id=${eventId}&lang=${LANG}`, 'onescore.app.v1.HistoryMatches');
  return {
    status: 200,
    raw,
    data: {
      eventId,
      source: 'aiscore',
      general: raw.general || [],
      head2head: raw.head2head || raw.h2h || raw.matches || [],
      home: raw.home || [],
      away: raw.away || [],
      homeFuture: raw.homeFuture || [],
      awayFuture: raw.awayFuture || [],
      teams: raw.teams || [],
      competitions: raw.comps || [],
    },
  };
}

export async function fetchAiScoreTeamInfo(teamId: string) {
  const raw = await fetchMatchList();
  const maps = buildMaps(raw);
  const team = maps.teams.get(String(teamId));

  if (!team) {
    return { status: 404, data: undefined, raw };
  }

  const name = getName(team);
  return {
    status: 200,
    raw,
    data: {
      teamId: team.id || teamId,
      name,
      shortName: team.shortName || name,
      fullName: name,
      slug: toSlug(name),
      nameCode: team.code || team.shortName || '',
      national: Boolean(team.national),
      sport: { name: 'Futebol', slug: 'football' },
      country: team.country || team.countryId ? { id: team.countryId, name: team.country } : undefined,
      manager: team.manager || null,
      venue: team.venue || null,
      colors: {
        primary: team.primaryColor,
        secondary: team.secondaryColor,
        text: '#ffffff',
      },
      userCount: numberOrZero(team.users),
      lastUpdated: Date.now(),
    },
  };
}

export async function fetchAiScoreTeamNextEvents(teamId: string) {
  const raw = await fetchMatchList();
  const matches = (raw.matches || []).filter((match: any) =>
    String(match.homeTeam?.id) === String(teamId) || String(match.awayTeam?.id) === String(teamId)
  );

  const events = matches.map((match: any) => {
    const event = normalizeMatch(match, raw);
    return {
      eventId: event.id,
      customId: String(event.id),
      startTimestamp: event.startTime,
      startDate: event.startTime ? new Date(event.startTime * 1000).toISOString() : undefined,
      tournament: event.tournament,
      season: event.season,
      round: event.round,
      homeTeam: event.homeTeam,
      awayTeam: event.awayTeam,
      status: event.status.type,
      slug: event.slug,
    };
  });

  return {
    status: 200,
    data: {
      teamId,
      events,
      hasNextPage: false,
      totalEvents: events.length,
      lastUpdated: Date.now(),
    },
  };
}

export function createAiScoreStandingsPlaceholder(tournamentId: string, seasonId: string) {
  return {
    tournamentId,
    seasonId,
    source: 'aiscore',
    teams: [],
    note: 'Standings endpoint was discovered but is not normalized yet for AiScore.',
  };
}
