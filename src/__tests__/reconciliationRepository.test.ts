import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getRayfinClient } = vi.hoisted(() => ({ getRayfinClient: vi.fn() }));
vi.mock('@/services/rayfinClient', () => ({ getRayfinClient }));

import { claimSchedule, comparePortfolio, normalizeRowLimit, setRuleEnabled, type StoredRule, type StoredRun, type StoredSchedule } from '@/services/reconciliationRepository';
import type { CompareField } from '@/services/reconciliationEngine';

type Row = Record<string, unknown>;

/**
 * Stands in for the Rayfin GraphQL client, reproducing the behaviour that broke
 * these call sites: a query returns only the columns it asked for, and
 * `findById` asks for the primary key alone.
 */
function fakeClient(tables: Record<string, Row[]>) {
  const writes: Record<string, Row[]> = {};
  const entity = (name: string) => {
    const rows = tables[name] ?? [];
    const builder = () => {
      let columns: string[] | null = null;
      let predicate: Row | null = null;
      const self = {
        select(cols: string[]) { columns = cols; return self; },
        where(clause: Row) { predicate = clause; return self; },
        orderBy() { return self; },
        first() { return self; },
        after() { return self; },
        executePaginated: async () => {
          let items = rows;
          if (predicate) {
            items = items.filter((row) => Object.entries(predicate!).every(([field, condition]) => {
              const eq = (condition as { eq?: unknown }).eq;
              return eq === undefined || row[field] === eq;
            }));
          }
          if (columns) {
            items = items.map((row) => Object.fromEntries(columns!.map((column) => [column, row[column]])));
          }
          return { items, hasNextPage: false, endCursor: null };
        },
      };
      return self;
    };
    return {
      select: (cols: string[]) => builder().select(cols),
      // Faithful to the real client: the generated query projects only the key.
      findById: async (id: string) => (rows.some((row) => row.id === id) ? { id } : null),
      create: async (values: Row) => {
        (writes[name] ??= []).push(values);
        return { id: `${name}-new`, ...values };
      },
      update: async (_where: Row, values: Row) => {
        (writes[`${name}:update`] ??= []).push(values);
        return values;
      },
      delete: async () => ({}),
    };
  };
  return {
    client: { data: new Proxy({}, { get: (_target, name: string) => entity(name) }) },
    writes,
  };
}

const compareFields: CompareField[] = [{
  label: 'Amount',
  type: 'number',
  a: { kind: 'field', value: 'Amount' },
  b: { kind: 'field', value: 'Amount' },
}];

const completeRule: Row = {
  id: 'rule-1',
  name: 'Ledger vs warehouse',
  priority: 'medium',
  status: 'draft',
  version: 3,
  sourceAId: 'source-a',
  sourceBId: 'source-b',
  datasetA: 'dbo.Ledger',
  datasetB: 'dbo.Warehouse',
  keyFieldA: 'Id',
  keyFieldB: 'Id',
  ruleGroup: 'ungrouped',
  duplicateHandling: 'exception',
  incompleteKeyHandling: 'exception',
  rowLimit: 1000,
  enabled: false,
  user_id: 'user-1',
};

const sources: Row[] = [
  { id: 'source-a', itemType: 'Lakehouse' },
  { id: 'source-b', itemType: 'Warehouse' },
];

beforeEach(() => vi.clearAllMocks());

describe('setRuleEnabled', () => {
  it('enables a rule whose sources, datasets and keys are all set', async () => {
    const { client, writes } = fakeClient({ ReconciliationRule: [completeRule], ReconciliationSource: sources });
    getRayfinClient.mockReturnValue(client);

    await expect(
      setRuleEnabled(completeRule as unknown as StoredRule, compareFields, true, 'user-1', 'Tester')
    ).resolves.toBeUndefined();

    const [update] = writes['ReconciliationRule:update'];
    expect(update).toMatchObject({ enabled: true, status: 'active', version: 4 });
  });

  it('still rejects a rule that is genuinely incomplete', async () => {
    const incomplete = { ...completeRule, keyFieldB: '' };
    const { client } = fakeClient({ ReconciliationRule: [incomplete], ReconciliationSource: sources });
    getRayfinClient.mockReturnValue(client);

    await expect(
      setRuleEnabled(incomplete as unknown as StoredRule, compareFields, true, 'user-1', 'Tester')
    ).rejects.toThrow(/Complete both sources, datasets and business keys/);
  });

  it('records a version snapshot that carries the rule definition', async () => {
    const { client, writes } = fakeClient({ ReconciliationRule: [completeRule], ReconciliationSource: sources });
    getRayfinClient.mockReturnValue(client);

    await setRuleEnabled(completeRule as unknown as StoredRule, compareFields, true, 'user-1', 'Tester');

    const snapshot = JSON.parse(writes.ReconciliationRuleVersion[0].snapshot as string) as Row;
    expect(snapshot).toMatchObject({ datasetA: 'dbo.Ledger', keyFieldA: 'Id', version: 4 });
  });
});

