type AnalysisStage = 'data_quality' | 'features' | 'market_decision' | 'odds_ev' | 'meta_analysis' | 'publication';

export function observeAnalysis(stage: AnalysisStage, eventId: string | number, payload: Record<string, unknown>) {
  console.info('[AnalysisPipeline]', JSON.stringify({ stage, eventId, timestamp: new Date().toISOString(), ...payload }));
}
