export interface BettingRecommendation {
  market: string;
  recommendation: string;
  confidence: number; // 0-100
  rationale: string;
  meta?: Record<string, unknown>;
}

export interface TeamAnalysis {
  team: string;
  strengths: string[];
  weaknesses: string[];
  tacticalReading: string;
  bettingImpact: string;
}

export interface AnalysisResult {
  eventId: number | string;
  market: string;
  recommendation: string;
  confidence: number; // 0-100
  rationale: string;
  matchAnalysis?: string;
  homeAnalysis?: TeamAnalysis;
  awayAnalysis?: TeamAnalysis;
  riskAnalysis?: string;
  bestEntry?: BettingRecommendation;
  recommendations?: BettingRecommendation[];
  analysisSource?: 'azure-openai' | 'odds' | 'heuristic' | 'odds-fallback';
  meta?: Record<string, unknown>;
}

export interface AnalyzeOptions {
  useLLM?: boolean;
  includeOdds?: boolean;
  useOddsFallback?: boolean;
}
