import dotenv from 'dotenv';

dotenv.config();

console.log('ENV LOADED - SOFASCORE_BASE_URL present:', process.env.SOFASCORE_BASE_URL);

import express from 'express';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './swagger';
import { healthRouter } from './routes/health';
import { matchesRouter } from './routes/matches';
import { oddsRouter } from './routes/odds';
import { eventsRouter } from './routes/events';
import { eventRouter } from './routes/event';
import { standingsRouter } from './routes/standings';
import { imagesRouter } from './routes/images';
import { searchRouter } from './routes/search';

const app = express();
const PORT = process.env.PORT || 3001;

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
app.use('/', imagesRouter);
app.use('/', searchRouter);

app.listen(PORT, () => {
  console.log(`🚀 Server is running on http://localhost:${PORT} 🌐`);

  console.log('Press Ctrl+C to stop the server.');
  console.log('----------------------------------------');
  console.log('📚 Documentation:');
  console.log(`  📖 Swagger UI: http://localhost:${PORT}/api-docs`);
  console.log(`  📝 OpenAPI JSON: http://localhost:${PORT}/api-docs.json`);
  console.log('----------------------------------------');
  console.log('🔗 Endpoints:');
  console.log(`  🩺 Health Check: http://localhost:${PORT}/health`);
  console.log(`  ⚽ Live Matches: http://localhost:${PORT}/live-matches`);
  console.log(`  📊 Odds Data: http://localhost:${PORT}/odds/:eventId/:marketId`);
  console.log(`  📈 Statistics: http://localhost:${PORT}/event/:eventId/statistics`);
  console.log(`  🏆 Standings: http://localhost:${PORT}/standings/:tournamentId/:seasonId`);
  console.log(`  🖼️  Images: http://localhost:${PORT}/team/:teamId/image`);
  console.log(`  ⚡ Events: http://localhost:${PORT}/event/:eventId/incidents`);
  console.log(`  🔍 Search: http://localhost:${PORT}/search/teams?q=query`);
  console.log('----------------------------------------');
});
