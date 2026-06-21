import { fetchEvent, SofaScoreBlockedError } from '../scrapers/event';
import { fetchIncidents } from '../scrapers/incidents';
import { fetchLineups } from '../scrapers/lineups';
import { fetchOdds } from '../scrapers/odds';
import { fetchStatistics } from '../scrapers/statistics';
import { fetchStreaks } from '../scrapers/streaks';
import { fetchTopPlayers } from '../scrapers/top-players';
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
}

interface LLMAnalysisResponse {
  result: AnalysisResult | null;
  error?: string;
}

function buildRecommendation(data: Partial<BettingRecommendation>): BettingRecommendation {
  const confidence = typeof data.confidence === 'number'
    ? data.confidence <= 1 ? Math.round(data.confidence * 100) : data.confidence
    : 50;

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

function summarizeStatistics(statisticsResp: any) {
  if (!statisticsResp?.by_period) return undefined;

  const periods = Object.entries(statisticsResp.by_period).slice(0, 3);
  const teamPeriods = periods.map(([period, periodData]: [string, any]) => ({
    period,
    groups: Object.values(periodData.groups_by_name || {}).map((group: any) => ({
      group: group.group_name,
      items: limitArray(group.items, 12).map((item: any) => ({
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
      stats: item.stats,
  });
  const summarizeSide = (side: any) => {
    const starters = (side?.players || []).filter((player: any) => !player.substitute);
    const bench = (side?.players || []).filter((player: any) => player.substitute);
    const keyStarters = [...starters]
      .filter((player: any) => Number.isFinite(Number(player.avgRating)))
      .sort((a: any, b: any) => Number(b.avgRating) - Number(a.avgRating));

    return {
      formation: side?.formation,
      missingPlayers: limitArray(side?.missingPlayers, 8).map((item: any) => ({
        name: item.player?.name || item.name,
        reason: item.reason,
      })),
      starters: limitArray(starters, 11).map(summarizePlayer),
      keyStartersByRating: limitArray(keyStarters, 5).map(summarizePlayer),
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

  return {
    general: limitArray(data.general, 12),
    head2head: limitArray(data.head2head, 12),
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

function build365LLMInput(raw: any, normalizedEvent: any, statisticsResp: any, incidentsResp: any, lineupsResp: any, streaksResp: any): LLMAnalysisInput {
  const game = raw.game || {};

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
  } as LLMAnalysisInput;
}

function buildLLMInput(event: any, oddsResp: any, statisticsResp: any, incidentsResp: any, lineupsResp: any, streaksResp: any, topPlayersResp?: any): LLMAnalysisInput {
  if (event?.raw?.game && event?.data) {
    return build365LLMInput(event.raw, event.data, statisticsResp, incidentsResp, lineupsResp, streaksResp);
  }

  const sourceEvent = event?.raw?.event || event?.data || event;
  const normalizedEvent = sourceEvent.event || sourceEvent;

  return {
    event: {
      id: normalizedEvent.id,
      slug: normalizedEvent.slug,
      tournament: normalizedEvent.tournament,
      season: normalizedEvent.season,
      roundInfo: normalizedEvent.roundInfo,
      status: normalizedEvent.status,
      startTimestamp: normalizedEvent.startTimestamp,
      homeTeam: normalizedEvent.homeTeam,
      awayTeam: normalizedEvent.awayTeam,
      homeScore: normalizedEvent.homeScore,
      awayScore: normalizedEvent.awayScore,
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
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const deploymentName = process.env.AZURE_OPENAI_DEPLOYMENT_NAME;
  const eventData = input.event;

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
So recomende mercado de jogador quando existir suporte nos dados esportivos enviados. Se houver playerProps/topPerformers/statistics.players, use esses dados para explicar gol, finalizacao ou chute no gol; se faltar estatistica individual de finalizacao, diga a incerteza e prefira mercados de time.
Na fonte 365scores, o arbitro pode vir em event.referee vindo de officials. Se houver nome do arbitro mas sem media historica de cartoes, marque refereeAnalysis.available como true, informe que o arbitro foi identificado, e classifique cardsTrend como "historico indisponivel" em vez de "indisponivel". Use estatisticas de cartoes do jogo quando existirem.
Considere tambem mercados de gols, ambas marcam, vencedor, dupla chance, handicap, escanteios, cartoes e entradas ao vivo quando os dados sustentarem.
Nao escolha entradas por cotacao, odd baixa, odd favorita, voto popular, predicao de mercado ou probabilidade implicita de mercado. A recomendacao deve nascer somente da leitura tecnica da partida.
Se algum dado de odd, cotacao, relatedLines, prediction ou mercado aparecer acidentalmente nos dados, ignore completamente para a decisao e para a justificativa.
Se algum bloco de dados estiver ausente, explique a incerteza sem inventar fatos.
Se a partida for pre-match, diferencie leitura provavel de fato confirmado.
Evite frases genericas. Cite os dados concretos recebidos: status, local, top performers, escalacoes, estatisticas, desfalques, shot chart, incidentes e perfil de arbitro.
Retorne APENAS um JSON valido neste formato:
{
  "dataCoverage": {
    "source": "365scores ou sofascore",
    "hasLineups": true,
    "hasTopPerformers": true,
    "hasPlayerProps": true,
    "hasShotChart": true,
    "hasStatistics": true,
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
Inclua entre 5 e 8 recomendacoes quando houver dados suficientes, cubra categorias diferentes de mercado, escolha a melhor entrada com disciplina e nunca use texto fora do JSON.`;

    const requestBody = {
      messages: [
        { role: 'system', content: 'Voce responde somente JSON valido e analisa futebol em portugues do Brasil.' },
        { role: 'user', content: `${prompt}\n\nDados:\n${JSON.stringify(input)}` }
      ],
      temperature: 0.2,
      max_tokens: 3200,
    };

    const url = `${normalizeAzureEndpoint(endpoint)}openai/deployments/${deploymentName}/chat/completions?api-version=2024-02-15-preview`;
    console.log('Calling Azure OpenAI at:', url);

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': apiKey,
      },
      body: JSON.stringify(requestBody),
    });

    console.log('Azure OpenAI response status:', res.status);

    if (!res.ok) {
      const errorText = await res.text();
      console.error(`Azure OpenAI error ${res.status}:`, errorText);
      return { result: null, error: `Azure OpenAI error ${res.status}: ${errorText}` };
    }

    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content;

    if (!content) {
      console.error('No content in Azure OpenAI response:', json);
      return { result: null, error: 'No content in Azure OpenAI response' };
    }

    console.log('Azure OpenAI raw response:', content);
    const parsed = extractJsonObject(content) as any;
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
      console.error('No valid recommendations extracted from Azure OpenAI response');
      return { result: null, error: 'No valid recommendations extracted from Azure OpenAI response' };
    }

    const result = selectBestRecommendation(recommendations, eventData?.id ?? 'unknown', 'azure-openai');
    result.matchAnalysis = typeof parsed.matchAnalysis === 'string' ? parsed.matchAnalysis : undefined;
    result.dataCoverage = parsed.dataCoverage;
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
    console.log('Azure OpenAI analysis success:', enrichedResult.analysisSource);
    return { result: enrichedResult };
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

export async function analyzeEvent(eventId: number | string, options: AnalyzeOptions = {}): Promise<AnalysisResult> {
  const {
    useLLM = true,
    includeOdds = false,
    useOddsFallback = false,
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
    return {
      eventId,
      market: 'none',
      recommendation: 'error',
      confidence: 0,
      rationale: 'Não foi possível obter dados do evento',
      meta: { raw: eventResp?.raw },
    } as AnalysisResult;
  }

  const event = eventResp.data;
  const is365ScoresProvider = process.env.SCORES_PROVIDER === '365scores';
  const [oddsResp, statisticsResp, incidentsResp, lineupsResp, streaksResp, topPlayersResp] = await Promise.all([
    !is365ScoresProvider && (includeOdds || useOddsFallback) ? safeFetch('odds', () => fetchOdds(eventId, 1)) : Promise.resolve(null),
    !is365ScoresProvider ? safeFetch('statistics', () => fetchStatistics(eventId)) : Promise.resolve(null),
    !is365ScoresProvider ? safeFetch('incidents', () => fetchIncidents(eventId)) : Promise.resolve(null),
    !is365ScoresProvider ? safeFetch('lineups', () => fetchLineups(eventId)) : Promise.resolve(null),
    !is365ScoresProvider ? safeFetch('streaks', () => fetchStreaks(String(eventId))) : Promise.resolve(null),
    useLLM && !is365ScoresProvider ? fetchTopPlayersForEvent(event) : Promise.resolve(null),
  ]);
  let llmError: string | undefined;

  if (useLLM) {
    const llmInput = buildLLMInput(
      { raw: eventResp.raw, data: eventResp.data },
      includeOdds ? oddsResp : null,
      statisticsResp,
      incidentsResp,
      lineupsResp,
      streaksResp,
      topPlayersResp
    );
    const llmAnalysis = await callLLMAnalysis(llmInput);
    if (llmAnalysis.result) return llmAnalysis.result;
    llmError = llmAnalysis.error;
  }

  if (!useLLM && useOddsFallback && oddsResp && oddsResp.markets_by_group) {
    const recommendations = buildOddsRecommendations(oddsResp);
    if (recommendations.length) {
      const result = selectBestRecommendation(recommendations, event.id ?? eventId, 'odds');
      result.meta = { source: 'odds', rawOdds: oddsResp, eventId, llmError };
      return result;
    }
  }

  const result = buildHeuristicRecommendations(event);
  result.meta = { ...(result.meta || {}), llmError };
  return result;
}

export default analyzeEvent;
