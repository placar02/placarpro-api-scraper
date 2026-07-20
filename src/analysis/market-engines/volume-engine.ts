import type { FeatureProfile } from '../feature-engine';
import { clampScore, hasNumericPair } from '../engine-utils';
import type { MarketEngineResult } from './types';

export function assessVolumeMarket(features: FeatureProfile, family: 'corners' | 'cards'): MarketEngineResult {
  const { signals } = features;
  const confirmations: string[] = [];
  const reasons: string[] = [];
  const primary = family === 'corners' ? signals.corners : signals.cards;
  const secondary = family === 'corners' ? signals.shots : signals.fouls;
  let score = 0;
  if (hasNumericPair(primary)) { score += 55; confirmations.push(`media numerica de ${family === 'corners' ? 'escanteios' : 'cartoes'} das equipes`); }
  else reasons.push(`sem media numerica de ${family === 'corners' ? 'escanteios' : 'cartoes'} para as duas equipes`);
  if (hasNumericPair(secondary)) { score += 20; confirmations.push(family === 'corners' ? 'volume de finalizacoes' : 'perfil de faltas das equipes'); }
  if (family === 'cards') {
    if (signals.referee?.cardsAverage !== undefined || signals.referee?.yellowCardsPerGame !== undefined) { score += 20; confirmations.push('media disciplinar do arbitro'); }
    else reasons.push('sem media disciplinar do arbitro');
  }
  if (confirmations.length < 2) reasons.push('mercado sem confirmacao por multiplos indicadores');
  return { engine: family, score: clampScore(score), confirmations, reasons };
}
