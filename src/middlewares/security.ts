import type { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';

type Bucket = { count: number; resetAt: number };

export function createRateLimit(options: { windowMs: number; max: number; prefix: string }) {
  const buckets = new Map<string, Bucket>();
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    if (buckets.size > 2000) {
      for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
      while (buckets.size > 2500) buckets.delete(buckets.keys().next().value as string);
    }
    const key = `${options.prefix}:${req.ip || req.socket.remoteAddress || 'unknown'}`;
    const current = buckets.get(key);
    if (!current || current.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + options.windowMs });
      return next();
    }
    current.count += 1;
    if (current.count > options.max) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((current.resetAt - now) / 1000))));
      return res.status(429).json({ ok: false, error: 'Muitas requisicoes. Tente novamente em instantes.' });
    }
    return next();
  };
}

function safeSecretEqual(received: unknown, configured: string) {
  const left = Buffer.from(String(received || ''));
  const right = Buffer.from(configured);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function requireAnalysisSecret(req: Request, res: Response, next: NextFunction) {
  const configured = String(process.env.SCRAPER_INTERNAL_SECRET || '').trim();
  if (!configured && process.env.NODE_ENV !== 'production') return next();
  if (!configured) return res.status(503).json({ ok: false, error: 'Segredo interno do scraper nao configurado.' });
  if (!safeSecretEqual(req.headers['x-scraper-secret'], configured)) {
    return res.status(401).json({ ok: false, error: 'Nao autorizado.' });
  }
  return next();
}
