import type { Page } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadOgolPage, withOgolPage } from './browser';
import {
  absoluteOgolUrl,
  OGOL_DEEP_CACHE_TTL_MS,
  OGOL_DEEP_CONCURRENCY,
  OGOL_DEEP_ENRICHMENT,
  OGOL_DEEP_DISK_CACHE_DIR,
  OGOL_DEEP_PAGE_LIMIT,
  OGOL_DEEP_PLAYER_LIMIT,
} from './config';
import { snapshotOgolPage, type OgolPageLink, type OgolPageSnapshot } from './snapshot';

type PageRecord = {
  type: string;
  url: string;
  status: 'ok' | 'error';
  snapshot?: OgolPageSnapshot;
  error?: string;
};

type HistoricalMatch = {
  id: number;
  url: string;
  date?: string;
  homeSlug?: string;
  awaySlug?: string;
  homeScore: number;
  awayScore: number;
  context: string;
};

const deepCache = new Map<string, { expiresAt: number; promise: Promise<any> }>();
const DEEP_CACHE_SCHEMA_VERSION = 1;
let activeDeepCollections = 0;
const deepCollectionWaiters: Array<() => void> = [];

async function withDeepCollectionSlot<T>(task: () => Promise<T>): Promise<T> {
  if (activeDeepCollections >= OGOL_DEEP_CONCURRENCY) {
    await new Promise<void>((resolve) => deepCollectionWaiters.push(resolve));
  }
  activeDeepCollections += 1;
  try {
    return await task();
  } finally {
    activeDeepCollections -= 1;
    deepCollectionWaiters.shift()?.();
  }
}

