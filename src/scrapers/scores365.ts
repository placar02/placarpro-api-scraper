import type { NormalizedEvent } from '../types/event';
import type { EventLive } from '../types/event.live';

const BASE_URL = process.env.SCORES365_BASE_URL || 'https://webws.365scores.com/web';
const LANG_ID = process.env.SCORES365_LANG_ID || '31';
const USER_COUNTRY_ID = process.env.SCORES365_USER_COUNTRY_ID || '21';
const TIMEZONE = process.env.MATCHES_TIMEZONE || 'America/Sao_Paulo';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

type Scores365Competitor = {
  id?: number;
  name?: string;
  shortName?: string;
  symbolicName?: string;
  nameForURL?: string;
  score?: number;
  countryId?: number;
  sportId?: number;
  color?: string;
  awayColor?: string;
};

type Scores365Game = {
  id?: number;
  competitionId?: number;
  seasonNum?: number;
  roundNum?: number;
  roundName?: string;
  competitionDisplayName?: string;
  startTime?: string;
  statusGroup?: number;
  statusText?: string;
  shortStatusText?: string;
  gameTime?: number;
  gameTimeDisplay?: string;
  homeCompetitor?: Scores365Competitor;
  awayCompetitor?: Scores365Competitor;
  venue?: {
    id?: number;
    name?: string;
    shortName?: string;
    capacity?: number;
  };
  hasStats?: boolean;
  hasLineups?: boolean;
  officials?: Array<{
    id?: number;
    name?: string;
    nameForURL?: string;
    countryId?: number;
  }>;
};

type Scores365Response = {
  game?: Scores365Game;
  games?: Scores365Game[];
  competitions?: Array<{
    id?: number;
    name?: string;
    nameForURL?: string;
    countryId?: number;
    currentSeasonNum?: number;
  }>;
};

export interface Scores365EventResponse {
  status: number;
  data?: NormalizedEvent;
  raw?: Scores365Response;
}

function buildQuery(extra: Record<string, string | number | undefined> = {}) {
  const params = new URLSearchParams({
    appTypeId: '5',
    langId: LANG_ID,
    timezoneName: TIMEZONE,
    userCountryId: USER_COUNTRY_ID,
  });

  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) params.set(key, String(value));
  }

  return params.toString();
}

async function fetch365<T>(path: string, extra: Record<string, string | number | undefined> = {}): Promise<T> {
  const url = `${BASE_URL}${path}?${buildQuery(extra)}`;
  let response: Response | null = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    response = await fetch(url, {
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
        'User-Agent': USER_AGENT,
        Referer: 'https://www.365scores.com/',
      },
    });

    if (response.ok || ![502, 503, 504].includes(response.status)) {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 750 * (attempt + 1)));
  }

  if (!response?.ok) {
    throw new Error(response ? `365Scores HTTP ${response.status}: ${response.statusText}` : '365Scores request failed without a response');
  }

  return response.json() as Promise<T>;
}

function toSlug(value?: string) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function toTimestamp(value?: string) {
  const timestamp = value ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : 0;
}

function normalizeScore(value?: number) {
  return typeof value === 'number' && value >= 0 ? value : 0;
}

function normalizeStatus(game: Scores365Game) {
  const statusGroup = game.statusGroup ?? 2;

  if (statusGroup === 2) {
    return { code: 0, description: game.statusText || 'Programação', type: 'notstarted' };
  }

  if (statusGroup === 4) {
    return { code: 100, description: game.statusText || 'Finalizado', type: 'finished' };
  }

  return { code: 6, description: game.statusText || 'Em andamento', type: 'inprogress' };
}

