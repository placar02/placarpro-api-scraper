import type { NormalizedEvent } from '../types/event';
import { chromium, type Browser, type Page } from 'playwright';

const BASE_URL = process.env.FOOTYSTATS_BASE_URL || 'https://api.football-data-api.com';
const API_KEY = process.env.FOOTYSTATS_API_KEY || '';
const TIMEZONE = process.env.FOOTYSTATS_TIMEZONE || process.env.MATCHES_TIMEZONE || 'America/Sao_Paulo';
const MAX_PAGES = Number(process.env.FOOTYSTATS_MATCH_SEARCH_PAGES || 4);
const WEB_BASE_URL = process.env.FOOTYSTATS_WEB_BASE_URL || 'https://footystats.org';
const WEB_TIMEOUT_MS = Number(process.env.FOOTYSTATS_WEB_TIMEOUT_MS || 30000);
const USE_PLAYWRIGHT = process.env.FOOTYSTATS_USE_PLAYWRIGHT !== 'false';

let browserPromise: Promise<Browser> | null = null;

type FootyStatsResponse = {
  success?: boolean;
  data?: any;
  pager?: {
    current_page?: number;
    max_page?: number;
    total_results?: number;
  };
  message?: string;
  error?: string;
};

function isEnabled() {
  return API_KEY.trim().length > 0;
}

function isWebEnabled() {
  return USE_PLAYWRIGHT;
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: ['--disable-blink-features=AutomationControlled'],
    });
  }

  return browserPromise;
}

async function withFootyStatsPage<T>(callback: (page: Page) => Promise<T>): Promise<T> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    locale: 'en-US',
    timezoneId: TIMEZONE,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(WEB_TIMEOUT_MS);

  try {
    return await callback(page);
  } finally {
    await context.close().catch(() => undefined);
  }
}

function toDateKey(timestamp?: number) {
  const date = timestamp ? new Date(timestamp * 1000) : new Date();
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function normalizeName(value: unknown) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(fc|sc|cf|afc|women|w|u19|u20|u21|u23)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokenSet(value: string) {
  return new Set(normalizeName(value).split(' ').filter((token) => token.length >= 3));
}

function nameScore(a: string, b: string) {
  const left = normalizeName(a);
  const right = normalizeName(b);
  if (!left || !right) return 0;
  if (left === right) return 100;
  if (left.includes(right) || right.includes(left)) return 80;

  const leftTokens = tokenSet(left);
  const rightTokens = tokenSet(right);
  if (!leftTokens.size || !rightTokens.size) return 0;

  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }

  return Math.round((overlap / Math.max(leftTokens.size, rightTokens.size)) * 70);
}

function getMatchTeamNames(match: any) {
  return {
    home: match.home_name || match.homeName || match.team_a_name || match.homeTeam?.name || match.team_a || '',
    away: match.away_name || match.awayName || match.team_b_name || match.awayTeam?.name || match.team_b || '',
  };
}

function scoreMatchCandidate(event: NormalizedEvent, match: any) {
  const names = getMatchTeamNames(match);
  const directScore = nameScore(event.homeTeam.name, names.home) + nameScore(event.awayTeam.name, names.away);
  const swappedScore = nameScore(event.homeTeam.name, names.away) + nameScore(event.awayTeam.name, names.home);
  const teamScore = Math.max(directScore, swappedScore);
  const footyTimestamp = Number(match.date_unix || match.dateUnix || match.timestamp || 0);
  const timeDeltaHours = event.startTime && footyTimestamp
    ? Math.abs(event.startTime - footyTimestamp) / 3600
    : 0;
  const timePenalty = timeDeltaHours > 48 ? 25 : timeDeltaHours > 24 ? 15 : timeDeltaHours > 6 ? 5 : 0;

  return {
    score: teamScore - timePenalty,
    swapped: swappedScore > directScore,
    timeDeltaHours,
  };
}

function createUrl(path: string, params: Record<string, string | number | undefined> = {}) {
  const url = new URL(`${BASE_URL}${path}`);
  url.searchParams.set('key', API_KEY);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }
  return url;
}

