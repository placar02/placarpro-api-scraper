import type { AnalysisResult, BettingRecommendation } from '../types/analysis';
import { marketTextSimilarity, normalizeMarket, normalizeMarketText, type CanonicalMarket } from './market-normalization';

type OddsCandidate = {
  source: string;
  bookmaker?: string;
  marketName: string;
  marketPeriod?: string;
  choiceGroup?: string;
  choiceName: string;
  decimalOdd: number;
  marketOverround?: number;
  fairImpliedProbability?: number;
  capturedAt?: string;
  normalized: CanonicalMarket;
};

type OddsDiscard = {
  source: string;
  bookmaker?: string;
  originalMarket: string;
  originalChoice: string;
  normalizedMarket: string;
  decimalOdd?: number;
  reason: string;
};

function firstValue(object: any, keys: string[]) {
  for (const key of keys) {
    const value = object?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function decimalOdd(choice: any) {
  const direct = Number(firstValue(choice, ['decimal_odds', 'decimalOdds', 'decimal', 'odd', 'odds', 'price', 'value']));
  if (Number.isFinite(direct) && direct > 1) return direct;
  const fractional = String(firstValue(choice, ['fractional_odds', 'fractionalOdds', 'fractional']) || '');
  const match = fractional.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if (!match || Number(match[2]) === 0) return undefined;
  const converted = (Number(match[1]) / Number(match[2])) + 1;
  return converted > 1 ? converted : undefined;
}

function marketCollections(response: any) {
  const collections: Array<{ groupName?: string; markets: any[] }> = [];
  for (const [groupName, group] of Object.entries(response?.markets_by_group || {})) {
    collections.push({ groupName, markets: Array.isArray((group as any)?.markets) ? (group as any).markets : [] });
  }
  for (const key of ['markets', 'odds', 'items']) {
    if (Array.isArray(response?.[key])) collections.push({ groupName: key, markets: response[key] });
  }
  return collections;
}

function flattenProviderOdds(response: any) {
  const candidates: OddsCandidate[] = [];
  const discarded: OddsDiscard[] = [];
  const source = String(response?.source || response?.summary?.source || response?.provider || 'odds-provider');

  for (const collection of marketCollections(response)) {
    for (const market of collection.markets) {
      const marketName = String(firstValue(market, ['market_name', 'marketName', 'market_group', 'marketGroup', 'displayName', 'title', 'name']) || collection.groupName || 'odds-market');
      const marketPeriod = String(firstValue(market, ['market_period', 'marketPeriod', 'period']) || '');
      const choiceGroup = String(firstValue(market, ['choice_group', 'choiceGroup', 'line', 'handicap', 'internalOption']) || '');
      const choices = firstValue(market, ['choices', 'options', 'selections', 'outcomes', 'odds']);

      if (market?.suspended || market?.isSuspended || market?.active === false) {
        discarded.push({ source, originalMarket: marketName, originalChoice: '', normalizedMarket: normalizeMarket({ marketName }).key, reason: 'mercado suspenso ou inativo' });
        continue;
      }
      if (!Array.isArray(choices)) {
        discarded.push({ source, originalMarket: marketName, originalChoice: '', normalizedMarket: normalizeMarket({ marketName }).key, reason: 'mercado sem lista de selecoes reconhecivel' });
        continue;
      }

      const validChoices = choices.map((choice: any) => ({ choice, odd: decimalOdd(choice) }));
      const overround = validChoices.reduce((total: number, item: any) => total + (item.odd ? 1 / item.odd : 0), 0);
      for (const { choice, odd } of validChoices) {
        const choiceName = String(firstValue(choice, ['name', 'raw_name', 'rawName', 'label', 'displayName', 'title', 'slip_content', 'slipContent', 'selectionName']) || '');
        const normalized = normalizeMarket({ marketName, marketPeriod, choiceGroup, choiceName });
        if (!odd) {
          discarded.push({ source, bookmaker: firstValue(choice, ['bookmaker', 'bookmakerName']) || market?.bookmaker, originalMarket: marketName, originalChoice: choiceName, normalizedMarket: normalized.key, reason: 'odd decimal ausente, invalida ou menor ou igual a 1' });
          continue;
        }
        candidates.push({
          source,
          bookmaker: firstValue(choice, ['bookmaker', 'bookmakerName']) || market?.bookmaker?.name || market?.bookmaker,
          marketName,
          marketPeriod,
          choiceGroup,
          choiceName,
          decimalOdd: odd,
          marketOverround: overround > 0 ? Number(overround.toFixed(4)) : undefined,
          fairImpliedProbability: overround > 0 ? Number(((1 / odd) / overround).toFixed(4)) : undefined,
          capturedAt: firstValue(response, ['scraped_at', 'updated_at', 'capturedAt']),
          normalized,
        });
      }
    }
  }
  return { source, candidates, discarded };
}

function sameLine(left?: number, right?: number) {
  return left === undefined || right === undefined ? left === right : Math.abs(left - right) <= 0.01;
}

function compatiblePeriod(wanted: CanonicalMarket, offered: CanonicalMarket) {
  if (wanted.period === 'unknown') return offered.period !== 'first_half' && offered.period !== 'second_half';
  return offered.period === 'unknown' || wanted.period === offered.period;
}

function resultSelectionMatches(wanted: string | undefined, offered: string | undefined) {
  if (!wanted || !offered) return false;
  const left = normalizeMarketText(wanted);
  const right = normalizeMarketText(offered);
  return left === right || (left.length >= 4 && right.length >= 4 && (left.includes(right) || right.includes(left)));
}

function candidateMatch(wanted: CanonicalMarket, offered: OddsCandidate) {
  const candidate = offered.normalized;
  if (!wanted.recognized) return { score: -1, stage: 'none', reason: 'mercado escolhido nao reconhecido pelo normalizador' };
  if (!candidate.recognized) return { score: -1, stage: 'none', reason: 'mercado da fonte nao reconhecido pelo normalizador' };
  if (wanted.family !== candidate.family) return { score: -1, stage: 'none', reason: `familia diferente (${candidate.family})` };
  if (!compatiblePeriod(wanted, candidate)) return { score: -1, stage: 'none', reason: `periodo diferente (${candidate.period})` };

  if (wanted.direction && wanted.direction !== candidate.direction) return { score: -1, stage: 'none', reason: `direcao diferente (${candidate.direction || 'ausente'})` };
  if (wanted.line !== undefined && !sameLine(wanted.line, candidate.line)) return { score: -1, stage: 'none', reason: `linha diferente (${candidate.line ?? 'ausente'})` };
  if (['result', 'double_chance', 'asian_handicap', 'european_handicap'].includes(wanted.family)
    && !resultSelectionMatches(wanted.selection, candidate.selection)) {
    return { score: -1, stage: 'none', reason: `selecao diferente (${candidate.selection || 'ausente'})` };
  }

  if (wanted.key === candidate.key) return { score: 100, stage: 'canonical', reason: '' };
  const similarity = marketTextSimilarity(wanted.normalized, candidate.normalized);
  if (similarity >= 0.75) return { score: 90 + similarity, stage: 'alias', reason: '' };
  if (similarity >= 0.3 || wanted.family !== 'unknown') return { score: 80 + similarity, stage: 'equivalent', reason: '' };
  return { score: -1, stage: 'none', reason: `similaridade insuficiente (${similarity.toFixed(2)})` };
}

function cleanUnavailableMeta(meta: Record<string, unknown>) {
  const clean = { ...meta };
  for (const key of ['decimal_odds', 'impliedProbability', 'fairImpliedProbability', 'marketOverround', 'oddsSource', 'bookmaker', 'oddsMarketName', 'oddsChoiceName', 'oddsMarketPeriod', 'oddsCapturedAt', 'oddsMatchedBy']) delete clean[key];
  return clean;
}

export function enrichRecommendationWithValidatedOdds(recommendation: BettingRecommendation, oddsResponses: any | any[]): BettingRecommendation {
  const responses = (Array.isArray(oddsResponses) ? oddsResponses : [oddsResponses]).filter(Boolean);
  const providerResults = responses.map(flattenProviderOdds);
  const candidates = providerResults.flatMap((result) => result.candidates);
  const wanted = normalizeMarket({ marketName: recommendation.market, recommendation: recommendation.recommendation });
  const evaluated = candidates.map((candidate) => ({ candidate, ...candidateMatch(wanted, candidate) }));
  const matches = evaluated.filter((item) => item.score >= 0)
    .sort((left, right) => right.score - left.score || right.candidate.decimalOdd - left.candidate.decimalOdd);
  const best = matches[0];
  const discarded = [
    ...providerResults.flatMap((result) => result.discarded),
    ...evaluated.filter((item) => item.score < 0).map((item) => ({
      source: item.candidate.source,
      bookmaker: item.candidate.bookmaker,
      originalMarket: item.candidate.marketName,
      originalChoice: item.candidate.choiceName,
      normalizedMarket: item.candidate.normalized.key,
      decimalOdd: item.candidate.decimalOdd,
      reason: item.reason,
    })),
  ];
  const audit = {
    status: best ? 'matched' : 'waiting_odds',
    decisionMarket: {
      originalMarket: recommendation.market,
      originalRecommendation: recommendation.recommendation,
      normalizedName: wanted.normalized,
      canonicalKey: wanted.key,
    },
    providers: providerResults.map((result) => ({
      source: result.source,
      status: result.candidates.length ? 'available' : 'unavailable',
      oddsFound: result.candidates.length,
      reason: responses.find((response) => String(response?.source || response?.provider || 'odds-provider') === result.source)?.unavailableReason,
    })),
    candidatesChecked: candidates.length,
    oddsFound: matches.slice(0, 10).map((item) => ({
      source: item.candidate.source,
      bookmaker: item.candidate.bookmaker,
      originalMarket: item.candidate.marketName,
      originalChoice: item.candidate.choiceName,
      normalizedMarket: item.candidate.normalized.key,
      decimalOdd: item.candidate.decimalOdd,
      matchStage: item.stage,
      compatibility: Number(item.score.toFixed(3)),
    })),
    oddsDiscarded: discarded.slice(0, 30),
    selected: best ? {
      source: best.candidate.source,
      bookmaker: best.candidate.bookmaker,
      originalMarket: best.candidate.marketName,
      originalChoice: best.candidate.choiceName,
      normalizedMarket: best.candidate.normalized.key,
      decimalOdd: best.candidate.decimalOdd,
      matchStage: best.stage,
    } : undefined,
    rejectionReason: best ? undefined : candidates.length
      ? 'Nenhuma odd correspondeu a familia, selecao, direcao, linha e periodo do mercado escolhido.'
      : 'As fontes consultadas nao retornaram odds decimais validas.',
  };

  if (!best) {
    return {
      ...recommendation,
      meta: {
        ...cleanUnavailableMeta(recommendation.meta || {}),
        oddsValidation: { status: 'waiting_odds', providersChecked: providerResults.map((item) => item.source), candidatesChecked: candidates.length },
        oddsAudit: audit,
      },
    };
  }

  const selected = best.candidate;
  return {
    ...recommendation,
    meta: {
      ...(recommendation.meta || {}),
      decimal_odds: selected.decimalOdd,
      impliedProbability: Number((100 / selected.decimalOdd).toFixed(2)),
      fairImpliedProbability: selected.fairImpliedProbability !== undefined ? Number((selected.fairImpliedProbability * 100).toFixed(2)) : undefined,
      marketOverround: selected.marketOverround,
      oddsSource: selected.source,
      bookmaker: selected.bookmaker,
      oddsMarketName: selected.marketName,
      oddsChoiceName: selected.choiceName,
      oddsMarketPeriod: selected.marketPeriod,
      oddsCapturedAt: selected.capturedAt,
      oddsMatchedBy: best.stage,
      oddsValidation: { status: 'matched', candidatesChecked: candidates.length, matchStage: best.stage },
      oddsAudit: audit,
    },
  };
}

export function enrichAnalysisWithValidatedOdds(result: AnalysisResult, oddsResponses: any | any[]): AnalysisResult {
  const recommendations = (result.recommendations || []).map((recommendation) => enrichRecommendationWithValidatedOdds(recommendation, oddsResponses));
  const bestEntry = result.bestEntry ? enrichRecommendationWithValidatedOdds(result.bestEntry, oddsResponses) : recommendations[0];
  return { ...result, recommendations, bestEntry };
}