async function readDeepDiskCache(eventId: string, allowExpired = false) {
  try {
    const file = path.join(OGOL_DEEP_DISK_CACHE_DIR, `${eventId}.json`);
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    const collectedAt = Date.parse(parsed?.collectedAt || '');
    if (parsed?.schemaVersion !== DEEP_CACHE_SCHEMA_VERSION || !Number.isFinite(collectedAt)) return null;
    if (!allowExpired && Date.now() - collectedAt > OGOL_DEEP_CACHE_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeDeepDiskCache(eventId: string, payload: any) {
  try {
    await fs.mkdir(OGOL_DEEP_DISK_CACHE_DIR, { recursive: true });
    await fs.writeFile(
      path.join(OGOL_DEEP_DISK_CACHE_DIR, `${eventId}.json`),
      JSON.stringify({ ...payload, schemaVersion: DEEP_CACHE_SCHEMA_VERSION }),
      'utf8',
    );
  } catch (error) {
    console.warn('[OGOL] Could not write deep cache:', error instanceof Error ? error.message : String(error));
  }
}

function normalized(value: unknown) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function slug(value: string) {
  return normalized(value).replace(/\s+/g, '-');
}

function uniqueLinks(links: OgolPageLink[]) {
  return [...new Map(links.filter((link) => link.href).map((link) => [link.href, link])).values()];
}

function linkScore(link: OgolPageLink, patterns: RegExp[]) {
  const text = normalized(`${link.text} ${link.section} ${link.context} ${link.href}`);
  return patterns.reduce((score, pattern) => score + (pattern.test(text) ? 1 : 0), 0);
}

function pickLink(links: OgolPageLink[], patterns: RegExp[]) {
  return [...links]
    .map((link) => ({ link, score: linkScore(link, patterns) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)[0]?.link;
}

export function parseHistoricalMatches(snapshot: OgolPageSnapshot): HistoricalMatch[] {
  const matches = uniqueLinks(snapshot.links.filter((link) => /\/jogo\/[^/]+\/\d+/.test(link.href)))
    .map((link) => {
      const id = Number(link.href.match(/\/(\d+)(?:[/?#]|$)/)?.[1]);
      const path = new URL(link.href).pathname;
      const pathMatch = path.match(/\/jogo\/(\d{4}-\d{2}-\d{2})-(.+)\/(\d+)/);
      const scoreSource = `${link.text} ${link.context}`.replace(/\d{4}-\d{2}-\d{2}/g, '');
      const score = scoreSource.match(/(?<!\d)(\d{1,2})-(\d{1,2})(?!\d)/);
      if (!id || !pathMatch || !score) return null;
      const teamsSlug = pathMatch[2];
      const scoreIndex = normalized(link.context).indexOf(`${score[1]} ${score[2]}`);
      const candidates = teamsSlug.split('-');
      let splitIndex = Math.max(1, Math.floor(candidates.length / 2));
      if (scoreIndex > 0) {
        const leftText = normalized(link.context).slice(0, scoreIndex);
        for (let index = 1; index < candidates.length; index += 1) {
          if (leftText.endsWith(candidates.slice(0, index).join(' '))) splitIndex = index;
        }
      }
      return {
        id,
        url: link.href,
        date: pathMatch[1],
        homeSlug: candidates.slice(0, splitIndex).join('-'),
        awaySlug: candidates.slice(splitIndex).join('-'),
        homeScore: Number(score[1]),
        awayScore: Number(score[2]),
        context: link.context || link.text,
      };
    })
    .filter((match): match is HistoricalMatch => Boolean(match));
  return [...new Map(matches.map((match) => [match.id, match])).values()]
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

export function aggregateMatches(matches: HistoricalMatch[], teamSlug: string, limit: number, venue?: 'home' | 'away') {
  const sample = matches
    .filter((match) => match.homeSlug?.includes(teamSlug) || match.awaySlug?.includes(teamSlug))
    .filter((match) => !venue || (venue === 'home' ? match.homeSlug?.includes(teamSlug) : match.awaySlug?.includes(teamSlug)))
    .slice(0, limit);
  const totals = sample.reduce((acc, match) => {
    const isHome = match.homeSlug?.includes(teamSlug);
    const goalsFor = isHome ? match.homeScore : match.awayScore;
    const goalsAgainst = isHome ? match.awayScore : match.homeScore;
    acc.wins += goalsFor > goalsAgainst ? 1 : 0;
    acc.draws += goalsFor === goalsAgainst ? 1 : 0;
    acc.losses += goalsFor < goalsAgainst ? 1 : 0;
    acc.goalsFor += goalsFor;
    acc.goalsAgainst += goalsAgainst;
    acc.cleanSheets += goalsAgainst === 0 ? 1 : 0;
    acc.failedToScore += goalsFor === 0 ? 1 : 0;
    acc.btts += goalsFor > 0 && goalsAgainst > 0 ? 1 : 0;
    acc.over25 += goalsFor + goalsAgainst > 2 ? 1 : 0;
    return acc;
  }, { wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0, cleanSheets: 0, failedToScore: 0, btts: 0, over25: 0 });
  const played = sample.length;
  return {
    played,
    ...totals,
    winRate: played ? Number(((totals.wins / played) * 100).toFixed(1)) : undefined,
    avgGoalsFor: played ? Number((totals.goalsFor / played).toFixed(2)) : undefined,
    avgGoalsAgainst: played ? Number((totals.goalsAgainst / played).toFixed(2)) : undefined,
    bttsRate: played ? Number(((totals.btts / played) * 100).toFixed(1)) : undefined,
    over25Rate: played ? Number(((totals.over25 / played) * 100).toFixed(1)) : undefined,
    under25Rate: played ? Number((((played - totals.over25) / played) * 100).toFixed(1)) : undefined,
    matches: sample,
  };
}

function extractValue(snapshot: OgolPageSnapshot | undefined, labels: RegExp[]) {
  if (!snapshot) return undefined;
  const pair = snapshot.keyValues.find((item) => labels.some((pattern) => pattern.test(normalized(item.label))));
  if (pair?.value) return pair.value;
  const lineIndex = snapshot.textLines.findIndex((line) => labels.some((pattern) => pattern.test(normalized(line))));
  if (lineIndex >= 0) {
    const sameLine = snapshot.textLines[lineIndex].match(/:\s*(.+)$/)?.[1];
    if (sameLine) return sameLine.trim();
    const next = snapshot.textLines.slice(lineIndex + 1, lineIndex + 4).find((line) => line && !labels.some((pattern) => pattern.test(normalized(line))));
    if (next) return next;
  }
  for (const [heading, text] of Object.entries(snapshot.sections)) {
    if (labels.some((pattern) => pattern.test(normalized(heading)))) return text;
  }
  return undefined;
}

function teamSummary(profile: OgolPageSnapshot | undefined, histories: Array<OgolPageSnapshot | undefined>, teamName: string) {
  const teamSlug = slug(teamName);
  const validHistories = histories.filter((history): history is OgolPageSnapshot => Boolean(history));
  const matches = [...new Map(
    (validHistories.length ? validHistories : profile ? [profile] : [])
      .flatMap((history) => parseHistoricalMatches(history))
      .map((match) => [match.id, match]),
  ).values()].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return {
    name: teamName,
    profileUrl: profile?.url,
    historyUrls: validHistories.map((history) => history.url),
    recent: {
      last5: aggregateMatches(matches, teamSlug, 5),
      last10: aggregateMatches(matches, teamSlug, 10),
      last20: aggregateMatches(matches, teamSlug, 20),
      home: aggregateMatches(matches, teamSlug, 20, 'home'),
      away: aggregateMatches(matches, teamSlug, 20, 'away'),
    },
    coach: extractValue(profile, [/tecnico|treinador/]),
    averageAge: extractValue(profile, [/idade media/]),
    squadValue: extractValue(profile, [/valor do elenco|valor de mercado/]),
    tablePosition: extractValue(profile, [/classificacao|posicao/]),
    injuries: Object.entries(profile?.sections || {}).filter(([heading]) => /lesion|desfalque/i.test(normalized(heading))).map(([, text]) => text),
    suspensions: Object.entries(profile?.sections || {}).filter(([heading]) => /suspens/i.test(normalized(heading))).map(([, text]) => text),
    currentSequence: profile?.statisticBlocks.filter((block) => /forma|sequencia|ultimos/i.test(normalized(`${block.label} ${block.section}`))).slice(0, 20),
    allTables: [...(profile?.tables || []), ...validHistories.flatMap((history) => history.tables)],
    allStatistics: [...(profile?.statisticBlocks || []), ...validHistories.flatMap((history) => history.statisticBlocks)],
  };
}

export function playerSummary(snapshot: OgolPageSnapshot, lineup?: OgolPageLink) {
  const number = (patterns: RegExp[]) => {
    const value = extractValue(snapshot, patterns);
    const parsed = Number(String(value || '').replace(',', '.').match(/-?\d+(?:\.\d+)?/)?.[0]);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const seasonTable = snapshot.tables.find((table) =>
    table.headers.includes('J') && table.headers.includes('M') && table.headers.some((header) => /GM|GOLS/i.test(header))
  );
  const totalRow = seasonTable?.rows.find((row) => normalized(row[0]) === 'total') || seasonTable?.rows.at(-1);
  const headerIndex = (patterns: RegExp[]) => seasonTable?.headers.findIndex((header) => patterns.some((pattern) => pattern.test(normalized(header)))) ?? -1;
  const totalRowOffset = totalRow && seasonTable ? Math.max(0, totalRow.length - seasonTable.headers.length) : 0;
  const rowNumber = (index: number) => index >= 0 && totalRow ? Number(String(totalRow[index + totalRowOffset]).replace(',', '.')) : undefined;
  const appearances = rowNumber(headerIndex([/^j$/, /jogos/]));
  const minutes = rowNumber(headerIndex([/^m$/, /minutos/]));
  const goals = rowNumber(headerIndex([/^gm$/, /^g$/, /gols/]));
  const assists = rowNumber(headerIndex([/^ass$/, /assist/]));
  const recentTable = snapshot.tables.find((table) => table.rows.some((row) => row.some((cell) => /^\d{1,2}-\d{1,2}$/.test(cell))));
  const recentMatches = (recentTable?.rows || []).slice(0, 10).map((row) => {
    const rating = Number(row.find((cell) => /^\d[.,]\d$/.test(cell))?.replace(',', '.'));
    const minuteText = row.find((cell) => /\d+['´]/.test(cell));
    return {
      result: row[0],
      date: row[1],
      score: row.find((cell) => /^\d{1,2}-\d{1,2}$/.test(cell)),
      minutes: Number(minuteText?.match(/\d+/)?.[0]) || undefined,
      rating: Number.isFinite(rating) ? rating : undefined,
      row,
    };
  });
  const ratings = recentMatches.map((match) => match.rating).filter((value): value is number => value !== undefined);
  const wins = recentMatches.filter((match) => /^v$/i.test(match.result)).length;
  const extractedPosition = extractValue(snapshot, [/posicao/]);
  const position = /goleiro|defensor|zagueiro|lateral|meio|meia|volante|atacante|ponta|avancado/i.test(normalized(extractedPosition))
    ? extractedPosition
    : undefined;
  const age = number([/idade/]);
  return {
    name: lineup?.text || snapshot.title.split('::')[0].trim(),
    url: snapshot.url,
    lineupRole: /suplente|reserva|banco/i.test(normalized(lineup?.context)) ? 'reserva' : 'provavel titular',
    position,
    age,
    appearances,
    minutes: minutes ?? number([/minutos/]),
    goals: goals ?? number([/^gols?$/]),
    assists: assists ?? number([/assistencias/]),
    cards: extractValue(snapshot, [/cartoes|amarelos|vermelhos/]),
    averageRating: ratings.length ? Number((ratings.reduce((total, value) => total + value, 0) / ratings.length).toFixed(2)) : number([/nota media|classificacao media|rating/]),
    consecutiveMatches: recentMatches.length || number([/partidas consecutivas|jogos consecutivos/]),
    recentForm: recentMatches.map((match) => match.result).filter(Boolean).join(''),
    recentMatches,
    goalParticipation: appearances ? Number((((goals || 0) + (assists || 0)) / appearances).toFixed(3)) : undefined,
    efficiency: recentMatches.length ? Number(((wins / recentMatches.length) * 100).toFixed(1)) : undefined,
    keyValues: snapshot.keyValues,
    tables: snapshot.tables,
    statistics: snapshot.statisticBlocks,
  };
}

function h2hSummary(snapshot: OgolPageSnapshot | undefined, homeTeam: string, awayTeam: string) {
  if (!snapshot) return undefined;
  const matches = parseHistoricalMatches(snapshot);
  const homeSlug = slug(homeTeam);
  const awaySlug = slug(awayTeam);
  const relevant = matches.filter((match) =>
    (match.homeSlug?.includes(homeSlug) || match.awaySlug?.includes(homeSlug))
    && (match.homeSlug?.includes(awaySlug) || match.awaySlug?.includes(awaySlug))
  );
  const totals = relevant.reduce((acc, match) => {
    const homeIsFirstTeam = match.homeSlug?.includes(homeSlug);
    const firstGoals = homeIsFirstTeam ? match.homeScore : match.awayScore;
    const secondGoals = homeIsFirstTeam ? match.awayScore : match.homeScore;
    acc.homeWins += firstGoals > secondGoals ? 1 : 0;
    acc.awayWins += firstGoals < secondGoals ? 1 : 0;
    acc.draws += firstGoals === secondGoals ? 1 : 0;
    acc.goals += firstGoals + secondGoals;
    acc.btts += firstGoals > 0 && secondGoals > 0 ? 1 : 0;
    acc.over25 += firstGoals + secondGoals > 2 ? 1 : 0;
    return acc;
  }, { homeWins: 0, awayWins: 0, draws: 0, goals: 0, btts: 0, over25: 0 });
  const played = relevant.length;
  return {
    played,
    ...totals,
    avgGoals: played ? Number((totals.goals / played).toFixed(2)) : undefined,
    bttsRate: played ? Number(((totals.btts / played) * 100).toFixed(1)) : undefined,
    over25Rate: played ? Number(((totals.over25 / played) * 100).toFixed(1)) : undefined,
    under25Rate: played ? Number((((played - totals.over25) / played) * 100).toFixed(1)) : undefined,
    matches: relevant.slice(0, 20),
    avgCorners: extractValue(snapshot, [/media de escanteios|escanteios/]),
    avgCards: extractValue(snapshot, [/media de cartoes|cartoes/]),
    firstGoal: extractValue(snapshot, [/primeiro gol/]),
    allTables: snapshot.tables,
    allStatistics: snapshot.statisticBlocks,
  };
}

async function safeSnapshot(page: Page, type: string, url: string): Promise<PageRecord> {
  try {
    await loadOgolPage(page, url);
    return { type, url, status: 'ok', snapshot: await snapshotOgolPage(page, type) };
  } catch (error) {
    return { type, url, status: 'error', error: error instanceof Error ? error.message : String(error) };
  }
}

function deriveTeamHistoryUrl(teamUrl: string) {
  const url = new URL(teamUrl);
  url.search = '';
  return `${url.toString().replace(/\/$/, '')}/todos-os-jogos`;
}

function derivePreviousSeasonUrl(historyUrl: string, snapshot?: OgolPageSnapshot) {
  const years = [snapshot?.title || '', ...(snapshot?.headings || []), ...(snapshot?.links || []).map((link) => link.href)]
    .flatMap((value) => [...String(value).matchAll(/(?:ano=|\b)(20\d{2})\b/g)].map((match) => Number(match[1])))
    .filter((value) => Number.isFinite(value));
  const currentYear = years.length ? Math.max(...years) : new Date().getFullYear();
  const url = new URL(historyUrl);
  url.search = '';
  url.searchParams.set('ano', String(currentYear - 1));
  url.searchParams.set('grp', '1');
  return url.toString();
}

async function collectDeepData(eventId: string, matchUrl: string, homeTeam?: string, awayTeam?: string) {
  if (!OGOL_DEEP_ENRICHMENT) return { available: false, reason: 'OGOL_DEEP_ENRICHMENT=false', eventId };

  return withOgolPage(async (page) => {
    const records: PageRecord[] = [];
    const seen = new Set<string>();
    const collect = async (type: string, url?: string) => {
      if (!url || seen.has(url) || records.length >= OGOL_DEEP_PAGE_LIMIT) return undefined;
      seen.add(url);
      const record = await safeSnapshot(page, type, absoluteOgolUrl(url));
      records.push(record);
      return record.snapshot;
    };

    const match = await collect('match', matchUrl);
    if (!match) {
      return { available: false, eventId, pages: records, errors: records.filter((record) => record.status === 'error') };
    }
    const links = uniqueLinks(match.links);
    const sameMatchLinks = links.filter((link) => link.href.includes(String(eventId)));
    const matchRelated = sameMatchLinks.filter((link) => /\/performance|\/resumo|\/odds|\/arbitro|\/estadio|\/noticias|\/videos|\/fotografias|match_player_stats\.php/i.test(link.href));
    for (const link of matchRelated) {
      const type = /performance/.test(link.href) ? 'match-performance'
        : /resumo/.test(link.href) ? 'match-summary'
          : /odds/.test(link.href) ? 'match-odds'
            : /arbitro/.test(link.href) ? 'match-referee'
            : /estadio/.test(link.href) ? 'match-stadium'
                : /noticias/.test(link.href) ? 'match-news'
                  : /videos/.test(link.href) ? 'match-videos'
                    : /fotografias/.test(link.href) ? 'match-photos'
                : 'match-player-statistics';
      await collect(type, link.href);
    }

    const h2hLink = pickLink(links.filter((link) => /\/estatisticas\//i.test(link.href)), [/historico de confrontos|confrontos|h2h/]);
    const h2h = await collect('head-to-head', h2hLink?.href);

    const teamLinks = uniqueLinks(links.filter((link) => /\/(?:equipe|equipa|time)\/[^/?#]+/i.test(link.href)))
      .filter((link) => /time |equipe |mandante|visitante|classificacoes|escalacoes/i.test(normalized(`${link.text} ${link.section} ${link.context}`)))
      .slice(0, 2);
    const resolvedHome = homeTeam || teamLinks[0]?.text.replace(/^time\s+/i, '') || 'home';
    const resolvedAway = awayTeam || teamLinks[1]?.text.replace(/^time\s+/i, '') || 'away';
    const homeProfile = await collect('home-team', teamLinks[0]?.href);
    const awayProfile = await collect('away-team', teamLinks[1]?.href);
    const homeHistoryUrl = teamLinks[0]?.href ? deriveTeamHistoryUrl(teamLinks[0].href) : undefined;
    const awayHistoryUrl = teamLinks[1]?.href ? deriveTeamHistoryUrl(teamLinks[1].href) : undefined;
    const homeHistory = await collect('home-team-history', homeHistoryUrl);
    const awayHistory = await collect('away-team-history', awayHistoryUrl);
    const homePreviousHistory = await collect('home-team-history-previous', homeHistoryUrl ? derivePreviousSeasonUrl(homeHistoryUrl, homeHistory) : undefined);
    const awayPreviousHistory = await collect('away-team-history-previous', awayHistoryUrl ? derivePreviousSeasonUrl(awayHistoryUrl, awayHistory) : undefined);

    const competitionLink = pickLink(
      links.filter((link) => /\/(?:edicao|competicao)\//i.test(link.href)),
      [/competicao/, /copa do mundo|campeonato|liga|serie/, /classificacao/],
    );
    const competition = await collect('competition', competitionLink?.href);

    const lineupLinks = match.playerBlocks
      .filter((block) => block.href && block.name)
      .map((block) => ({ text: block.name!, href: block.href!, context: block.text, section: block.section }));
    const playerLinks = uniqueLinks([
      ...lineupLinks,
      ...links.filter((link) => /\/jogador\/[^/]+\/\d+/.test(link.href)),
    ])
      .map((link) => ({
        link,
        score: (lineupLinks.some((lineup) => lineup.href === link.href) ? 10 : 0)
          + linkScore(link, [/escalacoes/, /classificacoes dos jogadores/, /estatisticas jogador/, /titular/]),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, OGOL_DEEP_PLAYER_LIMIT);
    const playerSnapshots: Array<{ link: OgolPageLink; snapshot: OgolPageSnapshot }> = [];
    for (const item of playerLinks) {
      const snapshot = await collect('player', item.link.href);
      if (snapshot) playerSnapshots.push({ link: item.link, snapshot });
    }

    const matchPages = records.filter((record) => record.type.startsWith('match-') && record.snapshot).map((record) => record.snapshot!);
    const dynamicStatistics = [match, ...matchPages].flatMap((snapshot) => snapshot.statisticBlocks);
    const allTables = [match, ...matchPages].flatMap((snapshot) => snapshot.tables);
    const allEvents = [match, ...matchPages].flatMap((snapshot) => snapshot.eventBlocks);
    const matchInfo = {
      competition: extractValue(match, [/competicao/]),
      round: extractValue(match, [/rodada|fase/]),
      date: extractValue(match, [/data/]) || matchUrl.match(/\/jogo\/(\d{4}-\d{2}-\d{2})/)?.[1],
      time: extractValue(match, [/hora|horario/]),
      stadium: extractValue(match, [/estadio/]),
      city: extractValue(match, [/cidade|local/]),
      referee: extractValue(match, [/arbitro/]),
      attendance: extractValue(match, [/publico|espectadores/]),
      weather: extractValue(match, [/clima|tempo/]),
      broadcast: extractValue(match, [/transmissao|televisao|tv/]),
      score: match.headings[0],
      minute: extractValue(match, [/minuto|tempo de jogo/]),
      odds: records.find((record) => record.type === 'match-odds')?.snapshot?.tables || [],
      events: allEvents,
      statistics: dynamicStatistics,
      tables: allTables,
    };
    const home = teamSummary(homeProfile, [homeHistory, homePreviousHistory], resolvedHome);
    const away = teamSummary(awayProfile, [awayHistory, awayPreviousHistory], resolvedAway);
    const headToHead = h2hSummary(h2h, resolvedHome, resolvedAway);
    const players = playerSnapshots.map(({ link, snapshot }) => playerSummary(snapshot, link));

    return {
      available: true,
      source: 'ogol',
      eventId,
      collectedAt: new Date().toISOString(),
      coverage: {
        pagesAttempted: records.length,
        pagesCollected: records.filter((record) => record.status === 'ok').length,
        pagesFailed: records.filter((record) => record.status === 'error').length,
        playerProfiles: players.length,
        dynamicStatisticBlocks: dynamicStatistics.length,
        tables: records.reduce((total, record) => total + (record.snapshot?.tables.length || 0), 0),
      },
      analysisReady: {
        match: matchInfo,
        teams: { home, away },
        headToHead,
        competition: competition ? {
          url: competition.url,
          keyValues: competition.keyValues,
          standingsAndCampaign: competition.tables,
          statistics: competition.statisticBlocks,
        } : undefined,
        players,
      },
      pages: records,
      errors: records.filter((record) => record.status === 'error').map(({ type, url, error }) => ({ type, url, error })),
    };
  });
}

export function fetchOgolDeepData(eventId: number | string, matchUrl: string, homeTeam?: string, awayTeam?: string) {
  const key = String(eventId);
  const cached = deepCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  const promise = (async () => {
    const disk = await readDeepDiskCache(key);
    if (disk) return disk;
    const staleDisk = await readDeepDiskCache(key, true);
    const result = await withDeepCollectionSlot(() => collectDeepData(key, matchUrl, homeTeam, awayTeam));
    const stalePages = Number(staleDisk?.coverage?.pagesCollected || 0);
    const collectedPages = Number(result?.coverage?.pagesCollected || 0);
    if (staleDisk?.available && stalePages > collectedPages) {
      return {
        ...staleDisk,
        cache: {
          staleFallback: true,
          rejectedCollectionPages: collectedPages,
          reason: 'The latest OGOL collection was less complete than the cached version.',
        },
      };
    }
    if (result?.available) await writeDeepDiskCache(key, result);
    return result;
  })().catch((error) => ({
      available: false,
      source: 'ogol',
      eventId: key,
      reason: error instanceof Error ? error.message : String(error),
    }));
  deepCache.set(key, { expiresAt: Date.now() + OGOL_DEEP_CACHE_TTL_MS, promise });
  return promise;
}
