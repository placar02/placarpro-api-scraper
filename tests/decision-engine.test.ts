import { describe, expect, it } from 'vitest';
import {
  applySelectiveDecisionGate,
  normalizeUnavailableData,
  NO_RECOMMENDATION,
  OPTIONAL_DATA_UNAVAILABLE,
} from '../src/analysis/decision-engine';
import type { AnalysisResult } from '../src/types/analysis';

function result(recommendation = 'Over 2.5 gols'): AnalysisResult {
  return {
    eventId: 123,
    market: 'Gols',
    recommendation,
    confidence: 88,
    rationale: 'A amostra recente e as medias de gols sustentam a selecao.',
    analysisSource: 'azure-openai',
    recommendations: [{
      market: 'Gols',
      recommendation,
      confidence: 88,
      rationale: 'A amostra recente e as medias de gols sustentam a selecao.',
      dataSupport: ['10 jogos de cada equipe', 'media de gols'],
    }],
  };
}

function strongInput() {
  const form = {
    played: 10,
    avgGoalsFor: 1.8,
    avgGoalsAgainst: 1.3,
    over25Rate: 70,
    bttsRate: 65,
    cleanSheetRate: 20,
    homePerformance: { played: 5 },
    awayPerformance: { played: 5 },
  };
  const stats = [
    ['Gols marcados', 18, 17],
    ['Gols sofridos', 12, 14],
    ['Media de gols', 1.8, 1.7],
    ['Chutes por jogo', 13, 12],
    ['Escanteios por jogo', 5.8, 5.2],
    ['Amarelos', 2.1, 2.4],
    ['Vitorias', 6, 5],
    ['Derrotas', 2, 3],
    ['Pontos', 20, 18],
    ['Posicao', 2, 4],
  ].map(([name, home, away]) => ({ name, home, away }));

  return {
    event: { homeTeam: { id: 1 }, awayTeam: { id: 2 }, referee: { id: 9 } },
    teamForm: {
      homeRecent: form,
      awayRecent: form,
      headToHead: { played: 5 },
    },
    statistics: {
      teamPeriods: [{ groups: [{ items: stats }] }],
      context: {
        referee: { name: 'Arbitro', cardsAverage: 4.5 },
        competitionTable: { home: { position: 2 }, away: { position: 4 } },
        teamNeeds: { home: 'disputa lideranca' },
      },
    },
    lineups: {
      confirmed: true,
      home: { starters: Array.from({ length: 11 }, (_, id) => ({ id })) },
      away: { starters: Array.from({ length: 11 }, (_, id) => ({ id })) },
    },
  };
}

