import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/server';

type RouteResult = {
  route: string;
  status: number;
};

type RuntimeContext = {
  eventId?: string;
  teamId?: string;
  tournamentId?: string;
  seasonId?: string;
};

const operationalStatuses = new Set([200, 304, 404]);
const routeResults: RouteResult[] = [];
const ctx: RuntimeContext = {};

async function hitRoute(path: string) {
  const response = await request(app).get(path);
  routeResults.push({ route: path, status: response.status });
  return response;
}

function expectOperational(route: string, status: number) {
  expect(
    operationalStatuses.has(status),
    `Rota ${route} retornou status inesperado: ${status}. Esperado: 200, 304 ou 404.`,
  ).toBe(true);
}

describe.sequential('Encadeamento de testes das rotas (baseado em live matches)', () => {
  beforeAll(async () => {
    const liveResponse = await hitRoute('/live-matches');
    expectOperational('/live-matches', liveResponse.status);

    if (liveResponse.status !== 200 || !Array.isArray(liveResponse.body?.data) || liveResponse.body.data.length === 0) {
      return;
    }

    const firstEvent = liveResponse.body.data[0];
    ctx.eventId = firstEvent?.id ? String(firstEvent.id) : undefined;
    ctx.teamId = firstEvent?.homeTeam?.id ? String(firstEvent.homeTeam.id) : undefined;
    ctx.tournamentId = firstEvent?.tournament?.uniqueTournament?.id
      ? String(firstEvent.tournament.uniqueTournament.id)
      : firstEvent?.tournament?.id
        ? String(firstEvent.tournament.id)
        : undefined;
    ctx.seasonId = firstEvent?.season?.id ? String(firstEvent.season.id) : undefined;

    if (ctx.eventId) {
      const eventResponse = await hitRoute(`/event/${ctx.eventId}`);
      expectOperational(`/event/${ctx.eventId}`, eventResponse.status);

      if (eventResponse.status === 200 && eventResponse.body?.data) {
        const eventData = eventResponse.body.data;
        ctx.teamId = ctx.teamId ?? (eventData.homeTeam?.id ? String(eventData.homeTeam.id) : undefined);
        const eventTournamentId = eventData.tournament?.uniqueTournament?.id ?? eventData.tournament?.id;
        if (!ctx.tournamentId && eventTournamentId) {
          ctx.tournamentId = String(eventTournamentId);
        }
        if (!ctx.seasonId && eventData.season?.id) {
          ctx.seasonId = String(eventData.season.id);
        }
      }
    }
  }, 180000);

  it('deve retornar status operacional para /live-matches', async () => {
    const result = routeResults.find((item) => item.route === '/live-matches');
    expect(result, 'A rota /live-matches precisa ter sido executada no beforeAll').toBeDefined();
    expectOperational('/live-matches', result!.status);
  });

  it('deve validar rotas de evento usando eventId encadeado', async () => {
    if (!ctx.eventId) {
      expect(routeResults.find((item) => item.route === '/live-matches')?.status).toBe(200);
      return;
    }
    const eventId = ctx.eventId as string;

    const eventRoutes = [
      `/event/${eventId}`,
      `/event/${eventId}/statistics`,
      `/event/${eventId}/incidents`,
      `/event/${eventId}/graph`,
      `/event/${eventId}/streaks`,
      `/event/${eventId}/lineups`,
      `/odds/${eventId}`,
    ];

    for (const route of eventRoutes) {
      const response = route === `/event/${eventId}`
        ? { status: routeResults.find((item) => item.route === route)?.status ?? 500 }
        : await hitRoute(route);

      expectOperational(route, response.status);
    }
  }, 180000);

  it('deve validar rotas de time usando teamId encadeado', async () => {
    if (!ctx.teamId) {
      expect(routeResults.find((item) => item.route === '/live-matches')?.status).toBe(200);
      return;
    }
    const teamId = ctx.teamId as string;

    const teamRoutes = [
      `/team/${teamId}`,
      `/team/${teamId}/events/next`,
    ];

    for (const route of teamRoutes) {
      const response = await hitRoute(route);
      expectOperational(route, response.status);
    }

    if (ctx.tournamentId && ctx.seasonId) {
      const topPlayersRoute = `/team/${teamId}/top-players?uniqueTournamentId=${ctx.tournamentId}&seasonId=${ctx.seasonId}`;
      const response = await hitRoute(topPlayersRoute);
      expectOperational(topPlayersRoute, response.status);
    }
  }, 180000);

  it('deve validar standings quando tournamentId e seasonId estiverem disponíveis', async () => {
    if (!ctx.tournamentId || !ctx.seasonId) {
      expect(routeResults.find((item) => item.route === '/live-matches')?.status).toBe(200);
      return;
    }

    const standingsRoute = `/standings/${ctx.tournamentId}/${ctx.seasonId}`;
    const response = await hitRoute(standingsRoute);
    expectOperational(standingsRoute, response.status);
  }, 180000);

  it('deve imprimir relatório resumido de status das rotas testadas', () => {
    console.table(routeResults);
    expect(routeResults.length).toBeGreaterThan(0);
  });
});
