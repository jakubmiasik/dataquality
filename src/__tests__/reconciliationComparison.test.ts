import { describe, expect, it } from 'vitest';

import {
  compareFindings,
  metricDelta,
  reconcile,
  validateCompareFields,
  type CompareField,
  type ReconciliationRule,
} from '../services/reconciliationEngine';

const field = (overrides: Partial<CompareField> = {}): CompareField => ({
  label: 'Amount',
  a: { kind: 'field', value: 'amount_a' },
  b: { kind: 'field', value: 'amount_b' },
  type: 'number',
  ...overrides,
});

const rule = (compareFields: CompareField[], overrides: Partial<ReconciliationRule> = {}): ReconciliationRule => ({
  id: 'rule-1',
  keyFieldA: 'key',
  keyFieldB: 'key',
  compareFields,
  ...overrides,
});

function run(compareFields: CompareField[], a: Record<string, unknown>, b: Record<string, unknown>, overrides?: Partial<ReconciliationRule>) {
  return reconcile({ rowsA: [{ key: 'K1', ...a }], rowsB: [{ key: 'K1', ...b }], rule: rule(compareFields, overrides) });
}

describe('string comparison options', () => {
  it('trims by default but stays case sensitive', () => {
    const spec = [field({ label: 'Name', type: 'string', a: { kind: 'field', value: 'n_a' }, b: { kind: 'field', value: 'n_b' } })];
    expect(run(spec, { n_a: ' Ada ' }, { n_b: 'Ada' }).summary.matched).toBe(1);
    expect(run(spec, { n_a: 'Ada' }, { n_b: 'ada' }).summary.exceptions).toBe(1);
  });

  it('honours caseInsensitive and trim independently', () => {
    const insensitive = [field({ label: 'Name', type: 'string', caseInsensitive: true, a: { kind: 'field', value: 'n_a' }, b: { kind: 'field', value: 'n_b' } })];
    expect(run(insensitive, { n_a: 'Ada' }, { n_b: 'ada' }).summary.matched).toBe(1);

    const untrimmed = [field({ label: 'Name', type: 'string', trim: false, a: { kind: 'field', value: 'n_a' }, b: { kind: 'field', value: 'n_b' } })];
    expect(run(untrimmed, { n_a: ' Ada' }, { n_b: 'Ada' }).summary.exceptions).toBe(1);
  });
});

describe('numeric and date tolerance', () => {
  it('matches inside an absolute tolerance and fails outside it', () => {
    const spec = [field({ tolerance: { type: 'absolute', value: 0.5 } })];
    expect(run(spec, { amount_a: 100 }, { amount_b: 100.4 }).summary.matched).toBe(1);
    expect(run(spec, { amount_a: 100 }, { amount_b: 100.6 }).summary.exceptions).toBe(1);
  });

  it('treats percent tolerance relative to the first side', () => {
    const spec = [field({ tolerance: { type: 'percent', value: 1 } })];
    expect(run(spec, { amount_a: 1000 }, { amount_b: 1009 }).summary.matched).toBe(1);
    expect(run(spec, { amount_a: 1000 }, { amount_b: 1011 }).summary.exceptions).toBe(1);
  });

  it('compares date tolerance on elapsed time rather than rounded days', () => {
    const spec = [field({
      label: 'Posted',
      type: 'date',
      tolerance: { type: 'days', value: 1 },
      a: { kind: 'field', value: 'd_a' },
      b: { kind: 'field', value: 'd_b' },
    })];
    // 23 hours apart is inside a one-day tolerance.
    expect(run(spec, { d_a: '2024-03-05T00:00:00Z' }, { d_b: '2024-03-05T23:00:00Z' }).summary.matched).toBe(1);
    // 25 hours apart is outside it, even though both rounded to "1 day".
    expect(run(spec, { d_a: '2024-03-05T00:00:00Z' }, { d_b: '2024-03-06T01:00:00Z' }).summary.exceptions).toBe(1);
  });
});

describe('boolean coercion', () => {
  it('matches recognised truthy spellings across sources', () => {
    const spec = [field({ label: 'Active', type: 'boolean', a: { kind: 'field', value: 'f_a' }, b: { kind: 'field', value: 'f_b' } })];
    expect(run(spec, { f_a: 1 }, { f_b: 'true' }).summary.matched).toBe(1);
    expect(run(spec, { f_a: 'Y' }, { f_b: true }).summary.matched).toBe(1);
  });

  it('reports an unrecognised value instead of silently treating it as false', () => {
    const spec = [field({ label: 'Active', type: 'boolean', a: { kind: 'field', value: 'f_a' }, b: { kind: 'field', value: 'f_b' } })];
    const result = run(spec, { f_a: 'maybe' }, { f_b: false });
    expect(result.summary.exceptions).toBe(1);
    expect(result.findings[0].differences[0].reason).toMatch(/true\/false/i);
  });
});

