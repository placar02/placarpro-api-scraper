import { DEFAULT_ANALYSIS_WEIGHTS, type AnalysisWeights } from '../config/analysisWeights';
import type { AnalysisMarketFamily } from '../config/decisionPolicy';

type WeightContext = { competition?: string; market?: AnalysisMarketFamily };

function mergeWeights(base: AnalysisWeights, override: any): AnalysisWeights {
  return {
    confidence: { ...base.confidence, ...(override?.confidence || {}) },
    meta: { ...base.meta, ...(override?.meta || {}) },
    match: { ...base.match, ...(override?.match || {}) },
  };
}

function configuredOverrides() {
  try {
    return JSON.parse(process.env.ANALYSIS_WEIGHT_OVERRIDES_JSON || '{}');
  } catch {
    console.warn('[WeightEngine] ANALYSIS_WEIGHT_OVERRIDES_JSON invalido; usando pesos padrao.');
    return {};
  }
}

export function resolveAnalysisWeights(context: WeightContext = {}): AnalysisWeights {
  const overrides = configuredOverrides();
  let weights = mergeWeights(DEFAULT_ANALYSIS_WEIGHTS, overrides.default);
  if (context.market) weights = mergeWeights(weights, overrides.markets?.[context.market]);
  if (context.competition) {
    const normalized = context.competition.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    weights = mergeWeights(weights, overrides.competitions?.[normalized]);
  }
  return weights;
}

export function weightedScore(values: Record<string, number>, weights: Record<string, number>) {
  const entries = Object.entries(weights).filter(([key, weight]) => Number.isFinite(weight) && weight > 0 && Number.isFinite(values[key]));
  const totalWeight = entries.reduce((sum, [, weight]) => sum + weight, 0);
  if (!totalWeight) return 0;
  return entries.reduce((sum, [key, weight]) => sum + (values[key] * weight), 0) / totalWeight;
}
