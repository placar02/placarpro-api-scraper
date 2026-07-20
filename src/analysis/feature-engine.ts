import { averageNumbers, clampScore, finiteNumber, hasNumericPair, matchingTeamStats } from './engine-utils';

export type FeatureProfile = {
  generatedAt: string;
  signals: {
    goals: any[];
    goalContext: any[];
    corners: any[];
    shots: any[];
    cards: any[];
    fouls: any[];
    avgGoalsFor?: number;
    avgGoalsAgainst?: number;
    overRate?: number;
    bttsRate?: number;
    cleanSheetRate?: number;
    standings: any;
    homeRecent: any;
    awayRecent: any;
    referee: any;
    playerShotsAvailable: boolean;
    lineupConfirmed: boolean;
    individualFormAvailable: boolean;
  };
  indices: {
    offensiveStrength: number;
    defensiveStrength: number;
    offensivePressure: number;
    defensiveVulnerability: number;
    recentConsistency: number;
    offensiveEfficiency: number;
    defensiveEfficiency: number;
    matchIntensity: number;
    technicalBalance: number;
    homeAdvantage: number;
    disciplinaryIndex: number;
    unpredictability: number;
    goalsPotential: number;
    cornersPotential: number;
    cardsPotential: number;
  };
};

const rate = (input: any, side: 'home' | 'away', field: string) => finiteNumber(input?.teamForm?.[`${side}Recent`]?.[field]);
const scaled = (value: number | undefined, maximum: number, fallback = 50) => value === undefined ? fallback : clampScore((value / maximum) * 100);

export function buildFeatureProfile(input: any): FeatureProfile {
  const goals = matchingTeamStats(input, /gol|xg|expected/);
  const corners = matchingTeamStats(input, /escanteio|corner/);
  const shots = matchingTeamStats(input, /chute|finaliza|remate/);
  const cards = matchingTeamStats(input, /cart|amarelo|vermelho/);
  const fouls = matchingTeamStats(input, /falta/);
  const avgGoalsFor = averageNumbers([rate(input, 'home', 'avgGoalsFor'), rate(input, 'away', 'avgGoalsFor')]);
  const avgGoalsAgainst = averageNumbers([rate(input, 'home', 'avgGoalsAgainst'), rate(input, 'away', 'avgGoalsAgainst')]);
  const overRate = averageNumbers([rate(input, 'home', 'over25Rate'), rate(input, 'away', 'over25Rate')]);
  const bttsRate = averageNumbers([rate(input, 'home', 'bttsRate'), rate(input, 'away', 'bttsRate')]);
  const cleanSheetRate = averageNumbers([rate(input, 'home', 'cleanSheetRate'), rate(input, 'away', 'cleanSheetRate')]);
  const homeRecent = input?.teamForm?.homeRecent || {};
  const awayRecent = input?.teamForm?.awayRecent || {};
  const homeWin = finiteNumber(homeRecent?.winRate);
  const awayWin = finiteNumber(awayRecent?.winRate);
  const formConsistency = averageNumbers([homeWin, awayWin, finiteNumber(homeRecent?.unbeatenRate), finiteNumber(awayRecent?.unbeatenRate)]);
  const totalGoals = (avgGoalsFor ?? 1.2) + (avgGoalsAgainst ?? 1.2);
  const balanceGap = homeWin !== undefined && awayWin !== undefined ? Math.abs(homeWin - awayWin) : 25;
  const homeVenue = finiteNumber(homeRecent?.homePerformance?.winRate);
  const awayVenue = finiteNumber(awayRecent?.awayPerformance?.winRate);
  const referee = input?.statistics?.context?.referee || input?.refereeProfile;
  const refereeCards = finiteNumber(referee?.cardsAverage) ?? finiteNumber(referee?.yellowCardsPerGame);
  const players = input?.statistics?.players || [];

  return {
    generatedAt: new Date().toISOString(),
    signals: {
      goals,
      goalContext: matchingTeamStats(input, /gol|ponto|posicao|vitoria|derrota/),
      corners,
      shots,
      cards,
      fouls,
      avgGoalsFor,
      avgGoalsAgainst,
      overRate,
      bttsRate,
      cleanSheetRate,
      standings: input?.statistics?.context?.competitionTable,
      homeRecent,
      awayRecent,
      referee,
      playerShotsAvailable: players.some((player: any) => finiteNumber(player?.shots) !== undefined && finiteNumber(player?.shotsOnTarget) !== undefined),
      lineupConfirmed: Boolean(input?.lineups?.confirmed),
      individualFormAvailable: Boolean(input?.topPlayers?.home?.length || input?.topPlayers?.away?.length),
    },
    indices: {
      offensiveStrength: scaled(avgGoalsFor, 2.5),
      defensiveStrength: clampScore(100 - scaled(avgGoalsAgainst, 2.5)),
      offensivePressure: clampScore((scaled(avgGoalsFor, 2.5) * 0.55) + (hasNumericPair(shots) ? 30 : 0) + (hasNumericPair(corners) ? 15 : 0)),
      defensiveVulnerability: scaled(avgGoalsAgainst, 2.5),
      recentConsistency: clampScore(formConsistency ?? 50),
      offensiveEfficiency: clampScore((scaled(avgGoalsFor, 2.5) * 0.7) + (hasNumericPair(shots) ? 30 : 0)),
      defensiveEfficiency: clampScore((100 - scaled(avgGoalsAgainst, 2.5)) * 0.75 + ((cleanSheetRate ?? 0) * 0.25)),
      matchIntensity: clampScore((scaled(totalGoals, 4.5) * 0.6) + ((overRate ?? 50) * 0.4)),
      technicalBalance: clampScore(100 - balanceGap),
      homeAdvantage: clampScore(50 + (((homeVenue ?? 50) - (awayVenue ?? 50)) / 2)),
      disciplinaryIndex: clampScore((scaled(refereeCards, 6) * 0.6) + (hasNumericPair(cards) ? 25 : 0) + (hasNumericPair(fouls) ? 15 : 0)),
      unpredictability: clampScore(100 - Math.abs(50 - (formConsistency ?? 50))),
      goalsPotential: clampScore((scaled(totalGoals, 4.5) * 0.55) + ((overRate ?? 50) * 0.3) + ((bttsRate ?? 50) * 0.15)),
      cornersPotential: clampScore((hasNumericPair(corners) ? 70 : 20) + (hasNumericPair(shots) ? 25 : 0)),
      cardsPotential: clampScore((hasNumericPair(cards) ? 55 : 15) + (hasNumericPair(fouls) ? 20 : 0) + (refereeCards !== undefined ? 20 : 0)),
    },
  };
}