async function fetchFootyStats(path: string, params: Record<string, string | number | undefined> = {}) {
  if (!isEnabled()) {
    throw new Error('FOOTYSTATS_API_KEY is not configured');
  }

  const url = createUrl(path, params);
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'PlacarPro/1.0',
    },
  });

  if (!response.ok) {
    throw new Error(`FootyStats HTTP ${response.status}: ${response.statusText}`);
  }

  const json = await response.json() as FootyStatsResponse;
  if (json.success === false) {
    throw new Error(json.message || json.error || 'FootyStats returned success=false');
  }

  return json;
}

async function fetchMatchesByDate(date: string) {
  const matches: any[] = [];

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await fetchFootyStats('/todays-matches', {
      date,
      timezone: TIMEZONE,
      page,
    });
    const data = Array.isArray(response.data) ? response.data : [];
    matches.push(...data);

    const maxPage = Number(response.pager?.max_page || 1);
    if (page >= maxPage || !data.length) break;
  }

  return matches;
}

async function findMatchingFootyStatsMatch(event: NormalizedEvent) {
  const date = toDateKey(event.startTime);
  const matches = await fetchMatchesByDate(date);
  const scored = matches
    .map((match) => ({ match, ...scoreMatchCandidate(event, match) }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0];

  if (!best || best.score < 95) {
    return {
      date,
      matchesChecked: matches.length,
      match: null,
      score: best?.score || 0,
      bestCandidate: best?.match,
    };
  }

  return {
    date,
    matchesChecked: matches.length,
    match: best.match,
    score: best.score,
    swapped: best.swapped,
    timeDeltaHours: best.timeDeltaHours,
  };
}

async function fetchMatchDetails(matchId: number | string) {
  return fetchFootyStats('/match', { match_id: matchId });
}

async function fetchLeagueTeams(seasonId: number | string | undefined) {
  if (!seasonId) return null;
  return fetchFootyStats('/league-teams', { season_id: seasonId, include: 'stats' }).catch(() => null);
}

async function fetchLeagueReferees(seasonId: number | string | undefined, maxTime?: number) {
  if (!seasonId) return null;
  return fetchFootyStats('/league-referees', { season_id: seasonId, max_time: maxTime }).catch(() => null);
}

async function fetchReferee(refereeId: number | string | undefined) {
  if (!refereeId || Number(refereeId) <= 0) return null;
  return fetchFootyStats('/referee', { referee_id: refereeId }).catch(() => null);
}

function pickTeam(data: any, teamId: unknown, teamName: string) {
  const teams = Array.isArray(data?.data) ? data.data : [];
  return teams.find((team: any) => String(team.id) === String(teamId))
    || teams
      .map((team: any) => ({ team, score: nameScore(teamName, team.name || team.full_name || team.english_name) }))
      .sort((a, b) => b.score - a.score)[0]?.team;
}

function pickReferee(data: any, refereeId: unknown) {
  const refs = Array.isArray(data?.data) ? data.data : [];
  return refs.find((ref: any) => String(ref.id) === String(refereeId));
}

function cleanStatNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function summarizeMatchDetails(match: any) {
  if (!match) return null;

  return {
    id: match.id,
    status: match.status,
    dateUnix: match.date_unix,
    competitionId: match.competition_id,
    homeID: match.homeID,
    awayID: match.awayID,
    refereeID: match.refereeID,
    score: {
      home: cleanStatNumber(match.homeGoalCount),
      away: cleanStatNumber(match.awayGoalCount),
      total: cleanStatNumber(match.totalGoalCount ?? match.overallGoalCount),
      htHome: cleanStatNumber(match.ht_goals_team_a),
      htAway: cleanStatNumber(match.ht_goals_team_b),
    },
    preMatch: {
      bttsPotential: cleanStatNumber(match.btts_potential),
      over15Potential: cleanStatNumber(match.o15_potential),
      over25Potential: cleanStatNumber(match.o25_potential),
      over35Potential: cleanStatNumber(match.o35_potential),
      under25Potential: cleanStatNumber(match.u25_potential),
      cornersPotential: cleanStatNumber(match.corners_potential),
      cardsPotential: cleanStatNumber(match.cards_potential),
      averageGoalsPotential: cleanStatNumber(match.avg_potential),
      homePPG: cleanStatNumber(match.pre_match_home_ppg ?? match.home_ppg),
      awayPPG: cleanStatNumber(match.pre_match_away_ppg ?? match.away_ppg),
      cornersOver85Potential: cleanStatNumber(match.corners_o85_potential),
      cornersOver95Potential: cleanStatNumber(match.corners_o95_potential),
      cornersOver105Potential: cleanStatNumber(match.corners_o105_potential),
    },
    matchStats: {
      corners: {
        home: cleanStatNumber(match.team_a_corners),
        away: cleanStatNumber(match.team_b_corners),
        total: cleanStatNumber(match.totalCornerCount),
      },
      cards: {
        homeYellow: cleanStatNumber(match.team_a_yellow_cards),
        awayYellow: cleanStatNumber(match.team_b_yellow_cards),
        homeRed: cleanStatNumber(match.team_a_red_cards),
        awayRed: cleanStatNumber(match.team_b_red_cards),
        homeTotal: cleanStatNumber(match.team_a_cards_num),
        awayTotal: cleanStatNumber(match.team_b_cards_num),
      },
      shots: {
        home: cleanStatNumber(match.team_a_shots),
        away: cleanStatNumber(match.team_b_shots),
        homeOnTarget: cleanStatNumber(match.team_a_shotsOnTarget),
        awayOnTarget: cleanStatNumber(match.team_b_shotsOnTarget),
        homeOffTarget: cleanStatNumber(match.team_a_shotsOffTarget),
        awayOffTarget: cleanStatNumber(match.team_b_shotsOffTarget),
      },
      fouls: {
        home: cleanStatNumber(match.team_a_fouls),
        away: cleanStatNumber(match.team_b_fouls),
      },
      possession: {
        home: cleanStatNumber(match.team_a_possession),
        away: cleanStatNumber(match.team_b_possession),
      },
      offsides: {
        home: cleanStatNumber(match.team_a_offsides),
        away: cleanStatNumber(match.team_b_offsides),
      },
    },
    trends: match.trends,
    h2h: match.h2h,
    cardDetails: {
      home: match.team_a_card_details,
      away: match.team_b_card_details,
    },
    lineups: match.lineups,
    bench: match.bench,
  };
}

function summarizeTeamStats(team: any) {
  if (!team) return null;

  return {
    id: team.id,
    name: team.name || team.full_name || team.english_name,
    tablePosition: team.table_position,
    performanceRank: team.performance_rank,
    risk: team.risk,
    matchesPlayed: {
      overall: cleanStatNumber(team.seasonMatchesPlayed_overall),
      home: cleanStatNumber(team.seasonMatchesPlayed_home),
      away: cleanStatNumber(team.seasonMatchesPlayed_away),
    },
    ppg: {
      overall: cleanStatNumber(team.seasonPPG_overall),
      home: cleanStatNumber(team.seasonPPG_home),
      away: cleanStatNumber(team.seasonPPG_away),
    },
    goals: {
      scoredOverall: cleanStatNumber(team.seasonGoals_overall),
      concededOverall: cleanStatNumber(team.seasonConceded_overall),
      avgOverall: cleanStatNumber(team.seasonAVG_overall),
      scoredAvgOverall: cleanStatNumber(team.seasonScoredAVG_overall),
      concededAvgOverall: cleanStatNumber(team.seasonConcededAVG_overall),
    },
    btts: {
      countOverall: cleanStatNumber(team.seasonBTTS_overall),
      percentageOverall: cleanStatNumber(team.seasonBTTSPercentage_overall),
    },
    cleanSheets: {
      countOverall: cleanStatNumber(team.seasonCS_overall),
      percentageOverall: cleanStatNumber(team.seasonCSPercentage_overall),
    },
    failedToScore: {
      countOverall: cleanStatNumber(team.seasonFTS_overall),
      percentageOverall: cleanStatNumber(team.seasonFTSPercentage_overall),
    },
    corners: {
      forAVGOverall: cleanStatNumber(team.cornersAVG_overall ?? team.cornersAVG),
      againstAVGOverall: cleanStatNumber(team.cornersAgainstAVG_overall),
      totalAVGOverall: cleanStatNumber(team.cornersTotalAVG_overall),
    },
    cards: {
      forAVGOverall: cleanStatNumber(team.cardsAVG_overall ?? team.cardsAVG),
      againstAVGOverall: cleanStatNumber(team.cardsAgainstAVG_overall),
      totalAVGOverall: cleanStatNumber(team.cardsTotalAVG_overall),
    },
    rawStatsAvailable: Boolean(team.stats || Object.keys(team).length > 20),
  };
}

function summarizeReferee(referee: any) {
  if (!referee) return null;

  return {
    id: referee.id,
    name: referee.full_name || referee.known_as || [referee.first_name, referee.last_name].filter(Boolean).join(' '),
    nationality: referee.nationality,
    appearances: cleanStatNumber(referee.appearances_overall),
    cardsPerMatch: cleanStatNumber(referee.cards_per_match_overall),
    cardsOverall: cleanStatNumber(referee.cards_overall),
    yellowCardsOverall: cleanStatNumber(referee.yellow_cards_overall),
    redCardsOverall: cleanStatNumber(referee.red_cards_overall),
    minPerCard: cleanStatNumber(referee.min_per_card_overall),
    penaltiesPerMatch: cleanStatNumber(referee.penalties_given_per_match_overall),
    overCards: {
      over25Percentage: cleanStatNumber(referee.over25_cards_percentage_overall),
      over35Percentage: cleanStatNumber(referee.over35_cards_percentage_overall),
      over45Percentage: cleanStatNumber(referee.over45_cards_percentage_overall),
      over55Percentage: cleanStatNumber(referee.over55_cards_percentage_overall),
    },
  };
}

function buildFootyStatsPathCandidates(event: NormalizedEvent) {
  const candidates = new Set<string>(['/matches']);
  const tournamentName = normalizeName(event.tournament?.name);
  const tournamentSlug = normalizeName(event.tournament?.slug).replace(/\s+/g, '-');

  if (tournamentName.includes('world cup') || tournamentName.includes('copa do mundo')) {
    candidates.add('/international/fifa-world-cup');
  }

  if (tournamentName.includes('uefa champions league')) {
    candidates.add('/europe/uefa-champions-league');
  }

  if (tournamentName.includes('uefa europa league')) {
    candidates.add('/europe/uefa-europa-league');
  }

  if (tournamentName.includes('copa libertadores') || tournamentName.includes('libertadores')) {
    candidates.add('/south-america/copa-libertadores');
  }

  if (tournamentName.includes('brasileirao') || tournamentName.includes('brasileiro serie a')) {
    candidates.add('/brazil/serie-a');
  }

  if (tournamentSlug) {
    candidates.add(`/international/${tournamentSlug}`);
    candidates.add(`/europe/${tournamentSlug}`);
    candidates.add(`/brazil/${tournamentSlug}`);
  }

  return [...candidates];
}

function parseFootyStatsMatchId(className: string, href: string) {
  const fromClass = String(className || '').match(/\bz(\d{4,})\b/);
  if (fromClass) return fromClass[1];

  const fromHref = String(href || '').match(/(\d{4,})/);
  return fromHref?.[1];
}

async function extractFixtureCandidates(page: Page, sourcePath: string) {
  return page.locator('a.match').evaluateAll((items, path) => items.map((item) => {
    const element = item as HTMLElement;
    const href = element.getAttribute('href') || '';
    const dateNode = element.querySelector('.date') as HTMLElement | null;
    const odds = Array.from(element.querySelectorAll('.odds')).map((node) => node.textContent?.trim()).filter(Boolean);
    const homeNode = element.querySelector('.team.home');
    const awayNode = element.querySelector('.team.away');
    const homeFormNode = element.querySelector('.team.home .form-box') || element.querySelector('.home .form-box');
    const awayFormNode = element.querySelector('.team.away .form-box') || element.querySelector('.away .form-box');
    const statusNode = element.querySelector('.status');

    return {
      sourcePath: path,
      href,
      className: element.className,
      dataTime: dateNode?.getAttribute('data-time') || element.getAttribute('data-time') || '',
      home: homeNode?.textContent?.replace(/\s+/g, ' ').trim() || '',
      away: awayNode?.textContent?.replace(/\s+/g, ' ').trim() || '',
      homeFormValue: homeFormNode?.textContent?.replace(/\s+/g, ' ').trim() || '',
      awayFormValue: awayFormNode?.textContent?.replace(/\s+/g, ' ').trim() || '',
      odds,
      status: statusNode?.textContent?.replace(/\s+/g, ' ').trim() || '',
      text: element.textContent?.replace(/\s+/g, ' ').trim() || '',
    };
  }), sourcePath);
}

async function findMatchingFootyStatsWebMatch(event: NormalizedEvent) {
  const paths = buildFootyStatsPathCandidates(event);
  const checked: Array<{ path: string; fixtures: number; error?: string }> = [];
  const allFixtures: any[] = [];

  await withFootyStatsPage(async (page) => {
    for (const path of paths) {
      const url = new URL(path, WEB_BASE_URL).toString();

      try {
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: WEB_TIMEOUT_MS });
        if (!response || response.status() >= 400) {
          checked.push({ path, fixtures: 0, error: `HTTP ${response?.status() || 'unknown'}` });
          continue;
        }

        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined);
        const fixtures = await extractFixtureCandidates(page, path);
        checked.push({ path, fixtures: fixtures.length });
        allFixtures.push(...fixtures);
      } catch (err) {
        checked.push({ path, fixtures: 0, error: err instanceof Error ? err.message : String(err) });
      }
    }
  });

  const uniqueFixtures = [...new Map(allFixtures.map((fixture) => [fixture.href || fixture.text, fixture])).values()];
  const scored = uniqueFixtures
    .map((fixture) => {
      const dataTime = Number(fixture.dataTime || 0);
      const match = {
        ...fixture,
        id: parseFootyStatsMatchId(fixture.className, fixture.href),
        home_name: fixture.home,
        away_name: fixture.away,
        date_unix: dataTime,
      };
      return { match, ...scoreMatchCandidate(event, match) };
    })
    .sort((a, b) => b.score - a.score);
  const best = scored[0];

  if (!best || best.score < 95) {
    return {
      date: toDateKey(event.startTime),
      pathsChecked: checked,
      matchesChecked: uniqueFixtures.length,
      match: null,
      score: best?.score || 0,
      bestCandidate: best?.match,
    };
  }

  return {
    date: toDateKey(event.startTime),
    pathsChecked: checked,
    matchesChecked: uniqueFixtures.length,
    match: best.match,
    score: best.score,
    swapped: best.swapped,
    timeDeltaHours: best.timeDeltaHours,
  };
}

