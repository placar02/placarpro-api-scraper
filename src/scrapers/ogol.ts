import { chromium, type Browser, type Page } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { NormalizedEvent } from '../types/event';
import type { EventLive } from '../types/event.live';

const BASE_URL = (process.env.OGOL_BASE_URL || 'https://www.ogol.com.br').replace(/\/+$/, '');
const AGENDA_URL = process.env.OGOL_AGENDA_URL || `${BASE_URL}/agenda.php`;
const REQUEST_TIMEOUT_MS = Number(process.env.OGOL_REQUEST_TIMEOUT_MS || 30000);
const CACHE_TTL_MS = Number(process.env.OGOL_CACHE_TTL_MS || 10 * 60 * 1000);
const MATCH_LIMIT = Number(process.env.OGOL_MATCH_LIMIT || 30);
const DISK_CACHE_PATH = process.env.OGOL_DISK_CACHE_PATH || path.join('C:\\tmp', 'placarpro-ogol-matches.json');
const OGOL_PROXY_URL = process.env.OGOL_PROXY_URL || '';
const OGOL_PROXY_USERNAME = process.env.OGOL_PROXY_USERNAME || '';
const OGOL_PROXY_PASSWORD = process.env.OGOL_PROXY_PASSWORD || '';
const OGOL_HEADLESS = process.env.OGOL_HEADLESS !== 'false';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

type OgolMatch = {
  id: number;
  url: string;
  homeTeam: string;
  awayTeam: string;
  tournamentName?: string;
  statusText?: string;
  date?: string;
  time?: string;
  homeScore?: number;
  awayScore?: number;
  odds?: number[];
};

type OgolEventDetails = {
  match: OgolMatch;
  title?: string;
  text: string;
  sections: Record<string, string>;
  anchors: Array<{ text: string; href: string }>;
  entities?: {
    players: OgolEntityLink[];
    referees: OgolEntityLink[];
  };
  context?: Record<string, unknown>;
};

type OgolEntityLink = {
  name: string;
  href: string;
  context: string;
  contexts?: string[];
  sectionTitle?: string;
  sideHint?: 'home' | 'away';
};

const matchCache = new Map<string, { expiresAt: number; promise: Promise<{ status: number; events: EventLive[]; raw: any }> }>();
const detailsCache = new Map<string, { expiresAt: number; promise: Promise<OgolEventDetails | null> }>();
const refereeProfileCache = new Map<string, { expiresAt: number; promise: Promise<Record<string, unknown>> }>();

async function readDiskCache() {
  try {
    const text = await fs.readFile(DISK_CACHE_PATH, 'utf8');
    const parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
    return Array.isArray(parsed?.matches) ? parsed : null;
  } catch {
    return null;
  }
}

async function writeDiskCache(payload: any) {
  try {
    const previous = await readDiskCache();
    if (Array.isArray(previous?.matches) && Array.isArray(payload?.matches)) {
      const byId = new Map<number, any>();
      for (const match of previous.matches) {
        const id = Number(match?.id);
        if (id) byId.set(id, match);
      }
      for (const match of payload.matches) {
        const id = Number(match?.id);
        if (id) byId.set(id, { ...(byId.get(id) || {}), ...match });
      }
      payload = {
        ...payload,
        previousCachedAt: previous.cachedAt,
        matches: [...byId.values()],
      };
    }

    await fs.mkdir(path.dirname(DISK_CACHE_PATH), { recursive: true });
    await fs.writeFile(DISK_CACHE_PATH, JSON.stringify(payload, null, 2), 'utf8');
  } catch (err) {
    console.warn('[OGOL] Could not write disk cache:', err instanceof Error ? err.message : String(err));
  }
}

