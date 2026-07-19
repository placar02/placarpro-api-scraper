import type { NormalizedMatchEnrichment, NormalizedMetric, NormalizedRecentForm } from '../providers/contracts';

function hasValue(value: unknown) {
  return value !== undefined && value !== null && value !== '' && value !== 'Unknown';
}

function choose<T>(current: T, fallback: T): T {
  return hasValue(current) ? current : fallback;
}

function metricPeriods(metrics: NormalizedMetric[]) {
  const periods = new Map<string, Map<string, any[]>>();
  for (const metric of metrics) {
    if (!periods.has(metric.period)) periods.set(metric.period, new Map());
    const groups = periods.get(metric.period)!;
    if (!groups.has(metric.group)) groups.set(metric.group, []);
    groups.get(metric.group)!.push({
      key: metric.key,
      name: metric.name,
      home: metric.homeLabel ?? metric.home,
      away: metric.awayLabel ?? metric.away,
      source: metric.source,
    });
  }
  return [...periods].map(([period, groups]) => ({
    period,
    groups: [...groups].map(([group, items]) => ({ group, items })),
  }));
}

function mergePeriods(current: any[] = [], supplemental: any[] = []) {
  const result = current.map((period) => ({ ...period, groups: (period.groups || []).map((group: any) => ({ ...group, items: [...(group.items || [])] })) }));
  for (const period of supplemental) {
    let targetPeriod = result.find((item) => item.period === period.period);
    if (!targetPeriod) { targetPeriod = { period: period.period, groups: [] }; result.push(targetPeriod); }
    for (const group of period.groups || []) {
      let targetGroup = targetPeriod.groups.find((item: any) => item.group === group.group);
      if (!targetGroup) { targetGroup = { group: group.group, items: [] }; targetPeriod.groups.push(targetGroup); }
      const keys = new Set(targetGroup.items.map((item: any) => String(item.key || item.name).toLowerCase()));
      for (const item of group.items || []) {
        const key = String(item.key || item.name).toLowerCase();
        if (!keys.has(key)) { targetGroup.items.push(item); keys.add(key); }
      }
    }
  }
  return result;
}

function preferForm(current: any, supplemental?: NormalizedRecentForm) {
  if (!supplemental) return current;
  return Number(current?.played || 0) >= Number(supplemental.played || 0) ? current : supplemental;
}

function preferLineup(current: any, supplemental: any) {
  const currentPlayers = Number(current?.starters?.length || 0) + Number(current?.bench?.length || 0);
  const supplementalPlayers = Number(supplemental?.starters?.length || 0) + Number(supplemental?.substitutes?.length || 0);
  if (currentPlayers >= supplementalPlayers) return current;
  return {
    starters: supplemental?.starters || [],
    bench: supplemental?.substitutes || [],
    missingPlayers: supplemental?.missingPlayers || [],
    source: 'sofascore',
  };
}

function sourceSummary(enrichment: NormalizedMatchEnrichment) {
  return {
    available: enrichment.available,
    providerEventId: enrichment.providerEventId,
    collectedAt: enrichment.collectedAt,
    matchedEvent: enrichment.matchedEvent,
    metrics: enrichment.metrics,
    lineups: enrichment.lineups,
    incidents: enrichment.incidents,
    shots: enrichment.shots,
    playerStatistics: enrichment.playerStatistics,
    averagePositions: enrichment.averagePositions,
    bestPlayers: enrichment.bestPlayers,
    odds: enrichment.odds,
    streaks: enrichment.streaks,
    pregameForm: enrichment.pregameForm,
    headToHead: enrichment.headToHead,
    teams: enrichment.teams,
    competition: enrichment.competition,
    context: enrichment.context,
    graph: enrichment.graph,
    raw: enrichment.raw,
    provenance: enrichment.provenance,
    reason: enrichment.reason,
  };
}

function providerQualityKeys(provider: string) {
  if (provider === 'sofascore') return { flag: 'hasSofaScore', metrics: 'sofaScoreMetrics', players: 'sofaScorePlayers', datasets: 'sofaScoreDatasets' };
  if (provider === '365scores') return { flag: 'has365Scores', metrics: 'scores365Metrics', players: 'scores365Players', datasets: 'scores365Datasets' };
  return { flag: 'hasOgol', metrics: 'ogolMetrics', players: 'ogolPlayers', datasets: 'ogolDatasets' };
}

