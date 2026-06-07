import swaggerJsdoc from 'swagger-jsdoc';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'PlacarPro API Scraper',
      version: '0.1.0',
      description: 'API de scraping e normalização de dados esportivos',
      contact: {
        name: 'EduardoPH',
        url: 'https://github.com/EduardoPH/placarpro-api',
      },
    },
    servers: [
      {
        url: `http://localhost:${process.env.PORT || 3001}`,
        description: 'Development server',
      },
    ],
    components: {
      schemas: {
        LiveMatch: {
          type: 'object',
          properties: {
            eventId: {
              type: 'string',
              description: 'ID único do evento',
            },
            homeTeam: {
              type: 'string',
              description: 'Nome do time da casa',
            },
            awayTeam: {
              type: 'string',
              description: 'Nome do time visitante',
            },
            score: {
              type: 'object',
              properties: {
                home: {
                  type: 'number',
                  description: 'Gols do time da casa',
                },
                away: {
                  type: 'number',
                  description: 'Gols do time visitante',
                },
              },
            },
            status: {
              type: 'string',
              description: 'Status da partida',
              enum: ['LIVE', 'FINISHED', 'SCHEDULED'],
            },
          },
        },
        OddsData: {
          type: 'object',
          properties: {
            eventId: {
              type: 'string',
              description: 'ID único do evento',
            },
            marketId: {
              type: 'number',
              description: 'ID do mercado de apostas',
            },
            odds: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  bookmaker: {
                    type: 'string',
                    description: 'Nome da casa de apostas',
                  },
                  value: {
                    type: 'number',
                    description: 'Valor da odd',
                  },
                },
              },
              description: 'Lista de odds por casa de apostas',
            },
          },
        },
        Statistics: {
          type: 'object',
          properties: {
            eventId: {
              type: 'string',
              description: 'ID único do evento',
            },
            homeTeam: {
              type: 'object',
              properties: {
                possession: {
                  type: 'number',
                  description: 'Percentual de posse de bola',
                },
                shotsOnTarget: {
                  type: 'number',
                  description: 'Chutes no alvo',
                },
                corners: {
                  type: 'number',
                  description: 'Escanteios',
                },
              },
            },
            awayTeam: {
              type: 'object',
              properties: {
                possession: {
                  type: 'number',
                  description: 'Percentual de posse de bola',
                },
                shotsOnTarget: {
                  type: 'number',
                  description: 'Chutes no alvo',
                },
                corners: {
                  type: 'number',
                  description: 'Escanteios',
                },
              },
            },
          },
        },
        Error: {
          type: 'object',
          properties: {
            error: {
              type: 'string',
              description: 'Mensagem de erro',
            },
            message: {
              type: 'string',
              description: 'Detalhes do erro',
            },
          },
        },
      },
    },
  },
  apis: [
    path.join(__dirname, 'routes/health.ts'),
    path.join(__dirname, 'routes/matches.ts'),
    path.join(__dirname, 'routes/odds.ts'),
    path.join(__dirname, 'routes/events.ts'),
    path.join(__dirname, 'routes/event.ts'),
    path.join(__dirname, 'routes/standings.ts'),
    path.join(__dirname, 'routes/images.ts'),
    path.join(__dirname, 'routes/search.ts'),
    path.join(__dirname, 'routes/teams.ts'),
    path.join(__dirname, 'routes/team-events.ts'),
    path.join(__dirname, 'routes/top-players.ts'),
    path.join(__dirname, 'routes/analysis.ts'),
  ],
};

export const swaggerSpec = swaggerJsdoc(options);
