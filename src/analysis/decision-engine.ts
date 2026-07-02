import type { AnalysisResult, BettingRecommendation } from '../types/analysis';

export const NO_RECOMMENDATION = 'Nenhuma entrada recomendada para este jogo.';
export const OPTIONAL_DATA_UNAVAILABLE = 'Dado não disponível.';

type MarketFamily = 'goals' | 'winner' | 'corners' | 'cards' | 'player' | 'unknown';

export type DecisionCandidateAudit = {
  market: string;
  recommendation: string;
  family: MarketFamily;
  aiConfidence: number;
  objectiveConfidence: number;
  dataQuality: number;
  marketEvidence: number;
  confirmations: string[];
  rejectionReasons: string[];
  expectedValue?: number;
};

export type DecisionAudit = {
  decision: 'approved' | 'rejected';
  threshold: number;
  dataQuality: number;
  missingData: string[];
  candidates: DecisionCandidateAudit[];
  selectedMarket?: string;
  selectedRecommendation?: string;
  reasons: string[];
};

function normalized(value: unknown) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

export function normalizeUnavailableData<T>(value: T): T {
  if (typeof value === 'string') {
    const text = normalized(value);
    if (/sem dados|dados? nao disponive(?:l|is)|nao ha (?:dados|informacoes)|historico indisponivel|informacao indisponivel/.test(text)) {
      return OPTIONAL_DATA_UNAVAILABLE as T;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeUnavailableData(item)) as T;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, normalizeUnavailableData(item)])
    ) as T;
  }
  return value;
}

