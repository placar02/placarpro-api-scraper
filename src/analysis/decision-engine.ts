import type { AnalysisResult, BettingRecommendation } from '../types/analysis';
import { getMarketDecisionPolicy, type AnalysisMarketFamily, type MarketDecisionPolicy } from '../config/decisionPolicy';
import { enrichAnalysisWithValidatedOdds } from './odds-validation';
import { evaluateDataQuality } from './data-quality-engine';
import { buildFeatureProfile } from './feature-engine';
import { assessMarketWithEngine } from './market-engines';
import { resolveAnalysisWeights, weightedScore } from './weight-engine';
import { rankAnalysisCandidates } from './meta-analysis-engine';
import { buildConfidenceBreakdown } from './confidence-breakdown';
import { calculateMatchScore } from './match-score-engine';
import { observeAnalysis } from '../observability/analysis-observer';

export const NO_RECOMMENDATION = 'Nenhuma entrada recomendada para este jogo.';
export const OPTIONAL_DATA_UNAVAILABLE = 'Dado não disponível.';

type MarketFamily = AnalysisMarketFamily;

export type DecisionGateOptions = {
  requireRealOdds?: boolean;
  minimumExpectedValue?: number;
  oddsResponses?: any | any[];
};

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
  probabilityEdge?: number;
  fairImpliedProbability?: number;
  oddsStatus?: string;
  oddsAudit?: unknown;
  engine?: string;
  metaScore?: number;
  policy: MarketDecisionPolicy;
};

