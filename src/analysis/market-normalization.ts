export type CanonicalMarketFamily =
  | 'result'
  | 'double_chance'
  | 'btts'
  | 'goals'
  | 'corners'
  | 'cards'
  | 'asian_handicap'
  | 'european_handicap'
  | 'shots_on_target'
  | 'unknown';

export type CanonicalMarket = {
  original: string;
  normalized: string;
  key: string;
  family: CanonicalMarketFamily;
  direction?: 'over' | 'under' | 'yes' | 'no';
  line?: number;
  selection?: string;
  period: 'fulltime' | 'first_half' | 'second_half' | 'unknown';
  recognized: boolean;
};

const ALIASES: Array<[RegExp, string]> = [
  [/\b(?:mais\s+de|acima\s+de|more\s+than)\b/g, 'over'],
  [/\b(?:menos\s+de|abaixo\s+de|less\s+than)\b/g, 'under'],
  [/\b(?:total\s+goals?|goals?\s+total|total\s+de\s+gols?|gols?\s+totais?)\b/g, 'goals'],
  [/\bambas\s+(?:as\s+)?equipes\s+nao\s+marcam\b|\bambas\s+nao\s+marcam\b|\bboth\s+teams\s+to\s+score\s+no\b/g, 'btts no'],
  [/\bambas\s+(?:as\s+)?equipes\s+marcam\b|\bambas\s+marcam\b|\bboth\s+teams\s+to\s+score\b/g, 'btts'],
  [/\b(?:resultado\s+final|match\s+winner|final\s+result|moneyline)\b/g, 'result'],
  [/\b(?:dupla\s+chance|double\s+chance)\b/g, 'double chance'],
  [/\b(?:escanteios?|pontapes?\s+de\s+canto)\b/g, 'corners'],
  [/\b(?:cartoes?|yellow\s+cards?|red\s+cards?)\b/g, 'cards'],
  [/\b(?:handicap\s+asiatico|asian\s+handicap)\b/g, 'asian handicap'],
  [/\b(?:handicap\s+europeu|european\s+handicap|3\s*way\s+handicap)\b/g, 'european handicap'],
  [/\b(?:chutes?\s+no\s+gol|finalizacoes?\s+no\s+alvo|remates?\s+a\s+baliza|shots?\s+on\s+target)\b/g, 'shots on target'],
  [/\b(?:sim|yes)\b/g, 'yes'],
  [/\b(?:nao|no)\b/g, 'no'],
  [/\b(?:empate|draw)\b/g, 'draw'],
  [/\b(?:casa|home)\b/g, 'home'],
  [/\b(?:fora|away)\b/g, 'away'],
];

