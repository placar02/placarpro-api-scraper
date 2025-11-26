import type { GraphApiResponse, GraphData, NormalizedGraphPoint } from '../types/graph';

const SOFASCORE_BASE_URL = process.env.SOFASCORE_BASE_URL || 'https://www.sofascore.com/api/v1';

interface FetchGraphOptions {
  retryOn403?: boolean;
}

interface GraphResponse {
  status: number;
  data?: GraphData;
  raw?: GraphApiResponse;
}

export async function fetchGraph(
  eventId: number | string,
  options: FetchGraphOptions = {}
): Promise<GraphResponse> {
  const { retryOn403 = true } = options;

  const url = `${SOFASCORE_BASE_URL}/event/${eventId}/graph`;

  try {
    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    };

    const response = await fetch(url, { headers });

    if (response.status === 403 && retryOn403) {
      console.warn(`Received 403 for graph. Retrying...`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return fetchGraph(eventId, { ...options, retryOn403: false });
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data: GraphApiResponse = await response.json();

    // Normalize graph points with period information
    const normalizedPoints: NormalizedGraphPoint[] = data.graphPoints.map((point) => {
      // Calculate which period this minute belongs to
      const period = Math.ceil(point.minute / data.periodTime);
      const timeInPeriod = ((point.minute - 1) % data.periodTime) + 1;

      return {
        minute: point.minute,
        value: point.value,
        period,
        timeInPeriod,
      };
    });

    // Calculate summary statistics
    const values = data.graphPoints.map((p) => p.value);
    const minValue = Math.min(...values);
    const maxValue = Math.max(...values);
    const averageValue = values.reduce((a, b) => a + b, 0) / values.length;

    const graphData: GraphData = {
      eventId: Number(eventId),
      points: normalizedPoints,
      periodTime: data.periodTime,
      overtimeLength: data.overtimeLength,
      periodCount: data.periodCount,
      summary: {
        totalMinutes: data.graphPoints.length,
        minValue: Math.round(minValue * 100) / 100,
        maxValue: Math.round(maxValue * 100) / 100,
        averageValue: Math.round(averageValue * 100) / 100,
      },
    };

    return {
      status: 200,
      data: graphData,
      raw: data,
    };
  } catch (error) {
    console.error('Error fetching graph:', error);
    throw error;
  }
}