function finite(value: unknown): number | undefined {
  if (value === null || value === undefined || String(value).trim() === '') return undefined;
  const parsed = Number(String(value).replace(',', '.').replace(/[^\d.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function clamp(value: number, min = 0, max = 100) {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function familyOf(recommendation: BettingRecommendation): MarketFamily {
  const text = normalized(`${recommendation.market} ${recommendation.recommendation}`);
  if (/escanteio|corner/.test(text)) return 'corners';
  if (/cart|amarelo|vermelho|falta/.test(text)) return 'cards';
  if (/chute|finaliza|remate|jogador|gol de|assistencia/.test(text)) return 'player';
  if (/over|under|gol|ambas|btts|mais de|menos de/.test(text)) return 'goals';
  if (/vencedor|resultado|handicap|dupla chance|empate anula|draw no bet|1x2|match.winner/.test(text)) return 'winner';
  return 'unknown';
}

function allStatItems(input: any) {
  return (input?.statistics?.teamPeriods || [])
    .flatMap((period: any) => period?.groups || [])
    .flatMap((group: any) => group?.items || []);
}

function matchingStats(input: any, pattern: RegExp) {
  return allStatItems(input).filter((item: any) => pattern.test(normalized(`${item?.name} ${item?.key}`)));
}

function hasNumericPair(items: any[]) {
  return items.some((item) => finite(item?.home) !== undefined && finite(item?.away) !== undefined);
}

function historyPlayed(input: any, side: 'home' | 'away') {
  const recent = input?.teamForm?.[`${side}Recent`];
  return finite(recent?.played) || 0;
}

function seasonPlayed(input: any, side: 'home' | 'away') {
  return finite(input?.statistics?.context?.seasonFacts?.[side]?.matches) || 0;
}

function rate(input: any, side: 'home' | 'away', field: string) {
  return finite(input?.teamForm?.[`${side}Recent`]?.[field]);
}

function average(values: Array<number | undefined>) {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length ? present.reduce((total, value) => total + value, 0) / present.length : undefined;
}

function dataQuality(input: any) {
  const homeMatches = historyPlayed(input, 'home');
  const awayMatches = historyPlayed(input, 'away');
  const statItems = allStatItems(input);
  const homePlayers = input?.lineups?.home?.starters?.length || input?.lineups?.home?.keyPlayersByMarketValue?.length || 0;
  const awayPlayers = input?.lineups?.away?.starters?.length || input?.lineups?.away?.keyPlayersByMarketValue?.length || 0;
  const h2h = input?.teamForm?.headToHead?.played || input?.streaks?.head2head?.length || 0;
  const homeSeasonMatches = seasonPlayed(input, 'home');
  const awaySeasonMatches = seasonPlayed(input, 'away');
  const missing: string[] = [];
  let score = 0;

  if (homeMatches >= 10 && awayMatches >= 10) score += 30;
  else if (homeMatches >= 5 && awayMatches >= 5) score += 27;
  else if (homeMatches >= 3 && awayMatches >= 3) score += 22;
  else if (homeMatches >= 2 && awayMatches >= 2) score += 12;
  else missing.push('historico_recente_insuficiente');

  if (statItems.length >= 10) score += 30;
  else if (statItems.length >= 6) score += 25;
  else if (statItems.length >= 3) score += 18;
  else if (statItems.length > 0) score += 8;
  else missing.push('estatisticas_de_equipe');

  if (homeSeasonMatches >= 5 && awaySeasonMatches >= 5) score += 15;
  else missing.push('amostra_da_temporada');

  const hasVenueSplits = Boolean(
    input?.teamForm?.homeRecent?.homePerformance?.played
    && input?.teamForm?.awayRecent?.awayPerformance?.played
  );
  if (hasVenueSplits) score += 8;
  else missing.push('desempenho_casa_fora');

  if (homePlayers >= 5 && awayPlayers >= 5) score += 6;
  else missing.push('escalacoes_ou_elenco');

  if (h2h >= 3) score += 5;
  else missing.push('confrontos_diretos');

  if (input?.event?.referee?.id || input?.refereeProfile?.id || input?.statistics?.context?.referee?.name) score += 3;
  else missing.push('arbitro');

  if (input?.statistics?.context?.competitionTable?.home || input?.statistics?.context?.teamNeeds?.home) score += 3;
  else missing.push('contexto_do_campeonato');

  return {
    score: clamp(score),
    missing,
    homeMatches,
    awayMatches,
    homeSeasonMatches,
    awaySeasonMatches,
    statItems,
  };
}

function assessGoals(input: any, recommendation: BettingRecommendation) {
  const text = normalized(`${recommendation.market} ${recommendation.recommendation}`);
  const confirmations: string[] = [];
  const reasons: string[] = [];
  let score = 0;
  const goals = matchingStats(input, /gol|xg|expected/);
  const avgGoalsFor = average([rate(input, 'home', 'avgGoalsFor'), rate(input, 'away', 'avgGoalsFor')]);
  const avgGoalsAgainst = average([rate(input, 'home', 'avgGoalsAgainst'), rate(input, 'away', 'avgGoalsAgainst')]);
  const overRate = average([rate(input, 'home', 'over25Rate'), rate(input, 'away', 'over25Rate')]);
  const bttsRate = average([rate(input, 'home', 'bttsRate'), rate(input, 'away', 'bttsRate')]);
  const cleanSheetRate = average([rate(input, 'home', 'cleanSheetRate'), rate(input, 'away', 'cleanSheetRate')]);

  if (hasNumericPair(goals)) { score += 25; confirmations.push('estatisticas de gols das duas equipes'); }
  if (avgGoalsFor !== undefined && avgGoalsAgainst !== undefined) { score += 25; confirmations.push('medias recentes de gols marcados e sofridos'); }

  if (/over|mais de/.test(text)) {
    if ((overRate ?? 0) >= 60) { score += 25; confirmations.push(`over 2.5 em ${Math.round(overRate!)}% da amostra`); }
    else if (overRate !== undefined && overRate < 50) reasons.push('tendencia recente nao confirma mercado over');
    if ((avgGoalsFor ?? 0) + (avgGoalsAgainst ?? 0) >= 2.6) score += 20;
  } else if (/under|menos de/.test(text)) {
    if (overRate !== undefined && overRate <= 40) { score += 25; confirmations.push(`baixa frequencia de over 2.5 (${Math.round(overRate)}%)`); }
    else if (overRate !== undefined && overRate > 50) reasons.push('tendencia recente conflita com mercado under');
    if ((avgGoalsFor ?? 99) + (avgGoalsAgainst ?? 99) <= 2.4 || (cleanSheetRate ?? 0) >= 40) score += 20;
  } else if (/ambas|btts/.test(text)) {
    const wantsNo = /nao|no /.test(text);
    const confirmed = wantsNo ? (bttsRate ?? 100) <= 40 : (bttsRate ?? 0) >= 60;
    if (confirmed) { score += 45; confirmations.push(`BTTS recente em ${Math.round(bttsRate!)}% da amostra`); }
    else if (bttsRate !== undefined) reasons.push('frequencia de ambas marcam nao confirma a selecao');
  }

  if (confirmations.length < 2) reasons.push('mercado de gols sem dois indicadores independentes');
  return { score: clamp(score), confirmations, reasons };
}

function assessWinner(input: any, recommendation: BettingRecommendation) {
  const confirmations: string[] = [];
  const reasons: string[] = [];
  let score = 0;
  const standings = input?.statistics?.context?.competitionTable;
  const goalStats = matchingStats(input, /gol|ponto|posicao|vitoria|derrota/);
  const homeRecord = input?.teamForm?.homeRecent;
  const awayRecord = input?.teamForm?.awayRecent;

  if (standings?.home && standings?.away) { score += 25; confirmations.push('posicao e pontos no campeonato'); }
  if (hasNumericPair(goalStats)) { score += 25; confirmations.push('diferenca tecnica em resultados e gols'); }
  if (homeRecord?.played >= 5 && awayRecord?.played >= 5) { score += 25; confirmations.push('forma recente de ambas as equipes'); }
  if (homeRecord?.homePerformance?.played >= 3 && awayRecord?.awayPerformance?.played >= 3) {
    score += 20;
    confirmations.push('desempenho casa e fora');
  }
  if (confirmations.length < 3) reasons.push('resultado exige forma, contexto de campeonato e mando confirmados');
  return { score: clamp(score), confirmations, reasons };
}

function assessSimpleStats(input: any, family: 'corners' | 'cards') {
  const confirmations: string[] = [];
  const reasons: string[] = [];
  let score = 0;
  const primary = family === 'corners'
    ? matchingStats(input, /escanteio|corner/)
    : matchingStats(input, /cart|amarelo|vermelho|falta/);
  const secondary = family === 'corners'
    ? matchingStats(input, /chute|finaliza|remate/)
    : matchingStats(input, /falta/);

  if (hasNumericPair(primary)) { score += 55; confirmations.push(`media numerica de ${family === 'corners' ? 'escanteios' : 'cartoes'} das equipes`); }
  else reasons.push(`sem media numerica de ${family === 'corners' ? 'escanteios' : 'cartoes'} para as duas equipes`);
  if (hasNumericPair(secondary)) { score += 20; confirmations.push(family === 'corners' ? 'volume de finalizacoes' : 'perfil de faltas das equipes'); }
  if (family === 'cards') {
    const referee = input?.statistics?.context?.referee || input?.refereeProfile;
    if (finite(referee?.cardsAverage) !== undefined || finite(referee?.yellowCardsPerGame) !== undefined) {
      score += 20;
      confirmations.push('media disciplinar do arbitro');
    } else reasons.push('sem media disciplinar do arbitro');
  }
  if (confirmations.length < 2) reasons.push('mercado sem confirmacao por multiplos indicadores');
  return { score: clamp(score), confirmations, reasons };
}

function assessPlayer(input: any) {
  const confirmations: string[] = [];
  const reasons: string[] = [];
  let score = 0;
  const players = input?.statistics?.players || [];
  const hasShots = players.some((player: any) => finite(player?.shots) !== undefined && finite(player?.shotsOnTarget) !== undefined);
  if (hasShots) { score += 55; confirmations.push('finalizacoes e chutes no alvo do jogador'); }
  else reasons.push('sem historico individual de finalizacoes no alvo');
  if (input?.lineups?.confirmed) { score += 25; confirmations.push('escalacao confirmada'); }
  else reasons.push('jogador sem titularidade confirmada');
  if (input?.topPlayers?.home?.length || input?.topPlayers?.away?.length) { score += 15; confirmations.push('desempenho individual recente'); }
  return { score: clamp(score), confirmations, reasons };
}

function assessMarket(input: any, recommendation: BettingRecommendation) {
  const family = familyOf(recommendation);
  if (family === 'goals') return { family, ...assessGoals(input, recommendation) };
  if (family === 'winner') return { family, ...assessWinner(input, recommendation) };
  if (family === 'corners' || family === 'cards') return { family, ...assessSimpleStats(input, family) };
  if (family === 'player') return { family, ...assessPlayer(input) };
  return { family, score: 0, confirmations: [], reasons: ['mercado nao reconhecido pelo validador estatistico'] };
}

function decimalOdd(recommendation: BettingRecommendation) {
  const value = finite(recommendation.meta?.decimal_odds);
  return value && value > 1 ? value : undefined;
}

export function applySelectiveDecisionGate(result: AnalysisResult, input: any): AnalysisResult {
  const threshold = clamp(finite(process.env.ANALYSIS_MIN_CONFIDENCE) ?? 68, 55, 90);
  const quality = dataQuality(input);
  const sourceRecommendations = result.recommendations?.length
    ? result.recommendations
    : result.bestEntry
      ? [result.bestEntry]
      : [{
        market: result.market,
        recommendation: result.recommendation,
        confidence: result.confidence,
        rationale: result.rationale,
      }];

  const candidates = sourceRecommendations.map((recommendation) => {
    const market = assessMarket(input, recommendation);
    const aiConfidence = clamp(finite(recommendation.confidence) ?? 0);
    let objectiveConfidence = clamp((quality.score * 0.4) + (market.score * 0.45) + (Math.min(aiConfidence, 90) * 0.15));
    const rejectionReasons = market.reasons.filter((reason) =>
      /conflita|nao confirma|sem media numerica|sem historico individual|mercado nao reconhecido/.test(normalized(reason))
    );
    const hasRecentBase = quality.homeMatches >= 3 && quality.awayMatches >= 3;
    const hasCompensatedBase = quality.homeMatches >= 2
      && quality.awayMatches >= 2
      && quality.homeSeasonMatches >= 5
      && quality.awaySeasonMatches >= 5
      && quality.statItems.length >= 6;

    if (!hasRecentBase && !hasCompensatedBase) rejectionReasons.push('base historica realmente insuficiente');
    if (quality.score < 45) rejectionReasons.push(`qualidade dos dados abaixo do minimo (${quality.score}/100)`);
    if (market.score < 60) rejectionReasons.push(`evidencia do mercado abaixo do minimo (${market.score}/100)`);
    if (market.confirmations.length < 2 && market.score < 75) rejectionReasons.push('mercado sem confirmacao suficiente');

    const odd = decimalOdd(recommendation);
    const expectedValue = odd ? Number((((objectiveConfidence / 100) * odd) - 1).toFixed(3)) : undefined;
    if (expectedValue !== undefined && expectedValue <= 0) rejectionReasons.push(`valor esperado nao positivo (${expectedValue})`);
    if (rejectionReasons.length) objectiveConfidence = Math.min(objectiveConfidence, threshold - 1);

    return {
      market: recommendation.market,
      recommendation: recommendation.recommendation,
      family: market.family,
      aiConfidence,
      objectiveConfidence,
      dataQuality: quality.score,
      marketEvidence: market.score,
      confirmations: market.confirmations,
      rejectionReasons: [...new Set(rejectionReasons)],
      expectedValue,
      original: recommendation,
    };
  }).sort((a, b) => b.objectiveConfidence - a.objectiveConfidence || b.marketEvidence - a.marketEvidence);

  const selected = candidates.find((candidate) => candidate.objectiveConfidence >= threshold && candidate.rejectionReasons.length === 0);
  const audit: DecisionAudit = {
    decision: selected ? 'approved' : 'rejected',
    threshold,
    dataQuality: quality.score,
    missingData: quality.missing,
    candidates: candidates.map(({ original: _original, ...candidate }) => candidate),
    selectedMarket: selected?.market,
    selectedRecommendation: selected?.recommendation,
    reasons: selected
      ? []
      : [...new Set(candidates.flatMap((candidate) => candidate.rejectionReasons))],
  };

  console.info('[AnalysisDecision]', JSON.stringify({ eventId: result.eventId, ...audit }));

  if (!selected) {
    return {
      ...result,
      market: 'none',
      recommendation: NO_RECOMMENDATION,
      confidence: 0,
      rationale: audit.reasons.length
        ? `A partida foi rejeitada pelo filtro de qualidade: ${audit.reasons.join('; ')}.`
        : NO_RECOMMENDATION,
      bestEntry: undefined,
      recommendations: [],
      meta: { ...(result.meta || {}), decisionAudit: audit },
    };
  }

  const approvedRecommendation: BettingRecommendation = {
    ...selected.original,
    confidence: selected.objectiveConfidence,
    riskLevel: selected.objectiveConfidence >= 80 ? 'baixo' : 'medio',
    meta: {
      ...(selected.original.meta || {}),
      objectiveConfidence: selected.objectiveConfidence,
      dataQuality: quality.score,
      marketEvidence: selected.marketEvidence,
      expectedValue: selected.expectedValue,
    },
  };

  return {
    ...result,
    market: approvedRecommendation.market,
    recommendation: approvedRecommendation.recommendation,
    confidence: approvedRecommendation.confidence,
    rationale: approvedRecommendation.rationale,
    bestEntry: approvedRecommendation,
    recommendations: [approvedRecommendation],
    meta: { ...(result.meta || {}), decisionAudit: audit },
  };
}

// Generates market candidates exclusively from structured statistics. The LLM
// is intentionally not involved in this decision; it only explains the result.
export function buildStatisticalDecision(input: any, eventId: number | string): AnalysisResult {
  const recommendations: BettingRecommendation[] = [];
  const home = input?.teamForm?.homeRecent || {};
  const away = input?.teamForm?.awayRecent || {};
  const avgFor = average([finite(home.avgGoalsFor), finite(away.avgGoalsFor)]);
  const avgAgainst = average([finite(home.avgGoalsAgainst), finite(away.avgGoalsAgainst)]);
  const over25 = average([finite(home.over25Rate), finite(away.over25Rate)]);
  const btts = average([finite(home.bttsRate), finite(away.bttsRate)]);
  const support = [
    avgFor !== undefined ? `média ofensiva combinada ${avgFor.toFixed(2)}` : null,
    avgAgainst !== undefined ? `média defensiva combinada ${avgAgainst.toFixed(2)}` : null,
  ].filter(Boolean) as string[];

  if (over25 !== undefined && over25 >= 60) recommendations.push({ market: 'Gols', recommendation: 'Over 2.5 gols', confidence: 82, rationale: `Over 2.5 ocorreu em média em ${Math.round(over25)}% da amostra recente.`, dataSupport: [...support, `over 2.5: ${Math.round(over25)}%`] });
  if (over25 !== undefined && over25 <= 40) recommendations.push({ market: 'Gols', recommendation: 'Under 2.5 gols', confidence: 82, rationale: `A frequência média de over 2.5 foi de apenas ${Math.round(over25)}%.`, dataSupport: [...support, `over 2.5: ${Math.round(over25)}%`] });
  if (btts !== undefined && btts >= 60) recommendations.push({ market: 'Gols', recommendation: 'Ambas as equipes marcam', confidence: 80, rationale: `BTTS ocorreu em média em ${Math.round(btts)}% da amostra recente.`, dataSupport: [...support, `BTTS: ${Math.round(btts)}%`] });
  if (btts !== undefined && btts <= 35) recommendations.push({ market: 'Gols', recommendation: 'Ambas as equipes não marcam', confidence: 80, rationale: `BTTS ocorreu em média em apenas ${Math.round(btts)}% da amostra recente.`, dataSupport: [...support, `BTTS: ${Math.round(btts)}%`] });

  const pairedCandidate = (family: 'corners' | 'cards', pattern: RegExp, label: string) => {
    const item = matchingStats(input, pattern).find((stat: any) => finite(stat.home) !== undefined && finite(stat.away) !== undefined);
    if (!item) return;
    const total = finite(item.home)! + finite(item.away)!;
    const line = Math.max(0.5, Math.floor(total) - 0.5);
    recommendations.push({ market: family === 'corners' ? 'Escanteios' : 'Cartões', recommendation: `Mais de ${line.toFixed(1)} ${label}`, confidence: 78, rationale: `As médias estruturadas somam ${total.toFixed(2)} ${label} por jogo.`, dataSupport: [`Média do mandante: ${item.home} ${label}`, `Média do visitante: ${item.away} ${label}`] });
  };
  pairedCandidate('corners', /escanteio|corner/, 'escanteios');
  pairedCandidate('cards', /cart|amarelo|vermelho/, 'cartões');

  const base: AnalysisResult = {
    eventId,
    market: recommendations[0]?.market || 'none',
    recommendation: recommendations[0]?.recommendation || NO_RECOMMENDATION,
    confidence: recommendations[0]?.confidence || 0,
    rationale: recommendations[0]?.rationale || 'Os indicadores objetivos não produziram uma entrada com evidência suficiente.',
    recommendations,
    analysisSource: 'heuristic',
  };
  const decided = applySelectiveDecisionGate(base, input);
  const audit = decided.meta?.decisionAudit as DecisionAudit | undefined;
  const selectedAudit = audit?.candidates?.find((candidate) =>
    candidate.market === decided.market && candidate.recommendation === decided.recommendation
  );
  const resultSupport = decided.bestEntry?.dataSupport || selectedAudit?.confirmations || [];
  const risks = audit?.missingData || [];

  return {
    ...decided,
    matchAnalysis: decided.confidence > 0
      ? `O motor estatístico selecionou ${decided.recommendation} após cruzar forma recente, médias das equipes e evidências específicas do mercado.`
      : 'Os indicadores disponíveis não apresentaram convergência suficiente para publicar uma entrada.',
    keyFactors: resultSupport.slice(0, 3),
    marketBreakdown: {
      [decided.market === 'none' ? 'resultado' : decided.market]: decided.rationale,
    },
    confidenceDrivers: selectedAudit?.confirmations?.slice(0, 4),
    riskAnalysis: risks.length
      ? `Pontos com cobertura limitada: ${risks.join(', ')}.`
      : 'A entrada pode ser invalidada por mudanças de escalação, contexto pré-jogo ou comportamento diferente da amostra histórica.',
  };
}
