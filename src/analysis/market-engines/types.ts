import type { AnalysisMarketFamily } from '../../config/decisionPolicy';

export type MarketEngineResult = {
  engine: string;
  score: number;
  confirmations: string[];
  reasons: string[];
};

export type MarketAssessment = MarketEngineResult & {
  family: AnalysisMarketFamily;
};