function countInputMetrics(input: any) {
  return (input?.statistics?.teamPeriods || []).flatMap((period: any) => period?.groups || [])
    .flatMap((group: any) => group?.items || []).length;
}

function numeric(value: unknown) {
  if (value === null || value === undefined || value === '') return undefined;
  const parsed = Number(String(value).replace(',', '.').replace(/[^\d.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function consensusMetricKey(value: unknown) {
  const text = String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (/xga|expected.*against|esperad.*contra/.test(text)) return 'xga';
  if (/\bxg\b|expected|gols esperados/.test(text)) return 'xg';
  if (/chute.*alvo|shot.*target|finaliza.*alvo/.test(text)) return 'shots_on_target';
  if (/chute|shot|finaliza/.test(text)) return 'shots';
  if (/escanteio|corner/.test(text)) return 'corners';
  if (/amarelo|yellow|cartao|card/.test(text)) return 'cards';
  if (/posse|possession/.test(text)) return 'possession';
  if (/gol.*marcad|goals.*for/.test(text)) return 'goals_for';
  if (/gol.*sofr|goals.*against/.test(text)) return 'goals_against';
  return text.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function inputMetricMap(input: any) {
  const map = new Map<string, { home: number; away: number }>();
  for (const item of (input?.statistics?.teamPeriods || []).flatMap((period: any) => period?.groups || []).flatMap((group: any) => group?.items || [])) {
    const home = numeric(item.home); const away = numeric(item.away);
    if (home === undefined || away === undefined) continue;
    map.set(consensusMetricKey(item.key || item.name), { home, away });
  }
  return map;
}

function enrichmentMetricMap(enrichment: NormalizedMatchEnrichment) {
  const map = new Map<string, { home: number; away: number }>();
  for (const metric of enrichment.metrics) {
    if (metric.home === undefined || metric.away === undefined) continue;
    map.set(consensusMetricKey(metric.key || metric.name), { home: metric.home, away: metric.away });
  }
  return map;
}

function valuesAgree(left: number, right: number) {
  return Math.abs(left - right) <= Math.max(0.3, Math.max(Math.abs(left), Math.abs(right)) * 0.2);
}

function buildSourceConsensus(input: any, originalInput: any, enrichments: NormalizedMatchEnrichment[]) {
  const primary = String(originalInput?.event?.source || process.env.SCORES_PROVIDER || 'sofascore').toLowerCase();
  const coverage: Record<string, Set<string>> = {};
  const add = (provider: string, category: string, present: boolean) => {
    if (!present) return;
    if (!coverage[provider]) coverage[provider] = new Set();
    coverage[provider].add(category);
  };
  add(primary, 'statistics', countInputMetrics(originalInput) > 0);
  add(primary, 'recent_form', Number(originalInput?.teamForm?.homeRecent?.played || 0) > 0 && Number(originalInput?.teamForm?.awayRecent?.played || 0) > 0);
  add(primary, 'lineups', Boolean(originalInput?.lineups?.home?.starters?.length || originalInput?.lineups?.away?.starters?.length));
  add(primary, 'match_context', Boolean(originalInput?.event?.venue || originalInput?.event?.referee));
  add(primary, 'competition', Boolean(originalInput?.statistics?.context?.competitionTable));

  if (originalInput?.scores365?.available) {
    const provider = '365scores';
    const data = originalInput.scores365;
    add(provider, 'statistics', Boolean(data.statistics || data.disciplineAndCorners));
    add(provider, 'lineups', Boolean(data.lineups));
    add(provider, 'recent_form', Boolean(data.streaks || data.teamForm));
    add(provider, 'odds', Boolean(data.odds));
  }
  for (const enrichment of enrichments.filter((item) => item.available)) {
    add(enrichment.provider, 'statistics', enrichment.metrics.length > 0);
    add(enrichment.provider, 'recent_form', Boolean(enrichment.teams.home.recentForm?.played && enrichment.teams.away.recentForm?.played));
    add(enrichment.provider, 'lineups', Boolean(enrichment.lineups.home.starters.length || enrichment.lineups.away.starters.length));
    add(enrichment.provider, 'match_context', Boolean(enrichment.context.venue || enrichment.context.referee));
    add(enrichment.provider, 'competition', Boolean(enrichment.competition));
    add(enrichment.provider, 'players', Boolean(enrichment.playerStatistics.length || enrichment.teams.home.squad.length || enrichment.teams.away.squad.length));
  }
  const providers = Object.keys(coverage);
  const categories = [...new Set(Object.values(coverage).flatMap((items) => [...items]))];
  const corroboratedDatasets = categories.filter((category) => providers.filter((provider) => coverage[provider].has(category)).length >= 2);
  const metricMaps = new Map<string, Map<string, { home: number; away: number }>>();
  metricMaps.set(primary, inputMetricMap(originalInput));
  for (const enrichment of enrichments.filter((item) => item.available)) metricMaps.set(enrichment.provider, enrichmentMetricMap(enrichment));
  const metricKeys = [...new Set([...metricMaps.values()].flatMap((map) => [...map.keys()]))];
  const metricAgreements = metricKeys.filter((key) => {
    const values = [...metricMaps].map(([provider, map]) => ({ provider, value: map.get(key) })).filter((item) => item.value);
    if (values.length < 2) return false;
    return values.slice(1).some((item) => valuesAgree(values[0].value!.home, item.value!.home) && valuesAgree(values[0].value!.away, item.value!.away));
  });
  const formSnapshots = new Map<string, any>();
  formSnapshots.set(primary, { home: originalInput?.teamForm?.homeRecent, away: originalInput?.teamForm?.awayRecent });
  for (const enrichment of enrichments.filter((item) => item.available)) {
    formSnapshots.set(enrichment.provider, { home: enrichment.teams.home.recentForm, away: enrichment.teams.away.recentForm });
  }
  const forms = [...formSnapshots].filter(([, value]) => value.home?.played >= 5 && value.away?.played >= 5);
  const formAgreement = forms.length >= 2 && forms.slice(1).some(([, candidate]) => {
    const reference = forms[0][1];
    return Math.abs(Number(reference.home.over25Rate) - Number(candidate.home.over25Rate)) <= 15
      && Math.abs(Number(reference.away.over25Rate) - Number(candidate.away.over25Rate)) <= 15
      && Math.abs(Number(reference.home.avgGoalsFor) - Number(candidate.home.avgGoalsFor)) <= 0.5
      && Math.abs(Number(reference.away.avgGoalsFor) - Number(candidate.away.avgGoalsFor)) <= 0.5;
  });
  const agreements = [...metricAgreements.map((key) => `metric:${key}`), ...(formAgreement ? ['recent_form'] : [])];
  const confidenceBonus = providers.length >= 3 && agreements.length >= 3
    ? 3
    : providers.length >= 2 && agreements.length >= 2
      ? 2
      : providers.length >= 2 && agreements.length >= 1
        ? 1
        : 0;
  return {
    primary,
    providers,
    providerCount: providers.length,
    coverage: Object.fromEntries(providers.map((provider) => [provider, [...coverage[provider]]])),
    corroboratedDatasets,
    agreements,
    confidenceBonus,
    note: confidenceBonus
      ? 'Bonus limitado por valores compativeis em fontes independentes; regras e limiares de mercado permanecem inalterados.'
      : 'Cobertura adicional sem valores compativeis suficientes para elevar a qualidade.',
  };
}

export function mergeEnrichmentIntoAnalysisInput(input: any, enrichments: NormalizedMatchEnrichment[]) {
  const originalInput = input;
  let merged = { ...input };
  for (const enrichment of enrichments) {
    const providerData = sourceSummary(enrichment);
    const qualityKeys = providerQualityKeys(enrichment.provider);
    if (!enrichment.available) {
      merged = {
        ...merged,
        [enrichment.provider]: providerData,
        dataProviders: { ...(merged.dataProviders || {}), [enrichment.provider]: providerData },
        dataQuality: { ...(merged.dataQuality || {}), [qualityKeys.flag]: false },
      };
      continue;
    }
    const supplementalPeriods = metricPeriods(enrichment.metrics);
    const currentStats = merged.statistics || {};
    const statistics = {
      ...currentStats,
      teamPeriods: mergePeriods(currentStats.teamPeriods || [], supplementalPeriods),
      players: (currentStats.players?.length ? currentStats.players : enrichment.playerStatistics).slice(0, 30),
      shotChart: (currentStats.shotChart?.length ? currentStats.shotChart : enrichment.shots).slice(0, 40),
      context: {
        ...(currentStats.context || {}),
        competitionTable: currentStats.context?.competitionTable || enrichment.competition,
        seasonFacts: {
          ...(currentStats.context?.seasonFacts || {}),
          home: currentStats.context?.seasonFacts?.home || enrichment.teams.home.seasonStatistics,
          away: currentStats.context?.seasonFacts?.away || enrichment.teams.away.seasonStatistics,
        },
        referee: currentStats.context?.referee || enrichment.context.referee,
        venue: currentStats.context?.venue || enrichment.context.venue,
        weather: currentStats.context?.weather || enrichment.context.weather,
        attendance: currentStats.context?.attendance || enrichment.context.attendance,
        country: currentStats.context?.country || enrichment.context.country,
        importance: currentStats.context?.importance || enrichment.context.importance,
        phase: currentStats.context?.phase || enrichment.context.phase,
      },
    };
    const currentForm = merged.teamForm || {};
    const teamForm = {
      ...currentForm,
      homeRecent: preferForm(currentForm.homeRecent, enrichment.teams.home.recentForm),
      awayRecent: preferForm(currentForm.awayRecent, enrichment.teams.away.recentForm),
      headToHead: preferForm(currentForm.headToHead, enrichment.headToHead),
    };
    const currentLineups = merged.lineups || {};
    const lineups = {
      ...currentLineups,
      confirmed: Boolean(currentLineups.confirmed || enrichment.lineups.confirmed),
      home: preferLineup(currentLineups.home, { ...enrichment.lineups.home, missingPlayers: enrichment.teams.home.missingPlayers }),
      away: preferLineup(currentLineups.away, { ...enrichment.lineups.away, missingPlayers: enrichment.teams.away.missingPlayers }),
    };
    const event = {
      ...(merged.event || {}),
      venue: choose(merged.event?.venue, enrichment.context.venue),
      referee: choose(merged.event?.referee, enrichment.context.referee),
      weather: choose(merged.event?.weather, enrichment.context.weather),
    };
    merged = {
      ...merged,
      event,
      statistics,
      teamForm,
      lineups,
      incidents: merged.incidents?.length ? merged.incidents : enrichment.incidents.slice(0, 40),
      topPlayers: merged.topPlayers || {
        match: enrichment.bestPlayers.slice(0, 15),
        home: enrichment.teams.home.topPlayers.slice(0, 15),
        away: enrichment.teams.away.topPlayers.slice(0, 15),
      },
      tacticalContext: merged.tacticalContext || {
        averagePositions: enrichment.averagePositions.slice(0, 40),
        graph: enrichment.graph,
        streaks: enrichment.streaks,
        pregameForm: enrichment.pregameForm,
      },
      [enrichment.provider]: providerData,
      dataProviders: { ...(merged.dataProviders || {}), [enrichment.provider]: providerData },
      dataQuality: {
        ...(merged.dataQuality || {}),
        [qualityKeys.flag]: true,
        [qualityKeys.metrics]: enrichment.metrics.length,
        [qualityKeys.players]: enrichment.playerStatistics.length,
        [qualityKeys.datasets]: Object.fromEntries(Object.entries(enrichment.provenance).map(([key, value]) => [key, value.status])),
      },
    };
  }
  const sourceConsensus = buildSourceConsensus(merged, originalInput, enrichments);
  return {
    ...merged,
    dataQuality: {
      ...(merged.dataQuality || {}),
      sourceConsensus,
    },
  };
}
