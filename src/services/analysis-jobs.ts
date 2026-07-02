import { randomUUID } from 'node:crypto';

export type AnalysisJobStatus = 'queued' | 'processing' | 'completed' | 'failed';

export type AnalysisJob<T = unknown> = {
  id: string;
  key: string;
  status: AnalysisJobStatus;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  quickResult?: unknown;
  result?: T;
  error?: string;
};

type QueueItem<T> = {
  job: AnalysisJob<T>;
  task: () => Promise<T>;
};

const jobs = new Map<string, AnalysisJob>();
const jobsByKey = new Map<string, string>();
const queue: QueueItem<unknown>[] = [];
let activeJobs = 0;

const concurrency = () => Math.max(1, Number(process.env.ANALYSIS_JOB_CONCURRENCY || 1));
const ttlMs = () => Math.max(60_000, Number(process.env.ANALYSIS_JOB_TTL_MS || 60 * 60 * 1000));

function pruneJobs() {
  const threshold = Date.now() - ttlMs();
  for (const [id, job] of jobs) {
    if (job.updatedAt >= threshold || ['queued', 'processing'].includes(job.status)) continue;
    jobs.delete(id);
    if (jobsByKey.get(job.key) === id) jobsByKey.delete(job.key);
  }
}

function runQueue() {
  while (activeJobs < concurrency() && queue.length) {
    const item = queue.shift()!;
    const { job, task } = item;
    activeJobs += 1;
    job.status = 'processing';
    job.startedAt = Date.now();
    job.updatedAt = job.startedAt;

    void task()
      .then((result) => {
        job.status = 'completed';
        job.result = result;
      })
      .catch((error) => {
        job.status = 'failed';
        job.error = error instanceof Error ? error.message : String(error);
        console.error(`[analysis-job:${job.id}]`, job.error);
      })
      .finally(() => {
        job.completedAt = Date.now();
        job.updatedAt = job.completedAt;
        activeJobs -= 1;
        runQueue();
      });
  }
}

export function enqueueAnalysisJob<T>(key: string, quickResult: unknown, task: () => Promise<T>) {
  pruneJobs();
  const existingId = jobsByKey.get(key);
  const existing = existingId ? jobs.get(existingId) as AnalysisJob<T> | undefined : undefined;
  if (existing && ['queued', 'processing'].includes(existing.status)) return existing;

  const now = Date.now();
  const job: AnalysisJob<T> = {
    id: randomUUID(),
    key,
    status: 'queued',
    quickResult,
    createdAt: now,
    updatedAt: now,
  };
  jobs.set(job.id, job);
  jobsByKey.set(key, job.id);
  queue.push({ job, task } as QueueItem<unknown>);
  setImmediate(runQueue);
  return job;
}

export function getAnalysisJob(id: string) {
  pruneJobs();
  return jobs.get(id) || null;
}

export function analysisJobPayload(job: AnalysisJob) {
  const pending = job.status === 'queued' || job.status === 'processing';
  return {
    ok: job.status !== 'failed',
    jobId: job.id,
    status: job.status,
    pending,
    pollAfterMs: pending ? Number(process.env.ANALYSIS_JOB_POLL_MS || 1500) : undefined,
    mode: pending ? 'fast' : 'complete',
    cache: false,
    result: job.status === 'completed' ? job.result : job.quickResult,
    error: job.error,
    createdAt: new Date(job.createdAt).toISOString(),
    updatedAt: new Date(job.updatedAt).toISOString(),
  };
}
