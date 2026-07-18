import { createHash } from 'node:crypto';
import { fetchEvent, SofaScoreBlockedError } from '../scrapers/event';
import { fetchAiScoreIncidents, fetchAiScoreLineups, fetchAiScoreOdds, fetchAiScoreStatistics, fetchAiScoreStreaks } from '../scrapers/aiscore';
import { fetchIncidents } from '../scrapers/incidents';
import { fetchLineups } from '../scrapers/lineups';
import { fetchOdds } from '../scrapers/odds';
import { fetchOgolIncidents, fetchOgolLineups, fetchOgolOdds, fetchOgolStatistics, fetchOgolStreaks } from '../scrapers/ogol';
import { fetch365Enrichment } from '../scrapers/scores365-enrichment';
import { fetch365Odds } from '../scrapers/scores365';
import { fetchStatistics } from '../scrapers/statistics';
import { fetchStreaks } from '../scrapers/streaks';
import { fetchTopPlayers } from '../scrapers/top-players';
import { applySelectiveDecisionGate, buildStatisticalDecision, normalizeUnavailableData, NO_RECOMMENDATION, OPTIONAL_DATA_UNAVAILABLE } from './decision-engine';
import type { AnalysisResult, AnalyzeOptions, BettingRecommendation } from '../types/analysis';

interface LLMAnalysisInput {
  event: any;
  odds?: any;
  statistics?: any;
  incidents?: any;
  lineups?: any;
  streaks?: any;
  topPlayers?: any;
  refereeProfile?: any;
  playerProps?: any;
  scores365?: any;
  teamForm?: any;
  dataQuality?: any;
  backendDecision?: any;
  explanationOnly?: boolean;
}

interface LLMAnalysisResponse {
  result: AnalysisResult | null;
  error?: string;
}

const azureResponseCache = new Map<string, { expiresAt: number; value: LLMAnalysisResponse }>();
const azureInFlight = new Map<string, Promise<LLMAnalysisResponse>>();
let activeAzureRequests = 0;
const azureWaiters: Array<() => void> = [];
let azureRateLimitedUntil = 0;
let azureRateLimitReason = '';

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withAzureSlot<T>(task: () => Promise<T>): Promise<T> {
  const concurrency = Math.max(1, Number(process.env.AZURE_OPENAI_CONCURRENCY || 1));
  if (activeAzureRequests >= concurrency) {
    await new Promise<void>((resolve) => azureWaiters.push(resolve));
  }
  activeAzureRequests += 1;
  try {
    return await task();
  } finally {
    activeAzureRequests -= 1;
    azureWaiters.shift()?.();
  }
}

function azureInputKey(input: LLMAnalysisInput) {
  return createHash('sha256')
    .update(`${process.env.AZURE_OPENAI_DEPLOYMENT_NAME || ''}:${JSON.stringify(input)}`)
    .digest('hex');
}

function pruneAzureCache() {
  while (azureResponseCache.size > 200) {
    const firstKey = azureResponseCache.keys().next().value;
    if (!firstKey) break;
    azureResponseCache.delete(firstKey);
  }
}

function compactReasoningValue(value: any, depth = 0, aggressive = false): any {
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.slice(0, aggressive ? 120 : 240);
  if (Array.isArray(value)) {
    const limit = aggressive ? 6 : depth <= 2 ? 12 : 8;
    return value.slice(0, limit).map((item) => compactReasoningValue(item, depth + 1, aggressive));
  }
  if (typeof value === 'object') {
    const ignored = new Set(['raw', 'rawResponse', 'profileText', 'textLines', 'pages', 'allTables', 'allStatistics']);
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !ignored.has(key))
      .slice(0, aggressive ? 24 : 40)
      .map(([key, item]) => [key, compactReasoningValue(item, depth + 1, aggressive)]));
  }
  return String(value);
}

export function compactReasoningInput(input: LLMAnalysisInput) {
  const maxChars = Math.max(8000, Number(process.env.AZURE_OPENAI_MAX_INPUT_CHARS || 24000));
  let compact = compactReasoningValue(input);
  if (JSON.stringify(compact).length > maxChars) compact = compactReasoningValue(input, 0, true);
  return compact;
}

export async function fetchAzureWithRetry(url: string, requestBody: unknown, apiKey: string, timeoutMs: number) {
  const retries = Math.max(0, Number(process.env.AZURE_OPENAI_RETRIES || 0));
  const baseDelayMs = Math.max(250, Number(process.env.AZURE_OPENAI_RETRY_BASE_MS || 2000));

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= retries) return response;

      const retryAfterMs = Number(response.headers.get('x-ms-retry-after-ms') || 0);
      const retryAfterSeconds = Number(response.headers.get('retry-after') || 0);
      const backoffMs = Math.min(60000, Math.max(
        retryAfterMs,
        retryAfterSeconds * 1000,
        baseDelayMs * (2 ** attempt) + Math.floor(Math.random() * 500),
      ));
      await response.text().catch(() => '');
      console.warn(`Azure OpenAI ${response.status}; nova tentativa ${attempt + 2}/${retries + 1} em ${backoffMs}ms.`);
      await delay(backoffMs);
    } catch (error) {
      if (attempt >= retries) throw error;
      const backoffMs = Math.min(60000, baseDelayMs * (2 ** attempt) + Math.floor(Math.random() * 500));
      console.warn(`Azure OpenAI request failed; retrying in ${backoffMs}ms:`, error instanceof Error ? error.message : String(error));
      await delay(backoffMs);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error('Azure OpenAI retry loop exhausted');
}

function buildRecommendation(data: Partial<BettingRecommendation>): BettingRecommendation {
  const confidence = typeof data.confidence === 'number'
    ? data.confidence <= 1 ? Math.round(data.confidence * 100) : data.confidence
    : 0;

  return {
    market: data.market || 'unknown',
    recommendation: data.recommendation || 'No recommendation',
    confidence,
    rationale: data.rationale || '',
    riskLevel: data.riskLevel,
    dataSupport: Array.isArray(data.dataSupport) ? data.dataSupport : undefined,
    warningSigns: Array.isArray(data.warningSigns) ? data.warningSigns : undefined,
    meta: data.meta,
  };
}

async function safeFetch<T>(label: string, loader: () => Promise<T>): Promise<T | null> {
  try {
    return await loader();
  } catch (err) {
    console.warn(`[Analysis] Could not fetch ${label}:`, formatError(err));
    return null;
  }
}

function limitArray<T>(items: T[] | undefined, max: number): T[] {
  return Array.isArray(items) ? items.slice(0, max) : [];
}

function summarizeOdds(oddsResp: any) {
  if (!oddsResp?.markets_by_group) return undefined;

  const groups = Object.values(oddsResp.markets_by_group).slice(0, 8);
  return {
    summary: oddsResp.summary,
    markets: groups.flatMap((group: any) =>
      limitArray(group.markets, 4).map((market: any) => ({
        market: market.market_name || market.market_group,
        period: market.market_period,
        line: market.choice_group,
        suspended: market.suspended,
        choices: limitArray(market.choices, 6).map((choice: any) => ({
          name: choice.name,
          odd: choice.decimal_odds,
          change: choice.change,
        })),
      }))
    ),
  };
}

function normalizeOddText(value: unknown): string {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\bmais de\b/g, 'over')
    .replace(/\bmenos de\b/g, 'under')
    .replace(/\bambas marcam\b/g, 'both teams score')
    .replace(/\bempate anula\b/g, 'draw no bet')
    .replace(/[^a-z0-9.]+/g, ' ')
    .trim();
}

function flattenOddsChoices(oddsResp: any) {
  const groups = Object.values(oddsResp?.markets_by_group || {});
  const choices: Array<{ marketName: string; choiceName: string; decimalOdd: number; meta: Record<string, unknown> }> = [];

  for (const group of groups) {
    for (const market of (group as any).markets || []) {
      for (const choice of market.choices || []) {
        const decimalOdd = Number(choice.decimal_odds);
        if (!Number.isFinite(decimalOdd) || decimalOdd <= 1) continue;

        choices.push({
          marketName: market.market_name || market.market_group || 'odds-market',
          choiceName: choice.name || '',
          decimalOdd,
          meta: {
            marketPeriod: market.market_period,
            choiceGroup: market.choice_group,
            oddsMarketName: market.market_name || market.market_group,
            oddsChoiceName: choice.name,
          },
        });
      }
    }
  }

  return choices;
}

function scoreOddMatch(recommendation: BettingRecommendation, choice: ReturnType<typeof flattenOddsChoices>[number]): number {
  const recText = normalizeOddText(`${recommendation.market} ${recommendation.recommendation}`);
  const marketText = normalizeOddText(choice.marketName);
  const choiceText = normalizeOddText(choice.choiceName);
  let score = 0;

  if (marketText && recText.includes(marketText)) score += 3;
  if (choiceText && recText.includes(choiceText)) score += 5;
  if (choiceText && choiceText.includes(recText)) score += 3;

  const recTokens = new Set(recText.split(' ').filter((token) => token.length >= 3));
  for (const token of choiceText.split(' ').filter((item) => item.length >= 3)) {
    if (recTokens.has(token)) score += 1;
  }
  for (const token of marketText.split(' ').filter((item) => item.length >= 3)) {
    if (recTokens.has(token)) score += 1;
  }

  return score;
}

function enrichRecommendationWithRealOdd(recommendation: BettingRecommendation, oddsResp: any): BettingRecommendation {
  const existingOdd = Number(recommendation.meta?.decimal_odds);
  if (Number.isFinite(existingOdd) && existingOdd > 1) return recommendation;

  const choices = flattenOddsChoices(oddsResp);
  const best = choices
    .map((choice) => ({ choice, score: scoreOddMatch(recommendation, choice) }))
    .sort((a, b) => b.score - a.score)[0];

  if (!best || best.score < 3) return recommendation;

  return {
    ...recommendation,
    meta: {
      ...(recommendation.meta || {}),
      ...best.choice.meta,
      decimal_odds: best.choice.decimalOdd,
      oddsMatchedBy: 'ai-recommendation',
    },
  };
}

function enrichAnalysisWithRealOdds(result: AnalysisResult, oddsResp: any): AnalysisResult {
  if (!oddsResp?.markets_by_group) return result;

  const recommendations = (result.recommendations || [])
    .map((recommendation) => enrichRecommendationWithRealOdd(recommendation, oddsResp));
  const bestEntry = result.bestEntry
    ? enrichRecommendationWithRealOdd(result.bestEntry, oddsResp)
    : recommendations[0];

  return {
    ...result,
    recommendations,
    bestEntry,
  };
}

