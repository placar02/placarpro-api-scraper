import type { FeatureProfile } from '../feature-engine';
import { clampScore } from '../engine-utils';
import type { MarketEngineResult } from './types';

export function assessPlayerMarket(features: FeatureProfile): MarketEngineResult {
  const confirmations: string[] = [];
  const reasons: string[] = [];
  let score = 0;
  if (features.signals.playerShotsAvailable) { score += 55; confirmations.push('finalizacoes e chutes no alvo do jogador'); }
  else reasons.push('sem historico individual de finalizacoes no alvo');
  if (features.signals.lineupConfirmed) { score += 25; confirmations.push('escalacao confirmada'); }
  else reasons.push('jogador sem titularidade confirmada');
  if (features.signals.individualFormAvailable) { score += 15; confirmations.push('desempenho individual recente'); }
  return { engine: 'shots-and-player-markets', score: clampScore(score), confirmations, reasons };
}
