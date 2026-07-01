import { describe, expect, it } from 'vitest';
import { aggregateMatches, parseHistoricalMatches, playerSummary } from '../src/scrapers/ogol/deep';
import { deepStatisticItems } from '../src/scrapers/ogol';
import type { OgolPageSnapshot } from '../src/scrapers/ogol/snapshot';

function snapshot(overrides: Partial<OgolPageSnapshot>): OgolPageSnapshot {
  return {
    url: 'https://www.ogol.com.br/teste',
    title: 'Teste',
    pageType: 'test',
    text: '',
    textLines: [],
    headings: [],
    sections: {},
    links: [],
    tables: [],
    keyValues: [],
    statisticBlocks: [],
    eventBlocks: [],
    playerBlocks: [],
    metadata: {},
    ...overrides,
  };
}

describe('enriquecimento profundo do OGOL', () => {
  it('calcula forma e desempenho usando partidas reais encontradas nas tabelas', () => {
    const page = snapshot({
      links: [
        { text: '2-1', href: 'https://www.ogol.com.br/jogo/2026-06-29-brasil-japao/11841290', context: 'Brasil 2-1 Japao' },
        { text: '0-3', href: 'https://www.ogol.com.br/jogo/2026-06-24-escocia-brasil/11832123', context: 'Escocia 0-3 Brasil' },
        { text: '1-1', href: 'https://www.ogol.com.br/jogo/2026-06-13-brasil-marrocos/11832119', context: 'Brasil 1-1 Marrocos' },
      ],
    });

    const matches = parseHistoricalMatches(page);
    const form = aggregateMatches(matches, 'brasil', 10);

    expect(matches).toHaveLength(3);
    expect(form.played).toBe(3);
    expect(form.wins).toBe(2);
    expect(form.draws).toBe(1);
    expect(form.goalsFor).toBe(6);
    expect(form.goalsAgainst).toBe(2);
  });

  it('estrutura totais e forma recente do perfil de jogador', () => {
    const page = snapshot({
      title: 'Casemiro :: Informacoes e Estatisticas',
      tables: [
        {
          index: 0,
          headers: ['J', 'M', 'GM', 'ASS'],
          rows: [['J', 'M', 'GM', 'ASS'], ['Total', '26', '1978', '7', '2']],
          text: 'Total 26 1978 7 2',
        },
        {
          index: 1,
          headers: [],
          rows: [
            ['V', '29/06', 'CM', 'Brasil', '2-1', 'Japao', "T90'", '7.8'],
            ['E', '13/06', 'CM', 'Brasil', '1-1', 'Marrocos', "T45'", '6.4'],
          ],
          text: 'Jogos recentes',
        },
      ],
    });

    const player = playerSummary(page, { text: 'Casemiro', href: page.url, context: 'Escalacoes titular' });

    expect(player.appearances).toBe(26);
    expect(player.minutes).toBe(1978);
    expect(player.goals).toBe(7);
    expect(player.assists).toBe(2);
    expect(player.averageRating).toBe(7.1);
    expect(player.recentForm).toBe('VE');
  });
});

describe('estatisticas dinamicas do OGOL', () => {
  it('separa tabelas com rotulos e pares em linhas diferentes', () => {
    const items = deepStatisticItems({
      analysisReady: {
        match: {
          tables: [{
            rows: [
              ['Posse de Bola', 'Chutes (a gol)', 'Escanteios', 'Gols esperados'],
              ['69% 31%', '(7) 19 5 (2)', '6 2', '1.92 0.26'],
            ],
          }],
          statistics: [],
        },
      },
    });

    expect(items.map((item) => [item.name, item.home.value, item.away.value])).toEqual(expect.arrayContaining([
      ['Posse de Bola', 69, 31],
      ['Chutes (a gol)', 19, 5],
      ['Chutes no alvo', 7, 2],
      ['Escanteios', 6, 2],
      ['Gols esperados', 1.92, 0.26],
    ]));
  });
});