function summarizeOgolDeepData(richData: any) {
  const deep = richData?.analysisReady;
  if (!richData?.available || !deep) return undefined;
  const compactAggregate = (aggregate: any) => aggregate ? {
    played: aggregate.played,
    wins: aggregate.wins,
    draws: aggregate.draws,
    losses: aggregate.losses,
    goalsFor: aggregate.goalsFor,
    goalsAgainst: aggregate.goalsAgainst,
    cleanSheets: aggregate.cleanSheets,
    failedToScore: aggregate.failedToScore,
    winRate: aggregate.winRate,
    avgGoalsFor: aggregate.avgGoalsFor,
    avgGoalsAgainst: aggregate.avgGoalsAgainst,
    bttsRate: aggregate.bttsRate,
    over25Rate: aggregate.over25Rate,
    under25Rate: aggregate.under25Rate,
  } : undefined;
  const compactTeam = (team: any) => team ? {
    name: team.name,
    coach: team.coach,
    averageAge: team.averageAge,
    squadValue: team.squadValue,
    tablePosition: team.tablePosition,
    injuries: limitArray(team.injuries, 10),
    suspensions: limitArray(team.suspensions, 10),
    recent: {
      last5: compactAggregate(team.recent?.last5),
      last10: compactAggregate(team.recent?.last10),
      last20: compactAggregate(team.recent?.last20),
      home: compactAggregate(team.recent?.home),
      away: compactAggregate(team.recent?.away),
    },
  } : undefined;
  return {
    coverage: richData.coverage,
    match: {
      competition: deep.match?.competition,
      round: deep.match?.round,
      date: deep.match?.date,
      time: deep.match?.time,
      stadium: deep.match?.stadium,
      city: deep.match?.city,
      referee: deep.match?.referee,
      attendance: deep.match?.attendance,
      weather: deep.match?.weather,
      broadcast: deep.match?.broadcast,
      score: deep.match?.score,
      minute: deep.match?.minute,
      events: limitArray(deep.match?.events, 40),
      statistics: limitArray(deep.match?.statistics, 80).map((item: any) => ({
        label: item.label,
        values: item.values,
        text: String(item.text || '').slice(0, 240),
        section: item.section,
      })),
    },
    teams: {
      home: compactTeam(deep.teams?.home),
      away: compactTeam(deep.teams?.away),
    },
    headToHead: deep.headToHead ? {
      played: deep.headToHead.played,
      homeWins: deep.headToHead.homeWins,
      awayWins: deep.headToHead.awayWins,
      draws: deep.headToHead.draws,
      avgGoals: deep.headToHead.avgGoals,
      avgCorners: deep.headToHead.avgCorners,
      avgCards: deep.headToHead.avgCards,
      bttsRate: deep.headToHead.bttsRate,
      over25Rate: deep.headToHead.over25Rate,
      under25Rate: deep.headToHead.under25Rate,
      firstGoal: deep.headToHead.firstGoal,
    } : undefined,
    competition: deep.competition ? {
      keyValues: limitArray(deep.competition.keyValues, 40),
      standingsAndCampaign: limitArray(deep.competition.standingsAndCampaign, 8).map((table: any) => ({
        caption: table.caption,
        section: table.section,
        headers: table.headers,
        rows: limitArray(table.rows, 25),
      })),
      statistics: limitArray(deep.competition.statistics, 40),
    } : undefined,
    players: limitArray(deep.players, 22).map((player: any) => ({
      name: player.name,
      lineupRole: player.lineupRole,
      position: player.position,
      age: player.age,
      minutes: player.minutes,
      goals: player.goals,
      assists: player.assists,
      cards: player.cards,
      averageRating: player.averageRating,
      consecutiveMatches: player.consecutiveMatches,
      recentForm: player.recentForm,
      goalParticipation: player.goalParticipation,
      efficiency: player.efficiency,
    })),
  };
}

function summarizeStatistics(statisticsResp: any) {
  if (!statisticsResp?.by_period) return undefined;

  const periods = Object.entries(statisticsResp.by_period).slice(0, 3);
  const teamPeriods = periods.map(([period, periodData]: [string, any]) => ({
    period,
    groups: Object.values(periodData.groups_by_name || {}).map((group: any) => ({
      group: group.group_name,
      items: limitArray(group.items, 60).map((item: any) => ({
        name: item.name,
        home: item.home?.label ?? item.home?.value,
        away: item.away?.label ?? item.away?.value,
      })),
    })),
  }));
  const players = Array.isArray(statisticsResp.players)
    ? limitArray(statisticsResp.players, 12).map((player: any) => ({
      name: player.name,
      team: player.team,
      shots: player.shots,
      shotsOnTarget: player.shotsOnTarget,
      goals: player.goals,
      xg: player.xg,
      xgot: player.xgot,
      shotsDetail: limitArray(player.shotsDetail, 4),
    }))
    : undefined;
  const shotChart = Array.isArray(statisticsResp.shotChart)
    ? limitArray(statisticsResp.shotChart, 20)
    : undefined;

  return {
    teamPeriods,
    players,
    shotChart,
    summary: statisticsResp.summary,
    context: statisticsResp.context || statisticsResp.raw?.context,
    deepData: summarizeOgolDeepData(statisticsResp.richData),
  };
}

function summarizeIncidents(incidentsResp: any) {
  const incidents = incidentsResp?.data?.incidents || incidentsResp?.incidents;
  if (!Array.isArray(incidents)) return undefined;

  return limitArray([...incidents].reverse(), 20).map((incident: any) => ({
    time: incident.time,
    type: incident.type || incident.incidentType,
    class: incident.class || incident.incidentClass,
    isHome: incident.isHome,
    player: incident.player?.name || incident.goalScorer?.name,
    score: incident.score,
  }));
}

function summarizeLineups(lineupsResp: any) {
  const data = lineupsResp?.data || lineupsResp;
  if (!data || (!data.home && !data.away)) return undefined;

  const summarizePlayer = (item: any) => ({
      name: item.player?.name,
      id: item.player?.id,
      position: item.position,
      shirtNumber: item.shirtNumber,
      rating: item.avgRating,
      captain: item.captain,
      age: item.age,
      height: item.height,
      marketValue: item.marketValue,
      intMarketValue: item.intMarketValue,
      detailedPositions: item.detailedPositions,
      hasStats: item.hasStats,
      profileText: item.profileText,
      stats: item.stats,
  });
  const summarizeSide = (side: any) => {
    const starters = (side?.players || []).filter((player: any) => !player.substitute);
    const bench = (side?.players || []).filter((player: any) => player.substitute);
    const keyStarters = [...starters]
      .filter((player: any) => Number.isFinite(Number(player.avgRating)))
      .sort((a: any, b: any) => Number(b.avgRating) - Number(a.avgRating));
    const keyByMarketValue = [...starters]
      .filter((player: any) => Number.isFinite(Number(player.intMarketValue)))
      .sort((a: any, b: any) => Number(b.intMarketValue) - Number(a.intMarketValue));

    return {
      formation: side?.formation,
      squadSummary: side?.squadSummary,
      missingPlayers: limitArray(side?.missingPlayers, 8).map((item: any) => ({
        name: item.player?.name || item.name,
        reason: item.reason,
      })),
      starters: limitArray(starters, 11).map(summarizePlayer),
      keyStartersByRating: limitArray(keyStarters, 5).map(summarizePlayer),
      keyPlayersByMarketValue: limitArray(keyByMarketValue, 6).map(summarizePlayer),
      bench: limitArray(bench, 5).map(summarizePlayer),
    };
  };

  return {
    confirmed: data.confirmed,
    home: summarizeSide(data.home),
    away: summarizeSide(data.away),
  };
}

function summarizeTopPlayers(topPlayersResp: any) {
  if (!topPlayersResp) return undefined;

  const summarizeTeam = (team: any) => {
    const players = team?.data?.topPlayers || team?.topPlayers;
    if (!Array.isArray(players)) return undefined;

    return limitArray(players, 8).map((player: any) => ({
      name: player.playerName,
      id: player.playerId,
      position: player.playerPosition,
      rating: player.rating,
      appearances: player.appearances,
      playedEnough: player.playedEnough,
    }));
  };

  return {
    home: summarizeTeam(topPlayersResp.home),
    away: summarizeTeam(topPlayersResp.away),
  };
}

function summarize365Enrichment(scores365Resp: any) {
  if (!scores365Resp) return undefined;
  if (!scores365Resp.available) {
    return {
      source: scores365Resp.source || '365scores-enrichment',
      available: false,
      reason: scores365Resp.reason,
      matchSearch: scores365Resp.matchSearch,
    };
  }

  return {
    source: scores365Resp.source || '365scores-enrichment',
    available: true,
    scores365EventId: scores365Resp.scores365EventId,
    matchSearch: scores365Resp.matchSearch,
    matchedEvent: scores365Resp.matchedEvent,
    dataCoverage: scores365Resp.dataCoverage,
    odds: summarizeOdds(scores365Resp.odds),
    statistics: summarizeStatistics(scores365Resp.statistics),
    incidents: summarizeIncidents(scores365Resp.incidents),
    lineups: summarizeLineups(scores365Resp.lineups),
    streaks: summarizeStreaks(scores365Resp.streaks),
    disciplineAndCorners: summarizeDisciplineAndCorners(scores365Resp.statistics, scores365Resp.incidents),
    graph: scores365Resp.graph?.data ? {
      periodTime: scores365Resp.graph.data.periodTime,
      periodCount: scores365Resp.graph.data.periodCount,
      summary: scores365Resp.graph.data.summary,
      lastPoints: limitArray([...(scores365Resp.graph.data.points || [])].reverse(), 12),
    } : undefined,
  };
}

function normalizeText(value: unknown) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function findStatItems(statisticsResp: any, patterns: RegExp[]) {
  const groups = Object.values(statisticsResp?.by_period?.ALL?.groups_by_name || {});
  const items = groups.flatMap((group: any) => Array.isArray(group.items) ? group.items : []);

  return items
    .filter((item: any) => {
      const name = normalizeText(`${item.name || ''} ${item.key || ''}`);
      return patterns.some((pattern) => pattern.test(name));
    })
    .map((item: any) => ({
      name: item.name,
      key: item.key,
      home: item.home?.label ?? item.home?.value,
      away: item.away?.label ?? item.away?.value,
    }));
}

function summarizeDisciplineAndCorners(statisticsResp: any, incidentsResp: any) {
  const incidents = incidentsResp?.data?.incidents || incidentsResp?.incidents || [];
  const cards = Array.isArray(incidents)
    ? incidents.filter((incident: any) => /card|yellow|red|cartao|cart/i.test(normalizeText(`${incident.type || ''} ${incident.class || ''} ${incident.incidentType || ''}`)))
    : [];

  return {
    cornersFromStats: findStatItems(statisticsResp, [/corner|escanteio|corners/]),
    cardsFromStats: findStatItems(statisticsResp, [/card|yellow|red|cartao|cartoes/]),
    foulsFromStats: findStatItems(statisticsResp, [/foul|faltas|faul/]),
    shotsFromStats: findStatItems(statisticsResp, [/shot|chute|finaliza|remate/]),
    cardsFromIncidents: limitArray(cards, 12).map((incident: any) => ({
      time: incident.time,
      type: incident.type || incident.incidentType,
      class: incident.class || incident.incidentClass,
      isHome: incident.isHome,
      player: incident.player?.name || incident.playerName,
    })),
    hasCardsData: Boolean(cards.length || findStatItems(statisticsResp, [/card|yellow|red|cartao|cartoes/]).length),
    hasCornersData: Boolean(findStatItems(statisticsResp, [/corner|escanteio|corners/]).length),
  };
}