function toSlug(value?: string) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeText(value: unknown) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toNumber(value: unknown) {
  const parsed = Number(String(value ?? '').replace(',', '.').replace(/\s+/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseEventIdFromUrl(url: string) {
  const match = String(url).match(/\/(\d+)(?:[/?#]|$)/);
  return match ? Number(match[1]) : 0;
}

function parseEntityIdFromUrl(url: string) {
  const ids = String(url).match(/\d+/g);
  return ids?.length ? Number(ids.at(-1)) : 0;
}

function cleanEntityName(value: string) {
  const lines = linesFrom(value).filter((line) =>
    !/^\d+$/.test(line)
    && !/^(jogador|arbitro|árbitro|perfil|ver mais)$/i.test(line)
  );
  return lines[0] || String(value || '').replace(/\s+/g, ' ').trim();
}

function absoluteUrl(href: string) {
  try {
    return new URL(href, BASE_URL).toString();
  } catch {
    return href;
  }
}

function dateToBrazilTimestamp(date?: string, time?: string) {
  if (!date) return 0;
  const safeTime = /^\d{1,2}:\d{2}$/.test(String(time || '')) ? time : '12:00';
  const parsed = Date.parse(`${date}T${safeTime}:00-03:00`);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

function localDateKey(offsetDays = 0) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.MATCHES_TIMEZONE || 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return formatter.format(date);
}

function normalizeStatus(match: OgolMatch) {
  const status = String(match.statusText || '').toLowerCase();
  if (status.includes('ft') || status.includes('final') || status.includes('encerr')) {
    return { code: 100, description: 'Finalizado', type: 'finished' };
  }
  if (/^\d{1,3}'/.test(status) || status.includes('intervalo') || status.includes('live')) {
    return { code: 6, description: match.statusText || 'Em andamento', type: 'inprogress' };
  }
  return { code: 0, description: match.statusText || 'Programado', type: 'notstarted' };
}

function teamId(name: string) {
  let hash = 0;
  for (const char of toSlug(name)) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return Math.abs(hash) || 0;
}

function toEventLive(match: OgolMatch): EventLive {
  const status = normalizeStatus(match);
  const timestamp = dateToBrazilTimestamp(match.date, match.time);
  const homeId = teamId(match.homeTeam);
  const awayId = teamId(match.awayTeam);

  return {
    id: match.id,
    customId: String(match.id),
    slug: `${toSlug(match.homeTeam)}-${toSlug(match.awayTeam)}-${match.id}`,
    startTimestamp: timestamp,
    lastPeriod: '',
    finalResultOnly: false,
    feedLocked: false,
    isEditor: false,
    tournament: {
      id: teamId(match.tournamentName || 'ogol'),
      name: match.tournamentName || 'OGOL',
      slug: toSlug(match.tournamentName || 'ogol'),
      category: {} as any,
    },
    season: {
      id: Number(match.date?.slice(0, 4)) || new Date().getFullYear(),
      name: match.date?.slice(0, 4) || String(new Date().getFullYear()),
      year: match.date?.slice(0, 4) || String(new Date().getFullYear()),
      editor: false,
    },
    roundInfo: { round: 0 },
    status,
    homeTeam: {
      id: homeId,
      name: match.homeTeam,
      slug: toSlug(match.homeTeam),
      shortName: match.homeTeam,
    } as any,
    awayTeam: {
      id: awayId,
      name: match.awayTeam,
      slug: toSlug(match.awayTeam),
      shortName: match.awayTeam,
    } as any,
    homeScore: {
      current: match.homeScore ?? 0,
      display: match.homeScore ?? 0,
      period1: 0,
      period2: 0,
      normaltime: match.homeScore ?? 0,
    },
    awayScore: {
      current: match.awayScore ?? 0,
      display: match.awayScore ?? 0,
      period1: 0,
      period2: 0,
      normaltime: match.awayScore ?? 0,
    },
    time: {
      injuryTime1: 0,
      initial: 0,
      max: 90,
      extra: 0,
      currentPeriodStartTimestamp: status.type === 'inprogress' ? timestamp : 0,
    },
    hasEventPlayerStatistics: true,
    hasEventPlayerHeatMap: false,
    hasGlobalHighlights: false,
  };
}

function toNormalizedEvent(details: OgolEventDetails): NormalizedEvent {
  const match = details.match;
  const live = toEventLive(match);
  const context = (details.context || buildOgolContext(details)) as any;
  const venueMatch = details.text.match(/Estadio\s+([^\n]+)|Estádio\s+([^\n]+)/i);
  const refereeMatch = details.text.match(/Arbitro\s+([^\n]+)|Árbitro\s+([^\n]+)/i);
  const venue = (context?.venue?.name || venueMatch?.[1] || venueMatch?.[2] || 'Unknown').trim();
  const referee = (context?.referee?.name || refereeMatch?.[1] || refereeMatch?.[2] || 'Unknown').trim();

  return {
    id: match.id,
    slug: live.slug,
    status: live.status,
    tournament: {
      id: live.tournament.id,
      name: live.tournament.name,
      slug: live.tournament.slug,
    },
    season: {
      id: live.season.id,
      name: live.season.name,
      year: live.season.year,
    },
    round: 0,
    homeTeam: {
      id: live.homeTeam.id,
      name: live.homeTeam.name,
      slug: live.homeTeam.slug,
      shortName: live.homeTeam.shortName,
    },
    awayTeam: {
      id: live.awayTeam.id,
      name: live.awayTeam.name,
      slug: live.awayTeam.slug,
      shortName: live.awayTeam.shortName,
    },
    score: {
      home: live.homeScore.current,
      away: live.awayScore.current,
      homeDisplay: live.homeScore.display,
      awayDisplay: live.awayScore.display,
    },
    venue: {
      id: teamId(venue),
      name: venue,
      slug: toSlug(venue),
      city: '',
      capacity: toNumber(details.text.match(/Lotacao\s+([\d\s.]+)/i)?.[1]),
    },
    referee: {
      id: teamId(referee),
      name: referee,
      slug: toSlug(referee),
      games: context?.referee?.games,
      yellowCards: context?.referee?.yellowCards,
      redCards: context?.referee?.redCards,
      country: context?.referee?.country,
    },
    startTime: live.startTimestamp,
    currentTime: live.time.currentPeriodStartTimestamp,
    features: {
      hasXg: false,
      hasPlayerStats: true,
      hasHeatMap: false,
    },
  };
}

async function withPage<T>(handler: (page: Page) => Promise<T>) {
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({
      headless: OGOL_HEADLESS,
      proxy: OGOL_PROXY_URL
        ? {
          server: OGOL_PROXY_URL,
          username: OGOL_PROXY_USERNAME || undefined,
          password: OGOL_PROXY_PASSWORD || undefined,
        }
        : undefined,
    });
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      locale: 'pt-BR',
      timezoneId: process.env.MATCHES_TIMEZONE || 'America/Sao_Paulo',
      viewport: { width: 1365, height: 768 },
      extraHTTPHeaders: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
      },
    });
    const page = await context.newPage();
    return await handler(page);
  } finally {
    if (browser) await browser.close();
  }
}

async function loadPageText(page: Page, url: string) {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: REQUEST_TIMEOUT_MS });
  if (!response?.ok()) {
    throw new Error(`OGOL HTTP ${response?.status() || 'no-response'} for ${url}`);
  }
  await page.waitForTimeout(500);
  const bodyText = await page.locator('body').innerText().catch(() => '');
  if (/sorry, you have been blocked|unable to access ogol/i.test(bodyText)) {
    throw new Error(`OGOL blocked the automated request for ${url}`);
  }
}

function buildAgendaUrls(date?: string) {
  if (!date) return [`${BASE_URL}/jogos/hoje`, `${BASE_URL}/jogos`, AGENDA_URL, BASE_URL];
  const compact = date.replace(/-/g, '');
  return [
    `${BASE_URL}/jogos/hoje`,
    `${BASE_URL}/jogos`,
    `${AGENDA_URL}?data=${date}`,
    `${AGENDA_URL}?data=${compact}`,
    `${AGENDA_URL}?ano=${date.slice(0, 4)}&mes=${Number(date.slice(5, 7))}&dia=${Number(date.slice(8, 10))}`,
    AGENDA_URL,
  ];
}

function parseTeamsFromText(text: string) {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  const vsMatch = cleaned.match(/^(.+?)\s+vs\s+(.+)$/i);
  if (vsMatch) return { homeTeam: vsMatch[1].trim(), awayTeam: vsMatch[2].trim() };

  const scoreMatch = cleaned.match(/^(.+?)\s+(\d+)\s*[-x]\s*(\d+)\s+(.+)$/i);
  if (scoreMatch) {
    return {
      homeTeam: scoreMatch[1].trim(),
      awayTeam: scoreMatch[4].trim(),
      homeScore: Number(scoreMatch[2]),
      awayScore: Number(scoreMatch[3]),
    };
  }

  return null;
}

function parseTeamsFromDetails(title?: string, h1Text?: string) {
  const h1 = String(h1Text || '').replace(/\r/g, '').trim();
  const h1Vs = h1.match(/^(.+?)\s*\n\s*vs\s*\n\s*(.+)$/i) || h1.match(/^(.+?)\s+vs\s+(.+)$/i);
  if (h1Vs) return { homeTeam: h1Vs[1].trim(), awayTeam: h1Vs[2].trim() };

  const h1Score = h1.replace(/\n+/g, ' ').match(/^(.+?)\s+\d+\s*[-x]\s*\d+\s+(.+)$/i);
  if (h1Score) return { homeTeam: h1Score[1].trim(), awayTeam: h1Score[2].trim() };

  const titleScore = String(title || '').match(/^(.+?)\s+\d+\s*[x-]\s*\d+\s+(.+?)\s+::/i);
  if (titleScore) return { homeTeam: titleScore[1].trim(), awayTeam: titleScore[2].trim() };
  const titleMatch = String(title || '').match(/^(.+?)\s+x\s+(.+?)\s+::/i);
  if (titleMatch) return { homeTeam: titleMatch[1].trim(), awayTeam: titleMatch[2].trim() };

  return null;
}

function parseDateFromMatchUrl(url: string) {
  return String(url).match(/\/(?:jogo|ao-vivo)\/(\d{4}-\d{2}-\d{2})-/)?.[1];
}

