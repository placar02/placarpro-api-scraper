import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRateLimit, requireAnalysisSecret } from '../src/middlewares/security';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('seguranca das rotas caras do scraper', () => {
  it('exige segredo em producao', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SCRAPER_INTERNAL_SECRET', 'segredo-interno-de-teste-comprido');
    const app = express();
    app.get('/analysis', requireAnalysisSecret, (_req, res) => res.json({ ok: true }));
    await request(app).get('/analysis').expect(401);
    await request(app).get('/analysis').set('x-scraper-secret', 'incorreto').expect(401);
    await request(app).get('/analysis').set('x-scraper-secret', 'segredo-interno-de-teste-comprido').expect(200);
  });

  it('mantem desenvolvimento local compativel quando segredo nao foi configurado', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('SCRAPER_INTERNAL_SECRET', '');
    const app = express();
    app.get('/analysis', requireAnalysisSecret, (_req, res) => res.json({ ok: true }));
    await request(app).get('/analysis').expect(200);
  });

  it('limita rajadas e informa retry-after', async () => {
    const app = express();
    app.use(createRateLimit({ windowMs: 60_000, max: 2, prefix: 'test' }));
    app.get('/', (_req, res) => res.json({ ok: true }));
    await request(app).get('/').expect(200);
    await request(app).get('/').expect(200);
    const blocked = await request(app).get('/').expect(429);
    expect(blocked.headers['retry-after']).toBeTruthy();
  });
});
