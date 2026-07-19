import { chromium, type Browser } from 'playwright';
import type { OrganizedOddsResponse, OddsMarket } from '../types/odds.event';

type MatchReference = {
  id?: number | string;
  homeTeam?: { name?: string } | string;
  awayTeam?: { name?: string } | string;
  startTimestamp?: number;
};

type ParsedEvent = {
  id: string;
  home: string;
  away: string;
  startTimestamp?: number;
  markets: OddsMarket[];
};

type BetanoOddsResponse = OrganizedOddsResponse & {
  source: 'betano';
  bookmaker: 'Betano';
  matched_event: { id: string; home: string; away: string; startTimestamp?: number };
};

const cache = new Map<string, { expiresAt: number; events: ParsedEvent[] }>();
let browserPromise: Promise<Browser> | null = null;
let collectionPromise: Promise<ParsedEvent[]> | null = null;
let lastRequestAt = 0;
let consecutiveFailures = 0;
let circuitOpenUntil = 0;
let browserIdleTimer: NodeJS.Timeout | null = null;

function enabled() {
  return process.env.BETANO_ODDS_ENABLED === 'true';
}

function text(value: unknown) {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object') {
    for (const key of ['name', 'label', 'displayName', 'title', 'value']) {
      const candidate = (value as any)[key];
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
  }
  return '';
}