function summarizeMatchForm(matches: any[], subjectTeam: any, fallbackSide: 'home' | 'away') {
  const finished = limitArray(matches, 10)
    .map((match: any) => {
      const subjectId = String(subjectTeam?.id || '');
      const subjectName = normalizeText(subjectTeam?.name || subjectTeam);
      const homeId = String(match.homeTeam?.id || match.homeTeamId || '');
      const awayId = String(match.awayTeam?.id || match.awayTeamId || '');
      const homeName = normalizeText(match.homeTeam?.name || match.homeTeam);
      const awayName = normalizeText(match.awayTeam?.name || match.awayTeam);
      const isHomeSide = match.subjectSide === 'home'
        || (match.subjectSide !== 'away' && Boolean(
          (subjectId && homeId && subjectId === homeId)
          || (subjectName && homeName && (subjectName === homeName || homeName.includes(subjectName)))
        ))
        || (match.subjectSide === undefined
          && !(subjectId && awayId && subjectId === awayId)
          && !(subjectName && awayName && (subjectName === awayName || awayName.includes(subjectName)))
          && fallbackSide === 'home');
      const forScore = Number(isHomeSide ? match.homeScore ?? match.homeScores?.[0] : match.awayScore ?? match.awayScores?.[0]);
      const againstScore = Number(isHomeSide ? match.awayScore ?? match.awayScores?.[0] : match.homeScore ?? match.homeScores?.[0]);
      if (!Number.isFinite(forScore) || !Number.isFinite(againstScore)) return null;

      return {
        id: match.id,
        timestamp: match.matchTime,
        opponent: isHomeSide ? match.awayTeam?.name || match.awayTeam?.id : match.homeTeam?.name || match.homeTeam?.id,
        homeTeam: match.homeTeam?.name || match.homeTeam?.id,
        awayTeam: match.awayTeam?.name || match.awayTeam?.id,
        score: `${forScore}-${againstScore}`,
        goalsFor: forScore,
        goalsAgainst: againstScore,
        result: forScore > againstScore ? 'W' : forScore === againstScore ? 'D' : 'L',
        btts: forScore > 0 && againstScore > 0,
        over25: forScore + againstScore > 2.5,
        cleanSheet: againstScore === 0,
        failedToScore: forScore === 0,
        venue: isHomeSide ? 'home' : 'away',
        leaguePosition: isHomeSide ? match.ext?.homePosition : match.ext?.awayPosition,
      };
    })
    .filter(Boolean) as any[];

  const summarize = (sample: any[]) => {
    const played = sample.length;
    const totals = sample.reduce((acc, match) => {
    acc.wins += match.result === 'W' ? 1 : 0;
    acc.draws += match.result === 'D' ? 1 : 0;
    acc.losses += match.result === 'L' ? 1 : 0;
    acc.goalsFor += match.goalsFor;
    acc.goalsAgainst += match.goalsAgainst;
    acc.btts += match.btts ? 1 : 0;
    acc.over25 += match.over25 ? 1 : 0;
    acc.cleanSheets += match.cleanSheet ? 1 : 0;
    acc.failedToScore += match.failedToScore ? 1 : 0;
    return acc;
  }, { wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0, btts: 0, over25: 0, cleanSheets: 0, failedToScore: 0 });

    return {
      played,
      wins: totals.wins,
      draws: totals.draws,
      losses: totals.losses,
      winRate: played ? Number(((totals.wins / played) * 100).toFixed(0)) : undefined,
      record: `${totals.wins}W-${totals.draws}D-${totals.losses}L`,
      avgGoalsFor: played ? Number((totals.goalsFor / played).toFixed(2)) : undefined,
      avgGoalsAgainst: played ? Number((totals.goalsAgainst / played).toFixed(2)) : undefined,
      bttsRate: played ? Number(((totals.btts / played) * 100).toFixed(0)) : undefined,
      over25Rate: played ? Number(((totals.over25 / played) * 100).toFixed(0)) : undefined,
      cleanSheetRate: played ? Number(((totals.cleanSheets / played) * 100).toFixed(0)) : undefined,
      failedToScoreRate: played ? Number(((totals.failedToScore / played) * 100).toFixed(0)) : undefined,
    };
  };

  return {
    ...summarize(finished),
    last5: summarize(finished.slice(0, 5)),
    last10: summarize(finished),
    homePerformance: summarize(finished.filter((match) => match.venue === 'home')),
    awayPerformance: summarize(finished.filter((match) => match.venue === 'away')),
    latestLeaguePosition: finished.find((match) => match.leaguePosition)?.leaguePosition,
    recentMatches: finished,
  };
}

function buildTeamFormSummary(streaksResp: any, statisticsResp: any, incidentsResp: any, event?: any) {
  const data = streaksResp?.data || streaksResp;
  if (!data) return {
    disciplineAndCorners: summarizeDisciplineAndCorners(statisticsResp, incidentsResp),
  };

  return {
    homeRecent: summarizeMatchForm(data.home || [], event?.homeTeam, 'home'),
    awayRecent: summarizeMatchForm(data.away || [], event?.awayTeam, 'away'),
    headToHead: summarizeMatchForm(data.head2head || [], event?.homeTeam, 'home'),
    homeFuture: limitArray(data.homeFuture, 5),
    awayFuture: limitArray(data.awayFuture, 5),
    teams: limitArray(data.teams, 8),
    competitions: limitArray(data.competitions, 8),
    disciplineAndCorners: summarizeDisciplineAndCorners(statisticsResp, incidentsResp),
  };
}

function hasPlayerData(input: LLMAnalysisInput) {
  return Boolean(
    input.statistics?.players?.length
    || input.statistics?.shotChart?.length
    || input.topPlayers?.home?.length
    || input.topPlayers?.away?.length
    || input.playerProps?.props?.length
    || input.lineups?.home?.starters?.length
    || input.lineups?.away?.starters?.length
    || input.lineups?.home?.keyPlayersByMarketValue?.length
    || input.lineups?.away?.keyPlayersByMarketValue?.length
  );
}

function normalizeGeneratedAnalysis(parsed: any, input: LLMAnalysisInput) {
  const unavailable = OPTIONAL_DATA_UNAVAILABLE;
  const normalized = normalizeUnavailableData({ ...parsed });
  const quality = input.dataQuality || {};
  const rawMarketBreakdown = normalized.marketBreakdown;
  const normalizedMarketBreakdown = typeof rawMarketBreakdown === 'string'
    ? { summary: rawMarketBreakdown }
    : Array.isArray(rawMarketBreakdown)
      ? { summary: rawMarketBreakdown.every((item) => typeof item === 'string' && item.length <= 2)
        ? rawMarketBreakdown.join('')
        : rawMarketBreakdown.map((item) => typeof item === 'string' ? item : JSON.stringify(item)).join(' ') }
      : rawMarketBreakdown && typeof rawMarketBreakdown === 'object'
        ? rawMarketBreakdown
        : {};
  const marketBreakdown = {
    ...normalizedMarketBreakdown,
  };

  if (!quality.hasCardsData) {
    marketBreakdown.cards = unavailable;
  }
  if (!quality.hasCornersData) {
    marketBreakdown.corners = unavailable;
  }
  if (!hasPlayerData(input)) {
    marketBreakdown.playerProps = unavailable;
    normalized.playerAnalysis = {
      ...(normalized.playerAnalysis || {}),
      available: false,
      mainPlayers: [],
      unsupportedPlayerMarkets: [unavailable],
    };
  }

  const referee = input.event?.referee;
  const refereeName = normalizeText(referee?.name);
  if (!referee || !referee?.id || refereeName === 'unknown' || refereeName === 'desconhecido') {
    normalized.refereeAnalysis = {
      available: false,
      summary: unavailable,
      cardsTrend: unavailable,
      bettingImpact: unavailable,
    };
  }

  normalized.marketBreakdown = marketBreakdown;
  return normalized;
}

function buildRefereeProfile(event: any) {
  const referee = event?.referee;
  if (!referee || !referee.id) return undefined;

  const games = Number(referee.games);
  const yellowCards = Number(referee.yellowCards);
  const redCards = Number(referee.redCards);
  const yellowRedCards = Number(referee.yellowRedCards);

  return {
    id: referee.id,
    name: referee.name,
    country: referee.country,
    games: Number.isFinite(games) ? games : undefined,
    yellowCards: Number.isFinite(yellowCards) ? yellowCards : undefined,
    redCards: Number.isFinite(redCards) ? redCards : undefined,
    yellowRedCards: Number.isFinite(yellowRedCards) ? yellowRedCards : undefined,
    yellowCardsPerGame: Number.isFinite(games) && games > 0 && Number.isFinite(yellowCards)
      ? Number((yellowCards / games).toFixed(2))
      : undefined,
    redCardsPerGame: Number.isFinite(games) && games > 0 && Number.isFinite(redCards)
      ? Number((redCards / games).toFixed(2))
      : undefined,
  };
}

function summarizeStreaks(streaksResp: any) {
  const data = streaksResp?.data || streaksResp;
  if (!data) return undefined;
  const teams = new Map((data.teams || []).map((team: any) => [String(team.id), team]));
  const getTeamName = (team: any) => {
    const full = teams.get(String(team?.id)) as any;
    return full?.name || team?.name || team?.id;
  };
  const summarizeMatch = (match: any) => ({
    id: match.id,
    timestamp: match.matchTime,
    statusId: match.statusId,
    homeTeam: getTeamName(match.homeTeam),
    awayTeam: getTeamName(match.awayTeam),
    homeScore: match.homeScore ?? match.homeScores?.[0],
    awayScore: match.awayScore ?? match.awayScores?.[0],
    round: match.roundNum,
    neutral: match.neutral,
    homePosition: match.ext?.homePosition,
    awayPosition: match.ext?.awayPosition,
  });

  return {
    general: limitArray(data.general, 12),
    head2head: limitArray(data.head2head, 12).map(summarizeMatch),
    homeRecent: limitArray(data.home, 8).map(summarizeMatch),
    awayRecent: limitArray(data.away, 8).map(summarizeMatch),
    homeFuture: limitArray(data.homeFuture, 5).map(summarizeMatch),
    awayFuture: limitArray(data.awayFuture, 5).map(summarizeMatch),
  };
}