function firstNumber(text: string, patterns: RegExp[]) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const parsed = Number(match[1]);
    if (Number.isFinite(parsed)) return parsed;
  }

  return undefined;
}

function extractRecentResults(text: string, teamName: string) {
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const normalizedTeam = normalizeName(teamName);
  const results: string[] = [];

  for (const line of lines) {
    if (results.length >= 8) break;
    const normalizedLine = normalizeName(line);
    if (!normalizedLine.includes(normalizedTeam)) continue;
    if (!/\b\d+\s*-\s*\d+\b/.test(line)) continue;
    results.push(line.replace(/\s+/g, ' '));
  }

  return results;
}

function extractTeamPublicStats(text: string, teamName: string) {
  const normalizedTeam = normalizeName(teamName);
  const teamTokens = normalizedTeam.split(' ').filter((token) => token.length >= 3);
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const currentFormIndex = lines.findIndex((line) => normalizeName(line) === 'current form');
  const matchingIndexes = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line, index }) => {
    const normalizedLine = normalizeName(line);
    if (normalizedLine.includes(' vs ')) return false;
    const wordCount = normalizedLine.split(' ').filter(Boolean).length;
    const isTeamLine = normalizedLine === normalizedTeam
      || normalizedLine === `${normalizedTeam} national team`
      || normalizedLine === `${normalizedTeam} team`
      || normalizedLine.startsWith(`${normalizedTeam} national`)
      || (wordCount <= 4 && teamTokens.some((token) => normalizedLine.includes(token)));
    const hasStatsBlock = lines.slice(index, index + 8).some((nearbyLine) => /^Recent\s*:/i.test(nearbyLine));

    return isTeamLine && hasStatsBlock;
    })
    .map((item) => item.index);
  const teamLineIndex = [...matchingIndexes]
    .filter((index) => currentFormIndex < 0 || index < currentFormIndex)
    .pop() ?? matchingIndexes[0] ?? -1;
  const nextTeamIndex = teamLineIndex >= 0
    ? lines.findIndex((line, index) => index > teamLineIndex && /National Team| Club$| FC$| SC$| Team$/i.test(line))
    : -1;
  const block = teamLineIndex >= 0
    ? lines.slice(teamLineIndex, nextTeamIndex > teamLineIndex ? nextTeamIndex : teamLineIndex + 80)
    : [];
  const valueAfter = (label: string, offset = 1) => {
    const index = block.findIndex((line) => normalizeName(line) === normalizeName(label));
    if (index < 0) return undefined;
    return cleanStatNumber(String(block[index + offset] || '').replace('%', ''));
  };
  const ppgIndex = block.findIndex((line) => normalizeName(line) === 'overall');
  const recentLine = block.find((line) => /^Recent\s*:/i.test(line));

  return {
    recentResults: extractRecentResults(text, teamName),
    recentSummary: recentLine,
    ppg: ppgIndex >= 0 ? cleanStatNumber(block[ppgIndex + 2]) : undefined,
    homePPG: ppgIndex >= 0 ? cleanStatNumber(block[ppgIndex + 5]) : undefined,
    awayPPG: ppgIndex >= 0 ? cleanStatNumber(block[ppgIndex + 8]) : undefined,
    winPercentage: valueAfter('Win %'),
    averageGoals: valueAfter('AVG'),
    scoredPerMatch: valueAfter('Scored'),
    concededPerMatch: valueAfter('Conceded'),
    bttsPercentage: valueAfter('BTTS'),
    cleanSheetPercentage: valueAfter('CS'),
    failedToScorePercentage: valueAfter('FTS'),
    xg: valueAfter('xG'),
    xga: valueAfter('xGA'),
  };
}