function first(object: any, keys: string[]) {
  for (const key of keys) {
    const value = object?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function decimalOdd(value: any): number | undefined {
  const raw = first(value, ['decimal_odds', 'decimalOdds', 'decimal', 'price', 'odd', 'odds', 'value', 'oddsValue']);
  const nested = typeof raw === 'object' ? first(raw, ['decimal', 'value', 'odds']) : raw;
  const parsed = Number(String(nested ?? '').replace(',', '.'));
  return Number.isFinite(parsed) && parsed > 1 && parsed < 1000 ? parsed : undefined;
}

function timestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : undefined;
}

function normalizeTeam(value: unknown) {
  return text(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(?:fc|cf|sc|afc|ec|futebol clube|club de futbol)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function teamSimilarity(left: string, right: string) {
  const a = new Set(normalizeTeam(left).split(' ').filter(Boolean));
  const b = new Set(normalizeTeam(right).split(' ').filter(Boolean));
  if (!a.size || !b.size) return 0;
  const common = [...a].filter((token) => b.has(token)).length;
  return (2 * common) / (a.size + b.size);
}

function extractTeams(node: any): { home: string; away: string } | null {
  const directHome = text(first(node, ['homeTeam', 'home', 'participantHome', 'competitor1']));
  const directAway = text(first(node, ['awayTeam', 'away', 'participantAway', 'competitor2']));
  if (directHome && directAway) return { home: directHome, away: directAway };

  const participants = first(node, ['participants', 'competitors', 'teams', 'contestants']);
  if (Array.isArray(participants) && participants.length >= 2) {
    const home = participants.find((item) => /home|casa/i.test(String(first(item, ['role', 'type', 'position']) || '')));
    const away = participants.find((item) => /away|fora/i.test(String(first(item, ['role', 'type', 'position']) || '')));
    const homeName = text(home || participants[0]);
    const awayName = text(away || participants[1]);
    if (homeName && awayName) return { home: homeName, away: awayName };
  }

  const eventName = text(first(node, ['eventName', 'name', 'displayName', 'title']));
  const split = eventName.split(/\s+(?:x|vs?\.?|-|–)\s+/i);
  return split.length === 2 && split[0].trim() && split[1].trim()
    ? { home: split[0].trim(), away: split[1].trim() }
    : null;
}

function extractChoices(node: any) {
  const choices = first(node, ['selections', 'outcomes', 'options', 'choices', 'odds']);
  if (!Array.isArray(choices)) return [];
  return choices.map((choice: any) => {
    const odd = decimalOdd(choice);
    const name = text(first(choice, ['name', 'label', 'displayName', 'title', 'selectionName']));
    if (!name || !odd) return null;
    return {
      name,
      decimal_odds: odd,
      initial_decimal_odds: odd,
      fractional_odds: '',
      slip_content: String(first(choice, ['id', 'selectionId', 'outcomeId']) || ''),
    };
  }).filter(Boolean);
}

function collectMarkets(node: any, depth = 0, seen = new Set<any>()): OddsMarket[] {
  if (!node || typeof node !== 'object' || depth > 5 || seen.has(node)) return [];
  seen.add(node);
  const markets: OddsMarket[] = [];
  const choices = extractChoices(node) as any[];
  const marketName = text(first(node, ['marketName', 'name', 'label', 'displayName', 'title']));
  if (choices.length && marketName) {
    const marketId = Number(first(node, ['marketId', 'id', 'betOfferId'])) || Math.abs(hashCode(`${marketName}:${depth}`));
    markets.push({
      market_id: marketId,
      market_name: marketName,
      market_group: text(first(node, ['marketGroup', 'groupName', 'category'])) || marketName,
      market_period: text(first(node, ['marketPeriod', 'period'])) || 'Full-time',
      choice_group: text(first(node, ['choiceGroup', 'line', 'handicap'])) || undefined,
      is_live: Boolean(first(node, ['isLive', 'live'])),
      suspended: Boolean(first(node, ['suspended', 'isSuspended'])) || first(node, ['active', 'enabled']) === false,
      choices,
    });
  }

  for (const key of ['markets', 'marketGroups', 'betOffers', 'offers', 'items', 'children', 'events', 'fixtures']) {
    const child = node[key];
    if (Array.isArray(child)) child.forEach((item) => markets.push(...collectMarkets(item, depth + 1, seen)));
    else if (child && typeof child === 'object') markets.push(...collectMarkets(child, depth + 1, seen));
  }
  return markets;
}

function hashCode(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = ((hash << 5) - hash) + value.charCodeAt(index);
  return hash | 0;
}

export function parseBetanoPayload(payload: unknown): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  const seen = new Set<any>();
  const walk = (node: any, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 9 || seen.has(node)) return;
    seen.add(node);
    const teams = extractTeams(node);
    const markets = collectMarkets(node);
    if (teams && markets.length) {
      const id = String(first(node, ['eventId', 'fixtureId', 'matchId', 'id']) || `${teams.home}-${teams.away}`);
      events.push({
        id,
        ...teams,
        startTimestamp: timestamp(first(node, ['startTimestamp', 'startTime', 'startDate', 'kickoff', 'date'])),
        markets,
      });
      return;
    }
    if (Array.isArray(node)) node.forEach((item) => walk(item, depth + 1));
    else Object.values(node).forEach((item) => walk(item, depth + 1));
  };
  walk(payload);
  const unique = new Map<string, ParsedEvent>();
  for (const event of events) {
    const key = `${normalizeTeam(event.home)}:${normalizeTeam(event.away)}:${event.startTimestamp || ''}`;
    const current = unique.get(key);
    if (!current || event.markets.length > current.markets.length) unique.set(key, event);
  }
  return [...unique.values()];
}

function matchReference(reference: MatchReference, candidates: ParsedEvent[]) {
  const home = text(reference.homeTeam);
  const away = text(reference.awayTeam);
  if (!home || !away) return null;
  const ranked = candidates.map((candidate) => {
    const direct = (teamSimilarity(home, candidate.home) + teamSimilarity(away, candidate.away)) / 2;
    const swapped = (teamSimilarity(home, candidate.away) + teamSimilarity(away, candidate.home)) / 2;
    const nameScore = Math.max(direct, swapped);
    const timeDifference = reference.startTimestamp && candidate.startTimestamp
      ? Math.abs(reference.startTimestamp - candidate.startTimestamp)
      : null;
    const timeScore = timeDifference === null ? 0.5 : timeDifference <= 3 * 60 * 60 ? 1 : timeDifference <= 12 * 60 * 60 ? 0.4 : 0;
    return { candidate, score: (nameScore * 0.85) + (timeScore * 0.15), nameScore };
  }).sort((left, right) => right.score - left.score);
  return ranked[0]?.nameScore >= 0.7 && ranked[0]?.score >= 0.72 ? ranked[0].candidate : null;
}

export function matchBetanoEvent(reference: MatchReference, candidates: ParsedEvent[]) {
  return matchReference(reference, candidates);
}

async function getBrowser() {
  if (browserIdleTimer) clearTimeout(browserIdleTimer);
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: process.env.BETANO_ODDS_HEADLESS !== 'false' })
      .catch((error) => { browserPromise = null; throw error; });
  }
  return browserPromise;
}

function scheduleBrowserClose() {
  if (browserIdleTimer) clearTimeout(browserIdleTimer);
  browserIdleTimer = setTimeout(() => {
    closeBetanoOddsBrowser().catch(() => undefined);
  }, Math.max(30000, Number(process.env.BETANO_BROWSER_IDLE_TIMEOUT_MS || 120000)));
  browserIdleTimer.unref?.();
}

