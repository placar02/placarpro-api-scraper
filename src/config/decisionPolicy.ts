export type AnalysisMarketFamily = 'goals' | 'winner' | 'corners' | 'cards' | 'player' | 'unknown';

export type MarketDecisionPolicy = {
  minConfidence: number;
  minDataQuality: number;
  minMarketEvidence: number;
  minConfirmations: number;
  minExpectedValue: number;
  minProbabilityEdge: number;
  requireConfirmedLineup: boolean;
};

const DEFAULT_POLICIES: Record<AnalysisMarketFamily, MarketDecisionPolicy> = {
  goals: { minConfidence: 72, minDataQuality: 60, minMarketEvidence: 70, minConfirmations: 3, minExpectedValue: 0.05, minProbabilityEdge: 0.03, requireConfirmedLineup: false },
  winner: { minConfidence: 74, minDataQuality: 65, minMarketEvidence: 70, minConfirmations: 3, minExpectedValue: 0.05, minProbabilityEdge: 0.03, requireConfirmedLineup: false },
  corners: { minConfidence: 74, minDataQuality: 65, minMarketEvidence: 70, minConfirmations: 2, minExpectedValue: 0.05, minProbabilityEdge: 0.03, requireConfirmedLineup: false },
  cards: { minConfidence: 75, minDataQuality: 65, minMarketEvidence: 75, minConfirmations: 3, minExpectedValue: 0.05, minProbabilityEdge: 0.03, requireConfirmedLineup: false },
  player: { minConfidence: 78, minDataQuality: 70, minMarketEvidence: 75, minConfirmations: 3, minExpectedValue: 0.05, minProbabilityEdge: 0.04, requireConfirmedLineup: true },
  unknown: { minConfidence: 80, minDataQuality: 70, minMarketEvidence: 80, minConfirmations: 3, minExpectedValue: 0.08, minProbabilityEdge: 0.05, requireConfirmedLineup: false },
};

function numberFromEnv(name: string, fallback: number, min: number, max: number) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

export function getMarketDecisionPolicy(family: AnalysisMarketFamily, minimumExpectedValue?: number): MarketDecisionPolicy {
  const base = DEFAULT_POLICIES[family] || DEFAULT_POLICIES.unknown;
  const suffix = family.toUpperCase();
  const globalConfidence = numberFromEnv('ANALYSIS_MIN_CONFIDENCE', base.minConfidence, 55, 95);
  const globalExpectedValue = minimumExpectedValue ?? numberFromEnv('ANALYSIS_MIN_EXPECTED_VALUE', base.minExpectedValue, 0, 1);

  return {
    minConfidence: Math.max(base.minConfidence, globalConfidence, numberFromEnv(`ANALYSIS_${suffix}_MIN_CONFIDENCE`, globalConfidence, 55, 95)),
    minDataQuality: numberFromEnv(`ANALYSIS_${suffix}_MIN_DATA_QUALITY`, base.minDataQuality, 0, 100),
    minMarketEvidence: numberFromEnv(`ANALYSIS_${suffix}_MIN_MARKET_EVIDENCE`, base.minMarketEvidence, 0, 100),
    minConfirmations: Math.round(numberFromEnv(`ANALYSIS_${suffix}_MIN_CONFIRMATIONS`, base.minConfirmations, 1, 6)),
    minExpectedValue: Math.max(base.minExpectedValue, globalExpectedValue),
    minProbabilityEdge: numberFromEnv(`ANALYSIS_${suffix}_MIN_PROBABILITY_EDGE`, base.minProbabilityEdge, 0, 1),
    requireConfirmedLineup: base.requireConfirmedLineup,
  };
}
