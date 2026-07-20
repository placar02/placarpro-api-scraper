import type { BettingRecommendation } from '../../types/analysis';
import type { AnalysisMarketFamily } from '../../config/decisionPolicy';
import type { FeatureProfile } from '../feature-engine';
import { normalizeEngineText } from '../engine-utils';
import { assessGoalsMarket } from './goals-engine';
import { assessResultMarket } from './result-engine';
import { assessVolumeMarket } from './volume-engine';
import { assessPlayerMarket } from './player-engine';
import type { MarketAssessment } from './types';

export function marketFamilyOf(recommendation: BettingRecommendation): AnalysisMarketFamily {
  const text = normalizeEngineText(`${recommendation.market} ${recommendation.recommendation}`);
  if (/escanteio|corner/.test(text)) return 'corners';
  if (/cart|amarelo|vermelho|falta/.test(text)) return 'cards';
  if (/chute|finaliza|remate|jogador|gol de|assistencia/.test(text)) return 'player';
  if (/over|under|gol|ambas|btts|mais de|menos de/.test(text)) return 'goals';
  if (/vencedor|resultado|handicap|dupla chance|empate anula|draw no bet|1x2|match.winner/.test(text)) return 'winner';
  return 'unknown';
}

export function assessMarketWithEngine(features: FeatureProfile, recommendation: BettingRecommendation): MarketAssessment {
  const family = marketFamilyOf(recommendation);
  if (family === 'goals') return { family, ...assessGoalsMarket(features, recommendation) };
  if (family === 'winner') return { family, ...assessResultMarket(features) };
  if (family === 'corners' || family === 'cards') return { family, ...assessVolumeMarket(features, family) };
  if (family === 'player') return { family, ...assessPlayerMarket(features) };
  return { family, engine: 'unsupported', score: 0, confirmations: [], reasons: ['mercado nao reconhecido pelo validador estatistico'] };
}

export type { MarketAssessment } from './types';