async function throttle() {
  const perMinute = Math.max(1, Number(process.env.BETANO_ODDS_MAX_REQUESTS_PER_MINUTE || 4));
  const minimumDelay = Math.ceil(60000 / perMinute);
  const wait = Math.max(0, minimumDelay - (Date.now() - lastRequestAt));
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();
}

async function collectPublicEvents() {
  if (Date.now() < circuitOpenUntil) throw new Error('Betano temporariamente indisponivel: circuit breaker aberto.');
  const cacheKey = 'public-football';
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.events;
  if (collectionPromise) return collectionPromise;

  collectionPromise = (async () => {
    await throttle();
    const browser = await getBrowser();
    const context = await browser.newContext({ locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
    const page = await context.newPage();
    const payloads: unknown[] = [];
    page.on('response', async (response) => {
      const contentType = String(response.headers()['content-type'] || '');
      if (response.status() === 200 && contentType.includes('json') && payloads.length < 100) {
        try { payloads.push(await response.json()); } catch { /* resposta nao era JSON valido */ }
      }
    });

    try {
      const url = process.env.BETANO_FOOTBALL_URL || 'https://www.betano.bet.br/sport/futebol/jogos-de-hoje/';
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: Number(process.env.BETANO_ODDS_TIMEOUT_MS || 45000),
      });
      if (!response || response.status() === 401 || response.status() === 403 || response.status() === 429) {
        throw new Error(`Betano bloqueou a coleta publica com HTTP ${response?.status() || 'sem resposta'}.`);
      }
      await page.waitForTimeout(Math.max(1000, Number(process.env.BETANO_ODDS_NETWORK_IDLE_MS || 5000)));
      const embedded = await page.locator('script[type="application/json"],script[type="application/ld+json"]').allTextContents();
      for (const item of embedded) {
        try { payloads.push(JSON.parse(item)); } catch { /* script nao era JSON valido */ }
      }
      const events = payloads.flatMap(parseBetanoPayload);
      if (!events.length) throw new Error('Betano respondeu, mas nenhum mercado publico reconhecivel foi encontrado.');
      consecutiveFailures = 0;
      cache.set(cacheKey, { expiresAt: Date.now() + Number(process.env.BETANO_ODDS_CACHE_TTL_MS || 300000), events });
      return events;
    } catch (error) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= Math.max(1, Number(process.env.BETANO_ODDS_CIRCUIT_FAILURES || 3))) {
        circuitOpenUntil = Date.now() + Number(process.env.BETANO_ODDS_CIRCUIT_RESET_MS || 900000);
      }
      throw error;
    } finally {
      await context.close();
      scheduleBrowserClose();
    }
  })().finally(() => { collectionPromise = null; });
  return collectionPromise;
}

export async function fetchBetanoOddsForMatch(reference: MatchReference): Promise<BetanoOddsResponse | null> {
  if (!enabled()) return null;
  const events = await collectPublicEvents();
  const event = matchReference(reference, events);
  if (!event) return null;
  const marketsByGroup: OrganizedOddsResponse['markets_by_group'] = {};
  for (const market of event.markets) {
    const group = market.market_group || market.market_name;
    if (!marketsByGroup[group]) {
      marketsByGroup[group] = {
        group_info: { market_group: group, market_period: market.market_period, total_markets: 0, total_choices: 0, market_ids: [] },
        markets: [],
      };
    }
    marketsByGroup[group].markets.push({ ...market, choices: market.choices.map((choice) => ({ ...choice, bookmaker: 'Betano' } as any)) });
    marketsByGroup[group].group_info.total_markets += 1;
    marketsByGroup[group].group_info.total_choices = (marketsByGroup[group].group_info.total_choices || 0) + market.choices.length;
    marketsByGroup[group].group_info.market_ids?.push(market.market_id);
  }
  return {
    source: 'betano',
    bookmaker: 'Betano',
    event_id: Number(event.id) || Math.abs(hashCode(event.id)),
    matched_event: { id: event.id, home: event.home, away: event.away, startTimestamp: event.startTimestamp },
    markets_by_group: marketsByGroup,
    summary: {
      total_markets: event.markets.length,
      market_groups: Object.keys(marketsByGroup),
      is_live: event.markets.some((market) => market.is_live),
      has_suspended_markets: event.markets.some((market) => market.suspended),
    },
    scraped_at: new Date().toISOString(),
  };
}

export function betanoOddsEnabled() {
  return enabled();
}

export async function closeBetanoOddsBrowser() {
  if (browserIdleTimer) clearTimeout(browserIdleTimer);
  browserIdleTimer = null;
  const browser = browserPromise ? await browserPromise.catch(() => null) : null;
  browserPromise = null;
  if (browser) await browser.close();
}
