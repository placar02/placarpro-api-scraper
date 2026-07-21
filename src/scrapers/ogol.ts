import type { Page } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { NormalizedEvent } from '../types/event';
import type { EventLive } from '../types/event.live';
import { loadOgolPage as loadPageText, withOgolPage as withPage } from './ogol/browser';
import {
  OGOL_AGENDA_URL as AGENDA_URL,
  OGOL_BASE_URL as BASE_URL,
  OGOL_CACHE_TTL_MS as CACHE_TTL_MS,
  OGOL_DISK_CACHE_PATH as DISK_CACHE_PATH,
  OGOL_EVENT_LOOKAHEAD_DAYS as EVENT_LOOKAHEAD_DAYS,
  OGOL_MATCH_LIMIT as MATCH_LIMIT,
  OGOL_REQUEST_TIMEOUT_MS as REQUEST_TIMEOUT_MS,
} from './ogol/config';
import { fetchOgolDeepData } from './ogol/deep';

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
  images?: OgolImageCandidate[];
  entities?: {
    players: OgolEntityLink[];
    referees: OgolEntityLink[];
    teams: OgolEntityLink[];
  };
  context?: Record<string, unknown>;
};

type OgolImageCandidate = {
  url: string;
  alt?: string;
  title?: string;
  context?: string;
  width?: number;
  height?: number;
};

type OgolEntityLink = {
  name: string;
  href: string;
  context: string;
  contexts?: string[];
  sectionTitle?: string;
  sideHint?: 'home' | 'away';
};

type OgolTeamProfile = {
  url: string;
  text: string;
  players: OgolEntityLink[];
  imageUrl?: string;
  teamName?: string;
  matches: OgolHistoricalMatch[];
};

type OgolHistoricalMatch = {
  id: number;
  url: string;
  date?: string;
  homeTeam: { id: number; name: string };
  awayTeam: { id: number; name: string };
  homeScore: number;
  awayScore: number;
  subjectSide: 'home' | 'away';
  sourceText: string;
};

const matchCache = new Map<string, { expiresAt: number; promise: Promise<{ status: number; events: EventLive[]; raw: any }> }>();
const detailsCache = new Map<string, { expiresAt: number; promise: Promise<OgolEventDetails | null> }>();
const refereeProfileCache = new Map<string, { expiresAt: number; promise: Promise<Record<string, unknown>> }>();
const teamSquadCache = new Map<string, { expiresAt: number; promise: Promise<OgolTeamProfile> }>();

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
  const parsed = Number(String(value ?? '').replace(',', '.').replace(/[%\s]+/g, ''));
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

