import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildExplanationInput, compactReasoningInput, fetchAzureWithRetry } from '../src/analysis/ai';

describe('resiliencia do Azure OpenAI', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete process.env.AZURE_OPENAI_RETRIES;
    delete process.env.AZURE_OPENAI_RETRY_BASE_MS;
    delete process.env.AZURE_OPENAI_MAX_INPUT_CHARS;
  });

  it('respeita o rate limit e tenta novamente depois de um 429', async () => {
    vi.useFakeTimers();
    process.env.AZURE_OPENAI_RETRIES = '2';
    process.env.AZURE_OPENAI_RETRY_BASE_MS = '250';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('rate_limit_exceeded', { status: 429 }))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const pending = fetchAzureWithRetry('https://example.test/openai', { eventId: 1 }, 'key', 5000);
    await vi.runAllTimersAsync();
    const response = await pending;

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('remove blocos brutos e limita o payload enviado ao modelo reasoning', () => {
    process.env.AZURE_OPENAI_MAX_INPUT_CHARS = '8000';
    const input = {
      event: { id: 1, homeTeam: { name: 'Brasil' }, awayTeam: { name: 'Japao' } },
      statistics: {
        raw: { html: 'x'.repeat(50000) },
        deepData: {
          pages: Array.from({ length: 100 }, (_, index) => ({ index, text: 'x'.repeat(1000) })),
          players: Array.from({ length: 100 }, (_, index) => ({ name: `Jogador ${index}`, stats: 'x'.repeat(1000) })),
        },
      },
    } as any;

    const compact = compactReasoningInput(input);
    const serialized = JSON.stringify(compact);
    expect(serialized.length).toBeLessThan(8000);
    expect(serialized).not.toContain('html');
    expect(serialized).not.toContain('pages');
  });

  it('envia para a IA somente o resumo objetivo sem jogadores ou desfalques', () => {
    const full: any = {
      event: { id: 1, source: 'ogol', homeTeam: { name: 'Casa' }, awayTeam: { name: 'Fora' }, tournament: { name: 'Liga' } },
      lineups: { home: { starters: [{ name: 'Nao enviar' }], missingPlayers: [{ name: 'Lesionado' }] } },
      statistics: { teamPeriods: [{ groups: [{ items: [
        { name: 'Gols por jogo', home: 1.8, away: 1.2 },
        { name: 'Dado interno irrelevante', home: 99, away: 99 },
      ] }] }], players: [{ name: 'Nao enviar', goals: 10 }] },
      teamForm: { homeRecent: { last5: { played: 5, avgGoalsFor: 1.8 }, recentMatches: [{ result: 'W' }] }, awayRecent: { last5: { played: 5, avgGoalsFor: 1.2 } } },
    };
    const summary = buildExplanationInput(full, { eventId: 1, market: 'Gols', recommendation: 'Over 2.5 gols', confidence: 78, rationale: 'ok' });
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain('Nao enviar');
    expect(serialized).not.toContain('Lesionado');
    expect(serialized).not.toContain('Dado interno irrelevante');
    expect(serialized).toContain('Gols por jogo');
    expect(serialized.length).toBeLessThan(5000);
  });
});
