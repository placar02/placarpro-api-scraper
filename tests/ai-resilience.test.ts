import { afterEach, describe, expect, it, vi } from 'vitest';
import { compactReasoningInput, fetchAzureWithRetry } from '../src/analysis/ai';

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
});