function isAgendaNoiseToken(value: string) {
  const token = value.trim();
  if (!token) return true;
  if (/^\d{1,2}\.\d{2}$/.test(token)) return true;
  if (/^\d{1,2}\/\d{1,2}\s*-\s*\d{1,2}:\d{2}$/.test(token)) return true;
  if (/^(FT|INT|LIVE|ADI|ADJ|PEN|AET)$/i.test(token)) return true;
  if (/^(R\d+|[A-Z]{1,4}|[A-Z]\d|D\d|QF|SF)$/i.test(token)) return true;
  if (/^(odds|classificacoes|jogos|resultados)$/i.test(token)) return true;
  return false;
}

function parseAgendaMatchText(rawText: string, rawNearText: string, url: string, fallbackDate?: string): OgolMatch | null {
  const id = parseEventIdFromUrl(url);
  if (!id) return null;

  const text = String(rawText || rawNearText || '').replace(/\r/g, '\n');
  const tokens = text
    .split(/\n+/)
    .map((token) => token.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const dateToken = tokens.find((token) => /^\d{1,2}\/\d{1,2}\s*-\s*\d{1,2}:\d{2}$/.test(token));
  const time = dateToken?.match(/-\s*(\d{1,2}:\d{2})/)?.[1];
  const statusText = tokens.find((token) => /^(FT|INT|LIVE|ADI|ADJ|PEN|AET|\d{1,3}')$/i.test(token));
  const scoreIndexes = tokens
    .map((token, index) => (/^\d{1,2}$/.test(token) ? index : -1))
    .filter((index) => index >= 0);

  let homeTeam = '';
  let awayTeam = '';
  let homeScore: number | undefined;
  let awayScore: number | undefined;

  if (scoreIndexes.length >= 2) {
    const firstScoreIndex = scoreIndexes[0];
    const secondScoreIndex = scoreIndexes[1];
    homeTeam = tokens[firstScoreIndex - 1] || '';
    awayTeam = tokens[secondScoreIndex - 1] || tokens[secondScoreIndex + 1] || '';
    homeScore = Number(tokens[firstScoreIndex]);
    awayScore = Number(tokens[secondScoreIndex]);
  } else {
    const teamTokens = tokens.filter((token) => !isAgendaNoiseToken(token));
    homeTeam = teamTokens.at(-2) || '';
    awayTeam = teamTokens.at(-1) || '';
  }

  const fallbackTeams = !homeTeam || !awayTeam ? parseTeamsFromText(rawText) : null;
  if (fallbackTeams) {
    homeTeam = fallbackTeams.homeTeam;
    awayTeam = fallbackTeams.awayTeam;
    homeScore = fallbackTeams.homeScore;
    awayScore = fallbackTeams.awayScore;
  }

  if (!homeTeam || !awayTeam || homeTeam === awayTeam) return null;

  const odds = String(rawNearText || rawText || '')
    .match(/\b\d{1,2}\.\d{2}\b/g)
    ?.slice(0, 3)
    .map(Number);

  return {
    id,
    url: absoluteUrl(url),
    homeTeam,
    awayTeam,
    homeScore,
    awayScore,
    statusText,
    date: parseDateFromMatchUrl(url) || fallbackDate,
    time,
    odds,
  };
}

function parseTournamentFromTitle(title?: string) {
  const parts = String(title || '')
    .split('::')
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1] : undefined;
}

const OGOL_SECTION_HEADINGS = [
  'ODDS',
  'PROBABILIDADES',
  'PRÉ-JOGO',
  'ÚLTIMOS TITULARES',
  'DESFALQUES',
  'CONFRONTOS(TOTAL)',
  'ÚLTIMOS JOGOS(TOTAL)',
  'ESTATÍSTICAS',
  'FATOS',
  'COMENTÁRIOS',
  'INFORMAÇÃO DO JOGO',
  'ENQUETE',
  'PALPITE',
  'GRUPO',
  'ESTAVA NO ESTÁDIO?',
  'COMPETIÇÃO',
  'ÁRBITROS',
  'ESTÁDIO',
  'NOTÍCIAS',
  'APOSTAS',
];

function normalizeSectionKey(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();
}

function extractKnownSections(text: string) {
  const sections: Record<string, string> = {};
  const lines = String(text || '').replace(/\r/g, '\n').split('\n');
  const headings: Array<{ index: number; key: string; original: string }> = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    const normalized = normalizeSectionKey(line);
    const match = OGOL_SECTION_HEADINGS.find((heading) => {
      const normalizedHeading = normalizeSectionKey(heading);
      return normalized === normalizedHeading
        || normalized.startsWith(`${normalizedHeading} `)
        || normalized.startsWith(`${normalizedHeading}(`);
    });
    if (match) headings.push({ index, key: match, original: line });
  }

  for (let index = 0; index < headings.length; index += 1) {
    const current = headings[index];
    const next = headings[index + 1]?.index ?? Math.min(lines.length, current.index + 90);
    const content = lines.slice(current.index, next).join('\n').trim();
    if (content.length > (sections[current.original]?.length || 0)) {
      sections[current.original] = content;
    }
    if (content.length > (sections[current.key]?.length || 0)) {
      sections[current.key] = content;
    }
  }

  return sections;
}

function sectionByName(sections: Record<string, string>, pattern: RegExp) {
  return Object.entries(sections).find(([key]) => pattern.test(key))?.[1] || '';
}

function linesFrom(value: string) {
  return String(value || '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function valueAfterLabel(text: string, label: RegExp) {
  const lines = linesFrom(text);
  const index = lines.findIndex((line) => label.test(line));
  return index >= 0 ? lines[index + 1] : undefined;
}

function parseVenueContext(text: string, sections: Record<string, string>) {
  const info = sectionByName(sections, /INFORMA/i);
  const venue = valueAfterLabel(info, /^EST[ÁA]DIO$/i) || valueAfterLabel(sectionByName(sections, /^EST[ÁA]DIO$/i), /^EST[ÁA]DIO$/i);
  const infoLines = linesFrom(info);
  const venueIndex = infoLines.findIndex((line) => /^EST[ÁA]DIO$/i.test(line));
  const city = venueIndex >= 0 ? infoLines[venueIndex + 2] : undefined;

  return {
    name: venue,
    city: city && !/^ÁRBITRO|TRANSMISS/i.test(city) ? city : undefined,
  };
}

function parseRefereeContext(text: string, sections: Record<string, string>, anchors: Array<{ text: string; href: string }>) {
  const info = sectionByName(sections, /INFORMA/i);
  const name = valueAfterLabel(info, /^ÁRBITRO$/i) || valueAfterLabel(sectionByName(sections, /ÁRBITROS/i), /^Árbitro$/i);
  const anchor = anchors.find((item) =>
    (name && normalizeText(item.text).includes(normalizeText(name)))
    || /\/arbitro\/|referee\.php/i.test(item.href)
  );
  const anchorName = anchor?.text
    ?.split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line && !/^ÁRBITRO$/i.test(line))
    .at(-1);

  return {
    name: name || anchorName,
    href: anchor?.href,
    cardsAverage: undefined,
    note: name || anchorName
      ? 'OGOL identificou o árbitro, mas a média de cartões não apareceu no HTML público da partida.'
      : 'Árbitro não identificado no HTML público recebido.',
  };
}

function profileNumber(text: string, labels: string[]) {
  for (const label of labels) {
    const escaped = escapeRegExp(label);
    const after = text.match(new RegExp(`${escaped}\\s*[:\\-]?\\s*(\\d+)`, 'i'))?.[1];
    const before = text.match(new RegExp(`(\\d+)\\s+${escaped}`, 'i'))?.[1];
    const value = toNumber(after || before);
    if (value > 0) return value;
  }
  return undefined;
}

function parseRefereeProfile(text: string, title: string) {
  const lines = linesFrom(text);
  const personalStart = lines.findIndex((line) => /^DADOS PESSOAIS$/i.test(line));
  const personalEnd = lines.findIndex((line, index) => index > personalStart && /^PR[ÓO]XIMOS JOGOS$/i.test(line));
  const personalLines = personalStart >= 0 ? lines.slice(personalStart, personalEnd > personalStart ? personalEnd : personalStart + 50) : [];
  const historyStart = lines.findIndex((line) => /^HIST[ÓO]RICO COMO [ÁA]RBITRO$/i.test(line));
  const historyEnd = lines.findIndex((line, index) => index > historyStart && /^COLABORA[CÇ][ÃA]O$/i.test(line));
  const historyLines = historyStart >= 0 ? lines.slice(historyStart, historyEnd > historyStart ? historyEnd : historyStart + 120) : [];
  const history = historyLines.join(' ');
  const games = profileNumber(history, ['Jogos arbitrados', 'Jogos dirigidos']);
  const yellowCards = profileNumber(history, ['Cartões amarelos']);
  const redCards = profileNumber(history, ['Cartões vermelhos']);
  const nationalityIndex = personalLines.findIndex((line) => /^NACIONALIDADE/i.test(line));
  const country = nationalityIndex >= 0 ? personalLines[nationalityIndex + 1] : undefined;
  const explicitAverage = history.match(/M[eé]dia\s+(?:de\s+)?cart[oõ]es\s*[:\-]?\s*([\d.,]+)/i)?.[1];
  const totalCards = Number(yellowCards || 0) + Number(redCards || 0);
  const cardsAverage = explicitAverage
    ? toNumber(explicitAverage)
    : games && totalCards
      ? Number((totalCards / games).toFixed(2))
      : undefined;

  return {
    profileTitle: title,
    games,
    yellowCards,
    redCards,
    cardsAverage,
    country,
    profileText: [...personalLines, ...historyLines].join(' ').slice(0, 1800),
  };
}

async function fetchRefereeProfile(page: Page, href?: string) {
  if (!href) return {};
  const cacheKey = absoluteUrl(href);
  const cached = refereeProfileCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;

  const promise = (async () => {
    try {
      await loadPageText(page, cacheKey);
      const profile = await page.evaluate(() => ({
        title: document.title,
        text: document.body.innerText,
      }));
      return parseRefereeProfile(profile.text, profile.title);
    } catch (err) {
      return {
        profileError: err instanceof Error ? err.message : String(err),
      };
    }
  })();

  refereeProfileCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, promise });
  return promise;
}