function extractPublicMatchStats(text: string, event: NormalizedEvent) {
  const compact = text.replace(/\s+/g, ' ');
  const cardsLocked = /unlock cards|data for premium members only/i.test(text);
  const cornersLocked = /unlock corners|data for premium members only/i.test(text);

  return {
    preMatch: {
      over05Potential: firstNumber(compact, [/(\d+)%\s*Over\s*0\.5/i]),
      over15Potential: firstNumber(compact, [/(\d+)%\s*Over\s*1\.5/i]),
      over25Potential: firstNumber(compact, [/(\d+)%\s*Over\s*2\.5/i]),
      over35Potential: firstNumber(compact, [/(\d+)%\s*Over\s*3\.5/i]),
      over45Potential: firstNumber(compact, [/(\d+)%\s*Over\s*4\.5/i]),
      bttsPotential: firstNumber(compact, [/(\d+)%\s*BTTS/i]),
      averageGoalsPotential: firstNumber(compact, [/([\d.]+)\s*Goals\s*\/\s*Match/i]),
    },
    publicTeams: {
      home: extractTeamPublicStats(text, event.homeTeam.name),
      away: extractTeamPublicStats(text, event.awayTeam.name),
    },
    publicAccess: {
      cards: {
        available: !cardsLocked,
        locked: cardsLocked,
        reason: cardsLocked ? 'FootyStats public page requires premium access for cards' : undefined,
      },
      corners: {
        available: !cornersLocked,
        locked: cornersLocked,
        reason: cornersLocked ? 'FootyStats public page requires premium access for corners' : undefined,
      },
      referee: {
        available: false,
        reason: 'Referee history is not visible on the public FootyStats page without API/premium data',
      },
    },
    pageTextExcerpt: text.slice(0, 12000),
  };
}

