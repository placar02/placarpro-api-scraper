import express from 'express';
import { analyzeEvent } from '../analysis/ai';
import type { AnalysisResult, AnalyzeOptions } from '../types/analysis';

export const analysisRouter = express.Router();

type BestOfThreeResponse = {
  eventIds: string[];
  bestEventId: string | number;
  bestEntry: AnalysisResult;
  analyses: AnalysisResult[];
};

function parseEventIds(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => parseEventIds(item));
  }

  if (typeof value === 'number') return [String(value)];
  if (typeof value !== 'string') return [];

  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function selectBestEventEntry(analyses: AnalysisResult[]): BestOfThreeResponse {
  const sorted = [...analyses].sort((a, b) => b.confidence - a.confidence);
  const bestEntry = sorted[0];

  return {
    eventIds: analyses.map((analysis) => String(analysis.eventId)),
    bestEventId: bestEntry.eventId,
    bestEntry,
    analyses: sorted,
  };
}

async function analyzeBestOfThree(eventIds: string[], options: AnalyzeOptions): Promise<BestOfThreeResponse> {
  const analyses = await Promise.all(eventIds.map((eventId) => analyzeEvent(eventId, options)));
  return selectBestEventEntry(analyses);
}

function isTrue(value: unknown): boolean {
  return value === true || value === 'true';
}

function validateThreeEventIds(eventIds: string[]) {
  if (eventIds.length !== 3) {
    return `Informe exatamente 3 IDs de evento. Recebidos: ${eventIds.length}.`;
  }

  return null;
}

/**
 * @swagger
 * /analysis/best-of-three:
 *   get:
 *     summary: Compara 3 eventos e retorna a melhor entrada
 *     tags:
 *       - Analysis
 *     parameters:
 *       - name: eventIds
 *         in: query
 *         description: Três IDs de evento separados por vírgula
 *         required: true
 *         schema:
 *           type: string
 *           example: "123,456,789"
 *       - name: useLLM
 *         in: query
 *         description: Use false para pular a análise com IA
 *         required: false
 *         schema:
 *           type: boolean
 *           default: true
 *     responses:
 *       200:
 *         description: Melhor entrada entre os 3 eventos
 *       400:
 *         description: Quantidade de IDs inválida
 */
// GET /analysis/best-of-three?eventIds=123,456,789
// You can also send repeated params: /analysis/best-of-three?eventIds=123&eventIds=456&eventIds=789
// Use ?useLLM=false only when you want to skip the AI analysis.
analysisRouter.get('/analysis/best-of-three', async (req, res) => {
  try {
    const eventIds = parseEventIds(req.query.eventIds);
    const validationError = validateThreeEventIds(eventIds);

    if (validationError) {
      res.status(400).json({ ok: false, error: validationError });
      return;
    }

    const result = await analyzeBestOfThree(eventIds, {
      useLLM: req.query.useLLM !== 'false',
      includeOdds: isTrue(req.query.includeOdds),
      useOddsFallback: isTrue(req.query.useOddsFallback),
    });

    res.json({ ok: true, result });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error('Best-of-three analysis error', error.stack || error.message);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

/**
 * @swagger
 * /analysis/best-of-three:
 *   post:
 *     summary: Compara 3 eventos e retorna a melhor entrada
 *     tags:
 *       - Analysis
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - eventIds
 *             properties:
 *               eventIds:
 *                 type: array
 *                 minItems: 3
 *                 maxItems: 3
 *                 items:
 *                   type: string
 *                 example: ["123", "456", "789"]
 *               useLLM:
 *                 type: boolean
 *                 default: true
 *     responses:
 *       200:
 *         description: Melhor entrada entre os 3 eventos
 *       400:
 *         description: Quantidade de IDs inválida
 */
// POST /analysis/best-of-three
// Body: { "eventIds": ["123", "456", "789"], "useLLM": false }
analysisRouter.post('/analysis/best-of-three', async (req, res) => {
  try {
    const eventIds = parseEventIds(req.body?.eventIds);
    const validationError = validateThreeEventIds(eventIds);

    if (validationError) {
      res.status(400).json({ ok: false, error: validationError });
      return;
    }

    const result = await analyzeBestOfThree(eventIds, {
      useLLM: req.body?.useLLM !== false,
      includeOdds: isTrue(req.body?.includeOdds),
      useOddsFallback: isTrue(req.body?.useOddsFallback),
    });

    res.json({ ok: true, result });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error('Best-of-three analysis error', error.stack || error.message);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// GET /analysis/:eventId
// Use ?useLLM=false only when you want to skip the AI analysis.
analysisRouter.get('/analysis/:eventId', async (req, res) => {
  try {
    const { eventId } = req.params;

    const result = await analyzeEvent(eventId, {
      useLLM: req.query.useLLM !== 'false',
      includeOdds: isTrue(req.query.includeOdds),
      useOddsFallback: isTrue(req.query.useOddsFallback),
    });

    res.json({ ok: true, result });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error('Analysis error', error.stack || error.message);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

export default analysisRouter;