function pickTeamLogo(images: OgolImageCandidate[] = [], teamName: string) {
  const team = normalizeText(teamName);
  const ranked = images
    .filter((image) => image.url && !/banner|publicidade|advert|pixel|avatar|user/i.test(image.url))
    .map((image) => {
      const description = normalizeText(`${image.alt || ''} ${image.title || ''} ${image.context || ''}`);
      const url = normalizeText(image.url);
      let score = 0;
      if (description.includes(team)) score += 30;
      if (url.includes(toSlug(teamName))) score += 16;
      if (/logo|equip|equipa|team|escudo|emblem|bandeira/.test(url)) score += 8;
      if (Number(image.width || 0) >= 40 && Number(image.height || 0) >= 40) score += 3;
      return { image, score };
    })
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.score >= 16 ? ranked[0].image.url : undefined;
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
      imageUrl: context?.teamLogos?.home,
    },
    awayTeam: {
      id: live.awayTeam.id,
      name: live.awayTeam.name,
      slug: live.awayTeam.slug,
      shortName: live.awayTeam.shortName,
      imageUrl: context?.teamLogos?.away,
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

function buildAgendaUrls(date?: string) {
  if (!date) return [`${BASE_URL}/jogos/hoje`, `${BASE_URL}/jogos`, AGENDA_URL, BASE_URL];
  const compact = date.replace(/-/g, '');
  return [
    `${AGENDA_URL}?data=${date}`,
    `${AGENDA_URL}?data=${compact}`,
    `${AGENDA_URL}?ano=${date.slice(0, 4)}&mes=${Number(date.slice(5, 7))}&dia=${Number(date.slice(8, 10))}`,
    `${BASE_URL}/futebol/agenda?data=${date}`,
    `${BASE_URL}/jogos?data=${date}`,
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

function cleanHistoricalTeamName(value: string) {
  return String(value || '')
    .replace(/^[VED]\s+\d{1,2}[/.]\d{1,2}(?:[/.]\d{2,4})?\s+\d{1,2}:\d{2}\s+\S+\s+/i, '')
    .replace(/^\d{1,2}[/.]\d{1,2}(?:[/.]\d{2,4})?\s+\d{1,2}:\d{2}\s+\S+\s+/i, '')
    .trim();
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

function parseAgendaMatchText(
  rawText: string,
  rawNearText: string,
  url: string,
  fallbackDate?: string,
  tournamentName?: string,
): OgolMatch | null {
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
    tournamentName: tournamentName?.trim() || undefined,
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
    cleanSheets: toNumber(text.match(/(\d+)\s+(?:clean sheets|jogos sem sofrer gol)/i)?.[1]),
    failedToScore: toNumber(text.match(/(\d+)\s+(?:jogos sem marcar|sem marcar)/i)?.[1]),
    winningStreak: toNumber(text.match(/(\d+)\s+(?:vitorias consecutivas|jogos vencendo)/i)?.[1]),
    winlessStreak: toNumber(text.match(/(\d+)\s+(?:jogos sem vencer|sem vitoria)/i)?.[1]),
  };
}

function buildOgolContext(details: OgolEventDetails) {
  const sections = { ...extractKnownSections(details.text), ...details.sections };
  const group = sectionByName(sections, /^GRUPO/i);
  const stats = sectionByName(sections, /ESTAT.*FIFA|ESTAT.*WORLD/i) || sectionByName(sections, /ESTAT/i);
  const homeFacts = sectionByName(sections, new RegExp(`FATOS\\s+${escapeRegExp(details.match.homeTeam)}`, 'i'));
  const awayFacts = sectionByName(sections, new RegExp(`FATOS\\s+${escapeRegExp(details.match.awayTeam)}`, 'i'));

  return {
    teamLogos: {
      home: pickTeamLogo(details.images, details.match.homeTeam),
      away: pickTeamLogo(details.images, details.match.awayTeam),
    },
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
      .map((anchor) => {
        const container = anchor.closest('article,li,tr,[class*="game"],[class*="match"],section,div') as HTMLElement | null;
        const directCompetition = container?.querySelector<HTMLElement>(
          '[data-competition-name],[data-tournament-name],[class*="competition"],[class*="tournament"],[class*="league"]'
        );
        let tournamentName = directCompetition?.dataset.competitionName
          || directCompetition?.dataset.tournamentName
          || directCompetition?.innerText?.trim()
          || '';
        if (tournamentName.length > 120) tournamentName = '';

        let current: Element | null = container || anchor;
        for (let depth = 0; !tournamentName && current && depth < 5; depth += 1) {
          let sibling = current.previousElementSibling;
          for (let step = 0; sibling && step < 4; step += 1, sibling = sibling.previousElementSibling) {
            const heading = sibling.matches('h2,h3,h4,[class*="competition"],[class*="tournament"],[class*="league"]')
              ? sibling as HTMLElement
              : sibling.querySelector<HTMLElement>('h2,h3,h4,[class*="competition"],[class*="tournament"],[class*="league"]');
            const headingText = heading?.innerText?.replace(/\s+/g, ' ').trim();
            if (headingText && headingText.length <= 120) {
              tournamentName = headingText;
              break;
            }
          }
          current = current.parentElement;
        }

        return {
          href: anchor.href,
          text: anchor.innerText || anchor.textContent || '',
          nearText: container?.innerText || '',
          tournamentName,
        };
      });
  });

  const byId = new Map<number, OgolMatch>();
  for (const raw of extracted) {
    const match = parseAgendaMatchText(raw.text, raw.nearText, raw.href, fallbackDate, raw.tournamentName);
    if (match && !byId.has(match.id)) byId.set(match.id, match);
  }

  const matches = [...byId.values()];
  const matchesForDate = fallbackDate
    ? matches.filter((match) => match.date === fallbackDate)
    : matches;
  return matchesForDate.slice(0, MATCH_LIMIT);
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

  const diskCache = await readDiskCache();
  const diskMatch = diskCache?.matches?.find((item: OgolMatch) => Number(item.id) === id);
  if (diskMatch) return diskMatch as OgolMatch;

  const dates = [
    undefined,
    localDateKey(-1),
    localDateKey(0),
    ...Array.from({ length: EVENT_LOOKAHEAD_DAYS }, (_, index) => localDateKey(index + 1)),
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
      const cachedMatches = Array.isArray(cached?.matches)
        ? date
          ? cached.matches.filter((match: OgolMatch) => match.date === date)
          : cached.matches
        : [];
      if (cachedMatches.length) {
        return {
          status: 200,
          raw: {
            source: 'ogol',
            stale: true,
            cachedAt: cached.cachedAt,
            url: cached.url,
            attempts,
            matches: cachedMatches,
          },
          events: cachedMatches.map(toEventLive),
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

// Never touches the network. Used by latency-sensitive routes to return a
// stale-while-revalidate preview while the regular collector refreshes data.
export async function fetchOgolMatchesFastCached(date?: string) {
  const disk = await readDiskCache();
  const matches = Array.isArray(disk?.matches)
    ? date ? disk.matches.filter((match: OgolMatch) => match.date === date) : disk.matches
    : [];
  return {
    status: matches.length ? 200 : 204,
    cache: 'disk' as const,
    raw: { source: 'ogol', stale: true, cachedAt: disk?.cachedAt, matches },
    events: matches.map(toEventLive),
  };
}

// Lightweight event lookup: agenda/cache only. It deliberately skips the match page,
// related pages and player profiles used by the complete analysis pipeline.
export async function fetchOgolEventFast(eventId: number | string) {
  const match = await findMatchById(eventId);
  if (!match) return null;
  return toEventLive(match);
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
          images: [...document.querySelectorAll<HTMLImageElement>('img')].map((image) => {
            const source = image.getAttribute('data-src')
              || image.getAttribute('data-original')
              || image.currentSrc
              || image.src;
            return {
              url: source ? new URL(source, window.location.href).href : '',
              alt: image.alt,
              title: image.title,
              context: (image.closest('a,figure,[class*="team"],[class*="equipa"],div') as HTMLElement | null)?.innerText
                ?.replace(/\s+/g, ' ')
                .trim()
                .slice(0, 300),
              width: image.naturalWidth || image.width,
              height: image.naturalHeight || image.height,
            };
          }).filter((image) => image.url),
          entities: {
            players: entityLinks.filter((item) => /\/jogador(?:\/|\.php)|\/player\//i.test(item.href)),
            referees: entityLinks.filter((item) => /\/arbitro(?:\/|\.php)|referee\.php/i.test(item.href)),
            teams: entityLinks.filter((item) => /\/(?:equipe|equipa|time)(?:\/|\.php)/i.test(item.href)),
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
        images: data.images,
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
          teams: data.entities.teams.map((team) => ({
            ...team,
            name: cleanEntityName(team.name),
            sideHint: inferSide(team),
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
            note: Object.keys(profile).some((key) => ['games', 'yellowCards', 'redCards', 'cardsAverage'].includes(key) && (profile as Record<string, unknown>)[key] !== undefined)
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
  const richData = await fetchOgolDeepData(
    eventId,
    details.match.url,
    details.match.homeTeam,
    details.match.awayTeam,
  );
  return {
    status: 200,
    data: {
      ...toNormalizedEvent(details),
      richData,
    },
    raw: {
      source: 'ogol',
      url: details.match.url,
      title: details.title,
      match: details.match,
      context: details.context || buildOgolContext(details),
      richData,
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

export function deepStatisticItems(richData: any) {
  const match = richData?.analysisReady?.match;
  const candidates: Array<{ label: string; home: string; away: string }> = [];
  for (const table of match?.tables || []) {
    const rows = table?.rows || [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const label = row.find((cell: string) => /[a-zA-ZÀ-ÿ]/.test(cell) && !/^\d+[.,]?\d*%?$/.test(cell));
      const values = row.filter((cell: string) => /^-?\d+(?:[.,]\d+)?%?$/.test(cell));
      if (label && values.length >= 2) candidates.push({ label, home: values[0], away: values[1] });

      const valueRow = rows[index + 1];
      if (!valueRow || row.length !== valueRow.length || !row.every((cell: string) => /[a-zA-Z]/.test(normalizeText(cell)))) continue;
      row.forEach((columnLabel: string, columnIndex: number) => {
        const valueText = String(valueRow[columnIndex] || '');
        const shotValues = valueText.match(/^\s*\((-?\d+(?:[.,]\d+)?)\)\s*(-?\d+(?:[.,]\d+)?)\s+(-?\d+(?:[.,]\d+)?)\s*\((-?\d+(?:[.,]\d+)?)\)\s*$/);
        if (shotValues) {
          candidates.push({ label: columnLabel, home: shotValues[2], away: shotValues[3] });
          if (/chute|finaliza/.test(normalizeText(columnLabel))) {
            candidates.push({ label: 'Chutes no alvo', home: shotValues[1], away: shotValues[4] });
          }
          return;
        }
        const pair = valueText.match(/-?\d+(?:[.,]\d+)?%?/g) || [];
        if (pair.length >= 2) candidates.push({ label: columnLabel, home: pair[0]!, away: pair[1]! });
      });
    }
  }
  for (const block of match?.statistics || []) {
    if (block?.label && Array.isArray(block.values) && block.values.length >= 2 && block.values.length <= 4) {
      candidates.push({ label: block.label, home: block.values[0], away: block.values[1] });
    }
  }
  const statisticName = /posse|chute|finaliza|escanteio|gols? esperados?|\bxg\b|passe|falta|impedimento|desarme|recupera|cruzamento|duelo|defesa|intercepta|lancamento|bola longa|pressao|intensidade|eficiencia|cartao|amarelo|vermelho|dividida/;
  return [...new Map(candidates.map((item) => [normalizeText(item.label), item])).values()]
    .filter((item) => statisticName.test(normalizeText(item.label)) && !/^\d/.test(item.label))
    .map((item) => createStatItem(`ogol-deep-${toSlug(item.label)}`, item.label, item.home, item.away));
}

function teamProfileMetric(profile: OgolTeamProfile, labels: string[]) {
  const sections = extractKnownSections(profile.text);
  const statisticsText = sectionByName(sections, /ESTAT/i);
  if (!statisticsText) return undefined;

  for (const label of labels) {
    const escaped = escapeRegExp(label);
    const after = statisticsText.match(new RegExp(`${escaped}\\s*[:\\-]?\\s*([\\d.,]+)`, 'i'))?.[1];
    const before = statisticsText.match(new RegExp(`([\\d.,]+)\\s+${escaped}`, 'i'))?.[1];
    if (after !== undefined || before !== undefined) return toNumber(after || before);
  }
  return undefined;
}

export async function fetchOgolStatistics(eventId: number | string) {
  const details = await loadOgolDetailsOrAgenda(eventId).catch(() => null);
  if (!details) return null;
  const richData = await fetchOgolDeepData(eventId, details.match.url, details.match.homeTeam, details.match.awayTeam);

  const text = details.text.replace(/\s+/g, ' ');
  const context = (details.context || buildOgolContext(details)) as any;
  const items: any[] = [
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
    extractPairStat(text, 'xGA por jogo', [/([\d.,]+)\s+(?:xGA|Gols esperados contra) por jogo\s+([\d.,]+)/i]),
    extractPairStat(text, 'Chutes por jogo', [/([\d.,]+)\s+Chutes por jogo\s+([\d.,]+)/i]),
    extractPairStat(text, 'Chutes no alvo por jogo', [/([\d.,]+)\s+(?:Chutes|Finalizacoes) no alvo por jogo\s+([\d.,]+)/i]),
    extractPairStat(text, 'Posse de bola', [/([\d.,]+)%?\s+Posse de bola\s+([\d.,]+)%?/i]),
    extractPairStat(text, 'Escanteios por jogo', [/([\d.,]+)\s+Escanteios por jogo\s+([\d.,]+)/i]),
    extractPairStat(text, 'Amarelos', [/(\d+)\s+Amarelos\s+(\d+)/i]),
    extractPairStat(text, 'Vermelhos', [/(\d+)\s+Vermelhos\s+(\d+)/i]),
  ].filter(Boolean);
  for (const item of deepStatisticItems(richData)) {
    if (!items.some((current) => normalizeText(current.name) === normalizeText(item.name))) items.push(item);
  }
  const itemExists = (pattern: RegExp) => items.some((item) => pattern.test(normalizeText(`${item.name} ${item.key}`)));

  if (!itemExists(/escanteio|corner/) || !itemExists(/amarelo|vermelho|cartao|falta/)) {
    const homeTeamLink = details.entities?.teams.find((team) => team.sideHint === 'home'
      || normalizeText(team.name).includes(normalizeText(details.match.homeTeam)));
    const awayTeamLink = details.entities?.teams.find((team) => team.sideHint === 'away'
      || normalizeText(team.name).includes(normalizeText(details.match.awayTeam)));
    const homeProfile = await fetchTeamProfile(homeTeamLink?.href);
    const awayProfile = await fetchTeamProfile(awayTeamLink?.href);
    const profileMetrics = [
      ['Escanteios por jogo', ['Escanteios por jogo', 'Média de escanteios']],
      ['Amarelos', ['Cartões amarelos por jogo', 'Cartões amarelos']],
      ['Vermelhos', ['Cartões vermelhos por jogo', 'Cartões vermelhos']],
      ['Faltas por jogo', ['Faltas por jogo', 'Média de faltas']],
      ['Posse de bola', ['Posse de bola', 'Media de posse']],
      ['Chutes por jogo', ['Chutes por jogo', 'Finalizacoes por jogo']],
      ['Chutes no alvo por jogo', ['Chutes no alvo por jogo', 'Finalizacoes no alvo por jogo']],
      ['xG por jogo', ['xG por jogo', 'Gols esperados por jogo']],
      ['xGA por jogo', ['xGA por jogo', 'Gols esperados contra por jogo']],
    ] as Array<[string, string[]]>;

    for (const [label, aliases] of profileMetrics) {
      if (itemExists(new RegExp(normalizeText(label).split(' ')[0]))) continue;
      const homeValue = teamProfileMetric(homeProfile, aliases);
      const awayValue = teamProfileMetric(awayProfile, aliases);
      if (homeValue !== undefined && awayValue !== undefined) {
        items.push(createStatItem(toSlug(label), label, homeValue, awayValue));
      }
    }
    context.teamProfiles = {
      home: { url: homeProfile.url, hasStatisticsSection: Boolean(sectionByName(extractKnownSections(homeProfile.text), /ESTAT/i)) },
      away: { url: awayProfile.url, hasStatisticsSection: Boolean(sectionByName(extractKnownSections(awayProfile.text), /ESTAT/i)) },
    };
  }
  context.deepCoverage = richData?.coverage;
  context.deepAnalysis = richData?.analysisReady ? {
    match: {
      attendance: richData.analysisReady.match?.attendance,
      weather: richData.analysisReady.match?.weather,
      broadcast: richData.analysisReady.match?.broadcast,
      events: richData.analysisReady.match?.events,
    },
    teams: {
      home: richData.analysisReady.teams?.home ? {
        coach: richData.analysisReady.teams.home.coach,
        averageAge: richData.analysisReady.teams.home.averageAge,
        squadValue: richData.analysisReady.teams.home.squadValue,
        recent: richData.analysisReady.teams.home.recent,
      } : undefined,
      away: richData.analysisReady.teams?.away ? {
        coach: richData.analysisReady.teams.away.coach,
        averageAge: richData.analysisReady.teams.away.averageAge,
        squadValue: richData.analysisReady.teams.away.squadValue,
        recent: richData.analysisReady.teams.away.recent,
      } : undefined,
    },
    headToHead: richData.analysisReady.headToHead,
    competition: richData.analysisReady.competition,
    players: richData.analysisReady.players,
  } : undefined;

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
    richData,
    context,
    raw: {
      url: details.match.url,
      sections: details.sections,
      context,
      deepCoverage: richData?.coverage,
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

function playerRowsFromEntities(entities: OgolEntityLink[], sideName: string) {
  const unique = [...new Map(entities.map((entity) => [normalizeText(entity.name), entity])).values()]
    .filter((entity) => entity.name.length > 2 && !/ver mais|historico|odds/i.test(entity.name))
    .slice(0, 25);

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

async function fetchTeamProfile(href?: string): Promise<OgolTeamProfile> {
  if (!href) return { url: '', text: '', players: [], matches: [] };
  const url = absoluteUrl(href);
  const cached = teamSquadCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;

  const promise = withPage(async (page) => {
    await loadPageText(page, url);
    const extractProfilePage = () => page.evaluate(() => ({
      text: document.body.innerText,
      teamName: (document.querySelector('h1') as HTMLElement | null)?.innerText?.replace(/\s+/g, ' ').trim(),
      historyUrl: [...document.querySelectorAll<HTMLAnchorElement>('a[href]')]
        .find((anchor) => /ultimos jogos|últimos jogos|todos os jogos|resultados/i.test(anchor.innerText)
          && /\/(?:equipe|equipa|time)\/[^/?]+\/(?:todos-os-jogos|resultados)/i.test(anchor.href))?.href,
      imageUrl: (document.querySelector('meta[property="og:image"]') as HTMLMetaElement | null)?.content
        || [...document.querySelectorAll<HTMLImageElement>('img')]
          .map((image) => image.getAttribute('data-src') || image.getAttribute('data-original') || image.currentSrc || image.src)
          .find((source) => source && /logo|equip|equipa|team|escudo|emblem/i.test(source)),
      players: [...document.querySelectorAll<HTMLAnchorElement>('a[href]')]
        .filter((anchor) => /\/jogador(?:\/|\.php)|\/player\//i.test(anchor.href))
        .map((anchor) => {
          const context = (anchor.closest('tr,li,article,section,div') as HTMLElement | null)?.innerText || anchor.innerText;
          return {
            name: anchor.innerText.replace(/\s+/g, ' ').trim(),
            href: anchor.href,
            context: context.replace(/\s+/g, ' ').trim().slice(0, 500),
          };
        })
        .filter((player) => player.name.length > 2)
        .slice(0, 35),
      matches: [...document.querySelectorAll<HTMLAnchorElement>('a[href*="/jogo/"]')]
        .map((anchor) => {
          const container = anchor.closest('tr,li,article,[class*="game"],[class*="match"],div') as HTMLElement | null;
          const teamNames = container
            ? [...container.querySelectorAll<HTMLAnchorElement>('a[href]')]
              .filter((item) => /\/(?:equipe|equipa|time)(?:\/|\.php)/i.test(item.href))
              .map((item) => item.innerText.replace(/\s+/g, ' ').trim())
              .filter(Boolean)
            : [];
          return {
            href: anchor.href,
            text: (container?.innerText || anchor.innerText).replace(/\s+/g, ' ').trim().slice(0, 600),
            teamNames: [...new Set(teamNames)],
          };
        })
        .filter((match) => match.href && match.text),
    }));
    const primary = await extractProfilePage();
    let combinedMatches = [...primary.matches];
    if (primary.matches.length < 10 && primary.historyUrl && primary.historyUrl !== url) {
      await loadPageText(page, primary.historyUrl);
      const history = await extractProfilePage();
      combinedMatches.push(...history.matches);
    }
    const canonicalUrl = new URL(url);
    canonicalUrl.searchParams.delete('edicao_id');
    if (combinedMatches.length < 10 && canonicalUrl.toString() !== url && canonicalUrl.toString() !== primary.historyUrl) {
      await loadPageText(page, canonicalUrl.toString());
      const general = await extractProfilePage();
      combinedMatches.push(...general.matches);
    }
    return { ...primary, matches: combinedMatches };
  }).then((profile) => {
    const profilePathParts = new URL(url).pathname.split('/').filter(Boolean);
    const teamPathIndex = profilePathParts.findIndex((part) => /^(equipe|equipa|time)$/i.test(part));
    const profileTeamName = teamPathIndex >= 0 && profilePathParts[teamPathIndex + 1]
      ? decodeURIComponent(profilePathParts[teamPathIndex + 1]).replace(/-/g, ' ')
      : cleanEntityName(profile.teamName || '');
    const matches = [...new Map(profile.matches.map((raw) => [parseEventIdFromUrl(raw.href), raw])).entries()]
      .map(([id, raw]) => {
        if (!id) return null;
        const score = raw.text.match(/(\d{1,2})\s*[-x]\s*(\d{1,2})/i);
        const parsedTeams = parseTeamsFromText(raw.text);
        const distinctTeams = raw.teamNames.filter((name) => normalizeText(name) !== normalizeText(profileTeamName));
        let homeName = parsedTeams?.homeTeam;
        let awayName = parsedTeams?.awayTeam;
        if ((!homeName || !awayName) && raw.teamNames.length >= 2) [homeName, awayName] = raw.teamNames;
        if ((!homeName || !awayName) && distinctTeams.length && profileTeamName) {
          const urlPath = normalizeText(new URL(raw.href).pathname);
          const subjectSlug = toSlug(profileTeamName);
          const opponentSlug = toSlug(distinctTeams[0]);
          const subjectFirst = urlPath.indexOf(`-${subjectSlug}-`) < urlPath.indexOf(`-${opponentSlug}-`);
          homeName = subjectFirst ? profileTeamName : distinctTeams[0];
          awayName = subjectFirst ? distinctTeams[0] : profileTeamName;
        }
        homeName = cleanHistoricalTeamName(homeName || '');
        awayName = cleanHistoricalTeamName(awayName || '');
        const homeScore = parsedTeams?.homeScore ?? (score ? Number(score[1]) : undefined);
        const awayScore = parsedTeams?.awayScore ?? (score ? Number(score[2]) : undefined);
        if (!homeName || !awayName || homeScore === undefined || awayScore === undefined) return null;
        if (profileTeamName
          && !normalizeText(homeName).includes(normalizeText(profileTeamName))
          && !normalizeText(awayName).includes(normalizeText(profileTeamName))) return null;
        const subjectSide = normalizeText(homeName).includes(normalizeText(profileTeamName)) ? 'home' : 'away';
        const isoDate = raw.href.match(/\/jogo\/(\d{4})-(\d{2})-(\d{2})-/);
        const dateMatch = raw.text.match(/\b(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?\b/);
        const year = dateMatch?.[3]
          ? Number(dateMatch[3]) < 100 ? 2000 + Number(dateMatch[3]) : Number(dateMatch[3])
          : new Date().getFullYear();
        return {
          id,
          url: absoluteUrl(raw.href),
          date: isoDate
            ? `${isoDate[1]}-${isoDate[2]}-${isoDate[3]}`
            : dateMatch ? `${year}-${dateMatch[2].padStart(2, '0')}-${dateMatch[1].padStart(2, '0')}` : undefined,
          homeTeam: { id: teamId(homeName), name: homeName },
          awayTeam: { id: teamId(awayName), name: awayName },
          homeScore,
          awayScore,
          subjectSide,
          sourceText: raw.text,
        } as OgolHistoricalMatch;
      })
      .filter((match): match is OgolHistoricalMatch => Boolean(match))
      .slice(0, 10);

    return {
      url,
      text: profile.text,
      teamName: profileTeamName,
      imageUrl: profile.imageUrl ? absoluteUrl(profile.imageUrl) : undefined,
      players: profile.players.map((player) => ({
        ...player,
        name: cleanEntityName(player.name),
      })),
      matches,
    };
  }).catch(() => ({ url, text: '', players: [], matches: [] }));

  teamSquadCache.set(url, { expiresAt: Date.now() + CACHE_TTL_MS, promise });
  return promise;
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
  return playerRowsFromEntities(candidates, sideName).slice(0, 18);
}

export async function fetchOgolLineups(eventId: number | string) {
  const details = await loadOgolDetailsOrAgenda(eventId).catch(() => null);
  if (!details) return { status: 404, raw: { requestedEventId: eventId } };
  const richData = await fetchOgolDeepData(eventId, details.match.url, details.match.homeTeam, details.match.awayTeam);

  const starters = sectionText(details, /ultimos titulares|últimos titulares/i);
  const injuries = sectionText(details, /desfalques/i);
  let homePlayers = playersFromSection(details, starters, details.match.homeTeam, 'home');
  let awayPlayers = playersFromSection(details, starters, details.match.awayTeam, 'away').filter((player) =>
    !homePlayers.some((homePlayer) => homePlayer.player.name === player.player.name)
  );
  const homeTeamLink = details.entities?.teams.find((team) => team.sideHint === 'home'
    || normalizeText(team.name).includes(normalizeText(details.match.homeTeam)));
  const awayTeamLink = details.entities?.teams.find((team) => team.sideHint === 'away'
    || normalizeText(team.name).includes(normalizeText(details.match.awayTeam)));
  const context = (details.context || {}) as any;
  let homeProfile: OgolTeamProfile | undefined;
  let awayProfile: OgolTeamProfile | undefined;
  const homeNeedsProfileLogo = !context?.teamLogos?.home || /bandeira|flag/i.test(context.teamLogos.home);
  const awayNeedsProfileLogo = !context?.teamLogos?.away || /bandeira|flag/i.test(context.teamLogos.away);

  if ((homePlayers.length < 10 || homeNeedsProfileLogo) && homeTeamLink?.href) {
    homeProfile = await fetchTeamProfile(homeTeamLink.href);
    if (homePlayers.length < 10) homePlayers = playerRowsFromEntities(homeProfile.players, details.match.homeTeam);
  }
  if ((awayPlayers.length < 10 || awayNeedsProfileLogo) && awayTeamLink?.href) {
    awayProfile = await fetchTeamProfile(awayTeamLink.href);
    if (awayPlayers.length < 10) {
      awayPlayers = playerRowsFromEntities(awayProfile.players, details.match.awayTeam)
        .filter((player) => !homePlayers.some((homePlayer) => homePlayer.player.name === player.player.name));
    }
  }
  const deepPlayers = Array.isArray(richData?.analysisReady?.players) ? richData.analysisReady.players : [];
  const enrichPlayers = (players: any[]) => players.map((player) => {
    const profile = deepPlayers.find((candidate: any) =>
      normalizeText(candidate.name) === normalizeText(player.player?.name)
      || normalizeText(candidate.name).includes(normalizeText(player.player?.name))
    );
    if (!profile) return player;
    return {
      ...player,
      avgRating: profile.averageRating ?? player.avgRating,
      age: profile.age ?? player.age,
      hasStats: true,
      stats: profile,
    };
  });
  homePlayers = enrichPlayers(homePlayers);
  awayPlayers = enrichPlayers(awayPlayers);

  return {
    status: 200,
    raw: {
      url: details.match.url,
      starters,
      injuries,
      deepCoverage: richData?.coverage,
    },
    data: {
      confirmed: Boolean(homePlayers.length || awayPlayers.length),
      source: 'ogol',
      playerProfiles: deepPlayers,
      home: {
        team: {
          id: teamId(details.match.homeTeam),
          name: details.match.homeTeam,
          imageUrl: homeProfile?.imageUrl || context?.teamLogos?.home,
        },
        formation: undefined,
        players: homePlayers,
        missingPlayers: playersFromSection(details, injuries, details.match.homeTeam, 'home').slice(0, 8),
      },
      away: {
        team: {
          id: teamId(details.match.awayTeam),
          name: details.match.awayTeam,
          imageUrl: awayProfile?.imageUrl || context?.teamLogos?.away,
        },
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
  const richData = await fetchOgolDeepData(eventId, details.match.url, details.match.homeTeam, details.match.awayTeam);
  const rawEvents = [...new Map(
    (richData?.analysisReady?.match?.events || [])
      .filter((event: any) => {
        const text = String(event.text || '').trim();
        const normalized = normalizeText(text);
        const semanticEvent = /gol|goal|cartao|amarelo|vermelho|substitu|entrou|saiu/.test(normalized);
        const namedEvent = (normalized.match(/[a-z]{3,}/g) || []).length >= 2;
        if ((!semanticEvent && !namedEvent) || /melhor rating|classificacoes|estatisticas jogador/.test(normalized)) return false;
        return text.length <= 180 && /(?:\b\d{1,2}|90\+\d+)\s*['´]/.test(text);
      })
      .map((event: any) => [`${event.section || ''}|${event.text}`, event]),
  ).values()];
  const incidents = rawEvents.map((event: any, index: number) => {
    const text = String(event.text || '');
    const normalized = normalizeText(text);
    const type = /vermelh/.test(normalized) ? 'red-card'
      : /amarel|cartao/.test(normalized) || /^q\s*\d/.test(normalized) ? 'yellow-card'
        : /substit/.test(normalized) || /^r\s*\d/.test(normalized) ? 'substitution'
          : /\bgol\b|\bgoal\b/.test(normalized) || /^b\s*\d/.test(normalized) ? 'goal'
            : 'match-event';
    return {
      id: `${eventId}-${index}`,
      time: Number(text.match(/(\d{1,3})\s*['´]/)?.[1]) || undefined,
      type,
      text,
      section: event.section,
    };
  });

  return {
    status: 200,
    raw: {
      url: details.match.url,
      deepCoverage: richData?.coverage,
      text: sectionText(details, /resumo|comentarios|comentários/i),
    },
    data: {
      eventId,
      source: 'ogol',
      incidents,
      note: incidents.length
        ? 'Eventos extraidos das paginas publicas relacionadas ao jogo no OGOL.'
        : 'OGOL match pages were parsed, but no structured minute-by-minute incidents were found.',
    },
  };
}

export async function fetchOgolOdds(eventId: number | string) {
  const details = await loadOgolDetailsOrAgenda(eventId).catch(() => null);
  if (!details) return null;
  const richData = await fetchOgolDeepData(eventId, details.match.url, details.match.homeTeam, details.match.awayTeam);

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
      deepOdds: richData?.analysisReady?.match?.odds,
      deepCoverage: richData?.coverage,
    },
  };
}

export async function fetchOgolStreaks(eventId: string) {
  const details = await loadOgolDetailsOrAgenda(eventId).catch(() => null);
  if (!details) return { status: 404, raw: { requestedEventId: eventId } };
  const richData = await fetchOgolDeepData(eventId, details.match.url, details.match.homeTeam, details.match.awayTeam);
  const homeFactsPattern = new RegExp(`fatos\\s+${escapeRegExp(details.match.homeTeam)}`, 'i');
  const awayFactsPattern = new RegExp(`fatos\\s+${escapeRegExp(details.match.awayTeam)}`, 'i');
  const homeTeamLink = details.entities?.teams.find((team) => team.sideHint === 'home'
    || normalizeText(team.name).includes(normalizeText(details.match.homeTeam)));
  const awayTeamLink = details.entities?.teams.find((team) => team.sideHint === 'away'
    || normalizeText(team.name).includes(normalizeText(details.match.awayTeam)));
  const [homeProfile, awayProfile] = await Promise.all([
    fetchTeamProfile(homeTeamLink?.href),
    fetchTeamProfile(awayTeamLink?.href),
  ]);
  const withSubject = (matches: OgolHistoricalMatch[], teamName: string) => matches.map((match) => ({
    ...match,
    subjectSide: normalizeText(match.homeTeam.name).includes(normalizeText(teamName)) ? 'home' as const : 'away' as const,
  }));
  const homeMatches = withSubject(homeProfile.matches, details.match.homeTeam);
  const awayMatches = withSubject(awayProfile.matches, details.match.awayTeam);
  const normalizeDeepMatch = (match: any, subject: string) => ({
    id: match.id,
    matchTime: match.date ? Math.floor(Date.parse(`${match.date}T12:00:00Z`) / 1000) : undefined,
    homeTeam: { id: teamId(match.homeSlug || 'home'), name: String(match.homeSlug || '').replace(/-/g, ' ') },
    awayTeam: { id: teamId(match.awaySlug || 'away'), name: String(match.awaySlug || '').replace(/-/g, ' ') },
    homeScore: match.homeScore,
    awayScore: match.awayScore,
    subjectSide: normalizeText(match.homeSlug).includes(normalizeText(subject)) ? 'home' : 'away',
    source: 'ogol-deep',
  });
  const deepHomeMatches = (richData?.analysisReady?.teams?.home?.recent?.last20?.matches || [])
    .map((match: any) => normalizeDeepMatch(match, details.match.homeTeam));
  const deepAwayMatches = (richData?.analysisReady?.teams?.away?.recent?.last20?.matches || [])
    .map((match: any) => normalizeDeepMatch(match, details.match.awayTeam));
  const deepHeadToHead = (richData?.analysisReady?.headToHead?.matches || [])
    .map((match: any) => normalizeDeepMatch(match, details.match.homeTeam));

  return {
    status: 200,
    raw: {
      url: details.match.url,
      factsHome: sectionText(details, homeFactsPattern),
      factsAway: sectionText(details, awayFactsPattern),
      homeProfileUrl: homeProfile.url,
      awayProfileUrl: awayProfile.url,
      homeMatchesFound: homeMatches.length,
      awayMatchesFound: awayMatches.length,
      deepCoverage: richData?.coverage,
      headToHead: sectionText(details, /confrontos|ultimos jogos|últimos jogos/i),
    },
    data: {
      eventId,
      source: 'ogol',
      general: [],
      head2head: deepHeadToHead,
      home: deepHomeMatches.length > homeMatches.length ? deepHomeMatches : homeMatches,
      away: deepAwayMatches.length > awayMatches.length ? deepAwayMatches : awayMatches,
      deepSummary: {
        home: richData?.analysisReady?.teams?.home?.recent,
        away: richData?.analysisReady?.teams?.away?.recent,
        headToHead: richData?.analysisReady?.headToHead,
      },
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
