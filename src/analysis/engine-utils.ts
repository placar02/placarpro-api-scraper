export function normalizeEngineText(value: unknown) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

export function finiteNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || String(value).trim() === '') return undefined;
  const parsed = Number(String(value).replace(',', '.').replace(/[^\d.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function clampScore(value: number, min = 0, max = 100) {
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function averageNumbers(values: Array<number | undefined>) {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length ? present.reduce((total, value) => total + value, 0) / present.length : undefined;
}

export function allTeamStatItems(input: any): any[] {
  return (input?.statistics?.teamPeriods || [])
    .flatMap((period: any) => period?.groups || [])
    .flatMap((group: any) => group?.items || []);
}

export function matchingTeamStats(input: any, pattern: RegExp) {
  return allTeamStatItems(input).filter((item: any) => pattern.test(normalizeEngineText(`${item?.name} ${item?.key}`)));
}

export function hasNumericPair(items: any[]) {
  return items.some((item) => finiteNumber(item?.home) !== undefined && finiteNumber(item?.away) !== undefined);
}
