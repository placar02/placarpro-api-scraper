import path from 'node:path';

export const OGOL_BASE_URL = (process.env.OGOL_BASE_URL || 'https://www.ogol.com.br').replace(/\/+$/, '');
export const OGOL_AGENDA_URL = process.env.OGOL_AGENDA_URL || `${OGOL_BASE_URL}/agenda.php`;
export const OGOL_REQUEST_TIMEOUT_MS = Number(process.env.OGOL_REQUEST_TIMEOUT_MS || 30000);
export const OGOL_CACHE_TTL_MS = Number(process.env.OGOL_CACHE_TTL_MS || 10 * 60 * 1000);
export const OGOL_MATCH_LIMIT = Number(process.env.OGOL_MATCH_LIMIT || 30);
export const OGOL_EVENT_LOOKAHEAD_DAYS = Math.max(1, Number(process.env.OGOL_EVENT_LOOKAHEAD_DAYS || 7));
export const OGOL_DISK_CACHE_PATH = process.env.OGOL_DISK_CACHE_PATH || path.join('C:\\tmp', 'placarpro-ogol-matches.json');
export const OGOL_DEEP_DISK_CACHE_DIR = process.env.OGOL_DEEP_DISK_CACHE_DIR || path.join('C:\\tmp', 'placarpro-ogol-rich');
export const OGOL_DEEP_CACHE_TTL_MS = Number(process.env.OGOL_DEEP_CACHE_TTL_MS || 30 * 60 * 1000);
export const OGOL_PROXY_URL = process.env.OGOL_PROXY_URL || '';
export const OGOL_PROXY_USERNAME = process.env.OGOL_PROXY_USERNAME || '';
export const OGOL_PROXY_PASSWORD = process.env.OGOL_PROXY_PASSWORD || '';
export const OGOL_HEADLESS = process.env.OGOL_HEADLESS !== 'false';
export const OGOL_DEEP_ENRICHMENT = process.env.OGOL_DEEP_ENRICHMENT !== 'false';
export const OGOL_DEEP_PLAYER_LIMIT = Math.max(0, Number(process.env.OGOL_DEEP_PLAYER_LIMIT || 22));
export const OGOL_DEEP_PAGE_LIMIT = Math.max(8, Number(process.env.OGOL_DEEP_PAGE_LIMIT || 50));
export const OGOL_DEEP_CONCURRENCY = Math.max(1, Number(process.env.OGOL_DEEP_CONCURRENCY || process.env.OGOL_ANALYSIS_CONCURRENCY || 1));
export const OGOL_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export function absoluteOgolUrl(href: string) {
  try {
    return new URL(href, OGOL_BASE_URL).toString();
  } catch {
    return href;
  }
}
