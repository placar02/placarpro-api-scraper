import './config/env';

console.log('ENV LOADED - SCORES_PROVIDER:', process.env.SCORES_PROVIDER);

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
import cors from "cors";

const PORT = process.env.PORT || 3001;

export const app = express();

app.use(cors());
app.use(express.json());

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
app.use('/team', teamsRouter);
app.use('/team', teamEventsRouter);
app.use('/team', topPlayersRouter);

export function startServer(port = PORT) {
  return app.listen(port, () => {
    console.log(`🚀 Server is running on http://localhost:${port} 🌐`);
    console.log('Press Ctrl+C to stop the server.');
    console.log('----------------------------------------');
    console.log('📚 Documentation:');
    console.log(`  📖 Swagger UI: http://localhost:${port}/api-docs`);
    console.log(`  📝 OpenAPI JSON: http://localhost:${port}/api-docs.json`);
    console.log('----------------------------------------');
  });
}