function parseCompetitionTable(section: string, homeTeam: string, awayTeam: string) {
  const lines = linesFrom(section);
  const rows = lines
    .map((line) => {
      const match = line.match(/^(\d+)\s+(.+?)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/);
      if (!match) return null;
      return {
        position: Number(match[1]),
        team: match[2],
        played: Number(match[3]),
        goalsFor: Number(match[4]),
        goalsAgainst: Number(match[5]),
        points: Number(match[6]),
      };
    })
    .filter(Boolean) as Array<{ position: number; team: string; played: number; goalsFor: number; goalsAgainst: number; points: number }>;

  const home = rows.find((row) => normalizeText(row.team) === normalizeText(homeTeam));
  const away = rows.find((row) => normalizeText(row.team) === normalizeText(awayTeam));
  const maxPlayed = Math.max(0, ...rows.map((row) => row.played));
  const topTwoCutoff = [...rows].sort((a, b) => b.points - a.points || (b.goalsFor - b.goalsAgainst) - (a.goalsFor - a.goalsAgainst))[1]?.points;
  const reading = (row?: typeof home) => {
    if (!row) return undefined;
    const outsideQualification = row.position > 2;
    const finalRoundLikely = maxPlayed >= 2;
    const mustWin = outsideQualification && finalRoundLikely;
    return {
      mustWin,
      pressure: mustWin ? 'alta' : outsideQualification ? 'media' : 'controlada',
      reason: mustWin
        ? `${row.team} está em ${row.position}º com ${row.points} pontos e precisa vencer para tentar classificação.`
        : `${row.team} está em ${row.position}º com ${row.points} pontos.`,
      pointsToSecond: typeof topTwoCutoff === 'number' ? Math.max(0, topTwoCutoff - row.points) : undefined,
    };
  };

  return {
    rows,
    home,
    away,
    homeReading: reading(home),
    awayReading: reading(away),
  };
}

function parseSeasonFacts(section: string) {
  const text = section.replace(/\s+/g, ' ').trim();
  return {
    text: text.slice(0, 1400),
    matches: toNumber(text.match(/(\d+)\s+Jogos/i)?.[1]),
    wins: toNumber(text.match(/(\d+)\s+Vit[oó]rias/i)?.[1]),
    draws: toNumber(text.match(/(\d+)\s+Empates/i)?.[1]),
    defeats: toNumber(text.match(/(\d+)\s+Derrotas/i)?.[1]),
    goalsFor: toNumber(text.match(/(\d+)\s*Gols\b/i)?.[1]),
    goalsAgainst: toNumber(text.match(/(\d+)\s*Gols Sofridos/i)?.[1]),
    goalsPerGame: toNumber(text.match(/([\d.,]+)\s+G\/J/i)?.[1]),
    form: text.match(/FORMA\s+([A-Z]+)/i)?.[1],
  };
}

function buildOgolContext(details: OgolEventDetails) {
  const sections = { ...extractKnownSections(details.text), ...details.sections };
  const group = sectionByName(sections, /^GRUPO/i);
  const stats = sectionByName(sections, /ESTAT.*FIFA|ESTAT.*WORLD/i) || sectionByName(sections, /ESTAT/i);
  const homeFacts = sectionByName(sections, new RegExp(`FATOS\\s+${escapeRegExp(details.match.homeTeam)}`, 'i'));
  const awayFacts = sectionByName(sections, new RegExp(`FATOS\\s+${escapeRegExp(details.match.awayTeam)}`, 'i'));

  return {
    venue: parseVenueContext(details.text, sections),
    referee: parseRefereeContext(details.text, sections, details.anchors),
    players: (details.entities?.players || []).slice(0, 36).map((player) => ({
      id: parseEntityIdFromUrl(player.href),
      name: player.name,
      href: player.href,
      side: player.sideHint,
      context: player.context.slice(0, 300),
    })),
    competitionTable: parseCompetitionTable(group, details.match.homeTeam, details.match.awayTeam),
    headToHead: sectionByName(sections, /CONFRONTOS/i).slice(0, 1000),
    competitionStatsText: stats.slice(0, 1800),
    seasonFacts: {
      home: parseSeasonFacts(homeFacts),
      away: parseSeasonFacts(awayFacts),
    },
    teamNeeds: {
      home: parseCompetitionTable(group, details.match.homeTeam, details.match.awayTeam).homeReading,
      away: parseCompetitionTable(group, details.match.homeTeam, details.match.awayTeam).awayReading,
    },
  };
}

