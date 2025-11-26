export interface StreakItem {
  name: string;
  value: string;
  team: 'home' | 'away' | 'both';
}

export interface StreaksResponse {
  general: StreakItem[];
  head2head: StreakItem[];
}

export interface NormalizedStreaksResponse {
  eventId: string;
  general: StreakItem[];
  head2head: StreakItem[];
  lastUpdated: number;
}

export interface FetchStreaksResult {
  status: number;
  data?: NormalizedStreaksResponse;
  error?: string;
}