function toNumber(value: unknown): number {
  const parsed = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundStat(value: number, digits = 2): number {
  return Number(value.toFixed(digits));
}

function getGameMemberMap(game: any): Map<number, any> {
  return new Map((game?.members || []).map((member: any) => [Number(member.id), member]));
}

function getCompetitorSide(game: any, competitorId: unknown): 'home' | 'away' | null {
  const id = Number(competitorId);
  if (id && id === Number(game?.homeCompetitor?.id)) return 'home';
  if (id && id === Number(game?.awayCompetitor?.id)) return 'away';
  return null;
}

function getPlayerSide(game: any, playerId: unknown): 'home' | 'away' | null {
  const member = getGameMemberMap(game).get(Number(playerId));
  return getCompetitorSide(game, member?.competitorId);
}

function isShotOnTarget(shot: any): boolean {
  const outcomeId = Number(shot?.outcome?.id);
  if ([0, 2].includes(outcomeId)) return true;
  return toNumber(shot?.xgot) > 0;
}

function createStatItem(key: string, name: string, homeValue: number, awayValue: number, valueType: 'event' | 'team' = 'team') {
  const formatValue = (value: number) => Number.isInteger(value) ? String(value) : String(roundStat(value));

  return {
    key,
    name,
    compare_code: homeValue === awayValue ? 0 : homeValue > awayValue ? 1 : 2,
    statistics_type: 'positive',
    value_type: valueType,
    render_type: 1,
    home: {
      label: formatValue(homeValue),
      value: roundStat(homeValue),
      total: valueType === 'team' ? roundStat(homeValue) : undefined,
    },
    away: {
      label: formatValue(awayValue),
      value: roundStat(awayValue),
      total: valueType === 'team' ? roundStat(awayValue) : undefined,
    },
  };
}

function aggregate365ShotChart(game: any) {
  const members = getGameMemberMap(game);
  const shots = Array.isArray(game?.chartEvents?.events) ? game.chartEvents.events : [];
  const teamStats = {
    home: { shots: 0, shotsOnTarget: 0, goals: 0, blockedShots: 0, xg: 0, xgot: 0 },
    away: { shots: 0, shotsOnTarget: 0, goals: 0, blockedShots: 0, xg: 0, xgot: 0 },
  };
  const playerStats = new Map<number, any>();
  const seenShots = new Set<string>();

  for (const shot of shots) {
    const shotSignature = [
      shot.playerId,
      shot.time,
      shot.bodyPart,
      shot.line,
      shot.side,
      shot.outcome?.id,
      shot.outcome?.name,
    ].join('|');
    if (seenShots.has(shotSignature)) continue;
    seenShots.add(shotSignature);

    const playerId = Number(shot.playerId);
    const member = members.get(playerId);
    const side = getCompetitorSide(game, member?.competitorId) || (Number(shot.competitorNum) === 1 ? 'home' : Number(shot.competitorNum) === 2 ? 'away' : null);
    if (!side) continue;

    const outcomeId = Number(shot?.outcome?.id);
    const onTarget = isShotOnTarget(shot);
    const xg = toNumber(shot.xg);
    const xgot = toNumber(shot.xgot);

    teamStats[side].shots += 1;
    teamStats[side].shotsOnTarget += onTarget ? 1 : 0;
    teamStats[side].goals += outcomeId === 0 ? 1 : 0;
    teamStats[side].blockedShots += outcomeId === 4 ? 1 : 0;
    teamStats[side].xg += xg;
    teamStats[side].xgot += xgot;

    if (!playerStats.has(playerId)) {
      playerStats.set(playerId, {
        id: playerId,
        name: member?.name || `Jogador ${playerId}`,
        shortName: member?.shortName,
        jerseyNumber: member?.jerseyNumber,
        team: side,
        competitorId: member?.competitorId,
        shots: 0,
        shotsOnTarget: 0,
        goals: 0,
        blockedShots: 0,
        xg: 0,
        xgot: 0,
        shotsDetail: [],
      });
    }

    const player = playerStats.get(playerId);
    player.shots += 1;
    player.shotsOnTarget += onTarget ? 1 : 0;
    player.goals += outcomeId === 0 ? 1 : 0;
    player.blockedShots += outcomeId === 4 ? 1 : 0;
    player.xg += xg;
    player.xgot += xgot;
    player.shotsDetail.push({
      time: shot.time,
      xg: roundStat(xg),
      xgot: roundStat(xgot),
      bodyPart: shot.bodyPart,
      outcome: shot.outcome?.name,
    });
  }

  return {
    teamStats,
    players: [...playerStats.values()]
      .map((player) => ({
        ...player,
        xg: roundStat(player.xg),
        xgot: roundStat(player.xgot),
        shotsDetail: player.shotsDetail.slice(0, 8),
      }))
      .sort((a, b) => b.shotsOnTarget - a.shotsOnTarget || b.shots - a.shots || b.xg - a.xg),
    shots: shots.slice(0, 40),
  };
}

function aggregate365Events(game: any) {
  const events = Array.isArray(game?.events) ? game.events : [];
  const cards = {
    home: { yellow: 0, red: 0 },
    away: { yellow: 0, red: 0 },
  };

  for (const event of events) {
    const typeName = String(event?.eventType?.name || '').toLowerCase();
    const side = getCompetitorSide(game, event?.competitorId);
    if (!side) continue;

    if (typeName.includes('cartao') || typeName.includes('cartão') || typeName.includes('yellow')) {
      cards[side].yellow += 1;
    }
    if (typeName.includes('vermelho') || typeName.includes('red')) {
      cards[side].red += 1;
    }
  }

  return { cards };
}

function get365TopPerformerPlayers(game: any) {
  const categories = game?.topPerformers?.categories;
  if (!Array.isArray(categories)) return [];

  return categories.flatMap((category: any) => [
    category.homePlayer ? { ...category.homePlayer, team: 'home', category: category.name } : null,
    category.awayPlayer ? { ...category.awayPlayer, team: 'away', category: category.name } : null,
  ].filter(Boolean));
}

function get365OddsLines(game: any) {
  const bestOdds = Array.isArray(game?.bestOdds) ? game.bestOdds : [];
  const predictionOdds = Array.isArray(game?.promotedPredictions?.predictions)
    ? game.promotedPredictions.predictions.map((prediction: any) => prediction.odds).filter(Boolean)
    : [];

  const byKey = new Map<string, any>();
  for (const line of [...bestOdds, ...predictionOdds]) {
    const key = String(line.lineId || `${line.lineTypeId}-${line.internalOption || ''}`);
    if (!byKey.has(key)) byKey.set(key, line);
  }

  return [...byKey.values()];
}

function format365OddsOptionName(line: any, option: any, game: any) {
  const marketName = String(line?.lineType?.name || line?.lineType?.title || '').toLowerCase();
  const optionName = String(option?.name || '');
  const optionNum = Number(option?.num);
  const homeName = game?.homeCompetitor?.name || 'Casa';
  const awayName = game?.awayCompetitor?.name || 'Fora';
  const totalLine = line?.internalOptionValue || line?.internalOption || '';

  if (marketName.includes('resultado')) {
    if (optionNum === 1 || optionName === '1') return homeName;
    if (optionNum === 2 || optionName.toLowerCase() === 'x') return 'Empate';
    if (optionNum === 3 || optionName === '2') return awayName;
  }

  if (marketName.includes('primeiro a marcar')) {
    if (optionNum === 1 || optionName.toLowerCase() === 'casa') return homeName;
    if (optionNum === 2 || optionName.toLowerCase().includes('sem')) return 'Sem gol';
    if (optionNum === 3 || optionName.toLowerCase() === 'fora') return awayName;
  }

  if (marketName.includes('total de gols')) {
    const suffix = totalLine ? ` ${totalLine}` : '';
    if (optionName.toLowerCase().includes('mais')) return `Mais de${suffix}`;
    if (optionName.toLowerCase().includes('menos')) return `Menos de${suffix}`;
  }

  return optionName;
}

function normalizeEvent(game: Scores365Game, raw: Scores365Response): NormalizedEvent {
  const competition = raw.competitions?.find((item) => item.id === game.competitionId);
  const home = game.homeCompetitor || {};
  const away = game.awayCompetitor || {};
  const official = Array.isArray(game.officials) ? game.officials[0] : undefined;

  return {
    id: game.id ?? 0,
    slug: `${toSlug(home.name)}-${toSlug(away.name)}-${game.id ?? ''}`,
    status: normalizeStatus(game),
    tournament: {
      id: game.competitionId ?? competition?.id ?? 0,
      name: game.competitionDisplayName || competition?.name || '',
      slug: competition?.nameForURL || toSlug(game.competitionDisplayName),
    },
    season: {
      id: game.seasonNum ?? competition?.currentSeasonNum ?? 0,
      name: game.seasonNum ? String(game.seasonNum) : '',
      year: game.seasonNum ? String(game.seasonNum) : '',
    },
    round: game.roundNum,
    homeTeam: {
      id: home.id ?? 0,
      name: home.name || '',
      slug: home.nameForURL || toSlug(home.name),
      shortName: home.shortName || home.symbolicName || home.name || '',
    },
    awayTeam: {
      id: away.id ?? 0,
      name: away.name || '',
      slug: away.nameForURL || toSlug(away.name),
      shortName: away.shortName || away.symbolicName || away.name || '',
    },
    score: {
      home: normalizeScore(home.score),
      away: normalizeScore(away.score),
      homeDisplay: normalizeScore(home.score),
      awayDisplay: normalizeScore(away.score),
    },
    venue: {
      id: game.venue?.id ?? 0,
      name: game.venue?.name || 'Unknown',
      slug: game.venue?.shortName || toSlug(game.venue?.name),
      city: '',
      capacity: game.venue?.capacity ?? 0,
    },
    referee: {
      id: official?.id ?? 0,
      name: official?.name || 'Unknown',
      slug: official?.nameForURL || toSlug(official?.name),
      country: undefined,
    },
    startTime: toTimestamp(game.startTime),
    currentTime: undefined,
    features: {
      hasXg: false,
      hasPlayerStats: Boolean(game.hasStats),
      hasHeatMap: false,
    },
  };
}

function toSofaLikeEvent(game: Scores365Game, raw: Scores365Response): EventLive {
  const normalized = normalizeEvent(game, raw);

  return {
    id: normalized.id,
    customId: String(normalized.id),
    slug: normalized.slug,
    startTimestamp: normalized.startTime,
    lastPeriod: '',
    finalResultOnly: false,
    feedLocked: false,
    isEditor: false,
    tournament: {
      name: normalized.tournament.name,
      slug: normalized.tournament.slug,
      id: normalized.tournament.id,
      category: {} as any,
    },
    season: {
      id: normalized.season.id,
      name: normalized.season.name,
      year: normalized.season.year,
      editor: false,
    },
    roundInfo: { round: normalized.round ?? 0 },
    status: normalized.status,
    homeTeam: {
      id: normalized.homeTeam.id,
      name: normalized.homeTeam.name,
      slug: normalized.homeTeam.slug,
      shortName: normalized.homeTeam.shortName,
    } as any,
    awayTeam: {
      id: normalized.awayTeam.id,
      name: normalized.awayTeam.name,
      slug: normalized.awayTeam.slug,
      shortName: normalized.awayTeam.shortName,
    } as any,
    homeScore: {
      current: normalized.score.home,
      display: normalized.score.homeDisplay,
      period1: 0,
      period2: 0,
      normaltime: normalized.score.home,
    },
    awayScore: {
      current: normalized.score.away,
      display: normalized.score.awayDisplay,
      period1: 0,
      period2: 0,
      normaltime: normalized.score.away,
    },
    time: {
      injuryTime1: 0,
      initial: 0,
      max: 90,
      extra: 0,
      currentPeriodStartTimestamp: 0,
    },
    hasEventPlayerStatistics: normalized.features.hasPlayerStats,
    hasEventPlayerHeatMap: normalized.features.hasHeatMap,
    hasGlobalHighlights: false,
  };
}

export async function fetch365Event(eventId: number | string): Promise<Scores365EventResponse> {
  const raw = await fetch365<Scores365Response>('/game/', { gameId: eventId });

  if (!raw.game?.id) {
    return { status: 404, raw };
  }

  return {
    status: 200,
    data: normalizeEvent(raw.game, raw),
    raw,
  };
}

export async function fetch365Matches(date?: string): Promise<{ status: number; events: EventLive[]; raw: Scores365Response }> {
  const raw = await fetch365<Scores365Response>('/games/current/', {
    sports: 1,
    date,
  });

  return {
    status: 200,
    raw,
    events: Array.isArray(raw.games) ? raw.games.map((game) => toSofaLikeEvent(game, raw)) : [],
  };
}

export async function fetch365Odds(eventId: number | string) {
  const raw = await fetch365<Scores365Response>('/game/', { gameId: eventId });
  const game = raw.game;
  const odds = get365OddsLines(game as any);

  if (!game?.id) return null;

  const markets = odds.map((line: any) => ({
    market_id: line.lineTypeId,
    market_name: line.lineType?.name || line.lineType?.title || 'Odds',
    market_group: line.lineType?.shortName || line.lineType?.name || 'Odds',
    market_period: 'fulltime',
    choice_group: line.internalOption || line.lineType?.shortName,
    suspended: false,
    choices: (line.options || []).map((option: any) => ({
      id: option.num,
      name: format365OddsOptionName(line, option, game),
      raw_name: option.name,
      decimal_odds: option.rate?.decimal,
      fractional_odds: option.rate?.fractional,
      american_odds: option.rate?.american,
      change: option.trend,
      bookmaker: line.bookmaker?.name,
    })),
  }));

  return {
    eventId: game.id,
    event_id: game.id,
    source: '365scores',
    summary: {
      total_markets: markets.length,
      total_choices: markets.reduce((total: number, market: any) => total + market.choices.length, 0),
    },
    markets_by_group: {
      '365scores': {
        group_name: '365Scores',
        markets,
      },
    },
    raw,
  };
}

export async function fetch365Lineups(eventId: number | string) {
  const raw = await fetch365<Scores365Response>('/game/', { gameId: eventId });
  const game = raw.game as any;

  if (!game?.id) return { status: 404, raw };

  const topPerformers = get365TopPerformerPlayers(game);
  const toLineupPlayer = (player: any) => ({
    avgRating: undefined,
    player: {
      id: player.id,
      name: player.name,
      slug: player.nameForURL,
      shortName: player.shortName,
      position: player.positionShortName || player.positionName,
    },
    teamId: player.team === 'home' ? game.homeCompetitor?.id : game.awayCompetitor?.id,
    shirtNumber: player.jerseyNumber,
    position: player.positionName || player.positionShortName || player.category,
    substitute: false,
    captain: false,
    stats: player.stats || [],
  });

  return {
    status: 200,
    raw,
    data: {
      confirmed: Boolean(game.hasLineups || topPerformers.length),
      source: '365scores',
      home: {
        team: game.homeCompetitor,
        formation: undefined,
        players: topPerformers.filter((player: any) => player.team === 'home').map(toLineupPlayer),
        topPerformers: topPerformers.filter((player: any) => player.team === 'home'),
      },
      away: {
        team: game.awayCompetitor,
        formation: undefined,
        players: topPerformers.filter((player: any) => player.team === 'away').map(toLineupPlayer),
        topPerformers: topPerformers.filter((player: any) => player.team === 'away'),
      },
    },
  };
}

export async function fetch365Statistics(eventId: number | string) {
  const raw = await fetch365<Scores365Response>('/game/', { gameId: eventId });
  const game = raw.game as any;
  if (!game?.id) return null;

  const normalized = normalizeEvent(game, raw);
  const shotStats = aggregate365ShotChart(game);
  const eventStats = aggregate365Events(game);
  const { home, away } = shotStats.teamStats;
  const cards = eventStats.cards;
  const items = [
    createStatItem('shots', 'Total de chutes', home.shots, away.shots),
    createStatItem('shotsOnTarget', 'Chutes no gol', home.shotsOnTarget, away.shotsOnTarget),
    createStatItem('blockedShots', 'Chutes bloqueados', home.blockedShots, away.blockedShots),
    createStatItem('goalsFromShotChart', 'Gols no shot chart', home.goals, away.goals),
    createStatItem('xg', 'Gols esperados (xG)', roundStat(home.xg), roundStat(away.xg)),
    createStatItem('xgot', 'xG no alvo (xGOT)', roundStat(home.xgot), roundStat(away.xgot)),
    createStatItem('yellowCards', 'Cartoes amarelos', cards.home.yellow, cards.away.yellow),
    createStatItem('redCards', 'Cartoes vermelhos', cards.home.red, cards.away.red),
  ];

  return {
    event_id: Number(eventId),
    source: '365scores',
    homeTeam: normalized.homeTeam,
    awayTeam: normalized.awayTeam,
    players: shotStats.players,
    shotChart: shotStats.shots.map((shot: any) => ({
      time: shot.time,
      playerId: shot.playerId,
      team: getPlayerSide(game, shot.playerId),
      xg: roundStat(toNumber(shot.xg)),
      xgot: roundStat(toNumber(shot.xgot)),
      bodyPart: shot.bodyPart,
      outcome: shot.outcome?.name,
    })),
    by_period: {
      ALL: {
        period: 'ALL',
        groups_by_name: {
          '365Scores Team Stats': {
            group_name: '365Scores Team Stats',
            items,
            total_items: items.length,
          },
        },
        group_order: ['365Scores Team Stats'],
        total_groups: 1,
        total_items: items.length,
      },
    },
    summary: {
      periods: ['ALL'],
      total_groups: 1,
      total_items: items.length,
      source: 'chartEvents',
      hasShotChart: shotStats.shots.length > 0,
      playerStatsCount: shotStats.players.length,
    },
    raw,
  };
}

export async function fetch365Incidents(eventId: number | string) {
  const raw = await fetch365<Scores365Response>('/game/', { gameId: eventId });
  const game = raw.game as any;
  if (!game?.id) return { status: 404, raw };

  const members = getGameMemberMap(game);
  const incidents = (game.events || []).map((event: any, index: number) => {
    const member = members.get(Number(event.playerId));
    const typeName = String(event.eventType?.name || '').toLowerCase();
    const isCard = typeName.includes('cartao') || typeName.includes('cartão') || typeName.includes('card');
    const isGoal = typeName.includes('gol') || typeName.includes('goal');
    const isSubstitution = typeName.includes('substitution') || typeName.includes('substitu');

    return {
      id: event.num || index + 1,
      eventId: Number(eventId),
      type: isCard ? 'card' : isGoal ? 'goal' : isSubstitution ? 'substitution' : event.eventType?.name,
      class: event.eventType?.subTypeName || event.eventType?.name,
      time: event.gameTime,
      addedTime: event.addedTime,
      isHome: getCompetitorSide(game, event.competitorId) === 'home',
      player: member ? {
        id: member.id,
        name: member.name,
        slug: member.nameForURL,
        jerseyNumber: member.jerseyNumber,
      } : undefined,
      goalScorer: isGoal && member ? {
        id: member.id,
        name: member.name,
        slug: member.nameForURL,
        jerseyNumber: member.jerseyNumber,
      } : undefined,
      cardType: isCard ? event.eventType?.name : undefined,
      rawType: event.eventType,
    };
  });

  return {
    status: 200,
    raw,
    data: {
      eventId: Number(eventId),
      source: '365scores',
      incidents,
      teamColors: {
        home: game.homeCompetitor?.color,
        away: game.awayCompetitor?.color,
      },
    },
  };
}

export async function fetch365Graph(eventId: number | string) {
  const event = await fetch365Event(eventId);
  if (!event.data) return { status: 404, raw: event.raw };

  return {
    status: 200,
    raw: event.raw,
    data: {
      eventId: Number(eventId),
      source: '365scores',
      points: [],
      periodTime: 45,
      overtimeLength: 0,
      periodCount: 2,
      summary: {
        totalMinutes: 0,
        minValue: 0,
        maxValue: 0,
        averageValue: 0,
      },
    },
  };
}

export async function fetch365Streaks(eventId: string) {
  const event = await fetch365Event(eventId);
  if (!event.data) return { status: 404, raw: event.raw };

  return {
    status: 200,
    raw: event.raw,
    data: {
      eventId,
      source: '365scores',
      general: [],
      head2head: [],
    },
  };
}

export function get365ImageUrl(type: 'team' | 'player', id: string, size: 'small' | 'large' = 'large') {
  const folder = type === 'team' ? 'Competitors' : 'Athletes';
  const fallback = type === 'team' ? 'd_Competitors:default1.png' : 'd_Athletes:default.png';
  const dimension = size === 'small' ? 64 : 160;

  return `https://imagecache.365scores.com/image/upload/f_png,w_${dimension},h_${dimension},c_limit,q_auto:eco,dpr_2,${fallback}/v1/${folder}/${id}`;
}

export async function fetch365TeamInfo(teamId: string) {
  const matches = await fetch365Matches();
  const game = matches.raw.games?.find((item) =>
    String(item.homeCompetitor?.id) === teamId || String(item.awayCompetitor?.id) === teamId
  );
  const team = String(game?.homeCompetitor?.id) === teamId ? game?.homeCompetitor : game?.awayCompetitor;

  if (!team?.id) {
    return { status: 404, data: undefined, raw: matches.raw };
  }

  return {
    status: 200,
    raw: matches.raw,
    data: {
      teamId: team.id,
      name: team.name || '',
      shortName: team.shortName || team.symbolicName || team.name || '',
      fullName: team.name || '',
      slug: team.nameForURL || toSlug(team.name),
      nameCode: team.symbolicName || '',
      national: false,
      sport: { name: 'Futebol', slug: 'football' },
      country: { id: team.countryId },
      manager: null,
      venue: null,
      colors: {
        primary: team.color,
        secondary: team.awayColor,
        text: '#ffffff',
      },
      userCount: 0,
      lastUpdated: Date.now(),
    },
  };
}

export async function fetch365TeamNextEvents(teamId: string) {
  const matches = await fetch365Matches();
  const events = (matches.raw.games || [])
    .filter((game) => String(game.homeCompetitor?.id) === teamId || String(game.awayCompetitor?.id) === teamId)
    .map((game) => {
      const normalized = normalizeEvent(game, matches.raw);

      return {
        eventId: normalized.id,
        customId: String(normalized.id),
        startTimestamp: normalized.startTime,
        startDate: new Date(normalized.startTime * 1000).toISOString(),
        tournament: normalized.tournament,
        season: normalized.season,
        round: normalized.round,
        roundName: game.roundName,
        homeTeam: {
          id: normalized.homeTeam.id,
          name: normalized.homeTeam.name,
          slug: normalized.homeTeam.slug,
          nameCode: game.homeCompetitor?.symbolicName || normalized.homeTeam.shortName,
        },
        awayTeam: {
          id: normalized.awayTeam.id,
          name: normalized.awayTeam.name,
          slug: normalized.awayTeam.slug,
          nameCode: game.awayCompetitor?.symbolicName || normalized.awayTeam.shortName,
        },
        status: normalized.status.type,
        slug: normalized.slug,
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

export async function fetch365SearchTeams(query: string, page = 0) {
  const raw = await fetch365<any>('/search/', {
    searchQuery: query,
  });
  const competitors = Array.isArray(raw.competitors) ? raw.competitors : [];

  return {
    status: 200,
    raw,
    data: {
      page,
      query,
      teams: competitors
        .filter((team: any) => team.sportId === 1)
        .slice(page * 20, page * 20 + 20)
        .map((team: any) => ({
          id: team.id,
          name: team.name,
          slug: team.nameForURL || toSlug(team.name),
          shortName: team.shortName || team.symbolicName || team.name,
          nameCode: team.symbolicName,
          country: { id: team.countryId },
          colors: {
            primary: team.color,
            secondary: team.awayColor,
          },
          image: `/team/${team.id}/image`,
          imageSmall: `/team/${team.id}/image/small`,
        })),
    },
  };
}