export function normalizeMarketText(value: unknown) {
  let text = String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/(\d),(\d)/g, '$1.$2')
    .replace(/([a-z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([a-z])/g, '$1 $2');

  for (const [pattern, replacement] of ALIASES) text = text.replace(pattern, replacement);
  return text.replace(/[^a-z0-9.+-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function getPeriod(text: string): CanonicalMarket['period'] {
  if (/\b(?:1st|first|primeiro)\s+(?:half|tempo)\b|\b1h\b/.test(text)) return 'first_half';
  if (/\b(?:2nd|second|segundo)\s+(?:half|tempo)\b|\b2h\b/.test(text)) return 'second_half';
  if (/\bfull\s*time\b|\btempo\s+regulamentar\b|\bft\b/.test(text)) return 'fulltime';
  return 'unknown';
}

function getLine(text: string) {
  const values = [...text.matchAll(/(?:^|\s)([+-]?\d+(?:\.\d+)?)(?=\s|$)/g)]
    .map((match) => Number(match[1]))
    .filter(Number.isFinite);
  return values.length ? values[values.length - 1] : undefined;
}

function cleanSelection(value: string) {
  return value
    .replace(/\b(?:vence|vencedor|winner|result|resultado|final|1x2|moneyline|odds?)\b/g, ' ')
    .replace(/\b(?:full time|ft|tempo regulamentar)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function lineKey(line: number | undefined) {
  return line === undefined ? 'UNSPECIFIED' : String(Math.abs(line)).replace('.', '_');
}

function signedLineKey(line: number | undefined) {
  if (line === undefined) return 'UNSPECIFIED';
  const prefix = line < 0 ? 'MINUS' : line > 0 ? 'PLUS' : 'ZERO';
  return `${prefix}_${lineKey(line)}`;
}

export function normalizeMarket(input: {
  marketName?: unknown;
  choiceName?: unknown;
  choiceGroup?: unknown;
  recommendation?: unknown;
  marketPeriod?: unknown;
}): CanonicalMarket {
  const original = [input.marketName, input.choiceGroup, input.choiceName, input.recommendation, input.marketPeriod]
    .filter(Boolean).join(' ');
  const market = normalizeMarketText(input.marketName);
  const choice = normalizeMarketText(input.choiceName ?? input.recommendation);
  const group = normalizeMarketText(input.choiceGroup);
  const periodText = normalizeMarketText(input.marketPeriod);
  const text = `${market} ${group} ${choice}`.trim();
  const period = getPeriod(`${text} ${periodText}`);
  const line = getLine(`${choice} ${group} ${market}`);
  let direction: CanonicalMarket['direction'] = /\bover\b/.test(text) ? 'over'
    : /\bunder\b/.test(text) ? 'under'
      : /\bbtts\b/.test(text) && /\bno\b/.test(choice) ? 'no'
        : /\bbtts\b/.test(text) ? 'yes'
          : undefined;

  let family: CanonicalMarketFamily = 'unknown';
  if (/\bshots on target\b/.test(text)) family = 'shots_on_target';
  else if (/\basian handicap\b/.test(text)) family = 'asian_handicap';
  else if (/\beuropean handicap\b/.test(text)) family = 'european_handicap';
  else if (/\bdouble chance\b|\b(?:1x|x2|12)\b/.test(text)) family = 'double_chance';
  else if (/\bbtts\b/.test(text)) family = 'btts';
  else if (/\bcorners?\b/.test(text)) family = 'corners';
  else if (/\bcards?\b/.test(text)) family = 'cards';
  else if (/\bgoals?\b|\bover\b|\bunder\b/.test(text)) family = 'goals';
  else if (/\bresult\b|\b1\s*x\s*2\b|\bwinner\b|\bmoneyline\b/.test(text)) family = 'result';
  if (!direction && family === 'goals' && /(?:^|\s)\+\d/.test(text)) direction = 'over';

  let selection: string | undefined;
  let key = 'UNKNOWN';
  if (family === 'goals' && (direction === 'over' || direction === 'under')) key = `${direction.toUpperCase()}_${lineKey(line)}`;
  else if (family === 'btts') key = `BTTS_${(direction || 'yes').toUpperCase()}`;
  else if (family === 'corners' && direction) key = `CORNERS_${direction.toUpperCase()}_${lineKey(line)}`;
  else if (family === 'cards' && direction) key = `CARDS_${direction.toUpperCase()}_${lineKey(line)}`;
  else if (family === 'shots_on_target' && direction) key = `SHOTS_ON_TARGET_${direction.toUpperCase()}_${lineKey(line)}`;
  else if (family === 'double_chance') {
    const compactChoice = choice.replace(/\s+/g, '');
    const compactText = text.replace(/\s+/g, '');
    selection = (compactChoice.match(/(?:1x|x2|12)/) || compactText.match(/(?:1x|x2|12)/))?.[0]?.toUpperCase();
    key = `DOUBLE_CHANCE_${selection || 'UNSPECIFIED'}`;
  } else if (family === 'result') {
    selection = /\bdraw\b/.test(choice) ? 'draw'
      : /^(?:1|home)$/.test(choice) ? 'home'
        : /^(?:2|away)$/.test(choice) ? 'away'
          : cleanSelection(choice);
    key = `RESULT_${normalizeMarketText(selection).replace(/\s+/g, '_').toUpperCase() || 'UNSPECIFIED'}`;
  } else if (family === 'asian_handicap' || family === 'european_handicap') {
    selection = cleanSelection(choice.replace(/[+-]?\d+(?:\.\d+)?/g, ''));
    key = `${family.toUpperCase()}_${normalizeMarketText(selection).replace(/\s+/g, '_').toUpperCase() || 'UNSPECIFIED'}_${signedLineKey(line)}`;
  }

  return { original, normalized: text, key, family, direction, line, selection, period, recognized: key !== 'UNKNOWN' };
}

export function marketTextSimilarity(left: string, right: string) {
  const a = new Set(normalizeMarketText(left).split(' ').filter((token) => token.length > 1));
  const b = new Set(normalizeMarketText(right).split(' ').filter((token) => token.length > 1));
  if (!a.size || !b.size) return 0;
  const intersection = [...a].filter((token) => b.has(token)).length;
  return (2 * intersection) / (a.size + b.size);
}
