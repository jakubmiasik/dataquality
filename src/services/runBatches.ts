import type { StoredRun } from '@/services/reconciliationRepository';

/**
 * A batch is the set of runs started by one trigger. Running a single rule
 * produces a batch of one; a bulk run produces one batch covering every rule,
 * so results can be read per trigger rather than rule by rule.
 */
export type RunBatch = {
  id: string;
  runs: StoredRun[];
  ruleCount: number;
  startedAt: Date;
  completedAt?: Date;
  /** `running` until every member settles; `failed` if any member failed. */
  status: 'running' | 'completed' | 'failed';
  recordsA: number;
  recordsB: number;
  keysCompared: number;
  matched: number;
  exceptionCount: number;
  failedCount: number;
  /** Short, stable handle shown to users, e.g. `a1b2c3d4`. */
  shortId: string;
};

function time(value: Date | string | undefined): number {
  if (!value) return 0;
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/** Runs predating batching stand alone, keyed by their own id. */
export function batchKeyOf(run: StoredRun): string {
  return run.batch_id || run.id;
}

export function shortBatchId(batchId: string): string {
  return batchId.replace(/-/g, '').slice(0, 8);
}

/**
 * Groups runs into batches, newest first. Totals are summed across members so a
 * bulk run reports one set of figures.
 */
export function groupRunsIntoBatches(runs: StoredRun[]): RunBatch[] {
  const byBatch = new Map<string, StoredRun[]>();
  for (const run of runs) {
    const key = batchKeyOf(run);
    const bucket = byBatch.get(key);
    if (bucket) bucket.push(run);
    else byBatch.set(key, [run]);
  }

  const batches = [...byBatch.entries()].map(([id, members]) => {
    const ordered = [...members].sort((a, b) => time(a.startedAt) - time(b.startedAt));
    const failedCount = ordered.filter((run) => run.status === 'failed').length;
    const stillRunning = ordered.some((run) => run.status === 'running');
    // A batch is only finished once its slowest member is, so the completion
    // stamp is the latest one and is withheld while anything is still running.
    const lastCompleted = ordered.reduce((latest, run) => Math.max(latest, time(run.completedAt)), 0);

    return {
      id,
      runs: ordered,
      ruleCount: new Set(ordered.map((run) => run.rule_id)).size,
      startedAt: asDate(ordered[0].startedAt),
      completedAt: !stillRunning && lastCompleted ? new Date(lastCompleted) : undefined,
      status: stillRunning ? 'running' : failedCount ? 'failed' : 'completed',
      recordsA: ordered.reduce((sum, run) => sum + (run.recordsA || 0), 0),
      recordsB: ordered.reduce((sum, run) => sum + (run.recordsB || 0), 0),
      keysCompared: ordered.reduce((sum, run) => sum + (run.keysCompared || 0), 0),
      matched: ordered.reduce((sum, run) => sum + (run.matched || 0), 0),
      exceptionCount: ordered.reduce((sum, run) => sum + (run.exceptionCount || 0), 0),
      failedCount,
      shortId: shortBatchId(id),
    } satisfies RunBatch;
  });

  return batches.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
}

/** Selector caption: identifies the batch by id and scope, not by one rule name. */
export function describeBatch(batch: RunBatch, formatDate: (value: Date) => string): string {
  const scope = batch.ruleCount === 1
    ? batch.runs[0].ruleName
    : `${batch.ruleCount} rules`;
  return `Run ${batch.shortId} · ${formatDate(batch.startedAt)} · ${scope}`;
}

export function findBatch(batches: RunBatch[], batchId: string): RunBatch | null {
  return batches.find((batch) => batch.id === batchId) ?? null;
}

/** Creates the identifier shared by every run in one trigger. */
export function newBatchId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `batch-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}
