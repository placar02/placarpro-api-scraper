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
const maxQueuedJobs = () => Math.max(1, Number(process.env.ANALYSIS_JOB_MAX_QUEUE || 50));
const maxStoredJobs = () => Math.max(maxQueuedJobs(), Number(process.env.ANALYSIS_JOB_MAX_STORED || 500));

function queuePosition(job: AnalysisJob) {
  if (job.status !== 'queued') return undefined;
  const index = queue.findIndex((item) => item.job.id === job.id);
  return index >= 0 ? index + 1 : undefined;
}

function statusMessage(job: AnalysisJob) {
  if (job.status === 'queued') {
    const position = queuePosition(job);
    return position && position > 1
      ? `Na fila de analise (${position} na fila)`
      : 'Na fila de analise';
  }
  if (job.status === 'processing') {
    if (job.key.startsWith('full-daily:')) return 'Selecionando partidas com dados fortes';
    if (job.key.startsWith('tournament')) return 'Analisando jogos do campeonato';
    if (job.key.startsWith('teams:')) return 'Localizando partida e cruzando estatisticas';
    return 'Cruzando estatisticas e validando mercado';
  }
  if (job.status === 'completed') return 'Analise concluida';
  return 'Nao foi possivel concluir a analise';
}

function pruneJobs() {
  const threshold = Date.now() - ttlMs();
  for (const [id, job] of jobs) {
    if (job.updatedAt >= threshold || ['queued', 'processing'].includes(job.status)) continue;
    jobs.delete(id);
    if (jobsByKey.get(job.key) === id) jobsByKey.delete(job.key);
  }
  if (jobs.size > maxStoredJobs()) {
    const removable = [...jobs.values()]
      .filter((job) => !['queued', 'processing'].includes(job.status))
      .sort((left, right) => left.updatedAt - right.updatedAt);
    while (jobs.size > maxStoredJobs() && removable.length) {
      const job = removable.shift()!;
      jobs.delete(job.id);
      if (jobsByKey.get(job.key) === job.id) jobsByKey.delete(job.key);
    }
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
  if (queue.length >= maxQueuedJobs()) return null;

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

const cleanupTimer = setInterval(pruneJobs, 60_000);
cleanupTimer.unref?.();

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
    statusMessage: statusMessage(job),
    queuePosition: queuePosition(job),
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
