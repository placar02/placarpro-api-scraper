import type { DataQualityReport } from './data-quality-engine';
import type { FeatureProfile } from './feature-engine';
import { clampScore } from './engine-utils';

export function buildConfidenceBreakdown(args: {
  finalConfidence: number;
  quality: DataQualityReport;
  features: FeatureProfile;
  marketEvidence: number;
  expectedValue?: number;
  oddsMatched: boolean;
}) {
  const { finalConfidence, quality, features, marketEvidence, expectedValue, oddsMatched } = args;
  const injuryCoverage = quality.coverage.injuriesAndSuspensions ? 90 : 45;
  const consensus = clampScore(50 + (quality.sourceConsensusBonus * 15));
  return {
    final: finalConfidence,
    attack: features.indices.offensiveStrength,
    defense: features.indices.defensiveStrength,
    form: features.indices.recentConsistency,
    marketEvidence,
    odds: oddsMatched ? clampScore(75 + Math.max(0, expectedValue || 0) * 100) : 0,
    data: quality.score,
    lineups: quality.coverage.lineups ? 90 : 40,
    injuries: injuryCoverage,
    consensus,
  };
}
