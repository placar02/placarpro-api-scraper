import { describe, expect, it } from 'vitest';
import { mergeEnrichmentIntoAnalysisInput } from '../src/analysis/enrichment-merge';
import { aggregateSofaScoreForm, scoreSofaScoreCandidate } from '../src/scrapers/sofascore';
import type { NormalizedMatchEnrichment } from '../src/providers/contracts';
import { scoreProviderCandidate } from '../src/providers/match-correlation';
import { normalize365Enrichment } from '../src/scrapers/scores365-enrichment';

const referenceEvent = {
  id: 10,
  startTime: 1784304000,
  homeTeam: { id: 1, name: 'Botafogo FR', shortName: 'Botafogo' },
  awayTeam: { id: 2, name: 'Santos FC', shortName: 'Santos' },
} as any;

describe('SofaScore enrichment', () => {
  it('matches equivalent team names and kickoff', () => {
    const candidate = {
      id: 20,
      startTimestamp: 1784304300,
      homeTeam: { id: 100, name: 'Botafogo' },
      awayTeam: { id: 200, name: 'Santos' },
    } as any;

    const score = scoreSofaScoreCandidate(referenceEvent, candidate);
    expect(score.teamsScore).toBeGreaterThan(0.85);
    expect(score.score).toBeGreaterThan(0.8);
    expect(scoreProviderCandidate(referenceEvent, candidate).score).toBeGreaterThan(0.8);
  });

  it('rejects unrelated teams even with a close kickoff', () => {
    const candidate = {
      id: 21,
      startTimestamp: 1784304000,
      homeTeam: { id: 300, name: 'Arsenal' },
      awayTeam: { id: 400, name: 'Chelsea' },
    } as any;

    expect(scoreSofaScoreCandidate(referenceEvent, candidate).teamsScore).toBeLessThan(0.3);
  });

  it('normalizes recent form and venue splits', () => {
    const form = aggregateSofaScoreForm({ events: [
      { status: { type: 'finished' }, homeTeam: { id: 1 }, awayTeam: { id: 3 }, homeScore: { current: 3 }, awayScore: { current: 1 } },
      { status: { type: 'finished' }, homeTeam: { id: 4 }, awayTeam: { id: 1 }, homeScore: { current: 0 }, awayScore: { current: 0 } },
    ] }, 1);

    expect(form).toMatchObject({ played: 2, wins: 1, draws: 1, goalsFor: 3, goalsAgainst: 1 });
    expect(form.homePerformance.played).toBe(1);
    expect(form.awayPerformance.played).toBe(1);
    expect(form.over25Rate).toBe(50);
  });

  it('adds missing datasets while preserving richer primary-provider values', () => {
    const enrichment: NormalizedMatchEnrichment = {
      provider: 'sofascore', available: true, providerEventId: 99, collectedAt: '2026-07-17T12:00:00.000Z',
      metrics: [{ key: 'expectedGoals', name: 'Expected goals', period: 'ALL', group: 'Match overview', home: 1.8, away: 0.9, source: 'sofascore' }],
      lineups: { confirmed: true, home: { starters: [{ name: 'H1' }], substitutes: [] }, away: { starters: [{ name: 'A1' }], substitutes: [] } },
      incidents: [{ incidentType: 'card' }], shots: [{ xg: 0.3 }], playerStatistics: [{ name: 'H1', rating: 8 }],
      averagePositions: [{ player: { name: 'H1' }, averageX: 42 }], bestPlayers: [{ player: { name: 'H1' }, rating: 8 }],
      teams: {
        home: { recentForm: { played: 10, wins: 7, draws: 2, losses: 1, goalsFor: 20, goalsAgainst: 8, avgGoalsFor: 2, avgGoalsAgainst: 0.8, over25Rate: 60, bttsRate: 40, cleanSheetRate: 50, homePerformance: { played: 5, wins: 4, draws: 1, losses: 0 }, awayPerformance: { played: 5, wins: 3, draws: 1, losses: 1 }, events: [] }, topPlayers: [], squad: [], missingPlayers: [] },
        away: { topPlayers: [], squad: [], missingPlayers: [] },
      },
      context: { venue: { name: 'Nilton Santos' } }, provenance: { statistics: { source: 'sofascore', status: 'available', records: 1 } },
    };
    const input = {
      event: { id: 10, venue: { name: 'Estadio principal' } },
      statistics: { teamPeriods: [] },
      teamForm: { homeRecent: { played: 3 }, awayRecent: { played: 8 } },
    };

    const result = mergeEnrichmentIntoAnalysisInput(input, [enrichment]);
    expect(result.event.venue.name).toBe('Estadio principal');
    expect(result.teamForm.homeRecent.played).toBe(10);
    expect(result.teamForm.awayRecent.played).toBe(8);
    expect(result.statistics.teamPeriods[0].groups[0].items[0].key).toBe('expectedGoals');
    expect(result.dataQuality.hasSofaScore).toBe(true);
  });

  it('accepts OGOL through the same normalized provider contract', () => {
    const ogol = {
      provider: 'ogol', available: true, providerEventId: 'ogol-1', collectedAt: '2026-07-18T12:00:00.000Z',
      metrics: [{ key: 'corners', name: 'Escanteios por jogo', period: 'ALL', group: 'OGOL', home: 5.5, away: 4.8, source: 'ogol' }],
      lineups: { confirmed: false, home: { starters: [], substitutes: [] }, away: { starters: [], substitutes: [] } },
      incidents: [], shots: [], playerStatistics: [], averagePositions: [], bestPlayers: [],
      teams: { home: { topPlayers: [], squad: [], missingPlayers: [] }, away: { topPlayers: [], squad: [], missingPlayers: [] } },
      context: {}, provenance: { statistics: { source: 'ogol', status: 'available', records: 1 } },
    } as NormalizedMatchEnrichment;

    const result = mergeEnrichmentIntoAnalysisInput({ statistics: { teamPeriods: [] } }, [ogol]);
    expect(result.ogol.available).toBe(true);
    expect(result.dataProviders.ogol.providerEventId).toBe('ogol-1');
    expect(result.dataQuality.hasOgol).toBe(true);
    expect(result.statistics.teamPeriods[0].groups[0].items[0].key).toBe('corners');
  });

  it('normalizes 365Scores into the shared provider contract', () => {
    const normalized = normalize365Enrichment({
      available: true,
      scores365EventId: 365,
      matchedEvent: { venue: { name: 'Estadio' } },
      statistics: {
        by_period: { ALL: { period: 'ALL', groups_by_name: { Team: { group_name: 'Team', items: [{ key: 'xg', name: 'xG', home: 1.4, away: 0.8 }] } } } },
        players: [{ id: 1, name: 'Jogador', shots: 3 }],
        shotChart: [{ xg: 0.4 }],
      },
      lineups: { data: { confirmed: true, home: { players: [{ player: { id: 1, name: 'Jogador' } }] }, away: { players: [] } } },
      incidents: { data: { incidents: [{ type: 'card' }] } },
      dataCoverage: { hasStatistics: true, hasLineups: true },
    }, referenceEvent);

    expect(normalized.provider).toBe('365scores');
    expect(normalized.metrics[0]).toMatchObject({ key: 'xg', home: 1.4, away: 0.8 });
    expect(normalized.playerStatistics).toHaveLength(1);
    expect(normalized.provenance.hasStatistics.status).toBe('available');
  });

  it('grants consensus only when independent values are compatible', () => {
    const ogol = {
      provider: 'ogol', available: true, collectedAt: '2026-07-18T12:00:00.000Z',
      metrics: [{ key: 'expectedGoals', name: 'Gols esperados', period: 'ALL', group: 'OGOL', home: 1.5, away: 0.9, source: 'ogol' }],
      lineups: { confirmed: false, home: { starters: [], substitutes: [] }, away: { starters: [], substitutes: [] } },
      incidents: [], shots: [], playerStatistics: [], averagePositions: [], bestPlayers: [],
      teams: { home: { topPlayers: [], squad: [], missingPlayers: [] }, away: { topPlayers: [], squad: [], missingPlayers: [] } },
      context: {}, provenance: {},
    } as NormalizedMatchEnrichment;
    const input = {
      event: { source: 'sofascore' },
      statistics: { teamPeriods: [{ groups: [{ items: [{ key: 'xg', name: 'xG', home: 1.4, away: 1 }] }] }] },
    };

    const result = mergeEnrichmentIntoAnalysisInput(input, [ogol]);
    expect(result.dataQuality.sourceConsensus.agreements).toContain('metric:xg');
    expect(result.dataQuality.sourceConsensus.confidenceBonus).toBe(1);
  });
});
