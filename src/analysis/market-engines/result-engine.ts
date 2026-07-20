import type { FeatureProfile } from '../feature-engine';
import { clampScore, hasNumericPair } from '../engine-utils';
import type { MarketEngineResult } from './types';

export function assessResultMarket(features: FeatureProfile): MarketEngineResult {
  const { signals } = features;
  const confirmations: string[] = [];
  const reasons: string[] = [];
  let score = 0;
  if (signals.standings?.home && signals.standings?.away) { score += 25; confirmations.push('posicao e pontos no campeonato'); }
  if (hasNumericPair(signals.goalContext)) { score += 25; confirmations.push('diferenca tecnica em resultados e gols'); }
  if (signals.homeRecent?.played >= 5 && signals.awayRecent?.played >= 5) { score += 25; confirmations.push('forma recente de ambas as equipes'); }
  if (signals.homeRecent?.homePerformance?.played >= 3 && signals.awayRecent?.awayPerformance?.played >= 3) { score += 20; confirmations.push('desempenho casa e fora'); }
  if (confirmations.length < 3) reasons.push('resultado exige forma, contexto de campeonato e mando confirmados');
  return { engine: 'result-double-chance-handicap', score: clampScore(score), confirmations, reasons };
}