describe('validateCompareFields', () => {
  it('rejects nonsensical tolerances', () => {
    expect(validateCompareFields([field({ tolerance: { type: 'absolute', value: -1 } })])).not.toEqual([]);
    expect(validateCompareFields([field({ tolerance: { type: 'percent', value: 150 } })])).not.toEqual([]);
    expect(validateCompareFields([field({ tolerance: { type: 'days', value: 1 } })])).not.toEqual([]);
    expect(validateCompareFields([field({ type: 'date', tolerance: { type: 'absolute', value: 1 } })])).not.toEqual([]);
    expect(validateCompareFields([field({ type: 'string', tolerance: { type: 'absolute', value: 1 } })])).not.toEqual([]);
  });

  it('accepts matching type and tolerance pairs', () => {
    expect(validateCompareFields([field({ tolerance: { type: 'absolute', value: 1 } })])).toEqual([]);
    expect(validateCompareFields([field({
      type: 'date',
      tolerance: { type: 'days', value: 2 },
      a: { kind: 'field', value: 'd_a' },
      b: { kind: 'field', value: 'd_b' },
    })])).toEqual([]);
  });
});

describe('ignored duplicates and invalid keys', () => {
  it('counts rather than silently drops ignored rows', () => {
    const result = reconcile({
      rowsA: [{ key: 'K1', amount_a: 1 }, { key: 'K1', amount_a: 1 }, { key: null, amount_a: 1 }],
      rowsB: [{ key: 'K1', amount_b: 1 }],
      rule: rule([field()], { duplicateHandling: 'ignore', incompleteKeyHandling: 'ignore' }),
    });
    expect(result.summary.duplicatesIgnored).toBeGreaterThan(0);
    expect(result.summary.invalidKeysIgnored).toBeGreaterThan(0);
  });

  it('keeps multiple invalid-key rows distinct', () => {
    const result = reconcile({
      rowsA: [{ key: null, amount_a: 1 }, { key: null, amount_a: 2 }],
      rowsB: [],
      rule: rule([field()], { incompleteKeyHandling: 'exception' }),
    });
    const invalid = result.findings.filter((finding) => finding.outcome === 'invalid_key');
    expect(invalid).toHaveLength(2);
    expect(new Set(invalid.map((finding) => finding.fingerprint)).size).toBe(2);
  });
});

describe('compareFindings verdicts', () => {
  const finding = (fingerprint: string, difference: number) => ({
    fingerprint,
    businessKey: fingerprint,
    outcome: 'value_mismatch' as const,
    severity: 'medium' as const,
    valuesA: null,
    valuesB: null,
    differences: [{ field: 'Amount', difference }],
  });

  it('reports a clean comparison when neither run had findings', () => {
    expect(compareFindings([], []).verdict).toBe('clean');
  });

  it('reports better when findings were fixed', () => {
    const comparison = compareFindings([finding('f1', 1), finding('f2', 1)], [finding('f1', 1)]);
    expect(comparison.verdict).toBe('better');
    expect(comparison.fixed.map((item) => item.fingerprint)).toEqual(['f2']);
  });

  it('reports worse when new findings appeared', () => {
    const comparison = compareFindings([finding('f1', 1)], [finding('f1', 1), finding('f2', 1)]);
    expect(comparison.verdict).toBe('worse');
    expect(comparison.newlyFailing.map((item) => item.fingerprint)).toEqual(['f2']);
  });

  it('reports churn when the same count hides a swap', () => {
    expect(compareFindings([finding('f1', 1)], [finding('f2', 1)]).verdict).toBe('churn');
  });

  it('separates findings that persisted but changed', () => {
    const comparison = compareFindings([finding('f1', 1)], [finding('f1', 9)]);
    expect(comparison.verdict).toBe('churn');
    expect(comparison.changed).toHaveLength(1);
    expect(comparison.changed[0].before.differences[0].difference).toBe(1);
    expect(comparison.changed[0].after.differences[0].difference).toBe(9);
    expect(comparison.stillFailing.map((item) => item.fingerprint)).toEqual(['f1']);
  });

  it('reports unchanged when a persisting finding is identical', () => {
    const comparison = compareFindings([finding('f1', 1)], [finding('f1', 1)]);
    expect(comparison.verdict).toBe('unchanged');
    expect(comparison.changed).toEqual([]);
  });
});

describe('metricDelta', () => {
  it('describes direction and percentage change', () => {
    expect(metricDelta(100, 120)).toMatchObject({ from: 100, to: 120, delta: 20, percentChange: 20, direction: 'up' });
    expect(metricDelta(100, 80)).toMatchObject({ delta: -20, percentChange: -20, direction: 'down' });
    expect(metricDelta(100, 100)).toMatchObject({ delta: 0, direction: 'flat' });
  });

  it('avoids dividing by zero', () => {
    expect(metricDelta(0, 5).percentChange).toBeNull();
  });
});
