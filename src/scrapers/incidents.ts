import type { IncidentsApiResponse, IncidentsData, NormalizedIncident } from '../types/incidents';

const SOFASCORE_BASE_URL = process.env.SOFASCORE_BASE_URL || 'https://www.sofascore.com/api/v1';

interface FetchIncidentsOptions {
  retryOn403?: boolean;
}

interface IncidentsResponse {
  status: number;
  data?: IncidentsData;
  raw?: IncidentsApiResponse;
}

export async function fetchIncidents(
  eventId: number | string,
  options: FetchIncidentsOptions = {}
): Promise<IncidentsResponse> {
  const { retryOn403 = true } = options;

  const url = `${SOFASCORE_BASE_URL}/event/${eventId}/incidents`;

  try {
    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    };

    const response = await fetch(url, { headers });

    if (response.status === 403 && retryOn403) {
      console.warn(`Received 403 for incidents. Retrying...`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return fetchIncidents(eventId, { ...options, retryOn403: false });
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data: IncidentsApiResponse = await response.json();

    // Transform the API response to normalized format
    const normalizedIncidents: NormalizedIncident[] = data.incidents.map((incident) => {
      const normalized: NormalizedIncident = {
        id: incident.id,
        eventId: Number(eventId),
        type: incident.incidentType,
        class: incident.incidentClass,
        time: incident.time,
        addedTime: incident.addedTime,
        isHome: incident.isHome,
      };

      // Handle Period incidents
      if (incident.incidentType === 'period' && 'text' in incident) {
        normalized.periodText = incident.text;
        normalized.score = {
          home: incident.homeScore ?? 0,
          away: incident.awayScore ?? 0,
        };
      }

      // Handle Card incidents
      if (incident.incidentType === 'card' && 'player' in incident) {
        normalized.player = {
          id: incident.player.id,
          name: incident.player.name,
          slug: incident.player.slug,
          position: incident.player.position,
          jerseyNumber: incident.player.jerseyNumber,
        };
        normalized.cardReason = (incident as any).reason;
        normalized.cardType = incident.incidentClass;
      }

      // Handle Goal incidents
      if (incident.incidentType === 'goal' && 'player' in incident) {
        normalized.goalScorer = {
          id: incident.player.id,
          name: incident.player.name,
          slug: incident.player.slug,
          position: incident.player.position,
          jerseyNumber: incident.player.jerseyNumber,
        };
        normalized.score = {
          home: incident.homeScore ?? 0,
          away: incident.awayScore ?? 0,
        };

        if ((incident as any).assist1) {
          normalized.assist = {
            id: (incident as any).assist1.id,
            name: (incident as any).assist1.name,
            slug: (incident as any).assist1.slug,
          };
        }

        if ((incident as any).goalkeeper) {
          normalized.goalkeeper = {
            id: (incident as any).goalkeeper.id,
            name: (incident as any).goalkeeper.name,
            slug: (incident as any).goalkeeper.slug,
          };
        }

        normalized.goalType = (incident as any).goalType;
      }

      // Handle Substitution incidents
      if (incident.incidentType === 'substitution' && 'playerIn' in incident) {
        normalized.playerIn = {
          id: incident.playerIn.id,
          name: incident.playerIn.name,
          slug: incident.playerIn.slug,
          position: incident.playerIn.position,
          jerseyNumber: incident.playerIn.jerseyNumber,
        };
        normalized.playerOut = {
          id: incident.playerOut.id,
          name: incident.playerOut.name,
          slug: incident.playerOut.slug,
          position: incident.playerOut.position,
          jerseyNumber: incident.playerOut.jerseyNumber,
        };
        normalized.isInjury = incident.injury;
      }

      // Handle Injury Time incidents
      if (incident.incidentType === 'injuryTime' && 'length' in incident) {
        normalized.injuryTimeLength = incident.length;
      }

      return normalized;
    });

    const incidentsData: IncidentsData = {
      eventId: Number(eventId),
      incidents: normalizedIncidents,
      teamColors: {
        home: data.home,
        away: data.away,
      },
    };

    return {
      status: 200,
      data: incidentsData,
      raw: data,
    };
  } catch (error) {
    console.error('Error fetching incidents:', error);
    throw error;
  }
}
