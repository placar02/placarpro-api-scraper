import dotenv from 'dotenv';

dotenv.config();

console.log('ENV LOADED - SOFASCORE_BASE_URL present:', process.env.SOFASCORE_BASE_URL);

import express from 'express';
import { fetchLiveMatches } from './scrapers/live';
import type { LiveMatchesResponse } from './scrapers/live';
import { fetchOdds } from './scrapers/odds';

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Hello, World!');
});

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});


app.get('/live-matches', async (req, res) => {
  const ifNoneMatch = req.header('if-none-match') || undefined;

  const retryOn403 = req.query.retryOn403 === 'false' ? false : true;

  try {
    const result: LiveMatchesResponse = await fetchLiveMatches({ ifNoneMatch, retryOn403 });

    if (result.status === 304) {
      if (result.etag) res.setHeader('ETag', result.etag as string);
      return res.sendStatus(304);
    }

    if (result.etag) {
      res.setHeader('ETag', result.etag as string);
    }

    const payload = result.events ?? (result as any).raw ?? {};

    return res.status(200).json({ status: result.status ?? 200, data: payload });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('Error in /live-matches:', err);
    return res.status(500).json({ error: 'Failed to fetch live matches', message });
  }
});

// Rota para odds com marketId obrigatório
app.get('/odds/:eventId/:marketId', async (req, res) => {
  const { eventId, marketId } = req.params;
  console.log('Received /odds request with eventId:', eventId, 'and marketId:', marketId);
  if (!eventId || eventId == ':eventId' || !marketId || marketId == ':marketId') {
    return res.status(400).json({ error: 'eventId is required' });
  }
  const marketIdNum = parseInt(marketId, 10); // Converte marketId para número, porém, quando nao 

  try {
    const oddsData = await fetchOdds(eventId, marketIdNum);
    if (!oddsData) {
      return res.status(404).json({ error: 'Odds data not found' });
    }
    return res.status(200).json({ status: 200, data: oddsData });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return res.status(500).json({ error: 'Failed to fetch odds data', message });
  }
});

app.get('/odds/:eventId', async (req, res) => {
  const { eventId } = req.params;
  if (!eventId || eventId == ':eventId') {
    return res.status(400).json({ error: 'eventId is required' });
  }
  const marketIdNum = 1;

  try {
    const oddsData = await fetchOdds(eventId, marketIdNum);
    if (!oddsData) {
      return res.status(404).json({ error: 'Odds data not found' });
    }
    return res.status(200).json({ status: 200, data: oddsData });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return res.status(500).json({ error: 'Failed to fetch odds data', message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server is running on http://localhost:${PORT} 🌐`);

  console.log('Press Ctrl+C to stop the server.');
  console.log('----------------------------------------');
  console.log('🔗 Endpoints:');
  console.log(`  🩺 Health Check: http://localhost:${PORT}/health`);
  console.log(`  ⚽ Live Matches: http://localhost:${PORT}/live-matches (Use 'If-None-Match' header for caching)`);
  console.log('    📝 Parameters for /live-matches:');
  console.log(`     - retryOn403: boolean (query - default: true)`);
  console.log(`     - If-None-Match: string (header - for caching)`);
  console.log(' ')
  console.log(`  📊 Odds Data: http://localhost:${PORT}/odds/:eventId/:marketId`)
  console.log('    📝 Parameters for /odds/:eventId/:marketId:');
  console.log(`     - eventId: string (path - required)`);
  console.log(`     - marketId: number (path - optional, default: 1)`);
  console.log(' ')
  console.log(`  📊 Odds Data (default marketId=1): http://localhost:${PORT}/odds/:eventId`)
  console.log('    📝 Parameters for /odds/:eventId:');
  console.log(`     - eventId: string (path - required)`);
  console.log('----------------------------------------');
});