function normalizeExtractedMatch(raw: any, fallbackDate?: string): OgolMatch | null {
  const id = parseEventIdFromUrl(raw.href);
  const teams = parseTeamsFromText(raw.text || '');
  if (!id || !teams?.homeTeam || !teams.awayTeam) return null;

  const odds = String(raw.nearText || '')
    .match(/\b\d{1,2}\.\d{2}\b/g)
    ?.slice(0, 3)
    .map(Number);

  return {
    id,
    url: absoluteUrl(raw.href),
    homeTeam: teams.homeTeam,
    awayTeam: teams.awayTeam,
    homeScore: teams.homeScore,
    awayScore: teams.awayScore,
    tournamentName: raw.tournamentName || undefined,
    statusText: raw.statusText || undefined,
    date: raw.date || fallbackDate,
    time: raw.time || undefined,
    odds,
  };
}

async function extractAgendaLinks(page: Page) {
  const extracted = await page.evaluate(() => {
    return [...document.querySelectorAll<HTMLAnchorElement>('a[href*="/jogo/"],a[href*="/ao-vivo/"]')]
      .map((anchor) => anchor.href);
  });

  const byId = new Map<number, string>();
  for (const href of extracted) {
    const id = parseEventIdFromUrl(href);
    if (id && !byId.has(id)) byId.set(id, absoluteUrl(href));
  }

  return [...byId.entries()]
    .map(([id, url]) => ({ id, url }))
    .slice(0, MATCH_LIMIT);
}

async function extractAgendaMatches(page: Page, fallbackDate?: string) {
  const extracted = await page.evaluate(() => {
    return [...document.querySelectorAll<HTMLAnchorElement>('a[href*="/jogo/"],a[href*="/ao-vivo/"]')]
      .map((anchor) => ({
        href: anchor.href,
        text: anchor.innerText || anchor.textContent || '',
        nearText: (anchor.closest('article,li,tr,section,div') as HTMLElement | null)?.innerText || '',
      }));
  });

  const byId = new Map<number, OgolMatch>();
  for (const raw of extracted) {
    const match = parseAgendaMatchText(raw.text, raw.nearText, raw.href, fallbackDate);
    if (match && !byId.has(match.id)) byId.set(match.id, match);
  }

  return [...byId.values()].slice(0, MATCH_LIMIT);
}

async function readMatchDetailsSummary(page: Page, url: string): Promise<OgolMatch | null> {
  await loadPageText(page, url);
  const data = await page.evaluate(() => ({
    title: document.title,
    h1: [...document.querySelectorAll('h1')].map((heading) => (heading as HTMLElement).innerText.trim())[0] || '',
    text: document.body.innerText,
  }));
  const id = parseEventIdFromUrl(url);
  const teams = parseTeamsFromDetails(data.title, data.h1);
  if (!id || !teams) return null;

  const odds = String(data.text || '')
    .match(/\b\d{1,2}\.\d{2}\b/g)
    ?.slice(0, 3)
    .map(Number);

  const match = {
    id,
    url: absoluteUrl(url),
    homeTeam: teams.homeTeam,
    awayTeam: teams.awayTeam,
    tournamentName: parseTournamentFromTitle(data.title),
    date: parseDateFromMatchUrl(url),
    odds,
  };

  detailsCache.set(String(id), {
    expiresAt: Date.now() + CACHE_TTL_MS,
    promise: Promise.resolve({
      match,
      title: data.title,
      text: data.text,
      sections: {},
      anchors: [],
    }),
  });

  return match;
}

async function hydrateAgendaMatches(page: Page, links: Array<{ id: number; url: string }>) {
  const matches: OgolMatch[] = [];

  for (const link of links) {
    try {
      const match = await readMatchDetailsSummary(page, link.url);
      if (match) matches.push(match);
    } catch (err) {
      console.warn(`[OGOL] Could not read match ${link.url}:`, err instanceof Error ? err.message : String(err));
    }
  }

  return matches;
}

async function findMatchById(eventId: number | string) {
  const id = Number(eventId);
  for (const key of [...matchCache.keys()]) {
    const cached = matchCache.get(key);
    if (!cached) continue;
    const response = await cached.promise.catch(() => null);
    const event = response?.events.find((item) => Number(item.id) === id);
    const raw = response?.raw?.matches?.find((item: OgolMatch) => Number(item.id) === id);
    if (event && raw) return raw as OgolMatch;
  }

  const dates = [
    undefined,
    localDateKey(0),
    localDateKey(-1),
    localDateKey(1),
  ];

  for (const date of dates) {
    const matches = await fetchOgolMatches(date);
    const match = matches.raw?.matches?.find((item: OgolMatch) => Number(item.id) === id);
    if (match) return match;
  }

  return null;
}

async function fetchOgolMatchesUncached(date?: string) {
  return withPage(async (page) => {
    let matches: OgolMatch[] = [];
    let urlUsed = '';
    const attempts: Array<{ url: string; status?: number; matches: number; error?: string }> = [];
    for (const url of buildAgendaUrls(date)) {
      try {
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: REQUEST_TIMEOUT_MS });
        const status = response?.status();
        await page.waitForTimeout(500);
        matches = await extractAgendaMatches(page, date);
        attempts.push({
          url,
          status,
          matches: matches.length,
          error: response?.ok() || matches.length ? undefined : `HTTP ${status || 'no-response'}`,
        });

        if (!response?.ok() && !matches.length) {
          continue;
        }
        urlUsed = url;
        if (matches.length) break;
      } catch (err) {
        attempts.push({
          url,
          matches: 0,
          error: err instanceof Error ? err.message : String(err),
        });
        console.warn(`[OGOL] Could not read agenda ${url}:`, err instanceof Error ? err.message : String(err));
      }
    }

    if (!matches.length) {
      const cached = await readDiskCache();
      if (cached?.matches?.length) {
        return {
          status: 200,
          raw: {
            source: 'ogol',
            stale: true,
            cachedAt: cached.cachedAt,
            url: cached.url,
            attempts,
            matches: cached.matches,
          },
          events: cached.matches.map(toEventLive),
        };
      }

      return {
        status: 503,
        raw: {
          source: 'ogol',
          url: urlUsed,
          attempts,
          matches: [],
          error: 'OGOL unavailable and no cached match list exists.',
        },
        events: [],
      };
    }

    await writeDiskCache({
      source: 'ogol',
      cachedAt: new Date().toISOString(),
      url: urlUsed,
      matches,
    });

    return {
      status: 200,
      raw: {
        source: 'ogol',
        url: urlUsed,
        matches,
      },
      events: matches.map(toEventLive),
    };
  });
}

