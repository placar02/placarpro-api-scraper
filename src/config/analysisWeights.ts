export type AnalysisWeights = {
  confidence: { dataQuality: number; marketEvidence: number };
  meta: { confidence: number; expectedValue: number; dataQuality: number; marketEvidence: number; consensus: number; completeness: number };
  match: { dataQuality: number; confidence: number; expectedValue: number; consensus: number; context: number; risk: number };
};

export const DEFAULT_ANALYSIS_WEIGHTS: AnalysisWeights = {
  confidence: { dataQuality: 0.45, marketEvidence: 0.55 },
  meta: { confidence: 0.34, expectedValue: 0.2, dataQuality: 0.16, marketEvidence: 0.12, consensus: 0.1, completeness: 0.08 },
  match: { dataQuality: 0.25, confidence: 0.25, expectedValue: 0.15, consensus: 0.1, context: 0.15, risk: 0.1 },
};
