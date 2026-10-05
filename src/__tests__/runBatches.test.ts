import { describe, expect, it } from 'vitest';
import type { StoredRun } from '@/services/reconciliationRepository';
import { batchKeyOf, describeBatch, findBatch, groupRunsIntoBatches, shortBatchId } from '@/services/runBatches';

function run(overrides: Partial<StoredRun> & Pick<StoredRun, 'id'>): StoredRun {
  return {
    rule_id: `rule-${overrides.id}`,
    ruleVersion: 1,
    ruleName: `Rule ${overrides.id}`,
    status: 'completed',
    recordsA: 10,
    recordsB: 10,
    keysCompared: 10,
    matched: 9,
    exceptionCount: 1,
    summaryJson: '{}',
    startedAt: new Date('2024-05-01T10:00:00Z'),
    completedAt: new Date('2024-05-01T10:01:00Z'),
    runBy: 'tester',
    ...overrides,
  };
}

describe('groupRunsIntoBatches', () => {
  it('treats runs recorded before batching as their own batch', () => {
    const batches = groupRunsIntoBatches([run({ id: 'a' }), run({ id: 'b' })]);
    expect(batches).toHaveLength(2);
    expect(batches.map((batch) => batch.id).sort()).toEqual(['a', 'b']);
    expect(batchKeyOf(run({ id: 'a' }))).toBe('a');
  });

  it('aggregates totals across every rule in one bulk trigger', () => {
    const batches = groupRunsIntoBatches([
      run({ id: 'a', batch_id: 'batch-1', recordsA: 10, recordsB: 20, matched: 5, exceptionCount: 2, keysCompared: 7 }),
      run({ id: 'b', batch_id: 'batch-1', recordsA: 3, recordsB: 4, matched: 1, exceptionCount: 6, keysCompared: 5 }),
    ]);

    expect(batches).toHaveLength(1);
    const [batch] = batches;
    expect(batch.ruleCount).toBe(2);
    expect(batch.recordsA).toBe(13);
    expect(batch.recordsB).toBe(24);
    expect(batch.matched).toBe(6);
    expect(batch.exceptionCount).toBe(8);
    expect(batch.keysCompared).toBe(12);
  });

  it('counts a rule rerun inside one batch only once', () => {
    const [batch] = groupRunsIntoBatches([
      run({ id: 'a', batch_id: 'batch-1', rule_id: 'rule-x' }),
      run({ id: 'b', batch_id: 'batch-1', rule_id: 'rule-x' }),
    ]);
    expect(batch.ruleCount).toBe(1);
    expect(batch.runs).toHaveLength(2);
  });

  it('reports running ahead of failed, and failed ahead of completed', () => {
    const members = (statuses: StoredRun['status'][]) => statuses.map((status, index) => run({ id: `r${index}`, batch_id: 'batch-1', status }));

    expect(groupRunsIntoBatches(members(['completed', 'failed', 'running']))[0].status).toBe('running');
    expect(groupRunsIntoBatches(members(['completed', 'failed']))[0].status).toBe('failed');
    expect(groupRunsIntoBatches(members(['completed', 'completed']))[0].status).toBe('completed');
  });

  it('withholds completion until the slowest member settles', () => {
    const [pending] = groupRunsIntoBatches([
      run({ id: 'a', batch_id: 'batch-1' }),
      run({ id: 'b', batch_id: 'batch-1', status: 'running', completedAt: undefined }),
    ]);
    expect(pending.completedAt).toBeUndefined();

    const [settled] = groupRunsIntoBatches([
      run({ id: 'a', batch_id: 'batch-1', completedAt: new Date('2024-05-01T10:01:00Z') }),
      run({ id: 'b', batch_id: 'batch-1', completedAt: new Date('2024-05-01T10:09:00Z') }),
    ]);
    expect(settled.completedAt?.toISOString()).toBe('2024-05-01T10:09:00.000Z');
  });

  it('orders batches newest first and members oldest first', () => {
    const batches = groupRunsIntoBatches([
      run({ id: 'old', batch_id: 'batch-old', startedAt: new Date('2024-05-01T10:00:00Z') }),
      run({ id: 'new-second', batch_id: 'batch-new', startedAt: new Date('2024-05-02T10:05:00Z') }),
      run({ id: 'new-first', batch_id: 'batch-new', startedAt: new Date('2024-05-02T10:00:00Z') }),
    ]);

    expect(batches.map((batch) => batch.id)).toEqual(['batch-new', 'batch-old']);
    expect(batches[0].runs.map((member) => member.id)).toEqual(['new-first', 'new-second']);
    expect(batches[0].startedAt.toISOString()).toBe('2024-05-02T10:00:00.000Z');
  });
});

describe('batch identifiers', () => {
  it('shortens a uuid to a stable handle', () => {
    expect(shortBatchId('3f2a9c1d-55b0-4a2e-9f10-aabbccddeeff')).toBe('3f2a9c1d');
  });

  it('names a single-rule batch by its rule and a bulk batch by its size', () => {
    const format = () => 'May 1';
    const [single] = groupRunsIntoBatches([run({ id: 'a', batch_id: 'batch-1', ruleName: 'Ledger vs GL' })]);
    expect(describeBatch(single, format)).toBe('Run batch1 · May 1 · Ledger vs GL');

    const [bulk] = groupRunsIntoBatches([
      run({ id: 'a', batch_id: 'batch-2', rule_id: 'rule-a' }),
      run({ id: 'b', batch_id: 'batch-2', rule_id: 'rule-b' }),
    ]);
    expect(describeBatch(bulk, format)).toBe('Run batch2 · May 1 · 2 rules');
  });

  it('returns null for an unknown batch', () => {
    const batches = groupRunsIntoBatches([run({ id: 'a', batch_id: 'batch-1' })]);
    expect(findBatch(batches, 'batch-1')?.id).toBe('batch-1');
    expect(findBatch(batches, 'missing')).toBeNull();
  });
});
