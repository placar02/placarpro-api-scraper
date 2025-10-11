import { chromium, Browser } from "playwright";
import { RawOddsResponse, OrganizedOddsResponse, OddsMarket, RawOddsChoice, type OddsChoice } from "../types/odds.event";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36";
const API_URL = (process.env.SOFASCORE_BASE_URL || "https://api.sofascore.com/api/v1") + "/event/{eventId}/odds/{marketId}/all";

export async function fetchOdds(eventId: number | string, marketId: number): Promise<OrganizedOddsResponse | null> {
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

    const url = API_URL.replace("{eventId}", eventId.toString()).replace("{marketId}", marketId.toString());
    let response = await page.goto(url, { waitUntil: 'domcontentloaded' });

    if (response && response.status() === 403) {
      await page.waitForTimeout(250);
      response = await page.goto(url, { waitUntil: 'domcontentloaded' });
    }

    if (!response || response.status() !== 200) {
      throw new Error(`Failed to fetch odds data. Status: ${response?.status()}`);
    }

    const data = (await response.json()) as RawOddsResponse;
    const organizedData = organizeOddsData(data);
    return organizedData;
  } catch (error) {
    console.error("Error fetching odds:", error);
    return null;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

export function organizeOddsData(rawOdds: RawOddsResponse): OrganizedOddsResponse {
  const marketsByGroup: { [key: string]: OddsMarket[] } = {};
  let isLive = false;
  let hasSuspended = false;

  for (const rawMarket of rawOdds.markets) {
    const market: OddsMarket = {
      market_id: rawMarket.marketId,
      market_name: rawMarket.marketName,
      market_group: rawMarket.marketGroup,
      market_period: rawMarket.marketPeriod,
      choice_group: rawMarket.choiceGroup,
      is_live: rawMarket.isLive,
      suspended: rawMarket.suspended,
      choices: rawMarket.choices.map((choice): OddsChoice => ({
        name: choice.name,
        decimal_odds: fractionalToDecimal(choice.fractionalValue),
        initial_decimal_odds: fractionalToDecimal(choice.initialFractionalValue),
        fractional_odds: choice.fractionalValue,
        winning: choice.winning,
        change: choice.change,
        slip_content: choice.slipContent,
      })),
    };

    if (market.is_live) isLive = true;
    if (market.suspended) hasSuspended = true;

    if (!marketsByGroup[rawMarket.marketGroup]) {
      marketsByGroup[rawMarket.marketGroup] = [];
    }
    marketsByGroup[rawMarket.marketGroup].push(market);
  }

  const organizedResponse: OrganizedOddsResponse = {
    event_id: rawOdds.eventId,
    markets_by_group: {},
    summary: {
      total_markets: rawOdds.markets.length,
      market_groups: Object.keys(marketsByGroup),
      is_live: isLive,
      has_suspended_markets: hasSuspended,
    },
    scraped_at: new Date().toISOString(),
  };

  for (const [groupName, markets] of Object.entries(marketsByGroup)) {
    markets.sort((a, b) => {
      if (a.market_id !== b.market_id) {
        return a.market_id - b.market_id;
      }
      // If same market_id, sort by choice_group (for over/under lines)
      if (a.choice_group && b.choice_group) {
        // Ordenar numericamente para linhas como 0.5, 1.5, 2.5, etc.
        const aValue = parseFloat(a.choice_group);
        const bValue = parseFloat(b.choice_group);
        if (!isNaN(aValue) && !isNaN(bValue)) {
          return aValue - bValue;
        }
        return a.choice_group.localeCompare(b.choice_group);
      }
      return 0;
    });

    // Contar total de opções de apostas neste grupo
    const totalChoices = markets.reduce((sum, market) => sum + (market.choices?.length || 0), 0);

    organizedResponse.markets_by_group[groupName] = {
      group_info: {
        market_group: groupName,
        market_period: markets[0]?.market_period || 'Full-time',
        total_markets: markets.length,
        total_choices: totalChoices,
        market_ids: [...new Set(markets.map(m => m.market_id))], // IDs únicos dos mercados
      },
      markets,
    };
  }

  return organizedResponse;
}

function fractionalToDecimal(fractional: string): number {
  try {
    const [numerator, denominator] = fractional.split('/').map(Number);
    if (isNaN(numerator) || isNaN(denominator) || denominator === 0) {
      return 1.00;
    }
    const decimal = (numerator / denominator) + 1;
    return Math.round(decimal * 100) / 100;
  } catch {
    return 1.00;
  }
}