export type DecisionAudit = {
  decision: 'approved' | 'rejected' | 'waiting_odds';
  threshold: number;
  dataQuality: number;
  missingData: string[];
  candidates: DecisionCandidateAudit[];
  selectedMarket?: string;
  selectedRecommendation?: string;
  reasons: string[];
  requireRealOdds?: boolean;
  dataQualityReport?: unknown;
  features?: unknown;
  metaAnalysis?: unknown;
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

function allStatItems(input: any) {
  return (input?.statistics?.teamPeriods || [])
    .flatMap((period: any) => period?.groups || [])
    .flatMap((group: any) => group?.items || []);
}

function matchingStats(input: any, pattern: RegExp) {
  return allStatItems(input).filter((item: any) => pattern.test(normalized(`${item?.name} ${item?.key}`)));
}

function average(values: Array<number | undefined>) {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length ? present.reduce((total, value) => total + value, 0) / present.length : undefined;
}

function decimalOdd(recommendation: BettingRecommendation) {
  const value = finite(recommendation.meta?.decimal_odds);
  return value && value > 1 ? value : undefined;
}

export function applySelectiveDecisionGate(result: AnalysisResult, input: any, options: DecisionGateOptions = {}): AnalysisResult {
  const quality = evaluateDataQuality({
    ...input,
    oddsResponses: options.oddsResponses,
    dataQuality: {
      ...(input?.dataQuality || {}),
      oddsAvailable: Boolean(options.oddsResponses || input?.odds || input?.oddsResponses),
    },
  });
  const features = buildFeatureProfile(input);
  observeAnalysis('data_quality', result.eventId, { score: quality.score, dimensions: quality.dimensions, missing: quality.missing });
  observeAnalysis('features', result.eventId, { indices: features.indices });
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

  const uniqueRecommendations = [...new Map(sourceRecommendations.map((recommendation) => [
    normalized(`${recommendation.market}|${recommendation.recommendation}`),
    recommendation,
  ])).values()];

  const assessedCandidates = uniqueRecommendations.map((recommendation) => {
    const market = assessMarketWithEngine(features, recommendation);
    const policy = getMarketDecisionPolicy(market.family, options.minimumExpectedValue);
    const aiConfidence = clamp(finite(recommendation.confidence) ?? 0);
    // Source confidence is kept only for audit. The published probability is
    // derived exclusively from measured data quality and market evidence.
    const weights = resolveAnalysisWeights({ competition: result.tournamentName || input?.event?.tournament?.name, market: market.family });
    const rawModelConfidence = weightedScore(
      { dataQuality: quality.score, marketEvidence: market.score },
      weights.confidence,
    );
    const configuredShrinkage = Number(process.env.ANALYSIS_UNCALIBRATED_SHRINKAGE ?? 0.8);
    const shrinkage = Number.isFinite(configuredShrinkage) ? Math.min(0.95, Math.max(0.5, configuredShrinkage)) : 0.8;
    let objectiveConfidence = clamp(50 + ((rawModelConfidence - 50) * shrinkage));
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
    if (quality.score < policy.minDataQuality) rejectionReasons.push(`qualidade dos dados abaixo do minimo (${quality.score}/${policy.minDataQuality})`);
    if (market.score < policy.minMarketEvidence) rejectionReasons.push(`evidencia do mercado abaixo do minimo (${market.score}/${policy.minMarketEvidence})`);
    if (market.confirmations.length < policy.minConfirmations) rejectionReasons.push(`mercado sem ${policy.minConfirmations} confirmacoes independentes`);
    if (policy.requireConfirmedLineup && !input?.lineups?.confirmed) rejectionReasons.push('mercado exige escalacao confirmada');

    const odd = decimalOdd(recommendation);
    const oddsValidationStatus = recommendation.meta?.oddsValidation && typeof recommendation.meta.oddsValidation === 'object'
      ? String((recommendation.meta.oddsValidation as any).status || '')
      : '';
    if (options.requireRealOdds && (!odd || oddsValidationStatus !== 'matched')) {
      rejectionReasons.push('odd real correspondente ao mercado nao encontrada');
    }
    const expectedValue = odd ? Number((((objectiveConfidence / 100) * odd) - 1).toFixed(3)) : undefined;
    const fairImpliedRaw = finite(recommendation.meta?.fairImpliedProbability);
    const fairImpliedProbability = fairImpliedRaw !== undefined
      ? fairImpliedRaw > 1 ? fairImpliedRaw / 100 : fairImpliedRaw
      : undefined;
    const probabilityEdge = fairImpliedProbability !== undefined
      ? Number(((objectiveConfidence / 100) - fairImpliedProbability).toFixed(4))
      : undefined;
    if (expectedValue !== undefined && expectedValue < policy.minExpectedValue) {
      rejectionReasons.push(`valor esperado abaixo do minimo (${expectedValue}/${policy.minExpectedValue})`);
    }
    if (probabilityEdge !== undefined && probabilityEdge < policy.minProbabilityEdge) {
      rejectionReasons.push(`vantagem sobre a probabilidade justa abaixo do minimo (${probabilityEdge}/${policy.minProbabilityEdge})`);
    }
    const onlyWaitingForOdds = rejectionReasons.length > 0
      && rejectionReasons.every((reason) => reason === 'odd real correspondente ao mercado nao encontrada');
    if (rejectionReasons.length && !onlyWaitingForOdds) objectiveConfidence = Math.min(objectiveConfidence, policy.minConfidence - 1);

    return {
      market: recommendation.market,
      recommendation: recommendation.recommendation,
      family: market.family,
      aiConfidence,
      objectiveConfidence,
      dataQuality: quality.score,
      marketEvidence: market.score,
      confirmations: [
        ...market.confirmations,
        ...(quality.sourceConsensusBonus > 0 ? [`dados corroborados por ${input?.dataQuality?.sourceConsensus?.providerCount || 2} fontes`] : []),
      ],
      rejectionReasons: [...new Set(rejectionReasons)],
      expectedValue,
      probabilityEdge,
      fairImpliedProbability,
      oddsStatus: oddsValidationStatus || 'not_checked',
      oddsAudit: recommendation.meta?.oddsAudit,
      engine: market.engine,
      policy,
      original: recommendation,
    };
  });
  const candidates = rankAnalysisCandidates(assessedCandidates, {
    competition: result.tournamentName || input?.event?.tournament?.name,
    consensus: 50 + quality.sourceConsensusBonus * 15,
    missingCount: quality.missing.length,
  });
  observeAnalysis('market_decision', result.eventId, {
    candidates: candidates.map(({ original: _original, oddsAudit: _oddsAudit, ...candidate }) => candidate),
  });
  observeAnalysis('odds_ev', result.eventId, {
    candidates: candidates.map((candidate) => ({
      market: candidate.market,
      oddsStatus: candidate.oddsStatus,
      expectedValue: candidate.expectedValue,
      probabilityEdge: candidate.probabilityEdge,
    })),
  });

  const selected = candidates.find((candidate) => candidate.objectiveConfidence >= candidate.policy.minConfidence && candidate.rejectionReasons.length === 0);
  const waiting = !selected ? candidates.find((candidate) => (
    candidate.objectiveConfidence >= candidate.policy.minConfidence
    && candidate.rejectionReasons.length > 0
    && candidate.rejectionReasons.every((reason) => reason === 'odd real correspondente ao mercado nao encontrada')
  )) : undefined;
  const chosen = selected || waiting;
  const threshold = chosen?.policy.minConfidence || candidates[0]?.policy.minConfidence || 80;
  const { statItems: _statItems, ...qualityAudit } = quality;
  const audit: DecisionAudit = {
    decision: selected ? 'approved' : waiting ? 'waiting_odds' : 'rejected',
    threshold,
    dataQuality: quality.score,
    missingData: quality.missing,
    candidates: candidates.map(({ original: _original, ...candidate }) => candidate),
    selectedMarket: chosen?.market,
    selectedRecommendation: chosen?.recommendation,
    reasons: selected
      ? []
      : waiting
        ? ['odd real correspondente ao mercado nao encontrada; analise preservada aguardando nova coleta']
      : [...new Set(candidates.flatMap((candidate) => candidate.rejectionReasons))],
    requireRealOdds: Boolean(options.requireRealOdds),
    dataQualityReport: qualityAudit,
    features: features.indices,
    metaAnalysis: {
      selectedScore: chosen?.metaScore,
      ranking: candidates.map((candidate) => ({
        market: candidate.market,
        recommendation: candidate.recommendation,
        score: candidate.metaScore,
      })),
    },
  };

  observeAnalysis('meta_analysis', result.eventId, { decision: audit.decision, selectedMarket: audit.selectedMarket, metaAnalysis: audit.metaAnalysis });

  if (!selected && !waiting) {
    observeAnalysis('publication', result.eventId, { status: 'rejected', reasons: audit.reasons });
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
      analysisStatus: 'rejected',
      meta: {
        ...(result.meta || {}),
        decisionAudit: audit,
        dataQualityScore: quality.score,
        featureProfile: features.indices,
        matchScore: calculateMatchScore({ quality, features, confidence: 0, competition: result.tournamentName }),
      },
    };
  }

  const effectiveSelection = selected || waiting!;
  const confidenceBreakdown = buildConfidenceBreakdown({
    finalConfidence: effectiveSelection.objectiveConfidence,
    quality,
    features,
    marketEvidence: effectiveSelection.marketEvidence,
    expectedValue: effectiveSelection.expectedValue,
    oddsMatched: effectiveSelection.oddsStatus === 'matched',
  });
  const matchScore = calculateMatchScore({
    quality,
    features,
    confidence: effectiveSelection.objectiveConfidence,
    expectedValue: effectiveSelection.expectedValue,
    competition: result.tournamentName || input?.event?.tournament?.name,
  });
  const approvedRecommendation: BettingRecommendation = {
    ...effectiveSelection.original,
    confidence: effectiveSelection.objectiveConfidence,
    riskLevel: effectiveSelection.objectiveConfidence >= 80 ? 'baixo' : 'medio',
    meta: {
      ...(effectiveSelection.original.meta || {}),
      objectiveConfidence: effectiveSelection.objectiveConfidence,
      dataQuality: quality.score,
      marketEvidence: effectiveSelection.marketEvidence,
      expectedValue: effectiveSelection.expectedValue,
      probabilityEdge: effectiveSelection.probabilityEdge,
      fairImpliedProbability: effectiveSelection.fairImpliedProbability,
      decisionPolicy: effectiveSelection.policy,
      matchScore,
      confidenceBreakdown,
      metaAnalysisScore: effectiveSelection.metaScore,
    },
  };

  observeAnalysis('publication', result.eventId, {
    status: waiting ? 'waiting_odds' : 'approved',
    market: approvedRecommendation.market,
    recommendation: approvedRecommendation.recommendation,
    confidence: approvedRecommendation.confidence,
    matchScore,
  });

  return {
    ...result,
    market: approvedRecommendation.market,
    recommendation: approvedRecommendation.recommendation,
    confidence: approvedRecommendation.confidence,
    rationale: approvedRecommendation.rationale,
    bestEntry: approvedRecommendation,
    recommendations: [approvedRecommendation],
    analysisStatus: waiting ? 'waiting_odds' : 'approved',
    meta: {
      ...(result.meta || {}),
      decisionAudit: audit,
      dataQualityScore: quality.score,
      featureProfile: features.indices,
      matchScore,
      confidenceBreakdown,
    },
  };
}