function summarize365Odds(game: any) {
  const bestOdds = Array.isArray(game?.bestOdds) ? game.bestOdds : [];
  const predictionOdds = Array.isArray(game?.promotedPredictions?.predictions)
    ? game.promotedPredictions.predictions.map((prediction: any) => prediction.odds).filter(Boolean)
    : [];
  const odds = [...new Map([...bestOdds, ...predictionOdds].map((line: any) => [
    String(line.lineId || `${line.lineTypeId}-${line.internalOption || ''}`),
    line,
  ])).values()];
  const predictions = game?.promotedPredictions?.predictions;

  return {
    markets: limitArray(odds, 8).map((line: any) => ({
      market: line.lineType?.name || line.lineType?.title,
      bookmaker: line.bookmaker?.name,
      options: limitArray(line.options, 6).map((option: any) => ({
        name: format365OddsOptionName(line, option, game),
        rawName: option.name,
        odd: option.rate?.decimal,
        trend: option.trend,
      })),
    })),
    predictions: Array.isArray(predictions)
      ? limitArray(predictions, 5).map((prediction: any) => ({
        title: prediction.title,
        totalVotes: prediction.totalVotes,
        options: limitArray(prediction.options, 5).map((option: any) => ({
          name: option.name,
          percentage: option.vote?.percentage,
          count: option.vote?.count,
        })),
      }))
      : undefined,
  };
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

function summarize365TopPerformers(game: any) {
  const categories = game?.topPerformers?.categories;
  if (!Array.isArray(categories)) return undefined;

  const summarizePlayer = (player: any) => player ? ({
    id: player.id,
    name: player.name,
    position: player.positionName,
    stats: limitArray(player.stats, 5).map((stat: any) => ({
      name: stat.name,
      value: stat.value,
    })),
  }) : undefined;

  return limitArray(categories, 6).map((category: any) => ({
    category: category.name,
    homePlayer: summarizePlayer(category.homePlayer),
    awayPlayer: summarizePlayer(category.awayPlayer),
  }));
}

function summarize365PlayerProps(game: any) {
  const topPerformers = game?.topPerformers?.categories;
  const props: any[] = [];

  if (Array.isArray(topPerformers)) {
    for (const category of topPerformers) {
      for (const [side, player] of [['home', category.homePlayer], ['away', category.awayPlayer]] as const) {
        if (!player) continue;

        props.push({
          source: 'topPerformers',
          team: side,
          category: category.name,
          playerId: player.id,
          player: player.name,
          position: player.positionName,
          stats: limitArray(player.stats, 5).map((stat: any) => ({
            name: stat.name,
            value: stat.value,
          })),
        });
      }
    }
  }

  return {
    available: props.length > 0,
    props: limitArray(props, 12),
  };
}

function build365LLMInput(raw: any, normalizedEvent: any, statisticsResp: any, incidentsResp: any, lineupsResp: any, streaksResp: any, scores365Resp?: any): LLMAnalysisInput {
  const game = raw.game || {};
  const teamForm = buildTeamFormSummary(streaksResp, statisticsResp, incidentsResp, normalizedEvent);
  const scores365 = summarize365Enrichment(scores365Resp);
  const scores365Discipline = scores365?.disciplineAndCorners;
  const ownDiscipline = teamForm.disciplineAndCorners;

  return {
    event: {
      id: normalizedEvent.id,
      slug: normalizedEvent.slug,
      source: '365scores',
      tournament: normalizedEvent.tournament,
      season: normalizedEvent.season,
      round: normalizedEvent.round,
      status: normalizedEvent.status,
      startTimestamp: normalizedEvent.startTime,
      homeTeam: normalizedEvent.homeTeam,
      awayTeam: normalizedEvent.awayTeam,
      score: normalizedEvent.score,
      venue: normalizedEvent.venue,
      referee: normalizedEvent.referee,
      gameTime: game.gameTime,
      gameTimeDisplay: game.gameTimeDisplay,
      statusText: game.statusText,
      hasStats: game.hasStats,
      hasLineups: game.hasLineups,
    },
    statistics: summarizeStatistics(statisticsResp),
    incidents: summarizeIncidents(incidentsResp),
    lineups: summarizeLineups(lineupsResp),
    streaks: summarizeStreaks(streaksResp),
    topPerformers: summarize365TopPerformers(game),
    refereeProfile: buildRefereeProfile(normalizedEvent),
    playerProps: summarize365PlayerProps(game),
    scores365,
    teamForm,
    dataQuality: {
      has365Scores: Boolean(scores365?.available),
      hasCardsData: Boolean(ownDiscipline?.hasCardsData || scores365Discipline?.hasCardsData),
      hasCornersData: Boolean(ownDiscipline?.hasCornersData || scores365Discipline?.hasCornersData),
    },
  } as LLMAnalysisInput;
}

function buildLLMInput(event: any, oddsResp: any, statisticsResp: any, incidentsResp: any, lineupsResp: any, streaksResp: any, topPlayersResp?: any, scores365Resp?: any): LLMAnalysisInput {
  if (event?.raw?.game && event?.data) {
    return build365LLMInput(event.raw, event.data, statisticsResp, incidentsResp, lineupsResp, streaksResp, scores365Resp);
  }

  const sourceEvent = event?.raw?.event || event?.data || event;
  const normalizedEvent = sourceEvent.event || sourceEvent;
  const source = process.env.SCORES_PROVIDER || 'sofascore';
  const teamForm = buildTeamFormSummary(streaksResp, statisticsResp, incidentsResp, normalizedEvent);
  const scores365 = summarize365Enrichment(scores365Resp);
  const ownDiscipline = teamForm.disciplineAndCorners;
  const scores365Discipline = scores365?.disciplineAndCorners;

  return {
    event: {
      id: normalizedEvent.id,
      slug: normalizedEvent.slug,
      source,
      tournament: normalizedEvent.tournament,
      season: normalizedEvent.season,
      roundInfo: normalizedEvent.roundInfo || (normalizedEvent.round ? { round: normalizedEvent.round } : undefined),
      status: normalizedEvent.status,
      startTimestamp: normalizedEvent.startTimestamp ?? normalizedEvent.startTime,
      homeTeam: normalizedEvent.homeTeam,
      awayTeam: normalizedEvent.awayTeam,
      homeScore: normalizedEvent.homeScore || (normalizedEvent.score ? {
        current: normalizedEvent.score.home,
        display: normalizedEvent.score.homeDisplay,
      } : undefined),
      awayScore: normalizedEvent.awayScore || (normalizedEvent.score ? {
        current: normalizedEvent.score.away,
        display: normalizedEvent.score.awayDisplay,
      } : undefined),
      venue: normalizedEvent.venue,
      referee: normalizedEvent.referee,
    },
    odds: oddsResp ? summarizeOdds(oddsResp) : undefined,
    statistics: summarizeStatistics(statisticsResp),
    incidents: summarizeIncidents(incidentsResp),
    lineups: summarizeLineups(lineupsResp),
    streaks: summarizeStreaks(streaksResp),
    topPlayers: summarizeTopPlayers(topPlayersResp),
    refereeProfile: buildRefereeProfile(normalizedEvent),
    scores365,
    teamForm,
    dataQuality: {
      has365Scores: Boolean(scores365?.available),
      hasAiScoreHistory: Boolean((streaksResp?.data || streaksResp)?.home?.length || (streaksResp?.data || streaksResp)?.away?.length),
      hasAiScoreLineupPool: Boolean((lineupsResp?.data || lineupsResp)?.home?.players?.length || (lineupsResp?.data || lineupsResp)?.away?.players?.length),
      hasAiScoreStats: Boolean(statisticsResp?.summary?.total_items),
      hasCardsData: Boolean(ownDiscipline?.hasCardsData || scores365Discipline?.hasCardsData),
      hasCornersData: Boolean(ownDiscipline?.hasCornersData || scores365Discipline?.hasCornersData),
    },
  };
}

function isMeaningfulId(value: unknown): value is number | string {
  if (typeof value === 'number') return value > 0;
  return typeof value === 'string' && value.trim() !== '' && value !== '0';
}

async function fetchTopPlayersForEvent(event: any) {
  const uniqueTournamentId = event?.tournament?.uniqueTournament?.id ?? event?.tournament?.id;
  const seasonId = event?.season?.id;
  const homeTeamId = event?.homeTeam?.id;
  const awayTeamId = event?.awayTeam?.id;

  if (!isMeaningfulId(uniqueTournamentId) || !isMeaningfulId(seasonId)) return null;

  const [home, away] = await Promise.all([
    isMeaningfulId(homeTeamId)
      ? safeFetch('home top players', () => fetchTopPlayers(String(homeTeamId), String(uniqueTournamentId), String(seasonId)))
      : Promise.resolve(null),
    isMeaningfulId(awayTeamId)
      ? safeFetch('away top players', () => fetchTopPlayers(String(awayTeamId), String(uniqueTournamentId), String(seasonId)))
      : Promise.resolve(null),
  ]);

  return { home, away };
}

function normalizeAzureEndpoint(endpoint: string): string {
  return endpoint.endsWith('/') ? endpoint : `${endpoint}/`;
}

function getAzureEndpointHost(endpoint: string): string {
  try {
    return new URL(normalizeAzureEndpoint(endpoint)).hostname;
  } catch {
    return endpoint;
  }
}

function extractJsonObject(content: string): unknown {
  const trimmed = content.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    return JSON.parse(withoutFence);
  } catch {
    const firstBrace = withoutFence.indexOf('{');
    const lastBrace = withoutFence.lastIndexOf('}');

    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return JSON.parse(withoutFence.slice(firstBrace, lastBrace + 1));
    }

    throw new Error('Azure OpenAI response did not contain a valid JSON object');
  }
}

function formatError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);

  const cause = (err as Error & { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const code = (cause as Error & { code?: string }).code;
    return code ? `${err.message}: ${code} ${cause.message}` : `${err.message}: ${cause.message}`;
  }

  return err.message;
}

function selectBestRecommendation(recommendations: BettingRecommendation[], eventId: number | string = 'unknown', source: AnalysisResult['analysisSource'] = 'heuristic'): AnalysisResult {
  const best = recommendations.sort((a, b) => b.confidence - a.confidence)[0];
  return {
    eventId,
    market: best.market,
    recommendation: best.recommendation,
    confidence: best.confidence,
    rationale: best.rationale,
    recommendations,
    analysisSource: source,
  };
}

async function callLLMAnalysis(input: LLMAnalysisInput): Promise<LLMAnalysisResponse> {
  const key = azureInputKey(input);
  const cached = azureResponseCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (cached) azureResponseCache.delete(key);

  const running = azureInFlight.get(key);
  if (running) return running;

  const promise = withAzureSlot(() => performLLMAnalysis(input))
    .then((response) => {
      if (response.result) {
        const ttlMs = Math.max(1000, Number(process.env.AZURE_OPENAI_CACHE_TTL_MS || 15 * 60 * 1000));
        azureResponseCache.set(key, { expiresAt: Date.now() + ttlMs, value: response });
        pruneAzureCache();
      }
      return response;
    })
    .finally(() => azureInFlight.delete(key));
  azureInFlight.set(key, promise);
  return promise;
}

