import { describe, expect, it } from 'vitest';
import { matchBetanoEvent, parseBetanoPayload } from '../src/scrapers/betano-odds';

const payload = {
  fixtures: [{
    eventId: 'betano-100',
    startTime: '2026-07-18T22:00:00.000Z',
    participants: [
      { name: 'Botafogo FR', role: 'home' },
      { name: 'Santos FC', role: 'away' },
    ],
    marketGroups: [{
      name: 'Total de gols',
      markets: [{
        id: 25,
        name: 'Mais/Menos de 2,5 gols',
        line: '2.5',
        selections: [
          { id: 'over', name: 'Mais de 2,5', price: 1.82 },
          { id: 'under', name: 'Menos de 2,5', price: 1.95 },
        ],
      }],
    }],
  }],
};

describe('provider de odds Betano', () => {
  it('extrai partida, mercados e odds decimais de JSON publico', () => {
    const events = parseBetanoPayload(payload);
    expect(events).toHaveLength(1);
    expect(events[0].home).toBe('Botafogo FR');
    expect(events[0].away).toBe('Santos FC');
    expect(events[0].markets[0].choices.map((choice) => choice.decimal_odds)).toEqual([1.82, 1.95]);
  });

  it('resolve a mesma partida apesar de sufixos dos clubes', () => {
    const event = matchBetanoEvent({
      homeTeam: { name: 'Botafogo' },
      awayTeam: { name: 'Santos' },
      startTimestamp: Date.parse('2026-07-18T22:00:00.000Z') / 1000,
    }, parseBetanoPayload(payload));
    expect(event?.id).toBe('betano-100');
  });

  it('nao casa equipes diferentes', () => {
    const event = matchBetanoEvent({
      homeTeam: { name: 'Flamengo' },
      awayTeam: { name: 'Palmeiras' },
    }, parseBetanoPayload(payload));
    expect(event).toBeNull();
  });
});