export async function fetchOgolMatches(date?: string) {
  const cacheKey = `matches:${date || 'today'}`;
  const cached = matchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;

  const promise = fetchOgolMatchesUncached(date);
  matchCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, promise });
  return promise;
}

async function loadOgolDetails(eventId: number | string): Promise<OgolEventDetails | null> {
  const cached = detailsCache.get(String(eventId));
  if (cached && cached.expiresAt > Date.now()) return cached.promise;

  const promise = (async () => {
    const match = await findMatchById(eventId);
    if (!match?.url) return null;

    return withPage(async (page) => {
      await loadPageText(page, match.url);
      const data = await page.evaluate(() => {
        const headings = [...document.querySelectorAll('h1,h2,h3')].map((heading) => ({
          text: (heading as HTMLElement).innerText.trim(),
          node: heading,
        }));
        const sections: Record<string, string> = {};
        for (const heading of headings) {
          const section = heading.node.closest('section, article, div') as HTMLElement | null;
          const key = heading.text;
          if (key && section?.innerText) sections[key] = section.innerText.replace(/\s+\n/g, '\n').trim();
        }
        const entityLinks = [...document.querySelectorAll<HTMLAnchorElement>('a[href]')]
          .map((anchor) => {
            const container = anchor.closest('tr,li,article,section,[class*="player"],[class*="lineup"],[class*="equipa"],div') as HTMLElement | null;
            const section = anchor.closest('section,article') as HTMLElement | null;
            const rect = anchor.getBoundingClientRect();
            const contexts: string[] = [];
            let parent = anchor.parentElement;
            for (let depth = 0; parent && depth < 7; depth += 1, parent = parent.parentElement) {
              const parentText = parent.innerText.replace(/\s+/g, ' ').trim();
              if (parentText && parentText.length <= 2000 && !contexts.includes(parentText)) contexts.push(parentText);
            }
            return {
              name: anchor.innerText.trim(),
              href: anchor.href,
              context: (container?.innerText || anchor.innerText).replace(/\s+/g, ' ').trim().slice(0, 500),
              contexts,
              sectionTitle: (section?.querySelector('h1,h2,h3,h4') as HTMLElement | null)?.innerText?.trim(),
              sideHint: rect.left + rect.width / 2 < document.documentElement.clientWidth / 2 ? 'home' : 'away',
            };
          })
          .filter((item) => item.name && item.href);
        return {
          title: document.title,
          h1: [...document.querySelectorAll('h1')].map((heading) => (heading as HTMLElement).innerText.trim())[0] || '',
          text: document.body.innerText,
          sections,
          anchors: [...document.querySelectorAll<HTMLAnchorElement>('a[href]')].map((anchor) => ({
            text: anchor.innerText.trim(),
            href: anchor.href,
          })),
          entities: {
            players: entityLinks.filter((item) => /\/jogador(?:\/|\.php)|\/player\//i.test(item.href)),
            referees: entityLinks.filter((item) => /\/arbitro(?:\/|\.php)|referee\.php/i.test(item.href)),
          },
        };
      });
      const pageTeams = parseTeamsFromDetails(data.title, data.h1);
      const detailMatch = pageTeams
        ? {
          ...match,
          homeTeam: pageTeams.homeTeam,
          awayTeam: pageTeams.awayTeam,
          tournamentName: match.tournamentName || parseTournamentFromTitle(data.title),
          date: match.date || parseDateFromMatchUrl(match.url),
        }
        : match;
      const sections = {
        ...data.sections,
        ...extractKnownSections(data.text),
      };
      const inferSide = (entity: { context: string; contexts?: string[]; sideHint: string }) => {
        const contexts = [entity.context, ...(entity.contexts || [])];
        const home = normalizeText(detailMatch.homeTeam);
        const away = normalizeText(detailMatch.awayTeam);
        const teamContext = contexts.find((value) => {
          const normalized = normalizeText(value);
          return (normalized.includes(home) && !normalized.includes(away))
            || (normalized.includes(away) && !normalized.includes(home));
        });
        if (teamContext) return normalizeText(teamContext).includes(home) ? 'home' : 'away';
        return entity.sideHint as 'home' | 'away';
      };
      const usefulContext = (entity: { name: string; context: string; contexts?: string[] }) =>
        entity.contexts?.find((value) => value.length > entity.name.length && value.length < 1000) || entity.context;
      const baseDetails = {
        match: detailMatch,
        title: data.title,
        text: data.text,
        sections,
        anchors: data.anchors,
        entities: {
          players: data.entities.players.map((player) => ({
            ...player,
            name: cleanEntityName(player.name),
            context: usefulContext(player),
            sideHint: inferSide(player),
          })),
          referees: data.entities.referees.map((referee) => ({
            ...referee,
            name: cleanEntityName(referee.name),
            sideHint: referee.sideHint as 'home' | 'away',
          })),
        },
      };

      const context = buildOgolContext(baseDetails);
      const refereeContext = context.referee as Record<string, unknown> | undefined;
      const profile = await fetchRefereeProfile(page, String(refereeContext?.href || ''));

      return {
        ...baseDetails,
        context: {
          ...context,
          referee: {
            ...refereeContext,
            ...profile,
            note: Object.keys(profile).some((key) => ['games', 'yellowCards', 'redCards', 'cardsAverage'].includes(key) && profile[key] !== undefined)
              ? 'Perfil público do árbitro consultado no OGOL.'
              : refereeContext?.note,
          },
        },
      };
    });
  })();

  detailsCache.set(String(eventId), { expiresAt: Date.now() + CACHE_TTL_MS, promise });
  return promise;
}

async function loadOgolDetailsOrAgenda(eventId: number | string): Promise<OgolEventDetails | null> {
  try {
    return await loadOgolDetails(eventId);
  } catch (err) {
    const match = await findMatchById(eventId);
    if (!match) throw err;

    return {
      match,
      title: `${match.homeTeam} x ${match.awayTeam}`,
      text: '',
      sections: {},
      anchors: [],
      context: {},
    };
  }
}

export async function fetchOgolEvent(eventId: number | string) {
  let details: OgolEventDetails | null = null;
  try {
    details = await loadOgolDetailsOrAgenda(eventId);
  } catch (err) {
    throw err;
  }

  if (!details) {
    const matches = await fetchOgolMatches().catch((err) => ({
      status: 503,
      raw: {
        source: 'ogol',
        error: err instanceof Error ? err.message : String(err),
      },
      events: [],
    }));

    return {
      status: matches.status === 503 ? 503 : 404,
      raw: {
        requestedEventId: eventId,
        source: 'ogol',
        reason: matches.status === 503
          ? 'OGOL unavailable and no cached event data was found for this id.'
          : 'Event id was not found in the OGOL agenda/cache.',
        matches: matches.raw,
      },
    };
  }
  return {
    status: 200,
    data: toNormalizedEvent(details),
    raw: {
      source: 'ogol',
      url: details.match.url,
      title: details.title,
      match: details.match,
      context: details.context || buildOgolContext(details),
    },
  };
}

function createStatItem(key: string, name: string, homeValue: unknown, awayValue: unknown) {
  const home = toNumber(homeValue);
  const away = toNumber(awayValue);
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

function extractPairStat(text: string, label: string, patterns: RegExp[]) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return createStatItem(toSlug(label), label, match[1], match[2]);
  }
  return null;
}

