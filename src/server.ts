import './config/env';

import express from 'express';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './swagger';
import { healthRouter } from './routes/health';
import { matchesRouter } from './routes/matches';
import { oddsRouter } from './routes/odds';
import { eventsRouter } from './routes/events';
import { eventRouter } from './routes/event';
import { standingsRouter } from './routes/standings';
import { lineupsRouter } from './routes/lineups';
import { imagesRouter } from './routes/images';
import { searchRouter } from './routes/search';
import { teamsRouter } from './routes/teams';
import { teamEventsRouter } from './routes/team-events';
import { topPlayersRouter } from './routes/top-players';
import { analysisRouter } from './routes/analysis';
import { enrichmentRouter } from './routes/enrichment';
import cors from "cors";
import { createRateLimit, requireAnalysisSecret } from './middlewares/security';

const PORT = process.env.PORT || 3001;

export const app = express();

app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);
const allowedOrigins = String(process.env.SCRAPER_CORS_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Origem nao autorizada pelo CORS'));
  },
}));
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.use(express.json({ limit: '100kb' }));
app.use(createRateLimit({ windowMs: 60_000, max: Number(process.env.SCRAPER_RATE_LIMIT_PER_MINUTE || 120), prefix: 'all' }));
app.use('/analysis', createRateLimit({ windowMs: 60_000, max: Number(process.env.SCRAPER_ANALYSIS_RATE_LIMIT_PER_MINUTE || 20), prefix: 'analysis' }), requireAnalysisSecret);

// Swagger setup
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Expose Swagger JSON
app.get('/api-docs.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.send(swaggerSpec);
});

// Register routers
app.use('/', healthRouter);
app.use('/', matchesRouter);
app.use('/', oddsRouter);
app.use('/', eventsRouter);
app.use('/', eventRouter);
app.use('/', standingsRouter);
app.use('/', lineupsRouter);
app.use('/', imagesRouter);
app.use('/', searchRouter);
app.use('/', analysisRouter);
app.use('/', enrichmentRouter);
app.use('/team', teamsRouter);
app.use('/team', teamEventsRouter);
app.use('/team', topPlayersRouter);

export function startServer(port = PORT) {
  const host = process.env.SCRAPER_HOST || '127.0.0.1';
  if (process.env.NODE_ENV === 'production' && !String(process.env.SCRAPER_INTERNAL_SECRET || '').trim()) {
    throw new Error('SCRAPER_INTERNAL_SECRET e obrigatorio em producao.');
  }
  return app.listen(Number(port), host, () => {
    console.log(`🚀 Server is running on http://localhost:${port} 🌐`);
    console.log('Press Ctrl+C to stop the server.');
    console.log('----------------------------------------');
    console.log('📚 Documentation:');
    console.log(`  📖 Swagger UI: http://localhost:${port}/api-docs`);
    console.log(`  📝 OpenAPI JSON: http://localhost:${port}/api-docs.json`);
    console.log('----------------------------------------');
  });
}