async function fetchFootyStatsWebEnrichment(event: NormalizedEvent) {
  if (!isWebEnabled()) {
    return {
      available: false,
      source: 'footystats',
      access: 'disabled',
      reason: 'FOOTYSTATS_API_KEY is not configured and FOOTYSTATS_USE_PLAYWRIGHT=false',
    };
  }

  const matchSearch = await findMatchingFootyStatsWebMatch(event);
  if (!matchSearch.match?.href) {
    return {
      available: false,
      source: 'footystats-web',
      access: 'public-playwright',
      reason: 'No public FootyStats match page found for event date/team names',
      matchSearch,
    };
  }

  const matchUrl = new URL(matchSearch.match.href, WEB_BASE_URL).toString();
  const pageData = await withFootyStatsPage(async (page) => {
    const response = await page.goto(matchUrl, { waitUntil: 'domcontentloaded', timeout: WEB_TIMEOUT_MS });
    if (!response || response.status() >= 400) {
      throw new Error(`FootyStats public match page HTTP ${response?.status() || 'unknown'}`);
    }

    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined);
    const title = await page.title().catch(() => '');
    const text = await page.locator('body').innerText({ timeout: WEB_TIMEOUT_MS });

    return {
      title,
      text,
    };
  });

  const publicStats = extractPublicMatchStats(pageData.text, event);

  return {
    available: true,
    source: 'footystats-web',
    access: 'public-playwright',
    matchSearch: {
      date: matchSearch.date,
      pathsChecked: matchSearch.pathsChecked,
      matchesChecked: matchSearch.matchesChecked,
      score: matchSearch.score,
      swapped: matchSearch.swapped,
      timeDeltaHours: matchSearch.timeDeltaHours,
    },
    match: {
      id: matchSearch.match.id,
      url: matchUrl,
      title: pageData.title,
      dateUnix: cleanStatNumber(matchSearch.match.date_unix),
      home: matchSearch.match.home,
      away: matchSearch.match.away,
      fixtureForm: {
        homePPG: cleanStatNumber(matchSearch.match.homeFormValue),
        awayPPG: cleanStatNumber(matchSearch.match.awayFormValue),
      },
      preMatch: publicStats.preMatch,
      publicAccess: publicStats.publicAccess,
      publicTextExcerpt: publicStats.pageTextExcerpt,
    },
    teams: publicStats.publicTeams,
    referee: null,
    raw: {
      matchedFixture: matchSearch.match,
      matchPageTitle: pageData.title,
    },
  };
}

