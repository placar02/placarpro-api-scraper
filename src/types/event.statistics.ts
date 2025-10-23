interface RawStatisticsItem {
  name: string;
  home: string;
  away: string;
  compareCode: number;
  statisticsType: "positive" | "negative";
  valueType: "event" | "team";
  homeValue: number;
  awayValue: number;
  homeTotal?: number;
  awayTotal?: number;
  renderType: number;
  key: string;
}

interface RawStatisticsGroup {
  groupName: string;
  statisticsItems: RawStatisticsItem[];
}

interface RawStatisticsPeriod {
  period: string; // "ALL" | "1ST" | "2ND" | ...
  groups: RawStatisticsGroup[];
}

export interface RawStatisticsResponse {
  statistics: RawStatisticsPeriod[];
}

export interface StatSideValue {
  label: string;      // Ex.: "79%" ou "14/28 (50%)"
  value?: number;     // Ex.: 79
  total?: number;     // Ex.: 28 (quando valueType = "team")
}

export interface StatItem {
  key: string;
  name: string;
  compare_code: number;
  statistics_type: "positive" | "negative";
  value_type: "event" | "team";
  render_type: number;
  home: StatSideValue;
  away: StatSideValue;
}

export interface StatGroup {
  group_name: string;
  items: StatItem[];
  total_items: number;
}

export interface PeriodStatistics {
  period: string;
  groups_by_name: { [groupName: string]: StatGroup };
  group_order: string[];
  total_groups: number;
  total_items: number;
}

export interface OrganizedStatisticsResponse {
  event_id: number;
  by_period: { [period: string]: PeriodStatistics };
  summary: {
    periods: string[];
    total_groups: number;
    total_items: number;
  };
  scraped_at: string;
}