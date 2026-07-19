import type { NormalizedEvent } from '../types/event';
import type { EventLive } from '../types/event.live';

export const DEFAULT_MATCH_WINDOW_SECONDS = 4 * 60 * 60;

export function normalizeEntityName(value: unknown) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(fc|sc|cf|ac|club|clube|football|soccer|the)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function entityTokenScore(leftValue: unknown, rightValue: unknown) {
  const left = normalizeEntityName(leftValue);
  const right = normalizeEntityName(rightValue);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return 0.88;
  const leftTokens = new Set(left.split(' ').filter((token) => token.length > 1));
  const rightTokens = new Set(right.split(' ').filter((token) => token.length > 1));
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union ? intersection / union : 0;
}

export function eventDateCandidates(event: NormalizedEvent) {
  const timestamp = Number((event as any).startTimestamp ?? event.startTime);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return [new Date().toISOString().slice(0, 10)];
  const baseMs = timestamp * 1000;
  return [...new Set([
    new Date(baseMs).toISOString().slice(0, 10),
    new Date(baseMs - 86400000).toISOString().slice(0, 10),
    new Date(baseMs + 86400000).toISOString().slice(0, 10),
  ])];
}

export function scoreProviderCandidate(
  event: NormalizedEvent,
  candidate: EventLive,
  maxTimeDeltaSeconds = DEFAULT_MATCH_WINDOW_SECONDS,
) {
  const home = entityTokenScore(event.homeTeam?.name || event.homeTeam?.shortName, candidate.homeTeam?.name || candidate.homeTeam?.shortName);
  const away = entityTokenScore(event.awayTeam?.name || event.awayTeam?.shortName, candidate.awayTeam?.name || candidate.awayTeam?.shortName);
  const swappedHome = entityTokenScore(event.homeTeam?.name || event.homeTeam?.shortName, candidate.awayTeam?.name || candidate.awayTeam?.shortName);
  const swappedAway = entityTokenScore(event.awayTeam?.name || event.awayTeam?.shortName, candidate.homeTeam?.name || candidate.homeTeam?.shortName);
  const directScore = (home + away) / 2;
  const swappedScore = (swappedHome + swappedAway) / 2;
  const teamsScore = Math.max(directScore, swappedScore);
  const eventTimestamp = Number((event as any).startTimestamp ?? event.startTime);
  const candidateTimestamp = Number(candidate.startTimestamp);
  const timeDeltaSeconds = Number.isFinite(eventTimestamp) && Number.isFinite(candidateTimestamp)
    ? Math.abs(eventTimestamp - candidateTimestamp)
    : maxTimeDeltaSeconds;
  const timeScore = Math.max(0, 1 - (timeDeltaSeconds / maxTimeDeltaSeconds));
  return {
    score: Number(((teamsScore * 0.84) + (timeScore * 0.16)).toFixed(4)),
    teamsScore: Number(teamsScore.toFixed(4)),
    timeScore: Number(timeScore.toFixed(4)),
    timeDeltaSeconds,
    swapped: swappedScore > directScore,
  };
}
