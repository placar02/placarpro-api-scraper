import type { DataQualityReport } from './data-quality-engine';
import type { FeatureProfile } from './feature-engine';
import { clampScore } from './engine-utils';
import { resolveAnalysisWeights, weightedScore } from './weight-engine';

export function calculateMatchScore(args: {
  quality: DataQualityReport;
  features: FeatureProfile;
  confidence: number;
  expectedValue?: number;
  competition?: string;
}) {
  const { quality, features, confidence, expectedValue, competition } = args;
  const weights = resolveAnalysisWeights({ competition });
  const consensus = clampScore(50 + quality.sourceConsensusBonus * 15);
  const context = clampScore((features.indices.recentConsistency + features.indices.homeAdvantage + features.indices.technicalBalance) / 3);
  const risk = clampScore(100 - features.indices.unpredictability);
  const expectedValueScore = clampScore(Math.max(0, Math.min(0.25, expectedValue || 0)) * 400);
  return clampScore(weightedScore({ dataQuality: quality.score, confidence, expectedValue: expectedValueScore, consensus, context, risk }, weights.match));
}
