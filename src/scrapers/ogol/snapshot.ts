import type { Page } from 'playwright';

export type OgolPageLink = {
  text: string;
  href: string;
  context?: string;
  section?: string;
};

export type OgolPageTable = {
  index: number;
  caption?: string;
  section?: string;
  headers: string[];
  rows: string[][];
  text: string;
};

export type OgolPageSnapshot = {
  url: string;
  title: string;
  pageType: string;
  text: string;
  textLines: string[];
  headings: string[];
  sections: Record<string, string>;
  links: OgolPageLink[];
  tables: OgolPageTable[];
  keyValues: Array<{ label: string; value: string; section?: string }>;
  statisticBlocks: Array<{ label?: string; values: string[]; text: string; section?: string }>;
  eventBlocks: Array<{ text: string; section?: string }>;
  playerBlocks: Array<{ name?: string; href?: string; text: string; section?: string; attributes: Record<string, string> }>;
  metadata: Record<string, string>;
};

export async function snapshotOgolPage(page: Page, pageType: string): Promise<OgolPageSnapshot> {
  await page.evaluate('globalThis.__name = globalThis.__name || ((target) => target)');
  return page.evaluate((type) => {
    const clean = (value: string | null | undefined) => String(value || '').replace(/\s+/g, ' ').trim();
    const sectionName = (element: Element) => {
      const container = element.closest('section,article,[class*="box"],[class*="card"],main,div');
      const heading = container?.querySelector('h1,h2,h3,h4,[class*="title"]');
      return clean(heading?.textContent).slice(0, 120) || undefined;
    };
    const unique = <T>(items: T[], key: (item: T) => string) => [...new Map(items.map((item) => [key(item), item])).values()];
    const headings = [...document.querySelectorAll('h1,h2,h3,h4')].map((item) => clean(item.textContent)).filter(Boolean);
    const sections: Record<string, string> = {};
    for (const heading of document.querySelectorAll('h1,h2,h3,h4')) {
      const name = clean(heading.textContent);
      const container = heading.closest('section,article,[class*="box"],[class*="card"],div');
      const text = clean(container?.textContent);
      if (name && text && text.length <= 10000 && (!sections[name] || text.length > sections[name].length)) sections[name] = text;
    }

    const links = unique(
      [...document.querySelectorAll<HTMLAnchorElement>('a[href]')]
        .map((anchor) => ({
          text: clean(anchor.textContent),
          href: anchor.href,
          context: clean(anchor.closest('tr,li,article,section,[class*="player"],[class*="match"],div')?.textContent).slice(0, 800),
          section: sectionName(anchor),
        }))
        .filter((item) => item.href),
      (item) => `${item.href}|${item.text}`,
    ).slice(0, 1200);

    const tables = [...document.querySelectorAll('table')].map((table, index) => ({
      index,
      caption: clean(table.querySelector('caption')?.textContent) || undefined,
      section: sectionName(table),
      headers: [...table.querySelectorAll('thead th')].map((cell) => clean(cell.textContent)).filter(Boolean),
      rows: [...table.querySelectorAll('tr')]
        .map((row) => [...row.querySelectorAll(':scope > th,:scope > td')].map((cell) => clean(cell.textContent)).filter(Boolean))
        .filter((row) => row.length),
      text: clean(table.textContent).slice(0, 12000),
    })).filter((table) => table.rows.length || table.text);

    const keyValues = unique([
      ...[...document.querySelectorAll('dl')].flatMap((list) => {
        const terms = [...list.querySelectorAll(':scope > dt')];
        return terms.map((term) => ({
          label: clean(term.textContent),
          value: clean(term.nextElementSibling?.textContent),
          section: sectionName(list),
        }));
      }),
      ...tables.flatMap((table) => table.rows
        .filter((row) => row.length === 2 && row[0] !== row[1])
        .map((row) => ({ label: row[0], value: row[1], section: table.section }))),
      ...[...document.querySelectorAll('[class*="info"] li,[class*="detail"] li')].map((item) => {
        const text = clean(item.textContent);
        const parts = text.split(/:\s*/);
        return { label: clean(parts[0]), value: clean(parts.slice(1).join(': ')), section: sectionName(item) };
      }).filter((item) => item.label && item.value),
    ], (item) => `${item.section}|${item.label}|${item.value}`).slice(0, 800);

    const statisticBlocks = unique(
      [...document.querySelectorAll('[data-stat],[class*="stat"],[class*="percent"],table')]
        .map((element) => {
          const text = clean(element.textContent);
          const values = text.match(/-?\d+(?:[.,]\d+)?%?/g) || [];
          const label = clean(element.querySelector('[class*="label"],[class*="name"],th')?.textContent);
          return { label: label || undefined, values, text: text.slice(0, 1500), section: sectionName(element) };
        })
        .filter((item) => item.text && item.values.length),
      (item) => `${item.section}|${item.label}|${item.text}`,
    ).slice(0, 500);

    const eventBlocks = unique(
      [...document.querySelectorAll('[class*="event"],[class*="incident"],[class*="timeline"],[class*="goal"],[class*="card"],[class*="substitution"]')]
        .map((element) => ({ text: clean(element.textContent).slice(0, 1000), section: sectionName(element) }))
        .filter((item) => item.text && /\d+['´]?|gol|cart|substit|intervalo|fim/i.test(item.text)),
      (item) => `${item.section}|${item.text}`,
    ).slice(0, 300);

    const playerBlocks = unique(
      [...document.querySelectorAll('[class*="player"],[class*="jogador"],.campo_onze_bloco_jogador')]
        .map((element) => {
          const anchor = element.querySelector<HTMLAnchorElement>('a[href*="/jogador/"]');
          const attributes = Object.fromEntries([...element.attributes]
            .filter((attribute) => attribute.name.startsWith('data-'))
            .map((attribute) => [attribute.name, attribute.value]));
          return {
            name: clean(anchor?.textContent) || undefined,
            href: anchor?.href,
            text: clean(element.textContent).slice(0, 1500),
            section: sectionName(element),
            attributes,
          };
        })
        .filter((item) => item.text),
      (item) => `${item.href}|${item.text}`,
    ).slice(0, 500);

    const metadata = Object.fromEntries(
      [...document.querySelectorAll<HTMLMetaElement>('meta[name],meta[property]')]
        .map((meta) => [meta.name || meta.getAttribute('property') || '', meta.content])
        .filter(([key, value]) => key && value),
    );

    const textLines = document.body.innerText.split(/\r?\n/).map((line) => clean(line)).filter(Boolean);
    return {
      url: window.location.href,
      title: document.title,
      pageType: type,
      text: textLines.join(' ').slice(0, 80000),
      textLines: textLines.slice(0, 10000),
      headings: headings.slice(0, 300),
      sections,
      links,
      tables,
      keyValues,
      statisticBlocks,
      eventBlocks,
      playerBlocks,
      metadata,
    };
  }, pageType);
}
