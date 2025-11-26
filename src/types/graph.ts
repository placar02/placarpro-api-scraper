export interface GraphPoint {
  minute: number;
  value: number;
}

export interface GraphApiResponse {
  graphPoints: GraphPoint[];
  periodTime: number;
  overtimeLength?: number;
  periodCount: number;
}

export interface NormalizedGraphPoint {
  minute: number;
  value: number;
  period: number;
  timeInPeriod: number;
}

export interface GraphData {
  eventId: number;
  points: NormalizedGraphPoint[];
  periodTime: number;
  overtimeLength?: number;
  periodCount: number;
  summary: {
    totalMinutes: number;
    minValue: number;
    maxValue: number;
    averageValue: number;
  };
}
