import { describe, expect, it } from 'vitest';
import { enrichRecommendationWithValidatedOdds } from '../src/analysis/odds-validation';
import { normalizeMarket } from '../src/analysis/market-normalization';

const recommendation = {
  market: 'Gols',
  recommendation: 'Over 2.5 gols',
  confidence: 80,
  rationale: 'Teste',
};

function odds() {
  return {
    source: 'provider-a',
    scraped_at: new Date().toISOString(),
    markets_by_group: {
      goals: {
        markets: [{
          market_name: 'Total de gols',
          choice_group: '2.5',
          market_period: 'fulltime',
          choices: [
            { name: 'Over 2.5', decimal_odds: 1.9 },
            { name: 'Under 2.5', decimal_odds: 1.9 },
          ],
        }, {
          market_name: 'Total de gols',
          choice_group: '3.5',
          market_period: 'fulltime',
          choices: [
            { name: 'Over 3.5', decimal_odds: 2.5 },
            { name: 'Under 3.5', decimal_odds: 1.5 },
          ],
        }],
      },
    },
  };
}

describe('validacao de odds reais', () => {
  it('casa familia, direcao e linha exatas', () => {
    const enriched = enrichRecommendationWithValidatedOdds(recommendation, odds());

    expect(enriched.meta?.decimal_odds).toBe(1.9);
    expect(enriched.meta?.oddsChoiceName).toBe('Over 2.5');
    expect(enriched.meta?.oddsValidation).toMatchObject({ status: 'matched' });
  });

  it('nao usa uma linha diferente mesmo que tenha odd maior', () => {
    const enriched = enrichRecommendationWithValidatedOdds(recommendation, odds());
    expect(enriched.meta?.oddsChoiceName).not.toBe('Over 3.5');
  });

  it('calcula probabilidade justa removendo o overround', () => {
    const enriched = enrichRecommendationWithValidatedOdds(recommendation, odds());
    expect(enriched.meta?.marketOverround).toBeCloseTo(1.0526, 4);
    expect(enriched.meta?.fairImpliedProbability).toBe(50);
  });

  it('descarta odd expirada antes do calculo de EV', () => {
    const payload = odds();
    payload.scraped_at = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const enriched = enrichRecommendationWithValidatedOdds(recommendation, payload);
    expect(enriched.meta?.oddsValidation).toMatchObject({ status: 'waiting_odds' });
    expect((enriched.meta?.oddsAudit as any).oddsDiscarded[0].reason).toContain('odd expirada');
  });

  it('marca como aguardando odds quando nao existe mercado correspondente', () => {
    const enriched = enrichRecommendationWithValidatedOdds({
      ...recommendation,
      recommendation: 'Over 4.5 gols',
    }, odds());
    expect(enriched.meta?.oddsValidation).toMatchObject({ status: 'waiting_odds' });
    expect(enriched.meta?.decimal_odds).toBeUndefined();
    expect((enriched.meta?.oddsAudit as any).rejectionReason).toContain('Nenhuma odd correspondeu');
  });

  it.each([
    'Over 2.5',
    'Mais de 2.5',
    'Mais de 2,5',
    'Over2.5',
    'Total Goals Over 2.5',
    'Total Goals +2.5',
    'Goals Over 2.5',
  ])('normaliza %s para OVER_2_5', (name) => {
    const normalized = normalizeMarket({ marketName: 'Total de gols', choiceName: name });
    expect(normalized.key).toBe('OVER_2_5');
  });

  it('le campos alternativos e aliases em outro idioma', () => {
    const enriched = enrichRecommendationWithValidatedOdds(recommendation, {
      provider: 'provider-b',
      markets: [{
        title: 'Total Goals',
        line: '2,5',
        options: [{ displayName: 'More than 2,5', price: 1.87, bookmakerName: 'Casa B' }],
      }],
    });
    expect(enriched.meta?.decimal_odds).toBe(1.87);
    expect(enriched.meta?.bookmaker).toBe('Casa B');
    expect((enriched.meta?.oddsAudit as any).selected.normalizedMarket).toBe('OVER_2_5');
  });

  it('prioriza compatibilidade antes da maior odd', () => {
    const payload = odds();
    payload.markets_by_group.goals.markets.push({
      market_name: 'Total de gols - primeiro tempo',
      choice_group: '2.5',
      market_period: 'first half',
      choices: [{ name: 'Over 2.5', decimal_odds: 9.9 }],
    } as any);
    const enriched = enrichRecommendationWithValidatedOdds(recommendation, payload);
    expect(enriched.meta?.decimal_odds).toBe(1.9);
  });

  it.each([
    [{ marketName: 'Resultado Final', choiceName: 'Empate' }, 'RESULT_DRAW'],
    [{ marketName: 'Dupla Chance', choiceName: '1X' }, 'DOUBLE_CHANCE_1X'],
    [{ marketName: 'Ambas Marcam', choiceName: 'Sim' }, 'BTTS_YES'],
    [{ marketName: 'Escanteios', choiceName: 'Mais de 9,5' }, 'CORNERS_OVER_9_5'],
    [{ marketName: 'Cartoes', choiceName: 'Under 4.5' }, 'CARDS_UNDER_4_5'],
    [{ marketName: 'Handicap Asiatico', choiceName: 'Casa -0,5' }, 'ASIAN_HANDICAP_HOME_MINUS_0_5'],
    [{ marketName: 'Handicap Europeu', choiceName: 'Fora +1,0' }, 'EUROPEAN_HANDICAP_AWAY_PLUS_1'],
    [{ marketName: 'Chutes no Gol', choiceName: 'Over 3.5' }, 'SHOTS_ON_TARGET_OVER_3_5'],
  ])('normaliza os mercados suportados %#', (input, expected) => {
    expect(normalizeMarket(input).key).toBe(expected);
  });

  it('casa vencedor pelo nome exato da equipe', () => {
    const enriched = enrichRecommendationWithValidatedOdds({
      ...recommendation,
      market: 'Resultado final',
      recommendation: 'Botafogo vence',
    }, {
      source: 'ogol',
      markets_by_group: {
        result: { markets: [{
          market_name: 'Resultado Final',
          choice_group: '1x2',
          choices: [
            { name: 'Botafogo', decimal_odds: 1.85 },
            { name: 'Empate', decimal_odds: 3.4 },
            { name: 'Santos', decimal_odds: 4.2 },
          ],
        }] },
      },
    });

    expect(enriched.meta?.decimal_odds).toBe(1.85);
    expect(enriched.meta?.oddsChoiceName).toBe('Botafogo');
  });
});