// Generates market candidates exclusively from structured statistics. The LLM
// is intentionally not involved in this decision; it only explains the result.
export function buildStatisticalDecision(input: any, eventId: number | string, options: DecisionGateOptions = {}): AnalysisResult {
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

  const homeWinRate = finite(home.winRate);
  const awayWinRate = finite(away.winRate);
  const homeVenueWinRate = finite(home.homePerformance?.winRate);
  const awayVenueWinRate = finite(away.awayPerformance?.winRate);
  const homeName = String(input?.event?.homeTeam?.name || '').trim();
  const awayName = String(input?.event?.awayTeam?.name || '').trim();
  if (homeName && homeWinRate !== undefined && awayWinRate !== undefined
    && homeVenueWinRate !== undefined && awayVenueWinRate !== undefined
    && homeWinRate - awayWinRate >= 25 && homeVenueWinRate - awayVenueWinRate >= 30) {
    recommendations.push({
      market: 'Resultado final',
      recommendation: `${homeName} vence`,
      confidence: 80,
      rationale: `${homeName} apresenta vantagem ampla na forma recente e no recorte casa/fora.`,
      dataSupport: [`forma geral: ${homeWinRate}% x ${awayWinRate}%`, `casa/fora: ${homeVenueWinRate}% x ${awayVenueWinRate}%`],
    });
  }
  if (awayName && homeWinRate !== undefined && awayWinRate !== undefined
    && homeVenueWinRate !== undefined && awayVenueWinRate !== undefined
    && awayWinRate - homeWinRate >= 25 && awayVenueWinRate - homeVenueWinRate >= 30) {
    recommendations.push({
      market: 'Resultado final',
      recommendation: `${awayName} vence`,
      confidence: 80,
      rationale: `${awayName} apresenta vantagem ampla na forma recente e no recorte casa/fora.`,
      dataSupport: [`forma geral: ${awayWinRate}% x ${homeWinRate}%`, `fora/casa: ${awayVenueWinRate}% x ${homeVenueWinRate}%`],
    });
  }

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
  const withOdds = enrichAnalysisWithValidatedOdds(base, options.oddsResponses);
  const decided = applySelectiveDecisionGate(withOdds, input, options);
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