function compactForm(form: any) {
  if (!form) return undefined;
  const pick = (sample: any) => sample ? {
    played: sample.played, record: sample.record, winRate: sample.winRate,
    avgGoalsFor: sample.avgGoalsFor, avgGoalsAgainst: sample.avgGoalsAgainst,
    bttsRate: sample.bttsRate, over25Rate: sample.over25Rate,
  } : undefined;
  return {
    last5: pick(form.last5),
    last10: pick(form.last10 || form),
    sequence: limitArray(form.recentMatches, 5).map((match: any) => match.result).filter(Boolean).join('-') || undefined,
    home: pick(form.homePerformance),
    away: pick(form.awayPerformance),
  };
}

export function buildExplanationInput(input: LLMAnalysisInput, decision: AnalysisResult): LLMAnalysisInput {
  const relevantStat = /gol|xg|expected|xga|chute.*alvo|finaliza.*alvo|escanteio|corner|cart|amarelo|vermelho/i;
  const statistics = (input.statistics?.teamPeriods || [])
    .flatMap((period: any) => period.groups || [])
    .flatMap((group: any) => group.items || [])
    .filter((item: any) => relevantStat.test(String(item.name || '')))
    .slice(0, 16)
    .map((item: any) => ({ name: item.name, home: item.home, away: item.away }));
  const h2h = input.teamForm?.headToHead;
  const audit = decision.meta?.decisionAudit as any;

  return {
    explanationOnly: true,
    event: {
      id: input.event?.id,
      source: input.event?.source,
      homeTeam: { name: input.event?.homeTeam?.name },
      awayTeam: { name: input.event?.awayTeam?.name },
      tournament: { name: input.event?.tournament?.name },
      startTimestamp: input.event?.startTimestamp,
      status: input.event?.status,
      round: input.event?.round ?? input.event?.roundInfo?.round,
      venue: input.event?.venue?.name ? { name: input.event.venue.name, city: input.event.venue.city } : undefined,
    },
    teamForm: {
      homeRecent: compactForm(input.teamForm?.homeRecent),
      awayRecent: compactForm(input.teamForm?.awayRecent),
      headToHead: h2h ? {
        played: h2h.played, record: h2h.record,
        avgGoalsFor: h2h.avgGoalsFor, avgGoalsAgainst: h2h.avgGoalsAgainst,
        bttsRate: h2h.bttsRate, over25Rate: h2h.over25Rate,
      } : undefined,
    },
    statistics: { main: statistics },
    dataQuality: input.dataQuality,
    backendDecision: {
      market: decision.market,
      recommendation: decision.recommendation,
      confidence: decision.confidence,
      approved: audit?.decision === 'approved',
      decisionStatus: audit?.decision || decision.analysisStatus,
      odd: decision.bestEntry?.meta?.decimal_odds,
      expectedValue: decision.bestEntry?.meta?.expectedValue,
      riskLevel: decision.bestEntry?.riskLevel,
      confirmations: audit?.candidates?.[0]?.confirmations || [],
      risks: audit?.reasons || audit?.missingData || [],
    },
  };
}

