import { chromium, type Browser, type Page } from 'playwright';
import {
  OGOL_HEADLESS,
  OGOL_PROXY_PASSWORD,
  OGOL_PROXY_URL,
  OGOL_PROXY_USERNAME,
  OGOL_REQUEST_TIMEOUT_MS,
  OGOL_USER_AGENT,
} from './config';

export async function withOgolPage<T>(handler: (page: Page) => Promise<T>): Promise<T> {
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({
      headless: OGOL_HEADLESS,
      proxy: OGOL_PROXY_URL
        ? {
          server: OGOL_PROXY_URL,
          username: OGOL_PROXY_USERNAME || undefined,
          password: OGOL_PROXY_PASSWORD || undefined,
        }
        : undefined,
    });
    const context = await browser.newContext({
      userAgent: OGOL_USER_AGENT,
      locale: 'pt-BR',
      timezoneId: process.env.MATCHES_TIMEZONE || 'America/Sao_Paulo',
      viewport: { width: 1365, height: 900 },
      extraHTTPHeaders: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
      },
    });
    const page = await context.newPage();
    return await handler(page);
  } finally {
    if (browser) await browser.close();
  }
}

export async function loadOgolPage(page: Page, url: string) {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: OGOL_REQUEST_TIMEOUT_MS });
  if (!response?.ok()) throw new Error(`OGOL HTTP ${response?.status() || 'no-response'} for ${url}`);
  await page.waitForTimeout(500);
  const bodyText = await page.locator('body').innerText().catch(() => '');
  if (/sorry, you have been blocked|unable to access ogol/i.test(bodyText)) {
    throw new Error(`OGOL blocked the automated request for ${url}`);
  }
  return response;
}
