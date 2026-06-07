import { fetchEvent } from '../scrapers/event';
import { fetchIncidents } from '../scrapers/incidents';
import { fetchLineups } from '../scrapers/lineups';
import { fetchOdds } from '../scrapers/odds';
import { fetchStatistics } from '../scrapers/statistics';
import { fetchStreaks } from '../scrapers/streaks';
import type { AnalysisResult, AnalyzeOptions, BettingRecommendation } from '../types/analysis';

interface LLMAnalysisInput {
  event: any;
  odds?: any;
  statistics?: any;
  incidents?: any;
  lineups?: any;
  streaks?: any;
}

interface LLMAnalysisResponse {
  result: AnalysisResult | null;
  error?: string;
}

function buildRecommendation(data: Partial<BettingRecommendation>): BettingRecommendation {
  return {
    market: data.market || 'unknown',
    recommendation: data.recommendation || 'No recommendation',
    confidence: typeof data.confidence === 'number' ? data.confidence : 50,
    rationale: data.rationale || '',
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

  if (!best || best.score < 2) return recommendation;

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
  return periods.map(([period, periodData]: [string, any]) => ({
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

  const summarizeSide = (side: any) => ({
    formation: side?.formation,
    missingPlayers: limitArray(side?.missingPlayers, 8).map((item: any) => ({
      name: item.player?.name || item.name,
      reason: item.reason,
    })),
    starters: limitArray((side?.players || []).filter((player: any) => !player.substitute), 11).map((item: any) => ({
      name: item.player?.name,
      position: item.position,
      rating: item.avgRating,
      captain: item.captain,
    })),
  });

  return {
    confirmed: data.confirmed,
    home: summarizeSide(data.home),
    away: summarizeSide(data.away),
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

function buildLLMInput(event: any, oddsResp: any, statisticsResp: any, incidentsResp: any, lineupsResp: any, streaksResp: any): LLMAnalysisInput {
  const normalizedEvent = event.event || event;

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
  };
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
Analise os dados da partida em profundidade. Compare mandante e visitante usando contexto do jogo, forma recente/streaks, escalacoes, desfalques, estatisticas, incidentes e placar/status.
Nao escolha entradas por cotacao, odd baixa, odd favorita ou probabilidade implicita de mercado. A recomendacao deve nascer da leitura tecnica da partida.
Se odds forem enviadas nos dados, use apenas como contexto secundario de mercado e nunca como motivo principal da entrada.
Se algum bloco de dados estiver ausente, explique a incerteza sem inventar fatos.
Retorne APENAS um JSON valido neste formato:
{
  "matchAnalysis": "leitura geral da partida em portugues, com contexto, ritmo provavel ou leitura ao vivo",
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
  "recommendations": [
    {
      "market": "nome do mercado",
      "recommendation": "entrada objetiva",
      "confidence": 0,
      "rationale": "analise detalhada em portugues explicando por que essa entrada faz sentido"
    }
  ],
  "bestRecommendation": {
    "market": "nome do mercado",
    "recommendation": "melhor entrada",
    "confidence": 0,
    "rationale": "por que esta e a melhor entrada"
  },
  "riskAnalysis": "principais riscos que podem invalidar a entrada"
}
Inclua pelo menos 3 recomendacoes, escolha a melhor entrada com disciplina e nunca use texto fora do JSON.`;

    const requestBody = {
      messages: [
        { role: 'system', content: 'Voce responde somente JSON valido e analisa futebol em portugues do Brasil.' },
        { role: 'user', content: `${prompt}\n\nDados:\n${JSON.stringify(input)}` }
      ],
      temperature: 0.2,
      max_tokens: 1400,
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
    result.homeAnalysis = parsed.homeAnalysis;
    result.awayAnalysis = parsed.awayAnalysis;
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
  const eventResp = await fetchEvent(eventId);

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
  const [oddsResp, statisticsResp, incidentsResp, lineupsResp, streaksResp] = await Promise.all([
    includeOdds || useOddsFallback ? safeFetch('odds', () => fetchOdds(eventId, 1)) : Promise.resolve(null),
    safeFetch('statistics', () => fetchStatistics(eventId)),
    safeFetch('incidents', () => fetchIncidents(eventId)),
    safeFetch('lineups', () => fetchLineups(eventId)),
    safeFetch('streaks', () => fetchStreaks(String(eventId))),
  ]);
  let llmError: string | undefined;

  if (useLLM) {
    const llmInput = buildLLMInput(
      eventResp.raw || eventResp.data,
      includeOdds ? oddsResp : null,
      statisticsResp,
      incidentsResp,
      lineupsResp,
      streaksResp
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
