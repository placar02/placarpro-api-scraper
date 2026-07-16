export type ChampionshipTier = 1 | 2 | 3;

export type ChampionshipPriority = {
  tier: ChampionshipTier;
  tierScore: 100 | 60 | 20;
  teamScore: number;
  score: number;
  competitionKey: string;
  competitionName: string;
  matchedBy: 'competition' | 'fallback';
  notableTeams: string[];
  dynamicParticipants: string[];
};

export type ChampionshipPriorityContext = {
  participantTiers: Map<string, ChampionshipTier>;
};

export const CHAMPIONSHIP_PRIORITY_VERSION = 'v1';

type CompetitionRule = {
  key: string;
  tier: Exclude<ChampionshipTier, 3>;
  patterns: RegExp[];
};

const TIER_SCORES = { 1: 100, 2: 60, 3: 20 } as const;
const CLOSE_CONFIDENCE_GAP = 5;

// Participants are intentionally not listed here. They are learned from the
// current schedule whenever a recognized competition is collected.
const COMPETITION_RULES: CompetitionRule[] = [
  { key: 'uefa-champions-league', tier: 1, patterns: [/\buefa champions league\b/, /\bchampions league\b/] },
  { key: 'copa-libertadores', tier: 1, patterns: [/\bcopa libertadores\b/, /\bconmebol libertadores\b/, /\blibertadores\b/] },
  { key: 'brasileirao-serie-b', tier: 1, patterns: [/\bbrasileir(?:ao|o) serie b\b/, /\bcampeonato brasileiro serie b\b/] },
  { key: 'brasileirao-serie-a', tier: 1, patterns: [/\bbrasileir(?:ao|o) serie a\b/, /\bcampeonato brasileiro serie a\b/] },
  { key: 'copa-do-brasil', tier: 1, patterns: [/\bcopa do brasil\b/] },
  { key: 'copa-sul-americana', tier: 1, patterns: [/\bcopa sul americana\b/, /\bconmebol sudamericana\b/, /\bsul americana\b/, /\bsudamericana\b/] },
  { key: 'fifa-world-cup', tier: 1, patterns: [/\bfifa world cup\b/, /\bcopa do mundo(?: fifa)?\b/, /\bworld cup\b/] },
  { key: 'premier-league', tier: 1, patterns: [/^premier league(?: england| inglaterra)?$/, /\benglish premier league\b/] },
  { key: 'la-liga', tier: 1, patterns: [/^la liga(?: ea sports| spain| espanha)?$/, /\bprimera division espanha\b/, /\bspanish la liga\b/] },
  { key: 'serie-a-italia', tier: 1, patterns: [/^serie a(?: enilive| italy| italia| italiana)?$/, /\bcampionato italiano\b/, /\bitalian serie a\b/] },
  { key: 'bundesliga', tier: 1, patterns: [/^bundesliga(?: alemanha| germany| germany alemanha)?$/, /\bgerman bundesliga\b/] },

  { key: 'ligue-1', tier: 2, patterns: [/^ligue 1(?: mcdonalds)?$/, /\bfrance ligue 1\b/] },
  { key: 'eredivisie', tier: 2, patterns: [/\beredivisie\b/] },
  { key: 'primeira-liga-portugal', tier: 2, patterns: [/\bprimeira liga\b/, /\bliga portugal\b/] },
  { key: 'championship-england', tier: 2, patterns: [/\befl championship\b/, /^championship(?: england| inglaterra)?$/] },
  { key: 'mls', tier: 2, patterns: [/\bmajor league soccer\b/, /^mls$/] },
  { key: 'liga-mx', tier: 2, patterns: [/\bliga mx\b/] },
  { key: 'campeonato-argentino', tier: 2, patterns: [/\bliga profesional argentina\b/, /\bprimera division argentina\b/, /\bcampeonato argentino\b/] },
  { key: 'campeonato-uruguaio', tier: 2, patterns: [/\bprimera division uruguay\b/, /\bcampeonato uruguaio\b/, /\bprimera division uruguaia\b/] },
  { key: 'fa-cup', tier: 2, patterns: [/\bfa cup\b/, /\bcopa da inglaterra\b/] },
  { key: 'efl-cup', tier: 2, patterns: [/\befl cup\b/, /\bcarabao cup\b/, /\bcopa da liga inglesa\b/] },
  { key: 'uefa-super-cup', tier: 2, patterns: [/\buefa super cup\b/, /\bsupercopa europeia\b/] },
];

// These are relevance bonuses, not seasonal participant lists.
const NOTABLE_TEAMS = new Set([
  'manchester city', 'liverpool', 'arsenal', 'chelsea', 'manchester united', 'tottenham', 'tottenham hotspur', 'newcastle', 'newcastle united', 'aston villa',
  'real madrid', 'barcelona', 'atletico de madrid', 'atletico madrid', 'sevilla', 'villarreal', 'real sociedad',
  'inter', 'inter milan', 'internazionale', 'milan', 'ac milan', 'juventus', 'napoli', 'roma', 'lazio', 'atalanta',
  'bayern munchen', 'bayern munich', 'borussia dortmund', 'rb leipzig', 'bayer leverkusen', 'eintracht frankfurt',
  'palmeiras', 'flamengo', 'corinthians', 'sao paulo', 'santos', 'gremio', 'internacional', 'atletico mineiro',
  'fluminense', 'botafogo', 'cruzeiro', 'vasco', 'bahia', 'fortaleza', 'athletico paranaense', 'red bull bragantino',
]);

