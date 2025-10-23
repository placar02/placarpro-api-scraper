import { chromium, Browser } from "playwright";
import type { OrganizedStatisticsResponse, PeriodStatistics, RawStatisticsResponse, StatGroup, StatItem } from "../types/event.statistics";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36";
const API_URL = (process.env.SOFASCORE_BASE_URL || "https://www.sofascore.com/api/v1") + "/event/{eventId}/statistics";
// https://www.sofascore.com/api/v1/event/14250690/statistics


export async function fetchStatistics(eventId: number | string): Promise<OrganizedStatisticsResponse | null> {
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch();
    const context = await browser.newContext({
      userAgent: UA,
      extraHTTPHeaders: {
        'Origin': 'http://sofascore.com',
        'Referer': 'http://sofascore.com/',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    const page = await context.newPage();

    const url = API_URL.replace("{eventId}", eventId.toString());
    let response = await page.goto(url, { waitUntil: 'domcontentloaded' });

    if (response && response.status() === 403) {
      await page.waitForTimeout(250);
      response = await page.goto(url, { waitUntil: 'domcontentloaded' });
    }

    if (!response || response.status() !== 200) {
      throw new Error(`Failed to fetch statistics. Status: ${response?.status()}`);
    }

    const raw = (await response.json()) as RawStatisticsResponse;
    const organized = organizeStatisticsData(raw, Number(eventId));
    return organized;
  } catch (error) {
    console.error("Error fetching statistics:", error);
    return null;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

export function organizeStatisticsData(raw: RawStatisticsResponse, eventId: number): OrganizedStatisticsResponse {
  const byPeriod: OrganizedStatisticsResponse["by_period"] = {};
  let globalGroups = 0;
  let globalItems = 0;

  for (const period of raw.statistics ?? []) {
    const groupsByName: PeriodStatistics["groups_by_name"] = {};
    const groupOrder: string[] = [];
    let periodItems = 0;

    for (const group of period.groups ?? []) {
      const items: StatItem[] = (group.statisticsItems ?? []).map((it) => ({
        key: it.key,
        name: it.name,
        compare_code: it.compareCode,
        statistics_type: it.statisticsType,
        value_type: it.valueType,
        render_type: it.renderType,
        home: {
          label: it.home,
          value: it.homeValue,
          total: it.valueType === "team" ? it.homeTotal : undefined,
        },
        away: {
          label: it.away,
          value: it.awayValue,
          total: it.valueType === "team" ? it.awayTotal : undefined,
        },
      }));

      const statGroup: StatGroup = {
        group_name: group.groupName,
        items,
        total_items: items.length,
      };

      groupsByName[group.groupName] = statGroup;
      groupOrder.push(group.groupName);

      periodItems += items.length;
      globalItems += items.length;
      globalGroups += 1;
    }

    byPeriod[period.period] = {
      period: period.period,
      groups_by_name: groupsByName,
      group_order: groupOrder,
      total_groups: groupOrder.length,
      total_items: periodItems,
    };
  }

  return {
    event_id: eventId,
    by_period: byPeriod,
    summary: {
      periods: Object.keys(byPeriod),
      total_groups: globalGroups,
      total_items: globalItems,
    },
    scraped_at: new Date().toISOString(),
  };
}