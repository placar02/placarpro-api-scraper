import { allTeamStatItems, clampScore, finiteNumber, hasNumericPair, matchingTeamStats } from './engine-utils';

export type DataQualityDimension = {
  score: number;
  max: number;
  available: boolean;
  detail?: string;
};

export type DataQualityReport = {
  score: number;
  baseScore: number;
  sourceConsensusBonus: number;
  missing: string[];
  homeMatches: number;
  awayMatches: number;
  homeSeasonMatches: number;
  awaySeasonMatches: number;
  statItems: any[];
  dimensions: Record<string, DataQualityDimension>;
  coverage: {
    odds: boolean;
    offensiveData: boolean;
    defensiveData: boolean;
    lineups: boolean;
    injuriesAndSuspensions: boolean;
    providerCount: number;
  };
};

function recentMatches(input: any, side: 'home' | 'away') {
  return finiteNumber(input?.teamForm?.[`${side}Recent`]?.played) || 0;
}

function seasonMatches(input: any, side: 'home' | 'away') {
  return finiteNumber(input?.statistics?.context?.seasonFacts?.[side]?.matches) || 0;
}

export function evaluateDataQuality(input: any): DataQualityReport {
  const homeMatches = recentMatches(input, 'home');
  const awayMatches = recentMatches(input, 'away');
  const statItems = allTeamStatItems(input);
  const homePlayers = input?.lineups?.home?.starters?.length || input?.lineups?.home?.keyPlayersByMarketValue?.length || 0;
  const awayPlayers = input?.lineups?.away?.starters?.length || input?.lineups?.away?.keyPlayersByMarketValue?.length || 0;
  const h2h = input?.teamForm?.headToHead?.played || input?.streaks?.head2head?.length || 0;
  const homeSeasonMatches = seasonMatches(input, 'home');
  const awaySeasonMatches = seasonMatches(input, 'away');
  const missing: string[] = [];
  const dimensions: Record<string, DataQualityDimension> = {};
  let score = 0;

  let historyScore = 0;
  if (homeMatches >= 10 && awayMatches >= 10) historyScore = 30;
  else if (homeMatches >= 5 && awayMatches >= 5) historyScore = 27;
  else if (homeMatches >= 3 && awayMatches >= 3) historyScore = 22;
  else if (homeMatches >= 2 && awayMatches >= 2) historyScore = 12;
  else missing.push('historico_recente_insuficiente');
  score += historyScore;
  dimensions.historicalSample = { score: historyScore, max: 30, available: historyScore > 0, detail: `${homeMatches}/${awayMatches} jogos recentes` };

  let statisticsScore = 0;
  if (statItems.length >= 10) statisticsScore = 30;
  else if (statItems.length >= 6) statisticsScore = 25;
  else if (statItems.length >= 3) statisticsScore = 18;
  else if (statItems.length > 0) statisticsScore = 8;
  else missing.push('estatisticas_de_equipe');
  score += statisticsScore;
  dimensions.statistics = { score: statisticsScore, max: 30, available: statisticsScore > 0, detail: `${statItems.length} indicadores` };

  const seasonScore = homeSeasonMatches >= 5 && awaySeasonMatches >= 5 ? 15 : 0;
  if (!seasonScore) missing.push('amostra_da_temporada');
  score += seasonScore;
  dimensions.seasonSample = { score: seasonScore, max: 15, available: seasonScore > 0, detail: `${homeSeasonMatches}/${awaySeasonMatches} jogos` };

  const hasVenueSplits = Boolean(input?.teamForm?.homeRecent?.homePerformance?.played && input?.teamForm?.awayRecent?.awayPerformance?.played);
  if (!hasVenueSplits) missing.push('desempenho_casa_fora');
  score += hasVenueSplits ? 8 : 0;
  dimensions.venueSplits = { score: hasVenueSplits ? 8 : 0, max: 8, available: hasVenueSplits };

  const hasLineups = homePlayers >= 5 && awayPlayers >= 5;
  if (!hasLineups) missing.push('escalacoes_ou_elenco');
  score += hasLineups ? 6 : 0;
  dimensions.lineups = { score: hasLineups ? 6 : 0, max: 6, available: hasLineups, detail: `${homePlayers}/${awayPlayers} jogadores` };

  const hasH2h = h2h >= 3;
  if (!hasH2h) missing.push('confrontos_diretos');
  score += hasH2h ? 5 : 0;
  dimensions.headToHead = { score: hasH2h ? 5 : 0, max: 5, available: hasH2h, detail: `${h2h} confrontos` };

  const hasReferee = Boolean(input?.event?.referee?.id || input?.refereeProfile?.id || input?.statistics?.context?.referee?.name);
  if (!hasReferee) missing.push('arbitro');
  score += hasReferee ? 3 : 0;
  dimensions.referee = { score: hasReferee ? 3 : 0, max: 3, available: hasReferee };

  const hasCompetitionContext = Boolean(input?.statistics?.context?.competitionTable?.home || input?.statistics?.context?.teamNeeds?.home);
  if (!hasCompetitionContext) missing.push('contexto_do_campeonato');
  score += hasCompetitionContext ? 3 : 0;
  dimensions.competitionContext = { score: hasCompetitionContext ? 3 : 0, max: 3, available: hasCompetitionContext };

  const sourceConsensusBonus = Math.min(3, Math.max(0, finiteNumber(input?.dataQuality?.sourceConsensus?.confidenceBonus) || 0));
  const providerCount = Math.max(1, finiteNumber(input?.dataQuality?.sourceConsensus?.providerCount) || 1);
  dimensions.sourceConsensus = { score: sourceConsensusBonus, max: 3, available: sourceConsensusBonus > 0, detail: `${providerCount} fontes` };

  const offensiveData = hasNumericPair(matchingTeamStats(input, /gol marcado|xg|expected goal|chute|finaliza|remate/));
  const defensiveData = hasNumericPair(matchingTeamStats(input, /gol sofrido|xga|desarme|intercept|defesa/));
  const odds = Boolean(input?.odds || input?.oddsResponses || input?.dataQuality?.oddsAvailable);
  const injuriesAndSuspensions = Boolean(
    input?.injuries?.length || input?.suspensions?.length || input?.missingPlayers?.length
    || input?.lineups?.home?.missingPlayers?.length || input?.lineups?.away?.missingPlayers?.length
  );

  return {
    score: clampScore(score + sourceConsensusBonus),
    baseScore: clampScore(score),
    sourceConsensusBonus,
    missing,
    homeMatches,
    awayMatches,
    homeSeasonMatches,
    awaySeasonMatches,
    statItems,
    dimensions,
    coverage: { odds, offensiveData, defensiveData, lineups: hasLineups, injuriesAndSuspensions, providerCount },
  };
}