export function normalizePriorityText(value: unknown) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tournamentDescriptors(event: any) {
  const names = [
    event?.tournament?.name,
    event?.tournamentName,
    event?.competition?.name,
  ].map(normalizePriorityText).filter(Boolean);
  const context = [
    event?.tournament?.category?.name,
    event?.category?.name,
    event?.country?.name,
  ].map(normalizePriorityText).filter(Boolean);
  return [...new Set([
    ...names,
    ...names.flatMap((name) => context.map((value) => `${name} ${value}`)),
  ])];
}

function eventTeams(event: any) {
  return [event?.homeTeam?.name, event?.awayTeam?.name]
    .map(normalizePriorityText)
    .filter(Boolean);
}

export function classifyChampionship(event: any) {
  const descriptors = tournamentDescriptors(event);
  const rule = COMPETITION_RULES.find((item) => item.patterns.some((pattern) => (
    descriptors.some((descriptor) => pattern.test(descriptor))
  )));
  const descriptor = rule
    ? descriptors.find((value) => rule.patterns.some((pattern) => pattern.test(value)))
    : descriptors[0];
  return {
    tier: (rule?.tier || 3) as ChampionshipTier,
    competitionKey: rule?.key || 'other',
    competitionName: descriptor || 'unknown',
    matchedBy: rule ? 'competition' as const : 'fallback' as const,
  };
}

export function buildChampionshipPriorityContext(events: any[]): ChampionshipPriorityContext {
  const participantTiers = new Map<string, ChampionshipTier>();

  for (const event of events) {
    const classification = classifyChampionship(event);
    if (classification.tier === 3) continue;

    for (const team of eventTeams(event)) {
      const current = participantTiers.get(team);
      if (!current || classification.tier < current) participantTiers.set(team, classification.tier);
    }
  }

  return { participantTiers };
}

export function getChampionshipPriority(event: any, context?: ChampionshipPriorityContext): ChampionshipPriority {
  const classification = classifyChampionship(event);
  const teams = eventTeams(event);
  const notableTeams = teams.filter((team) => NOTABLE_TEAMS.has(team.replace(/\s+(?:fc|cf|futebol clube)$/g, '').trim()));
  const dynamicParticipants = teams.filter((team) => {
    const participantTier = context?.participantTiers.get(team);
    return participantTier !== undefined && participantTier <= classification.tier;
  });
  const teamScore = Math.min(16, notableTeams.length * 6 + dynamicParticipants.length * 2);
  const tierScore = TIER_SCORES[classification.tier];

  return {
    ...classification,
    tierScore,
    teamScore,
    score: tierScore + teamScore,
    notableTeams,
    dynamicParticipants,
  };
}

export function profileSelectionScore(dataQuality: number, priority: ChampionshipPriority, fullData: boolean) {
  // Tier influence is deliberately bounded so strong data can beat a higher tier.
  return Number(dataQuality || 0) + priority.tierScore * 0.2 + priority.teamScore * 0.25 + (fullData ? 10 : 0);
}

function expectedValue(analysis: any) {
  const value = Number(
    analysis?.bestEntry?.meta?.expectedValue
    ?? analysis?.meta?.expectedValue
    ?? analysis?.meta?.decisionAudit?.candidates?.find((candidate: any) => candidate?.rejectionReasons?.length === 0)?.expectedValue
  );
  return Number.isFinite(value) ? value : undefined;
}

function analysisPriority(analysis: any) {
  return Number(analysis?.championshipPriority?.score ?? analysis?.dataProfile?.championshipPriority?.score ?? 20);
}

export function compareAnalysisRanking(left: any, right: any) {
  const leftConfidence = Number(left?.confidence || 0);
  const rightConfidence = Number(right?.confidence || 0);
  const leftApproved = leftConfidence > 0;
  const rightApproved = rightConfidence > 0;
  if (leftApproved !== rightApproved) return leftApproved ? -1 : 1;

  const confidenceGap = leftConfidence - rightConfidence;
  if (Math.abs(confidenceGap) > CLOSE_CONFIDENCE_GAP) return confidenceGap > 0 ? -1 : 1;

  const leftEv = expectedValue(left);
  const rightEv = expectedValue(right);
  if (leftEv !== undefined && rightEv !== undefined && Math.abs(leftEv - rightEv) > 0.05) {
    return rightEv - leftEv;
  }

  const priorityGap = analysisPriority(right) - analysisPriority(left);
  if (priorityGap !== 0) return priorityGap;
  if (confidenceGap !== 0) return confidenceGap > 0 ? -1 : 1;
  if (leftEv !== undefined && rightEv !== undefined && leftEv !== rightEv) return rightEv - leftEv;

  return Number(right?.dataProfile?.score || 0) - Number(left?.dataProfile?.score || 0);
}