describe('claimSchedule', () => {
  const dueAt = new Date('2026-01-01T06:00:00.000Z');
  const schedule: Row = {
    id: 'schedule-1',
    rule_id: 'rule-1',
    ruleName: 'Ledger vs warehouse',
    enabled: true,
    cadence: 'daily',
    intervalCount: 1,
    hourUtc: 6,
    minuteUtc: 0,
    dayOfWeek: 0,
    nextDueAt: dueAt,
    user_id: 'user-1',
  };

  it('claims a due schedule and advances its next occurrence', async () => {
    const { client, writes } = fakeClient({ ReconciliationSchedule: [schedule] });
    getRayfinClient.mockReturnValue(client);

    const claimed = await claimSchedule(schedule as unknown as StoredSchedule, dueAt);

    expect(claimed).toBe(true);
    const [update] = writes['ReconciliationSchedule:update'];
    expect(update.lastStatus).toBe('running');
    expect(new Date(update.nextDueAt as Date).getTime()).toBeGreaterThan(dueAt.getTime());
  });

  it('declines a slot another sweep already advanced', async () => {
    const moved = { ...schedule, nextDueAt: new Date('2026-01-02T06:00:00.000Z') };
    const { client } = fakeClient({ ReconciliationSchedule: [moved] });
    getRayfinClient.mockReturnValue(client);

    await expect(claimSchedule(schedule as unknown as StoredSchedule, dueAt)).resolves.toBe(false);
  });
});

describe('normalizeRowLimit', () => {
  it('keeps the capped default when no limit was supplied', () => {
    expect(normalizeRowLimit(undefined)).toBe(10000);
    expect(normalizeRowLimit(null)).toBe(10000);
    expect(normalizeRowLimit('')).toBe(10000);
  });

  it('treats an explicit zero as "read every row" and caps everything else', () => {
    expect(normalizeRowLimit(0)).toBe(0);
    expect(normalizeRowLimit(250)).toBe(250);
    expect(normalizeRowLimit(999999)).toBe(10000);
  });
});

describe('comparePortfolio', () => {
  const run = (id: string, ruleId: string, startedAt: string, exceptionCount: number): Row => ({
    id, rule_id: ruleId, ruleName: `Rule ${ruleId}`, ruleVersion: 1, status: 'completed',
    recordsA: 10, recordsB: 10, keysCompared: 10, matched: 10 - exceptionCount, exceptionCount,
    summaryJson: '{}', startedAt: new Date(startedAt), runBy: 'Tester',
  });
  const finding = (runId: string, ruleId: string, fingerprint: string): Row => ({
    id: `${runId}-${fingerprint}`, run_id: runId, rule_id: ruleId, fingerprint,
    businessKey: fingerprint, outcome: 'value_mismatch', severity: 'medium',
    detailJson: '{}', recordedAt: new Date(), user_id: 'user-1',
  });

  it('pairs every rule with its own runs and sums the per-rule results', async () => {
    const runs = [
      run('a-old', 'rule-a', '2026-01-01T00:00:00.000Z', 1),
      run('a-new', 'rule-a', '2026-01-03T00:00:00.000Z', 1),
      run('b-old', 'rule-b', '2026-01-01T00:00:00.000Z', 1),
      run('b-new', 'rule-b', '2026-01-03T00:00:00.000Z', 0),
    ];
    const { client } = fakeClient({
      ReconciliationFinding: [
        finding('a-old', 'rule-a', 'a-key-1'),
        finding('a-new', 'rule-a', 'a-key-2'),
        finding('b-old', 'rule-b', 'b-key-1'),
      ],
    });
    getRayfinClient.mockReturnValue(client);

    const result = await comparePortfolio(runs as unknown as StoredRun[], new Date('2026-01-02T00:00:00.000Z'), new Date('2026-01-04T00:00:00.000Z'));

    expect(result.rulesCompared).toBe(2);
    // rule-a swapped one finding for another, rule-b fixed its only finding.
    expect(result.aggregate.newlyFailing.map((entry) => entry.fingerprint)).toEqual(['a-key-2']);
    expect(result.aggregate.fixed.map((entry) => entry.fingerprint).sort()).toEqual(['a-key-1', 'b-key-1']);
    expect(result.aggregate.verdict).toBe('churn');
    expect(result.aggregate.metrics.exceptionCount).toMatchObject({ from: 2, to: 1, delta: -1 });
  });

  it('skips a rule with no run before the earlier moment', async () => {
    const runs = [run('a-new', 'rule-a', '2026-01-03T00:00:00.000Z', 0)];
    const { client } = fakeClient({ ReconciliationFinding: [] });
    getRayfinClient.mockReturnValue(client);

    const result = await comparePortfolio(runs as unknown as StoredRun[], new Date('2026-01-02T00:00:00.000Z'), new Date('2026-01-04T00:00:00.000Z'));

    expect(result.rulesCompared).toBe(0);
    expect(result.rulesSkipped).toBe(1);
  });
});