export async function fetchOgolStatistics(eventId: number | string) {
  const details = await loadOgolDetailsOrAgenda(eventId).catch(() => null);
  if (!details) return null;

  const text = details.text.replace(/\s+/g, ' ');
  const context = details.context || buildOgolContext(details);
  const items = [
    extractPairStat(text, 'Posicao', [/(\d+)\s+Posi[cç][aã]o\s+(\d+)/i]),
    extractPairStat(text, 'Pontos', [/(\d+)\s+Pontos\s+(\d+)/i]),
    extractPairStat(text, 'Jogos', [/(\d+)\s+Jogos\s+(\d+)/i]),
    extractPairStat(text, 'Vitorias', [/(\d+)\s+Vitorias\s+(\d+)/i, /(\d+)\s+Vitórias\s+(\d+)/i]),
    extractPairStat(text, 'Empates', [/(\d+)\s+Empates\s+(\d+)/i]),
    extractPairStat(text, 'Derrotas', [/(\d+)\s+Derrotas\s+(\d+)/i]),
    extractPairStat(text, 'Gols marcados', [/(\d+)\s+Gols marcados\s+(\d+)/i]),
    extractPairStat(text, 'Gols sofridos', [/(\d+)\s+Gols sofridos\s+(\d+)/i]),
    extractPairStat(text, 'Media de gols', [/([\d.,]+)\s+M[eé]dia de gols\s+([\d.,]+)/i]),
    extractPairStat(text, 'Gols esperados por jogo', [/([\d.,]+)\s+Gols esperados por jogo\s+([\d.,]+)/i]),
    extractPairStat(text, 'Chutes por jogo', [/([\d.,]+)\s+Chutes por jogo\s+([\d.,]+)/i]),
    extractPairStat(text, 'Escanteios por jogo', [/([\d.,]+)\s+Escanteios por jogo\s+([\d.,]+)/i]),
    extractPairStat(text, 'Amarelos', [/(\d+)\s+Amarelos\s+(\d+)/i]),
    extractPairStat(text, 'Vermelhos', [/(\d+)\s+Vermelhos\s+(\d+)/i]),
  ].filter(Boolean);

  return {
    event_id: eventId,
    source: 'ogol',
    homeTeam: toNormalizedEvent(details).homeTeam,
    awayTeam: toNormalizedEvent(details).awayTeam,
    by_period: {
      ALL: {
        period: 'ALL',
        groups_by_name: {
          'OGOL Team Stats': {
            group_name: 'OGOL Team Stats',
            items,
            total_items: items.length,
          },
        },
        group_order: ['OGOL Team Stats'],
        total_groups: 1,
        total_items: items.length,
      },
    },
    summary: {
      periods: ['ALL'],
      total_groups: 1,
      total_items: items.length,
      source: 'ogol',
    },
    context,
    raw: {
      url: details.match.url,
      sections: details.sections,
      context,
    },
  };
}

function sectionText(details: OgolEventDetails, name: RegExp) {
  const entry = Object.entries(details.sections).find(([key]) => name.test(key));
  if (entry) return entry[1];
  const text = details.text;
  const heading = text.match(name);
  if (!heading?.index) return '';
  return text.slice(heading.index, heading.index + 1200);
}

function inferPlayerPosition(context: string) {
  if (/goleiro|goalkeeper|\bgr\b/i.test(context)) return 'Goleiro';
  if (/zagueiro|lateral|defensor|defesa|\bdf\b/i.test(context)) return 'Defensor';
  if (/meia|meio-campo|medio|\bmc\b|\bmei\b/i.test(context)) return 'Meio-campo';
  if (/atacante|avancado|ponta|\bata\b|\bav\b/i.test(context)) return 'Atacante';
  return undefined;
}

function playersFromSection(details: OgolEventDetails, section: string, sideName: string, side: 'home' | 'away') {
  const structured = (details.entities?.players || []).filter((entity) => {
    const belongsToSection = !section
      || section.includes(entity.name)
      || normalizeText(entity.sectionTitle).includes('titular')
      || normalizeText(entity.sectionTitle).includes('desfalque');
    return belongsToSection && (!entity.sideHint || entity.sideHint === side);
  });
  const fallback = details.anchors
    .filter((anchor) => section.includes(anchor.text) && anchor.text.length > 2 && !/ver mais|historico|odds/i.test(anchor.text))
    .map((anchor) => ({ name: cleanEntityName(anchor.text), href: anchor.href, context: anchor.text }));
  const candidates = structured.length ? structured : fallback;
  const unique = [...new Map(candidates.map((entity) => [normalizeText(entity.name), entity])).values()]
    .filter((entity) => entity.name.length > 2 && !/ver mais|historico|odds/i.test(entity.name))
    .slice(0, 18);

  return unique.map((entity, index) => ({
    avgRating: undefined,
    player: {
      id: parseEntityIdFromUrl(entity.href) || teamId(`${sideName}:${entity.name}`),
      name: entity.name,
      slug: toSlug(entity.name),
      shortName: entity.name,
      position: inferPlayerPosition(entity.context),
      href: entity.href,
    },
    teamId: teamId(sideName),
    shirtNumber: undefined,
    position: inferPlayerPosition(entity.context),
    substitute: /banco|reserva|suplente/i.test(entity.context) || index >= 11,
    captain: /capit[aã]o|\(c\)/i.test(entity.context),
    profileText: entity.context,
  }));
}

export async function fetchOgolLineups(eventId: number | string) {
  const details = await loadOgolDetailsOrAgenda(eventId).catch(() => null);
  if (!details) return { status: 404, raw: { requestedEventId: eventId } };

  const starters = sectionText(details, /ultimos titulares|últimos titulares/i);
  const injuries = sectionText(details, /desfalques/i);
  const homePlayers = playersFromSection(details, starters, details.match.homeTeam, 'home');
  const awayPlayers = playersFromSection(details, starters, details.match.awayTeam, 'away').filter((player) =>
    !homePlayers.some((homePlayer) => homePlayer.player.name === player.player.name)
  );

  return {
    status: 200,
    raw: {
      url: details.match.url,
      starters,
      injuries,
    },
    data: {
      confirmed: Boolean(homePlayers.length || awayPlayers.length),
      source: 'ogol',
      home: {
        team: { id: teamId(details.match.homeTeam), name: details.match.homeTeam },
        formation: undefined,
        players: homePlayers,
        missingPlayers: playersFromSection(details, injuries, details.match.homeTeam, 'home').slice(0, 8),
      },
      away: {
        team: { id: teamId(details.match.awayTeam), name: details.match.awayTeam },
        formation: undefined,
        players: awayPlayers,
        missingPlayers: playersFromSection(details, injuries, details.match.awayTeam, 'away').slice(0, 8),
      },
    },
  };
}

