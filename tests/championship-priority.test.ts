import { describe, expect, it } from 'vitest';
import {
  buildChampionshipPriorityContext,
  classifyChampionship,
  compareAnalysisRanking,
  getChampionshipPriority,
  profileSelectionScore,
} from '../src/config/championshipPriority';

function event(tournament: string, home = 'Time A', away = 'Time B') {
  return {
    tournament: { name: tournament },
    homeTeam: { name: home },
    awayTeam: { name: away },
  };
}

describe('championship priority', () => {
  it.each([
    ['Premier League', 1, 'premier-league'],
    ['CONMEBOL Libertadores', 1, 'copa-libertadores'],
    ['Campeonato Brasileiro Serie A', 1, 'brasileirao-serie-a'],
    ['Campeonato Brasileiro Serie B', 1, 'brasileirao-serie-b'],
    ['Copa do Brasil', 1, 'copa-do-brasil'],
    ['Ligue 1', 2, 'ligue-1'],
    ['Liga Portugal', 2, 'primeira-liga-portugal'],
    ['Campeonato Regional', 3, 'other'],
  ])('classifies %s as tier %i', (name, tier, key) => {
    expect(classifyChampionship(event(name))).toMatchObject({ tier, competitionKey: key });
  });

  it('learns current-season participants from collected competition data', () => {
    const context = buildChampionshipPriorityContext([
      event('UEFA Champions League', 'Clube Classificado 2026', 'Outro Classificado 2026'),
    ]);
    const priority = getChampionshipPriority(
      event('UEFA Champions League', 'Clube Classificado 2026', 'Outro Classificado 2026'),
      context,
    );

    expect(priority.dynamicParticipants).toEqual(['clube classificado 2026', 'outro classificado 2026']);
    expect(priority.tier).toBe(1);
    expect(priority.score).toBeGreaterThan(100);
  });

  it('supports duplicated provider fields and country context', () => {
    expect(classifyChampionship({
      tournament: { name: 'Premier League' },
      tournamentName: 'Premier League',
    }).tier).toBe(1);
    expect(classifyChampionship({
      tournament: { name: 'Serie A', category: { name: 'Italy' } },
    }).competitionKey).toBe('serie-a-italia');
  });

  it('keeps data quality stronger than the bounded tier bonus during profile selection', () => {
    const tierOne = getChampionshipPriority(event('Premier League'));
    const tierThree = getChampionshipPriority(event('Liga Regional'));

    expect(profileSelectionScore(95, tierThree, true)).toBeGreaterThan(
      profileSelectionScore(60, tierOne, true),
    );
  });

  it('uses tier as a tie-breaker when confidence is similar', () => {
    const tierOne = { confidence: 86, championshipPriority: getChampionshipPriority(event('Premier League')) };
    const tierThree = { confidence: 86, championshipPriority: getChampionshipPriority(event('Liga Regional')) };

    expect([tierThree, tierOne].sort(compareAnalysisRanking)[0]).toBe(tierOne);
  });

  it('allows a much stronger tier 3 analysis to outrank tier 1', () => {
    const tierOne = { confidence: 82, championshipPriority: getChampionshipPriority(event('Premier League')) };
    const tierThree = { confidence: 95, championshipPriority: getChampionshipPriority(event('Liga Regional')) };

    expect([tierOne, tierThree].sort(compareAnalysisRanking)[0]).toBe(tierThree);
  });

  it('keeps a materially better expected value ahead of championship priority', () => {
    const tierOne = {
      confidence: 84,
      championshipPriority: getChampionshipPriority(event('Premier League')),
      bestEntry: { meta: { expectedValue: 0.08 } },
    };
    const tierThree = {
      confidence: 84,
      championshipPriority: getChampionshipPriority(event('Liga Regional')),
      bestEntry: { meta: { expectedValue: 0.22 } },
    };

    expect([tierOne, tierThree].sort(compareAnalysisRanking)[0]).toBe(tierThree);
  });
});
