import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
});
await page.goto('https://www.aiscore.com/football', {
  waitUntil: 'domcontentloaded',
  timeout: 60000,
});
await page.waitForTimeout(5000);

const scripts = await page.$$eval('script[src]', (items) => items
  .map((item) => item.src)
  .filter((src) => src.includes('/_nuxt/') && src.endsWith('.js')));
const endpoints = new Set();
const scriptSummaries = [];

await browser.close();

for (const scriptUrl of scripts) {
  const text = await (await fetch(scriptUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  })).text();
  const decoderHits = [...text.matchAll(/protobuf|decode|Reader|uint32|match\/stats|today\/matches|match\/data/gi)].length;
  if (decoderHits) {
    scriptSummaries.push({ scriptUrl, decoderHits, length: text.length });
  }

  for (const match of text.matchAll(/(?:\/v1\/web\/api\/|https:\/\/api\.aiscore\.com\/v1\/web\/api\/)[A-Za-z0-9_?&=./${}:,\-]+/g)) {
    endpoints.add(match[0]);
  }

  for (const match of text.matchAll(/["'](\/[A-Za-z0-9_\-/]*?(?:match|matches|odds|lineup|lineups|stat|stats|detail|standing|team|player)[A-Za-z0-9_\-/]*?)["']/gi)) {
    endpoints.add(match[1]);
  }
}

console.log(`scripts=${scripts.length}`);
console.log('decoderScripts=');
for (const item of scriptSummaries) {
  console.log(`${item.decoderHits}\t${item.length}\t${item.scriptUrl}`);
}
console.log([...endpoints].sort().join('\n'));