export async function fetchOgolIncidents(eventId: number | string) {
  const details = await loadOgolDetailsOrAgenda(eventId).catch(() => null);
  if (!details) return { status: 404, raw: { requestedEventId: eventId } };

  return {
    status: 200,
    raw: {
      url: details.match.url,
      text: sectionText(details, /resumo|comentarios|comentários/i),
    },
    data: {
      eventId,
      source: 'ogol',
      incidents: [],
      note: 'OGOL match page was parsed, but minute-by-minute incidents are not consistently available in the public HTML.',
    },
  };
}

export async function fetchOgolOdds(eventId: number | string) {
  const details = await loadOgolDetailsOrAgenda(eventId).catch(() => null);
  if (!details) return null;

  const odds = details.match.odds?.length === 3
    ? details.match.odds
    : sectionText(details, /odds/i).match(/\b\d{1,2}\.\d{2}\b/g)?.slice(0, 3).map(Number) || [];

  const choices = [
    { id: 1, name: details.match.homeTeam, decimal_odds: odds[0], bookmaker: 'OGOL/partner' },
    { id: 2, name: 'Empate', decimal_odds: odds[1], bookmaker: 'OGOL/partner' },
    { id: 3, name: details.match.awayTeam, decimal_odds: odds[2], bookmaker: 'OGOL/partner' },
  ].filter((choice) => Number.isFinite(choice.decimal_odds) && Number(choice.decimal_odds) > 1);

  return {
    eventId,
    event_id: eventId,
    source: 'ogol',
    summary: {
      total_markets: choices.length ? 1 : 0,
      total_choices: choices.length,
    },
    markets_by_group: {
      ogol: {
        group_name: 'OGOL',
        markets: choices.length ? [{
          market_id: '1x2',
          market_name: 'Resultado Final',
          market_group: '1 x 2',
          market_period: 'fulltime',
          choice_group: '1x2',
          suspended: false,
          choices,
        }] : [],
      },
    },
    raw: {
      url: details.match.url,
      odds,
    },
  };
}

export async function fetchOgolStreaks(eventId: string) {
  const details = await loadOgolDetailsOrAgenda(eventId).catch(() => null);
  if (!details) return { status: 404, raw: { requestedEventId: eventId } };
  const homeFactsPattern = new RegExp(`fatos\\s+${escapeRegExp(details.match.homeTeam)}`, 'i');
  const awayFactsPattern = new RegExp(`fatos\\s+${escapeRegExp(details.match.awayTeam)}`, 'i');

  return {
    status: 200,
    raw: {
      url: details.match.url,
      factsHome: sectionText(details, homeFactsPattern),
      factsAway: sectionText(details, awayFactsPattern),
      headToHead: sectionText(details, /confrontos|ultimos jogos|últimos jogos/i),
    },
    data: {
      eventId,
      source: 'ogol',
      general: [],
      head2head: [],
      home: [],
      away: [],
      teams: [
        { name: details.match.homeTeam },
        { name: details.match.awayTeam },
      ],
      competitions: [{ name: details.match.tournamentName || 'OGOL' }],
      facts: {
        home: sectionText(details, homeFactsPattern),
        away: sectionText(details, awayFactsPattern),
      },
    },
  };
}

export async function fetchOgolGraph(eventId: number | string) {
  const details = await loadOgolDetailsOrAgenda(eventId).catch(() => null);
  return {
    status: details ? 200 : 404,
    raw: details ? { url: details.match.url } : { requestedEventId: eventId },
    data: details ? {
      eventId,
      source: 'ogol',
      points: [],
      periodTime: 45,
      overtimeLength: 0,
      periodCount: 2,
      summary: { totalMinutes: 0, minValue: 0, maxValue: 0, averageValue: 0 },
    } : undefined,
  };
}

export async function fetchOgolTeamInfo(teamIdValue: string) {
  const response = await fetchOgolMatches();
  const match = response.raw.matches.find((item: OgolMatch) =>
    String(teamId(item.homeTeam)) === String(teamIdValue) || String(teamId(item.awayTeam)) === String(teamIdValue)
  );
  const name = match && String(teamId(match.homeTeam)) === String(teamIdValue) ? match.homeTeam : match?.awayTeam;
  if (!name) return { status: 404, data: undefined, raw: response.raw };

  return {
    status: 200,
    raw: response.raw,
    data: {
      teamId: teamIdValue,
      name,
      shortName: name,
      fullName: name,
      slug: toSlug(name),
      nameCode: '',
      national: false,
      sport: { name: 'Futebol', slug: 'football' },
      country: undefined,
      manager: null,
      venue: null,
      colors: { primary: undefined, secondary: undefined, text: '#ffffff' },
      userCount: 0,
      lastUpdated: Date.now(),
    },
  };
}

export async function fetchOgolTeamNextEvents(teamIdValue: string) {
  const response = await fetchOgolMatches();
  const events = response.raw.matches
    .filter((match: OgolMatch) => String(teamId(match.homeTeam)) === String(teamIdValue) || String(teamId(match.awayTeam)) === String(teamIdValue))
    .map((match: OgolMatch) => {
      const event = toEventLive(match);
      return {
        eventId: event.id,
        customId: event.customId,
        startTimestamp: event.startTimestamp,
        startDate: event.startTimestamp ? new Date(event.startTimestamp * 1000).toISOString() : undefined,
        tournament: event.tournament,
        season: event.season,
        round: event.roundInfo.round,
        homeTeam: event.homeTeam,
        awayTeam: event.awayTeam,
        status: event.status.type,
        slug: event.slug,
      };
    });

  return {
    status: 200,
    data: {
      teamId: teamIdValue,
      events,
      hasNextPage: false,
      totalEvents: events.length,
      lastUpdated: Date.now(),
    },
  };
}

export async function fetchOgolSearchTeams(query: string, page = 0) {
  const response = await fetchOgolMatches();
  const normalizedQuery = toSlug(query);
  const teams = response.raw.matches
    .flatMap((match: OgolMatch) => [match.homeTeam, match.awayTeam])
    .filter((name: string, index: number, items: string[]) => items.indexOf(name) === index)
    .filter((name: string) => toSlug(name).includes(normalizedQuery))
    .slice(page * 20, page * 20 + 20)
    .map((name: string) => ({
      id: teamId(name),
      name,
      slug: toSlug(name),
      shortName: name,
      image: `/team/${teamId(name)}/image`,
      imageSmall: `/team/${teamId(name)}/image/small`,
    }));

  return {
    status: 200,
    raw: response.raw,
    data: {
      page,
      query,
      teams,
    },
  };
}