describe('motor seletivo de analise', () => {
  it('padroniza dados opcionais ausentes sem inventar informacoes', () => {
    const normalized = normalizeUnavailableData({
      cards: 'Sem dados.',
      referee: { trend: 'Historico indisponivel para este arbitro.' },
      goals: 'Media confirmada de 2.8 gols.',
    });

    expect(normalized.cards).toBe(OPTIONAL_DATA_UNAVAILABLE);
    expect(normalized.referee.trend).toBe(OPTIONAL_DATA_UNAVAILABLE);
    expect(normalized.goals).toBe('Media confirmada de 2.8 gols.');
  });

  it('rejeita uma partida com poucos dados', () => {
    const gated = applySelectiveDecisionGate(result(), {
      event: { homeTeam: {}, awayTeam: {} },
      teamForm: { homeRecent: { played: 2 }, awayRecent: { played: 1 } },
    });

    expect(gated.recommendation).toBe(NO_RECOMMENDATION);
    expect(gated.confidence).toBe(0);
    expect((gated.meta?.decisionAudit as any).decision).toBe('rejected');
  });

  it('aprova somente o mercado com evidencia objetiva suficiente', () => {
    const gated = applySelectiveDecisionGate(result(), strongInput());

    expect(gated.recommendation).toBe('Over 2.5 gols');
    expect(gated.confidence).toBeGreaterThanOrEqual(75);
    expect(gated.recommendations).toHaveLength(1);
    expect((gated.meta?.decisionAudit as any).decision).toBe('approved');
  });

  it('rejeita analise moderada sem qualidade minima', () => {
    const input: any = strongInput();
    input.teamForm.homeRecent.played = 3;
    input.teamForm.awayRecent.played = 3;
    input.teamForm.homeRecent.homePerformance = { played: 0 };
    input.teamForm.awayRecent.awayPerformance = { played: 0 };
    input.teamForm.headToHead = { played: 0 };
    input.statistics.teamPeriods[0].groups[0].items = input.statistics.teamPeriods[0].groups[0].items.slice(0, 6);
    input.statistics.context = {};
    input.lineups = {};
    input.event.referee = undefined;

    const gated = applySelectiveDecisionGate(result(), input);

    expect(gated.recommendation).toBe(NO_RECOMMENDATION);
    expect(gated.confidence).toBe(0);
    expect((gated.meta?.decisionAudit as any).decision).toBe('rejected');
    expect((gated.meta?.decisionAudit as any).missingData).toContain('arbitro');
  });

  it('limita o bonus de consenso entre fontes sem alterar os limiares do mercado', () => {
    const input: any = strongInput();
    input.dataQuality = { sourceConsensus: { confidenceBonus: 99, providerCount: 3 } };
    const baseline = applySelectiveDecisionGate(result(), strongInput());
    const corroborated = applySelectiveDecisionGate(result(), input);
    const baselineAudit = baseline.meta?.decisionAudit as any;
    const corroboratedAudit = corroborated.meta?.decisionAudit as any;

    expect(corroboratedAudit.dataQuality - baselineAudit.dataQuality).toBe(3);
    expect(corroboratedAudit.candidates[0].confirmations).toContain('dados corroborados por 3 fontes');
    expect(corroboratedAudit.candidates[0].policy).toEqual(baselineAudit.candidates[0].policy);
  });

  it('preserva a analise como waiting odds quando o modo estrito nao encontra cotacao', () => {
    const gated = applySelectiveDecisionGate(result(), strongInput(), { requireRealOdds: true });

    expect(gated.recommendation).toBe('Over 2.5 gols');
    expect(gated.analysisStatus).toBe('waiting_odds');
    expect((gated.meta?.decisionAudit as any).decision).toBe('waiting_odds');
    expect((gated.meta?.decisionAudit as any).reasons[0]).toContain('odd real correspondente');
  });

  it('aprova odd validada somente com EV e vantagem suficientes', () => {
    const candidate = result();
    candidate.recommendations![0].meta = {
      decimal_odds: 1.8,
      fairImpliedProbability: 58,
      oddsValidation: { status: 'matched' },
    };
    const gated = applySelectiveDecisionGate(candidate, strongInput(), { requireRealOdds: true, minimumExpectedValue: 0.05 });

    expect(gated.recommendation).toBe('Over 2.5 gols');
    expect(gated.bestEntry?.meta?.expectedValue).toBeGreaterThanOrEqual(0.05);
    expect(gated.bestEntry?.meta?.probabilityEdge).toBeGreaterThanOrEqual(0.03);
  });

  it('rejeita de verdade quando a odd existe mas o EV e insuficiente', () => {
    const candidate = result();
    candidate.recommendations![0].meta = {
      decimal_odds: 1.1,
      fairImpliedProbability: 90,
      oddsValidation: { status: 'matched' },
    };
    const gated = applySelectiveDecisionGate(candidate, strongInput(), { requireRealOdds: true, minimumExpectedValue: 0.05 });

    expect(gated.analysisStatus).toBe('rejected');
    expect((gated.meta?.decisionAudit as any).decision).toBe('rejected');
    expect((gated.meta?.decisionAudit as any).reasons.join(' ')).toContain('valor esperado abaixo do minimo');
  });

  it('nao utiliza a confianca da IA na probabilidade objetiva', () => {
    const lowSource = result();
    const highSource = result();
    lowSource.recommendations![0].confidence = 20;
    highSource.recommendations![0].confidence = 95;

    expect(applySelectiveDecisionGate(lowSource, strongInput()).confidence)
      .toBe(applySelectiveDecisionGate(highSource, strongInput()).confidence);
  });

  it('rejeita um under quando a tendencia recente aponta para over', () => {
    const gated = applySelectiveDecisionGate(result('Under 2.5 gols'), strongInput());

    expect(gated.recommendation).toBe(NO_RECOMMENDATION);
    expect((gated.meta?.decisionAudit as any).reasons).toContain('tendencia recente conflita com mercado under');
  });
});