async function performLLMAnalysis(input: LLMAnalysisInput): Promise<LLMAnalysisResponse> {
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const deploymentName = process.env.AZURE_OPENAI_DEPLOYMENT_NAME;
  const timeoutMs = input.explanationOnly
    ? Number(process.env.AZURE_OPENAI_EXPLANATION_TIMEOUT_MS || 20000)
    : Number(process.env.AZURE_OPENAI_TIMEOUT_MS || 45000);
  const maxTokens = input.explanationOnly
    ? Number(process.env.AZURE_OPENAI_EXPLANATION_MAX_TOKENS || 900)
    : Number(process.env.AZURE_OPENAI_MAX_TOKENS || 2200);
  const eventData = input.event;
  const isReasoningModel = process.env.AZURE_OPENAI_REASONING_MODEL === 'true'
    || /^(gpt-5|o[134](?:-|$))/i.test(deploymentName || '');

  const cooldownRemainingMs = azureRateLimitedUntil - Date.now();
  if (cooldownRemainingMs > 0) {
    const seconds = Math.ceil(cooldownRemainingMs / 1000);
    return {
      result: null,
      error: `Azure OpenAI temporariamente em cooldown por rate limit (${seconds}s restantes). ${azureRateLimitReason}`.trim(),
    };
  }

  if (!apiKey || !endpoint || !deploymentName) {
    console.error('Azure OpenAI credentials missing:', {
      hasApiKey: !!apiKey,
      hasEndpoint: !!endpoint,
      hasDeployment: !!deploymentName,
    });
    return { result: null, error: 'Azure OpenAI credentials missing' };
  }

  try {
    const prompt = `Voce e um analista profissional de apostas em futebol.
Analise os dados da partida em profundidade. Compare mandante e visitante usando contexto do jogo, forma recente/streaks, escalacoes, desfalques, top players, estatisticas, incidentes, arbitro e placar/status.
Use o perfil do arbitro para mercados de cartoes quando houver dados de jogos, amarelos, vermelhos ou cartoes por jogo.
Use escalacoes, top players, posicoes, ratings e estatisticas de finalizacao/chances para avaliar mercados de jogador, como chute no gol, finalizacao, gol ou assistencia.
Na fonte 365scores, considere que ha dados de jogador se existir qualquer um destes blocos: statistics.players, statistics.shotChart, topPerformers ou playerProps. Nao marque playerAnalysis.available como false quando esses blocos existirem.
Na fonte aiscore, use event.source="aiscore" no dataCoverage.source. Considere que partidas pre-match podem nao ter estatisticas, escalações ou incidentes ainda; nesse caso, use os dados confirmados de evento, times, competição, local, status e arbitro para uma leitura conservadora, sem inventar forma recente.
Na fonte ogol, use event.source="ogol" no dataCoverage.source. O OGOL vem de HTML publico e pode trazer agenda, status ao vivo, minuto, placar, odds 1x2, ultimos titulares, desfalques, estatisticas da competicao, fatos da temporada, confronto direto, estadio e arbitro. Use esses campos quando existirem e escreva exatamente "Dado não disponível." para incidentes minuto a minuto, xG, heatmap ou props de jogador quando ausentes.
Na fonte ogol, priorize statistics.context quando existir. Use competitionTable e teamNeeds para explicar situacao no campeonato/grupo, posicao, pontos, saldo aproximado por gols pro/contra e se o time precisa vencer. Use seasonFacts para forma, aproveitamento, gols marcados/sofridos e tendencias de marcar/sofrer. Use teamPeriods para comparar pontos, posicao, gols, gols esperados, chutes, escanteios, amarelos/vermelhos quando existirem. Use referee.name e referee.cardsAverage quando existir; se cardsAverage estiver ausente, diga que o arbitro foi identificado mas sem media publica no OGOL, e nao invente media. Para mercados de cartoes e faltas, so recomende se houver dado disciplinar real de arbitro, amarelos, vermelhos, faltas ou perfil de times faltosos. Para escanteios, use escanteios por jogo e volume de chutes. Para gols, use media de gols, gols esperados, gols marcados/sofridos e forma recente.
Na fonte ogol, statistics.deepData contem o enriquecimento multipagina. Use match.statistics e match.events, os agregados last5/last10/last20 e casa/fora de teams, headToHead, classificacao/estatisticas de competition e os perfis de players. Campos dinamicos novos coletados de tabelas do OGOL sao dados validos mesmo quando nao aparecem nesta lista, mas cite o nome e o valor exatamente como recebidos.
Na fonte ogol, quando event.status.type="inprogress", minuto, placar e estatisticas ao vivo sao dados concretos, mas minuto e placar sozinhos nunca bastam para recomendar uma entrada. Exija volume ofensivo, finalizacoes, posse, escanteios ou outro conjunto coerente de indicadores ao vivo. Cite obrigatoriamente minuto e placar quando houver recomendacao.
Quando scores365.available=true, use scores365 como fonte complementar para estatisticas, odds reais, escanteios quando houver, cartoes, lineups, incidentes, streaks, placar/status e dados ao vivo. Cite scores365.scores365EventId e os campos concretos usados quando eles ajudarem a justificar a entrada.
Se 365Scores nao encontrar correspondencia confiavel ou algum endpoint publico nao retornar dados, diga isso em dataCoverage.missingData, mas continue usando AiScore e os demais dados disponiveis.
Use apenas os campos retornados em scores365.statistics, scores365.incidents, scores365.lineups, scores365.streaks e scores365.odds. Se um bloco estiver ausente, nao invente; escreva exatamente "Dado não disponível." para o mercado afetado.
Na fonte aiscore, use obrigatoriamente teamForm.homeRecent, teamForm.awayRecent, teamForm.headToHead, teamForm.disciplineAndCorners e lineups antes de dizer que faltam dados. Esses blocos resumem ultimas partidas, gols pro/contra, BTTS, over 2.5, clean sheets, posicao recente no campeonato, elenco, desfalques e estatisticas de jogo quando disponiveis.
Para cartoes e escanteios, primeiro procure em teamForm.disciplineAndCorners.cardsFromStats, cardsFromIncidents, cornersFromStats, foulsFromStats e statistics.teamPeriods. Se existir qualquer valor concreto, faca uma leitura tecnica com cautela. So diga que nao ha dado concreto quando esses campos tambem estiverem vazios.
Nao coloque "cartoes" ou "escanteios" em avoidMarkets apenas porque uma fonte secundaria nao retornou dados; se AiScore ou 365Scores tiver stats/incidentes ou historico suficiente, use esses dados. Se realmente nao houver dado numerico, diga a limitacao dentro de marketBreakdown sem transformar isso em entrada principal.
So recomende mercado de jogador quando existir suporte nos dados esportivos enviados. Se houver playerProps/topPerformers/statistics.players, use esses dados para explicar gol, finalizacao ou chute no gol; se faltar estatistica individual de finalizacao, diga a incerteza e prefira mercados de time.
Na fonte 365scores, o arbitro pode vir em event.referee vindo de officials. Se houver nome do arbitro mas sem media historica de cartoes, marque refereeAnalysis.available como true, informe que o arbitro foi identificado, e classifique cardsTrend como "historico indisponivel" em vez de "indisponivel". Use estatisticas de cartoes do jogo quando existirem.
Considere tambem mercados de gols, ambas marcam, vencedor, dupla chance, handicap, escanteios, cartoes e entradas ao vivo quando os dados sustentarem.
Nao escolha entradas por cotacao, odd baixa, odd favorita, voto popular, predicao de mercado ou probabilidade implicita de mercado. A recomendacao deve nascer somente da leitura tecnica da partida.
Se houver odd real, use-a apenas depois da estimativa estatistica para verificar valor esperado. Nunca use a odd para criar a recomendacao. Se o valor esperado nao for positivo, rejeite a entrada.
Se algum bloco de dados estiver ausente, explique a incerteza sem inventar fatos.
Nunca invente numeros, tendencias, arbitro, cartoes, escanteios, chutes ou dados de jogador. Tente usar todos os dados reais enviados primeiro; se depois disso nao houver dado concreto para um mercado, escreva exatamente "Dado não disponível." naquele campo do marketBreakdown ou da analise correspondente.
Se a partida for pre-match, diferencie leitura provavel de fato confirmado.
Evite frases genericas. Cite os dados concretos recebidos: status, local, top performers, escalacoes, estatisticas, desfalques, shot chart, incidentes e perfil de arbitro.
Seja seletivo sem ser excessivamente restritivo. Dados opcionais ausentes nao impedem uma recomendacao de outro mercado. Uma recomendacao moderada pode usar 3 jogos recentes por equipe; com apenas 2, exija tambem amostra de temporada e estatisticas estruturadas. Sempre exija dados especificos do mercado e ausencia de conflito relevante.
Nao transforme ausencia de dados em tendencia. Nao aumente confianca por intuicao, reputacao do time ou favoritismo presumido.
Pode retornar recommendations vazio e bestRecommendation null. Prefira nao recomendar a publicar uma entrada apenas razoavel.
Analise todos os mercados suportados, mas retorne no maximo 3 candidatos realmente fortes. O motor deterministico validara e publicara somente o melhor.
Retorne APENAS um JSON valido neste formato:
{
  "dataCoverage": {
    "source": "aiscore, 365scores, ogol ou sofascore",
    "hasLineups": true,
    "hasTopPerformers": true,
    "hasPlayerProps": true,
    "hasShotChart": true,
    "hasStatistics": true,
    "has365Scores": true,
    "hasReferee": true,
    "missingData": ["dados ausentes que limitam a analise"]
  },
  "matchAnalysis": "leitura geral da partida em portugues, com contexto, ritmo provavel ou leitura ao vivo",
  "keyFactors": [
    "fator decisivo 1 com impacto de aposta",
    "fator decisivo 2 com impacto de aposta",
    "fator decisivo 3 com impacto de aposta"
  ],
  "homeAnalysis": {
    "team": "nome do mandante",
    "strengths": ["forca 1", "forca 2"],
    "weaknesses": ["risco 1", "risco 2"],
    "tacticalReading": "como o mandante tende a se comportar",
    "bettingImpact": "como isso afeta as entradas"
  },
  "awayAnalysis": {
    "team": "nome do visitante",
    "strengths": ["forca 1", "forca 2"],
    "weaknesses": ["risco 1", "risco 2"],
    "tacticalReading": "como o visitante tende a se comportar",
    "bettingImpact": "como isso afeta as entradas"
  },
  "refereeAnalysis": {
    "available": true,
    "summary": "leitura do arbitro para cartoes",
    "cardsTrend": "alto, medio, baixo ou indisponivel",
    "bettingImpact": "como isso impacta over/under cartoes"
  },
  "playerAnalysis": {
    "available": true,
    "mainPlayers": [
      {
        "team": "time",
        "player": "nome",
        "role": "funcao",
        "whyRelevant": "por que importa para gol, assistencia ou chute",
        "supportedMarkets": ["mercado de jogador que os dados sustentam"]
      }
    ],
    "unsupportedPlayerMarkets": ["mercados de jogador que nao devem ser recomendados por falta de dado"]
  },
  "marketBreakdown": {
    "goals": "leitura para over/under e ambas marcam",
    "winner": "leitura para resultado, dupla chance ou handicap",
    "cards": "leitura para cartoes",
    "corners": "leitura para escanteios",
    "playerProps": "leitura para jogador",
    "liveAngle": "como mudar a entrada ao vivo se o jogo estiver em andamento"
  },
  "recommendations": [
    {
      "market": "nome do mercado",
      "recommendation": "entrada objetiva",
      "confidence": 0,
      "riskLevel": "baixo, medio ou alto",
      "dataSupport": ["dado 1 que sustenta", "dado 2 que sustenta"],
      "warningSigns": ["sinal que pode invalidar", "incerteza relevante"],
      "rationale": "analise detalhada em portugues explicando por que essa entrada faz sentido com base nos dados disponiveis"
    }
  ],
  "bestRecommendation": {
    "market": "nome do mercado",
    "recommendation": "melhor entrada",
    "confidence": 0,
    "riskLevel": "baixo, medio ou alto",
    "dataSupport": ["principais dados de apoio"],
    "warningSigns": ["principais riscos"],
    "rationale": "por que esta e a melhor entrada"
  },
  "confidenceDrivers": ["o que aumenta a confianca", "o que reduz a confianca"],
  "avoidMarkets": [
    {
      "market": "mercado a evitar",
      "reason": "por que nao tem valor ou nao tem dados suficientes"
    }
  ],
  "riskAnalysis": "principais riscos que podem invalidar a entrada"
}
Quando nao houver vantagem clara, use "recommendations": [] e "bestRecommendation": null. Nunca use texto fora do JSON.`;

    const reasoningPrompt = `Atue como analista profissional e seletivo de futebol.
Use somente os dados recebidos. Nao invente estatisticas. Para campo opcional ausente escreva "Dado nao disponivel.".
Compare forma recente, casa/fora, ataque, defesa, gols, escanteios, cartoes, chutes, xG, H2H, contexto da competicao, arbitro, desfalques e jogadores quando existirem.
Analise gols, ambas marcam, resultado, dupla chance, handicap, escanteios, cartoes e props de jogador, mas recomende somente o mercado com evidencia objetiva convergente.
Odds nunca criam a recomendacao; quando existirem, servem apenas para validar EV depois da estimativa esportiva.
Se dados forem insuficientes ou conflitantes, retorne recommendations=[] e bestRecommendation=null.
Responda somente JSON valido com: matchAnalysis, dataCoverage, keyFactors, homeAnalysis, awayAnalysis, refereeAnalysis, playerAnalysis, marketBreakdown, recommendations, bestRecommendation, confidenceDrivers, avoidMarkets e riskAnalysis.
Cada recommendation deve ter market, recommendation, confidence de 0 a 100, riskLevel, dataSupport, warningSigns e rationale.`;
    const explanationPrompt = `Voce e o redator esportivo do PlacarPro e apenas explica uma decisao ja tomada pelo motor estatistico do backend.
Nao altere mercado, recomendacao, confianca, odd, risco, EV ou status de backendDecision. Nao crie outra entrada.
Use linguagem simples, objetiva e profissional para uma pessoa sem conhecimento avancado em estatistica.
Use somente os dados recebidos. Nao invente numeros, contexto, jogadores, desfalques, importancia da partida ou estilo de jogo.
Transforme indicadores tecnicos em frases naturais. Evite listas de numeros sem explicar o que representam.
rationale deve ser um resumo da IA de 4 a 8 linhas: explique a recomendacao, comportamento esperado, indicadores decisivos e por que foi o melhor mercado.
matchAnalysis deve explicar o contexto disponivel: momento das equipes, forma recente, mando e caracteristicas do confronto. Quando um aspecto nao estiver nos dados, nao o mencione.
keyFactors deve conter de 3 a 5 evidencias curtas, completas e compreensiveis.
marketBreakdown deve ter a chave whyThisMarket com uma explicacao sobre a combinacao entre probabilidade estatistica, qualidade dos dados e EV, sem afirmar que o EV foi positivo se ele estiver ausente.
riskAnalysis deve sempre apresentar os riscos reais ou as limitacoes dos dados. Nunca esconda incertezas.
bestRecommendation deve copiar exatamente market, recommendation e confidence de backendDecision, adicionando apenas rationale, dataSupport em frases naturais e warningSigns.
Se decisionStatus=waiting_odds, explique que a analise esportiva foi preservada, mas ainda nao existe cotacao real para validar o EV.
Se decisionStatus=rejected, explique objetivamente por que nao houve entrada.
Responda somente JSON valido com: matchAnalysis, keyFactors, marketBreakdown, riskAnalysis e bestRecommendation.`;
    const requestInput = isReasoningModel ? compactReasoningInput(input) : input;
    const requestPrompt = input.explanationOnly ? explanationPrompt : isReasoningModel ? reasoningPrompt : prompt;
    const serializedInput = JSON.stringify(requestInput);
    const messages = [
      { role: isReasoningModel ? 'developer' : 'system', content: 'Voce responde somente JSON valido e analisa futebol em portugues do Brasil.' },
      { role: 'user', content: `${requestPrompt}\n\nDados:\n${serializedInput}` }
    ];
    const requestBody = isReasoningModel ? {
      model: deploymentName,
      messages,
      max_completion_tokens: maxTokens,
      reasoning_effort: process.env.AZURE_OPENAI_REASONING_EFFORT || 'minimal',
    } : {
      messages: [
        { role: 'system', content: 'Voce responde somente JSON valido e analisa futebol em portugues do Brasil.' },
        { role: 'user', content: `${requestPrompt}\n\nDados:\n${JSON.stringify(requestInput)}` }
      ],
      temperature: 0.2,
      max_tokens: maxTokens,
    };

    const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-02-15-preview';
    const url = isReasoningModel
      ? `${normalizeAzureEndpoint(endpoint)}openai/v1/chat/completions`
      : `${normalizeAzureEndpoint(endpoint)}openai/deployments/${deploymentName}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;
    const res = await fetchAzureWithRetry(url, requestBody, apiKey, timeoutMs);

    if (!res.ok) {
      const errorText = await res.text();
      if (res.status === 429) {
        const retryAfterMs = Number(res.headers.get('x-ms-retry-after-ms') || 0);
        const retryAfterSeconds = Number(res.headers.get('retry-after') || 0);
        const configuredCooldownMs = Math.max(30000, Number(process.env.AZURE_OPENAI_COOLDOWN_MS || 5 * 60 * 1000));
        const cooldownMs = Math.max(retryAfterMs, retryAfterSeconds * 1000, configuredCooldownMs);
        azureRateLimitedUntil = Date.now() + cooldownMs;
        azureRateLimitReason = 'Novas chamadas foram suspensas para evitar mais respostas 429.';
        console.warn(`Azure OpenAI circuit breaker aberto por ${Math.ceil(cooldownMs / 1000)}s.`);
      }
      const log = res.status === 429 ? console.warn : console.error;
      log(`Azure OpenAI error ${res.status}:`, errorText);
      return { result: null, error: `Azure OpenAI error ${res.status}: ${errorText}` };
    }

    azureRateLimitedUntil = 0;
    azureRateLimitReason = '';

    const json = await res.json();
    const rawContent = json?.choices?.[0]?.message?.content;
    const content = Array.isArray(rawContent)
      ? rawContent
        .map((part: any) => typeof part === 'string' ? part : part?.text || part?.content || '')
        .join('')
      : rawContent;

    if (!content) {
      console.error('No content in Azure OpenAI response:', json);
      const finishReason = json?.choices?.[0]?.finish_reason || json?.choices?.[0]?.finishReason;
      const usage = json?.usage ? ` usage=${JSON.stringify(json.usage)}` : '';
      return { result: null, error: `No content in Azure OpenAI response${finishReason ? `; finish_reason=${finishReason}` : ''}${usage}` };
    }

    const parsed = normalizeGeneratedAnalysis(extractJsonObject(content) as any, input);
    if (input.explanationOnly && input.backendDecision) {
      const fixed = input.backendDecision;
      const explained = parsed.bestRecommendation || {};
      const bestEntry = buildRecommendation({
        market: fixed.market,
        recommendation: fixed.recommendation,
        confidence: fixed.confidence,
        riskLevel: fixed.confidence >= 80 ? 'baixo' : 'medio',
        rationale: explained.rationale || parsed.matchAnalysis || 'Decisão sustentada pelos indicadores objetivos do backend.',
        dataSupport: Array.isArray(explained.dataSupport) ? explained.dataSupport : fixed.confirmations,
        warningSigns: Array.isArray(explained.warningSigns) ? explained.warningSigns : fixed.risks,
      });
      return { result: {
        eventId: eventData?.id ?? 'unknown',
        market: fixed.market,
        recommendation: fixed.recommendation,
        confidence: fixed.confidence,
        rationale: bestEntry.rationale,
        analysisSource: 'azure-openai',
        bestEntry,
        recommendations: [bestEntry],
        matchAnalysis: parsed.matchAnalysis,
        keyFactors: Array.isArray(parsed.keyFactors) ? parsed.keyFactors.slice(0, 3) : undefined,
        homeAnalysis: parsed.homeAnalysis,
        awayAnalysis: parsed.awayAnalysis,
        marketBreakdown: parsed.marketBreakdown,
        confidenceDrivers: Array.isArray(parsed.confidenceDrivers) ? parsed.confidenceDrivers : undefined,
        avoidMarkets: Array.isArray(parsed.avoidMarkets) ? parsed.avoidMarkets : undefined,
        riskAnalysis: parsed.riskAnalysis,
      } };
    }
    const recommendations: BettingRecommendation[] = [];

    if (Array.isArray(parsed.recommendations)) {
      for (const item of parsed.recommendations) {
        if (item && item.market && item.recommendation) {
          recommendations.push(buildRecommendation(item));
        }
      }
    }

    if (recommendations.length === 0 && parsed.bestRecommendation) {
      recommendations.push(buildRecommendation(parsed.bestRecommendation));
    }

    if (recommendations.length === 0 && parsed.market && parsed.recommendation) {
      recommendations.push(buildRecommendation(parsed));
    }

    if (recommendations.length === 0) {
      const noEntryResult: AnalysisResult = {
        eventId: eventData?.id ?? 'unknown',
        market: 'none',
        recommendation: NO_RECOMMENDATION,
        confidence: 0,
        rationale: 'A IA nao identificou vantagem estatistica clara nos mercados analisados.',
        analysisSource: 'azure-openai',
        matchAnalysis: typeof parsed.matchAnalysis === 'string' ? parsed.matchAnalysis : undefined,
        dataCoverage: parsed.dataCoverage,
        keyFactors: Array.isArray(parsed.keyFactors) ? parsed.keyFactors : undefined,
        homeAnalysis: parsed.homeAnalysis,
        awayAnalysis: parsed.awayAnalysis,
        refereeAnalysis: parsed.refereeAnalysis,
        playerAnalysis: parsed.playerAnalysis,
        marketBreakdown: parsed.marketBreakdown,
        confidenceDrivers: Array.isArray(parsed.confidenceDrivers) ? parsed.confidenceDrivers : undefined,
        avoidMarkets: Array.isArray(parsed.avoidMarkets) ? parsed.avoidMarkets : undefined,
        riskAnalysis: typeof parsed.riskAnalysis === 'string' ? parsed.riskAnalysis : undefined,
        recommendations: [],
      };
      return { result: applySelectiveDecisionGate(noEntryResult, input) };
    }

    const result = selectBestRecommendation(recommendations, eventData?.id ?? 'unknown', 'azure-openai');
    result.matchAnalysis = typeof parsed.matchAnalysis === 'string' ? parsed.matchAnalysis : undefined;
    result.dataCoverage = {
      ...(parsed.dataCoverage || {}),
      source: eventData?.source || parsed.dataCoverage?.source || process.env.SCORES_PROVIDER || 'unknown',
    };
    result.keyFactors = Array.isArray(parsed.keyFactors) ? parsed.keyFactors : undefined;
    result.homeAnalysis = parsed.homeAnalysis;
    result.awayAnalysis = parsed.awayAnalysis;
    result.refereeAnalysis = parsed.refereeAnalysis;
    result.playerAnalysis = parsed.playerAnalysis;
    result.marketBreakdown = parsed.marketBreakdown;
    result.confidenceDrivers = Array.isArray(parsed.confidenceDrivers) ? parsed.confidenceDrivers : undefined;
    result.avoidMarkets = Array.isArray(parsed.avoidMarkets) ? parsed.avoidMarkets : undefined;
    result.riskAnalysis = typeof parsed.riskAnalysis === 'string' ? parsed.riskAnalysis : undefined;
    result.bestEntry = parsed.bestRecommendation ? buildRecommendation(parsed.bestRecommendation) : recommendations[0];
    result.meta = { source: 'azure-openai', rawResponse: json, eventId: eventData?.id ?? 'unknown' };
    const enrichedResult = enrichAnalysisWithRealOdds(result, input.odds);
    const gatedResult = applySelectiveDecisionGate(enrichedResult, input);
    return { result: gatedResult };
  } catch (err) {
    console.error('Azure OpenAI analysis error:', err);
    const formattedError = formatError(err);
    const endpointHost = endpoint ? getAzureEndpointHost(endpoint) : 'unknown';
    const dnsHint = formattedError.includes('ENOTFOUND')
      ? `Azure OpenAI endpoint host was not found in DNS: ${endpointHost}. Check AZURE_OPENAI_ENDPOINT in .env. It must be the resource endpoint from Azure Portal, not the deployment name.`
      : formattedError;

    return { result: null, error: dnsHint };
  }
}

function buildOddsRecommendations(oddsResp: any): BettingRecommendation[] {
  const recommendations: BettingRecommendation[] = [];
  const marketGroups = Object.values(oddsResp.markets_by_group || {}) as any[];

  for (const group of marketGroups) {
    for (const market of group.markets || []) {
      const choices = market.choices || [];
      if (!choices.length) continue;

      const sorted = [...choices].sort((a, b) => (a.decimal_odds || 0) - (b.decimal_odds || 0));
      const topChoices = sorted.slice(0, 3);

      for (const choice of topChoices) {
        const implied = choice.decimal_odds ? 1 / choice.decimal_odds : 0;
        const baseConfidence = Math.min(85, Math.round((choice.decimal_odds ? 1 / choice.decimal_odds : 0) * 100));
        recommendations.push(buildRecommendation({
          market: market.market_name || market.market_group || 'odds-market',
          recommendation: `${choice.name} @ ${choice.decimal_odds.toFixed(2)}`,
          confidence: Math.max(30, baseConfidence),
          rationale: `Aposta baseada em cotações do mercado ${market.market_name}: ${choice.name} com odd ${choice.decimal_odds.toFixed(2)}.`,
          meta: {
            marketPeriod: market.market_period,
            choiceGroup: market.choice_group,
            decimal_odds: choice.decimal_odds,
          },
        }));
      }
    }
  }

  return recommendations.sort((a, b) => b.confidence - a.confidence).slice(0, 5);
}

function buildMarketOddsRecommendations(oddsResp: any): BettingRecommendation[] {
  const recommendations: BettingRecommendation[] = [];
  const marketGroups = Object.values(oddsResp?.markets_by_group || {}) as any[];

  for (const group of marketGroups) {
    for (const market of group.markets || []) {
      const choices = Array.isArray(market.choices) ? market.choices : [];
      const validChoices = choices
        .map((choice: any) => ({ ...choice, decimal_odds: Number(choice.decimal_odds || 0) }))
        .filter((choice: any) => Number.isFinite(choice.decimal_odds) && choice.decimal_odds > 1)
        .sort((a: any, b: any) => a.decimal_odds - b.decimal_odds);
      if (!validChoices.length) continue;

      const impliedTotal = validChoices.reduce((total: number, choice: any) => total + (1 / choice.decimal_odds), 0);

      for (const [index, choice] of validChoices.slice(0, 3).entries()) {
        const implied = 1 / choice.decimal_odds;
        const normalizedImplied = impliedTotal > 0 ? implied / impliedTotal : implied;
        const rankBoost = index === 0 ? 8 : index === 1 ? 3 : 0;
        const confidence = Math.max(35, Math.min(78, Math.round(((normalizedImplied * 0.75) + (implied * 0.25)) * 100) + rankBoost));

        recommendations.push(buildRecommendation({
          market: market.market_name || market.market_group || 'odds-market',
          recommendation: `${choice.name} @ ${choice.decimal_odds.toFixed(2)}`,
          confidence,
          rationale: `Entrada baseada nas odds reais do provider: ${choice.name} aparece como a ${index === 0 ? 'opcao mais provavel' : 'opcao alternativa'} com odd ${choice.decimal_odds.toFixed(2)}.`,
          dataSupport: [
            `odd ${choice.decimal_odds.toFixed(2)}`,
            `probabilidade implicita normalizada ${Math.round(normalizedImplied * 100)}%`,
            oddsResp?.source ? `fonte ${oddsResp.source}` : 'fonte odds',
          ],
          riskLevel: confidence >= 65 ? 'baixo' : confidence >= 52 ? 'medio' : 'alto',
          meta: {
            marketPeriod: market.market_period,
            choiceGroup: market.choice_group,
            decimal_odds: choice.decimal_odds,
            impliedProbability: Number((implied * 100).toFixed(2)),
            normalizedImpliedProbability: Number((normalizedImplied * 100).toFixed(2)),
          },
        }));
      }
    }
  }

  return recommendations.sort((a, b) => b.confidence - a.confidence).slice(0, 5);
}

function buildHeuristicRecommendations(event: any): AnalysisResult {
  const home = event.homeTeam?.name || 'Home';
  const away = event.awayTeam?.name || 'Away';
  const homeScore = event.score?.home ?? 0;
  const awayScore = event.score?.away ?? 0;
  const diff = Math.abs(homeScore - awayScore);
  const statusType = event.status?.type || 'notstarted';
  const recommendations: BettingRecommendation[] = [];

  if (statusType === 'notstarted') {
    recommendations.push(buildRecommendation({
      market: 'pre-match',
      recommendation: 'wait for lineups and match data',
      confidence: 35,
      rationale: 'A partida ainda não começou; aguarde escalações, forma recente e sinais de contexto antes de apostar.',
    }));
    recommendations.push(buildRecommendation({
      market: 'pre-match',
      recommendation: `draw no bet ${home} or ${away}`,
      confidence: 40,
      rationale: 'Em jogos equilibrados, o mercado draw no bet pode reduzir risco.',
    }));
    recommendations.push(buildRecommendation({
      market: 'pre-match',
      recommendation: 'under 2.5 goals',
      confidence: 45,
      rationale: 'Em partidas sem favoritos claros, under 2.5 costuma ser uma opção conservadora.',
    }));
  } else {
    if (diff >= 2) {
      const leader = homeScore > awayScore ? home : away;
      recommendations.push(buildRecommendation({
        market: 'match-winner',
        recommendation: `${leader} to win`,
        confidence: 80,
        rationale: `Time com vantagem de ${diff} gols tem boa chance de vitória.`,
      }));
      recommendations.push(buildRecommendation({
        market: 'inplay',
        recommendation: 'under 3.5 goals',
        confidence: 55,
        rationale: 'Partida com vantagem pode segurar o ritmo e limitar gols.',
      }));
    }

    recommendations.push(buildRecommendation({
      market: 'inplay',
      recommendation: 'over 2.5 goals',
      confidence: homeScore + awayScore >= 2 ? 60 : 40,
      rationale: 'Se já há gols no placar, é provável que a partida continue aberta.',
    }));
    recommendations.push(buildRecommendation({
      market: 'inplay',
      recommendation: 'next goal: either team',
      confidence: 45,
      rationale: 'Mercado de próximo gol pode oferecer valor em partidas com chances balanceadas.',
    }));
    recommendations.push(buildRecommendation({
      market: 'inplay',
      recommendation: 'both teams to score',
      confidence: 50,
      rationale: 'Se ambas equipes têm qualidade ofensiva, BTTS é uma boa alternativa.',
    }));
  }

  return selectBestRecommendation(recommendations, event.id ?? 'unknown', 'heuristic');
}

function isActionableAnalysis(result: AnalysisResult | null) {
  if (!result) return false;
  const recommendation = normalizeText(result.recommendation);
  const market = normalizeText(result.market);
  if (Number(result.confidence || 0) <= 0) return false;
  if (['error', 'erro', 'none', 'nenhum'].includes(recommendation)) return false;
  if (['error', 'erro', 'none', 'nenhum'].includes(market)) return false;
  if (recommendation.includes('nenhuma entrada') || recommendation.includes('no recommendation')) return false;
  return true;
}

function attachEventPresentation(result: AnalysisResult, event: any, lineups?: any): AnalysisResult {
  const lineupData = lineups?.data || lineups;
  return {
    ...result,
    eventId: event?.id ?? result.eventId,
    homeTeam: event?.homeTeam ? {
      id: event.homeTeam.id,
      name: event.homeTeam.name,
      shortName: event.homeTeam.shortName,
      slug: event.homeTeam.slug,
      imageUrl: lineupData?.home?.team?.imageUrl || event.homeTeam.imageUrl,
    } : result.homeTeam,
    awayTeam: event?.awayTeam ? {
      id: event.awayTeam.id,
      name: event.awayTeam.name,
      shortName: event.awayTeam.shortName,
      slug: event.awayTeam.slug,
      imageUrl: lineupData?.away?.team?.imageUrl || event.awayTeam.imageUrl,
    } : result.awayTeam,
    tournamentName: event?.tournament?.name || result.tournamentName,
    startTimestamp: event?.startTimestamp ?? event?.startTime ?? result.startTimestamp,
    round: event?.round ?? event?.roundInfo?.round ?? result.round,
    venue: event?.venue?.name && !/^unknown$/i.test(String(event.venue.name))
      ? { id: event.venue.id, name: event.venue.name, city: event.venue.city }
      : result.venue,
  };
}

export async function analyzeEvent(eventId: number | string, options: AnalyzeOptions = {}): Promise<AnalysisResult> {
  const {
    useLLM = true,
    useLLMExplanation = true,
    explainRejected = false,
    includeOdds = false,
    useOddsFallback = false,
    includeEnrichment = true,
    requireRealOdds = false,
    minimumExpectedValue,
  } = options;
  const eventResp = await fetchEvent(eventId).catch((err) => {
    if (err instanceof SofaScoreBlockedError) {
      return {
        status: err.status,
        raw: {
          error: err.code,
          message: err.message,
          attempts: err.attempts,
        },
      } as any;
    }

    throw err;
  });

  if (!eventResp || eventResp.status !== 200 || !eventResp.data) {
    const providerReason = eventResp?.raw?.reason || eventResp?.raw?.matches?.error || eventResp?.raw?.message;
    return {
      eventId,
      market: 'none',
      recommendation: 'error',
      confidence: 0,
      rationale: providerReason
        ? `Não foi possível obter dados do evento: ${providerReason}`
        : 'Não foi possível obter dados do evento',
      meta: { raw: eventResp?.raw },
    } as AnalysisResult;
  }

  const event = eventResp.data;
  const is365ScoresProvider = process.env.SCORES_PROVIDER === '365scores';
  const isAiScoreProvider = process.env.SCORES_PROVIDER === 'aiscore';
  const isOgolProvider = process.env.SCORES_PROVIDER === 'ogol';
  const shouldUseOdds = includeOdds || useOddsFallback || requireRealOdds;
  const needsDeepData = useLLM;
  const [oddsResp, statisticsResp, incidentsResp, lineupsResp, streaksResp, topPlayersResp, scores365Resp] = await Promise.all([
    shouldUseOdds
      ? safeFetch('odds', () => is365ScoresProvider
        ? fetch365Odds(eventId)
        : isAiScoreProvider
          ? fetchAiScoreOdds(eventId)
          : isOgolProvider
            ? fetchOgolOdds(eventId)
            : fetchOdds(eventId, 1))
      : Promise.resolve(null),
    needsDeepData && !is365ScoresProvider
      ? safeFetch('statistics', () => isAiScoreProvider ? fetchAiScoreStatistics(eventId) : isOgolProvider ? fetchOgolStatistics(eventId) : fetchStatistics(eventId))
      : Promise.resolve(null),
    needsDeepData && !is365ScoresProvider
      ? safeFetch('incidents', () => isAiScoreProvider ? fetchAiScoreIncidents(eventId) : isOgolProvider ? fetchOgolIncidents(eventId) : fetchIncidents(eventId))
      : Promise.resolve(null),
    needsDeepData && !is365ScoresProvider
      ? safeFetch('lineups', () => isAiScoreProvider ? fetchAiScoreLineups(eventId) : isOgolProvider ? fetchOgolLineups(eventId) : fetchLineups(eventId))
      : Promise.resolve(null),
    needsDeepData && !is365ScoresProvider
      ? safeFetch('streaks', () => isAiScoreProvider ? fetchAiScoreStreaks(String(eventId)) : isOgolProvider ? fetchOgolStreaks(String(eventId)) : fetchStreaks(String(eventId)))
      : Promise.resolve(null),
    useLLM && !is365ScoresProvider && !isAiScoreProvider && !isOgolProvider ? fetchTopPlayersForEvent(event) : Promise.resolve(null),
    useLLM && includeEnrichment && !is365ScoresProvider ? safeFetch('365Scores enrichment', () => fetch365Enrichment(event)) : Promise.resolve(null),
  ]);
  let llmError: string | undefined;

  if (useLLM) {
    const fullInput = buildLLMInput(
      { raw: eventResp.raw, data: eventResp.data },
      shouldUseOdds ? oddsResp : null,
      statisticsResp,
      incidentsResp,
      lineupsResp,
      streaksResp,
      topPlayersResp,
      scores365Resp
    );
    const statisticalDecision = buildStatisticalDecision(fullInput, event.id ?? eventId, {
      requireRealOdds,
      minimumExpectedValue,
      oddsResponses: [
        oddsResp || {
          source: is365ScoresProvider ? '365scores' : isAiScoreProvider ? 'aiscore' : isOgolProvider ? 'ogol' : 'sofascore',
          unavailableReason: shouldUseOdds ? 'A fonte principal nao retornou mercados de odds.' : 'A coleta de odds nao foi solicitada.',
        },
        scores365Resp?.available
          ? scores365Resp.odds
          : { source: '365scores', unavailableReason: scores365Resp?.reason || 'Enriquecimento alternativo nao retornou uma partida correspondente.' },
      ],
    });
    const decisionAudit = statisticalDecision.meta?.decisionAudit as any;

    // By default rejected matches do not consume Azure quota. Manual searches can
    // opt in to an LLM explanation so the user sees why there was no entry.
    if (decisionAudit?.decision !== 'approved' && !explainRejected) {
      return attachEventPresentation(statisticalDecision, event, lineupsResp);
    }

    if (!useLLMExplanation) {
      return attachEventPresentation(statisticalDecision, event, lineupsResp);
    }

    const explanationInput = buildExplanationInput(fullInput, statisticalDecision);
    const llmAnalysis = await callLLMAnalysis(explanationInput);
    llmError = llmAnalysis.error;
    const explanation = llmAnalysis.result;
    const explainedDecision: AnalysisResult = {
      ...statisticalDecision,
      analysisSource: explanation ? 'azure-openai' : 'heuristic',
      rationale: explanation?.rationale || explanation?.bestEntry?.rationale || statisticalDecision.rationale,
      matchAnalysis: explanation?.matchAnalysis,
      dataCoverage: explanation?.dataCoverage,
      keyFactors: explanation?.keyFactors,
      homeAnalysis: explanation?.homeAnalysis,
      awayAnalysis: explanation?.awayAnalysis,
      refereeAnalysis: undefined,
      playerAnalysis: undefined,
      marketBreakdown: explanation?.marketBreakdown,
      confidenceDrivers: explanation?.confidenceDrivers,
      avoidMarkets: explanation?.avoidMarkets,
      riskAnalysis: explanation?.riskAnalysis,
      bestEntry: statisticalDecision.bestEntry ? {
        ...statisticalDecision.bestEntry,
        rationale: explanation?.bestEntry?.rationale || explanation?.rationale || statisticalDecision.bestEntry.rationale,
        dataSupport: explanation?.bestEntry?.dataSupport || statisticalDecision.bestEntry.dataSupport,
        warningSigns: explanation?.bestEntry?.warningSigns || statisticalDecision.bestEntry.warningSigns,
      } : undefined,
      meta: { ...(statisticalDecision.meta || {}), llmError, explanationOnly: true },
    };
    return attachEventPresentation(explainedDecision, event, lineupsResp);
  }

  if (useOddsFallback && oddsResp && oddsResp.markets_by_group) {
    const recommendations = buildOddsRecommendations(oddsResp);
    if (recommendations.length) {
      const result = selectBestRecommendation(recommendations, event.id ?? eventId, 'odds');
      result.meta = {
        source: 'odds',
        rawOdds: oddsResp,
        eventId,
        llmError,
      };
      return attachEventPresentation(result, event, lineupsResp);
    }
  }

  const result = buildHeuristicRecommendations(event);
  result.meta = { ...(result.meta || {}), llmError };
  return attachEventPresentation(result, event, lineupsResp);
}

export default analyzeEvent;
