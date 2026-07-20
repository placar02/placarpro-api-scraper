import { clampScore } from './engine-utils';
import { resolveAnalysisWeights, weightedScore } from './weight-engine';

export type MetaAnalysisCandidate = {
  market: string;
  recommendation: string;
  family: any;
  objectiveConfidence: number;
  dataQuality: number;
  marketEvidence: number;
  expectedValue?: number;
  rejectionReasons: string[];
  [key: string]: any;
};

export function rankAnalysisCandidates<T extends MetaAnalysisCandidate>(candidates: T[], context: { competition?: string; consensus?: number; missingCount?: number } = {}) {
  return candidates.map((candidate) => {
    const weights = resolveAnalysisWeights({ competition: context.competition, market: candidate.family });
    const expectedValueScore = clampScore(Math.max(0, Math.min(0.25, candidate.expectedValue || 0)) * 400);
    const consensus = clampScore(context.consensus ?? 50);
    const completeness = clampScore(100 - ((context.missingCount || 0) * 8));
    const metaScore = clampScore(weightedScore({
      confidence: candidate.objectiveConfidence,
      expectedValue: expectedValueScore,
      dataQuality: candidate.dataQuality,
      marketEvidence: candidate.marketEvidence,
      consensus,
      completeness,
    }, weights.meta));
    return { ...candidate, metaScore };
  }).sort((a, b) => {
    const aEligible = a.rejectionReasons.length === 0;
    const bEligible = b.rejectionReasons.length === 0;
    if (aEligible !== bEligible) return aEligible ? -1 : 1;
    return b.metaScore - a.metaScore || b.objectiveConfidence - a.objectiveConfidence || b.marketEvidence - a.marketEvidence;
  });
}
