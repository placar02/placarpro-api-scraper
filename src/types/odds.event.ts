export interface RawOddsChoice {
  initialFractionalValue: string;
  fractionalValue: string;
  name: string;
  winning?: boolean;
  slipContent?: string;
  change?: number;
}

export interface RawOddsMarket {
  structureType: number;
  marketId: number;
  marketName: string;
  choiceGroup?: string;
  isLive: boolean;
  suspended: boolean;
  id: number;
  marketGroup: string;
  marketPeriod: string;
  choices: RawOddsChoice[];
}

export interface RawOddsResponse {
  markets: RawOddsMarket[];
  eventId: number;
}

export interface OddsChoice {
  name: string;
  decimal_odds: number;
  initial_decimal_odds: number;
  fractional_odds: string;
  winning?: boolean;
  change?: number;
  slip_content?: string;
}

export interface OddsMarket {
  market_id: number;
  market_name: string;
  market_group: string;
  market_period: string;
  choice_group?: string;
  is_live: boolean;
  suspended: boolean;
  choices: OddsChoice[];
}

export interface OrganizedOddsResponse {
  event_id: number;
  markets_by_group: {
    [marketGroup: string]: {
      group_info: {
        market_group: string;
        market_period: string;
        total_markets: number;
        total_choices?: number;
        market_ids?: number[];
      };
      markets: OddsMarket[];
    };
  };
  summary: {
    total_markets: number;
    market_groups: string[];
    is_live: boolean;
    has_suspended_markets: boolean;
  };
  scraped_at: string;
}