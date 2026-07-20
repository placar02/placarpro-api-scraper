import type { BettingRecommendation } from '../../types/analysis';
import type { FeatureProfile } from '../feature-engine';
import { clampScore, hasNumericPair, normalizeEngineText } from '../engine-utils';
import type { MarketEngineResult } from './types';

export function assessGoalsMarket(features: FeatureProfile, recommendation: BettingRecommendation): MarketEngineResult {
  const { signals } = features;
  const text = normalizeEngineText(`${recommendation.market} ${recommendation.recommendation}`);
  const confirmations: string[] = [];
  const reasons: string[] = [];
  let score = 0;
  if (hasNumericPair(signals.goals)) { score += 25; confirmations.push('estatisticas de gols das duas equipes'); }
  if (signals.avgGoalsFor !== undefined && signals.avgGoalsAgainst !== undefined) { score += 25; confirmations.push('medias recentes de gols marcados e sofridos'); }
  if (/over|mais de/.test(text)) {
    if ((signals.overRate ?? 0) >= 60) { score += 25; confirmations.push(`over 2.5 em ${Math.round(signals.overRate!)}% da amostra`); }
    else if (signals.overRate !== undefined && signals.overRate < 50) reasons.push('tendencia recente nao confirma mercado over');
    if ((signals.avgGoalsFor ?? 0) + (signals.avgGoalsAgainst ?? 0) >= 2.6) score += 20;
  } else if (/under|menos de/.test(text)) {
    if (signals.overRate !== undefined && signals.overRate <= 40) { score += 25; confirmations.push(`baixa frequencia de over 2.5 (${Math.round(signals.overRate)}%)`); }
    else if (signals.overRate !== undefined && signals.overRate > 50) reasons.push('tendencia recente conflita com mercado under');
    if ((signals.avgGoalsFor ?? 99) + (signals.avgGoalsAgainst ?? 99) <= 2.4 || (signals.cleanSheetRate ?? 0) >= 40) score += 20;
  } else if (/ambas|btts/.test(text)) {
    const wantsNo = /nao|no /.test(text);
    const confirmed = wantsNo ? (signals.bttsRate ?? 100) <= 40 : (signals.bttsRate ?? 0) >= 60;
    if (confirmed) { score += 45; confirmations.push(`BTTS recente em ${Math.round(signals.bttsRate!)}% da amostra`); }
    else if (signals.bttsRate !== undefined) reasons.push('frequencia de ambas marcam nao confirma a selecao');
  }
  if (confirmations.length < 2) reasons.push('mercado de gols sem dois indicadores independentes');
  return { engine: 'over-under-btts', score: clampScore(score), confirmations, reasons };
}
