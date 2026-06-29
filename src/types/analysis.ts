export interface BettingRecommendation {
  market: string;
  recommendation: string;
  confidence: number; // 0-100
  rationale: string;
  riskLevel?: 'baixo' | 'medio' | 'alto';
  dataSupport?: string[];
  warningSigns?: string[];
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
  homeTeam?: {
    id?: number | string;
    name: string;
    shortName?: string;
    slug?: string;
    imageUrl?: string;
  };
  awayTeam?: {
    id?: number | string;
    name: string;
    shortName?: string;
    slug?: string;
    imageUrl?: string;
  };
  tournamentName?: string;
  startTimestamp?: number;
  matchAnalysis?: string;
  dataCoverage?: Record<string, unknown>;
  keyFactors?: string[];
  homeAnalysis?: TeamAnalysis;
  awayAnalysis?: TeamAnalysis;
  refereeAnalysis?: Record<string, unknown>;
  playerAnalysis?: Record<string, unknown>;
  marketBreakdown?: Record<string, unknown>;
  confidenceDrivers?: string[];
  avoidMarkets?: unknown[];
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
  includeEnrichment?: boolean;
}