async function fetchFootyStatsApiEnrichment(event: NormalizedEvent) {
  if (!isEnabled()) {
    return fetchFootyStatsWebEnrichment(event);
  }

  const matchSearch = await findMatchingFootyStatsMatch(event);
  if (!matchSearch.match?.id) {
    return {
      available: false,
      source: 'footystats',
      reason: 'No FootyStats match found for event date/team names',
      matchSearch,
    };
  }

  const detailsResponse = await fetchMatchDetails(matchSearch.match.id);
  const details = Array.isArray(detailsResponse.data) ? detailsResponse.data[0] : detailsResponse.data;
  const match = details || matchSearch.match;
  const seasonId = match.competition_id || matchSearch.match.competition_id;
  const [leagueTeams, leagueReferees, referee] = await Promise.all([
    fetchLeagueTeams(seasonId),
    fetchLeagueReferees(seasonId, event.startTime),
    fetchReferee(match.refereeID),
  ]);
  const homeTeam = pickTeam(leagueTeams, match.homeID, event.homeTeam.name);
  const awayTeam = pickTeam(leagueTeams, match.awayID, event.awayTeam.name);
  const leagueReferee = pickReferee(leagueReferees, match.refereeID);

  return {
    available: true,
    source: 'footystats',
    matchSearch: {
      date: matchSearch.date,
      matchesChecked: matchSearch.matchesChecked,
      score: matchSearch.score,
      swapped: matchSearch.swapped,
      timeDeltaHours: matchSearch.timeDeltaHours,
    },
    match: summarizeMatchDetails(match),
    teams: {
      home: summarizeTeamStats(homeTeam),
      away: summarizeTeamStats(awayTeam),
    },
    referee: summarizeReferee((Array.isArray(referee?.data) ? referee.data[0] : referee?.data) || leagueReferee),
    raw: {
      matchedFixture: matchSearch.match,
      matchDetails: detailsResponse.data,
      leagueTeams: leagueTeams?.data,
      leagueReferees: leagueReferees?.data,
      referee: referee?.data,
    },
  };
}

export async function fetchFootyStatsEnrichment(event: NormalizedEvent) {
  return isEnabled()
    ? fetchFootyStatsApiEnrichment(event)
    : fetchFootyStatsWebEnrichment(event);
}

export function isFootyStatsConfigured() {
  return isEnabled() || isWebEnabled();
}
