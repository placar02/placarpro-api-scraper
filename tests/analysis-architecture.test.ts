import { describe, expect, it } from 'vitest';
import { evaluateDataQuality } from '../src/analysis/data-quality-engine';
import { buildFeatureProfile } from '../src/analysis/feature-engine';
import { assessMarketWithEngine } from '../src/analysis/market-engines';
import { rankAnalysisCandidates } from '../src/analysis/meta-analysis-engine';
import { buildConfidenceBreakdown } from '../src/analysis/confidence-breakdown';
import { calculateMatchScore } from '../src/analysis/match-score-engine';

function input() {
  const form = { played: 10, avgGoalsFor: 1.8, avgGoalsAgainst: 1.2, over25Rate: 70, bttsRate: 65, cleanSheetRate: 25, winRate: 60, homePerformance: { played: 5, winRate: 70 }, awayPerformance: { played: 5, winRate: 40 } };
  const items = [
    { name: 'Gols marcados', home: 1.8, away: 1.7 },
    { name: 'Gols sofridos', home: 1.1, away: 1.3 },
    { name: 'Expected goals', home: 1.7, away: 1.6 },
    { name: 'Chutes', home: 14, away: 12 },
    { name: 'Escanteios', home: 6, away: 5 },
    { name: 'Cartoes', home: 2, away: 3 },
    { name: 'Faltas', home: 12, away: 14 },
    { name: 'Vitorias', home: 6, away: 5 },
    { name: 'Pontos', home: 21, away: 18 },
    { name: 'Posicao', home: 2, away: 4 },
  ];
  return {
    event: { referee: { id: 1 } },
    teamForm: { homeRecent: form, awayRecent: { ...form, winRate: 50 }, headToHead: { played: 4 } },
    statistics: { teamPeriods: [{ groups: [{ items }] }], context: { competitionTable: { home: {}, away: {} }, referee: { cardsAverage: 5 } } },
    lineups: { confirmed: true, home: { starters: Array(11).fill({}) }, away: { starters: Array(11).fill({}) } },
    dataQuality: { sourceConsensus: { confidenceBonus: 2, providerCount: 3 } },
  };
}

describe('arquitetura profissional de analise', () => {
  it('gera qualidade explicavel e features normalizadas', () => {
    const quality = evaluateDataQuality(input());
    const features = buildFeatureProfile(input());
    expect(quality.score).toBeGreaterThanOrEqual(80);
    expect(quality.dimensions.statistics.available).toBe(true);
    expect(quality.coverage.providerCount).toBe(3);
    Object.values(features.indices).forEach((value) => expect(value).toBeGreaterThanOrEqual(0));
    Object.values(features.indices).forEach((value) => expect(value).toBeLessThanOrEqual(100));
  });

  it('delega a avaliacao ao motor especifico de mercado', () => {
    const assessment = assessMarketWithEngine(buildFeatureProfile(input()), {
      market: 'Gols', recommendation: 'Over 2.5 gols', confidence: 80, rationale: 'teste',
    });
    expect(assessment.family).toBe('goals');
    expect(assessment.engine).toBe('over-under-btts');
    expect(assessment.score).toBeGreaterThanOrEqual(70);
  });

  it('ranqueia aprovados pela meta-analise e explica a confianca', () => {
    const candidates: any[] = [
      { market: 'Gols', recommendation: 'A', family: 'goals', objectiveConfidence: 80, dataQuality: 80, marketEvidence: 80, expectedValue: 0.06, rejectionReasons: [] },
      { market: 'Gols', recommendation: 'B', family: 'goals', objectiveConfidence: 82, dataQuality: 90, marketEvidence: 85, expectedValue: 0.12, rejectionReasons: [] },
    ];
    const ranked = rankAnalysisCandidates(candidates, { consensus: 80 });
    expect(ranked[0].recommendation).toBe('B');
    const quality = evaluateDataQuality(input());
    const features = buildFeatureProfile(input());
    const breakdown = buildConfidenceBreakdown({ finalConfidence: 82, quality, features, marketEvidence: 85, expectedValue: 0.12, oddsMatched: true });
    const matchScore = calculateMatchScore({ quality, features, confidence: 82, expectedValue: 0.12 });
    expect(breakdown.final).toBe(82);
    expect(breakdown.odds).toBeGreaterThan(0);
    expect(matchScore).toBeGreaterThan(0);
    expect(matchScore).toBeLessThanOrEqual(100);
  });
});
