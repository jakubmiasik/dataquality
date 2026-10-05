import { describe, expect, it } from 'vitest';

import {
  buildSelectSql,
  compareFindings,
  planRule,
  reconcile,
  validateSqlExpression,
  type CompareField,
  type ReconciliationRule,
} from '@/services/reconciliationEngine';

const compareFields: CompareField[] = [
  { label: 'Customer', a: { kind: 'field', value: 'Customer' }, b: { kind: 'expression', value: 'TRIM(CustomerName)' }, type: 'string' },
  { label: 'Amount', a: { kind: 'field', value: 'NetAmount' }, b: { kind: 'field', value: 'Net' }, type: 'number', tolerance: { type: 'absolute', value: 0.01 } },
];

const rule: ReconciliationRule = {
  id: 'rule-1',
  keyFieldA: 'InvoiceNumber',
  keyFieldB: 'Invoice_No',
  compareFields,
};

describe('reconciliation engine', () => {
  it('plans each source with stable aliases and preserves source-specific operands', () => {
    const plan = planRule(rule);
    expect(plan.selectionsA.map(({ alias }) => alias)).toEqual(['recon_key', 'recon_c0a', 'recon_c1a']);
    expect(plan.selectionsB[1]).toMatchObject({ alias: 'recon_c0b', kind: 'expression' });
    expect(plan.engineRule.compareFields[0].b.value).toBe('recon_c0b');
  });

  it('builds a bounded grouped SQL projection with safely quoted identifiers', () => {
    expect(buildSelectSql({
      dataset: 'dbo.Postings',
      rowLimit: 400000,
      selections: [
        { alias: 'recon_key', kind: 'field', value: 'Account' },
        { alias: 'recon_c0a', kind: 'aggregate', fn: 'sum', valueKind: 'field', value: 'Amount' },
      ],
    })).toBe('SELECT TOP (10000) [Account] AS [recon_key], SUM([Amount]) AS [recon_c0a] FROM [dbo].[Postings] GROUP BY [Account]');
    expect(() => buildSelectSql({ dataset: 'dbo.Users; DROP TABLE X', selections: [{ alias: 'k', kind: 'field', value: 'id' }] })).toThrow();
  });

  it('allows scalar SQL logic while refusing statements and comments', () => {
    expect(validateSqlExpression("CASE WHEN Status = 1 THEN 'Posted' ELSE 'Draft' END")).toBeNull();
    expect(validateSqlExpression('CAST(Amount AS decimal(18,2))')).toBeNull();
    expect(validateSqlExpression('Amount; DROP TABLE Invoices')).toMatch(/separators/i);
    expect(validateSqlExpression('Amount -- comment')).toMatch(/comments/i);
    expect(validateSqlExpression('(SELECT Value FROM OtherTable)')).toMatch(/read-only/i);
  });

  it('finds value mismatches, missing rows, duplicates and blank keys', () => {
    const planned = planRule(rule);
    const result = reconcile({
      rule: planned.engineRule,
      rowsA: [
        { recon_key: 'INV-1', recon_c0a: 'Acme', recon_c1a: 100 },
        { recon_key: 'INV-2', recon_c0a: 'Left', recon_c1a: 7 },
        { recon_key: 'INV-3', recon_c0a: 'Dup', recon_c1a: 1 },
        { recon_key: 'INV-3', recon_c0a: 'Dup', recon_c1a: 1 },
        { recon_key: 'INV-5', recon_c0a: 'Only left', recon_c1a: 9 },
        { recon_key: '', recon_c0a: 'No key', recon_c1a: 0 },
      ],
      rowsB: [
        { recon_key: 'INV-1', recon_c0b: 'Acme', recon_c1b: 100 },
        { recon_key: 'INV-2', recon_c0b: 'Right', recon_c1b: 7 },
        { recon_key: 'INV-4', recon_c0b: 'Other', recon_c1b: 4 },
      ],
    });
    expect(result.summary).toMatchObject({ matched: 1, exceptions: 5, passed: false });
    expect(result.summary.counts).toMatchObject({ value_mismatch: 1, missing_from_b: 1, missing_from_a: 1, duplicate: 1, invalid_key: 1 });
  });

  it('uses numeric and date tolerances and case-insensitive trimmed text keys', () => {
    const tolerantRule: ReconciliationRule = {
      ...rule,
      compareFields: [
        { label: 'Amount', a: { kind: 'field', value: 'amountA' }, b: { kind: 'field', value: 'amountB' }, type: 'number', tolerance: { type: 'percent', value: 1 } },
        { label: 'Date', a: { kind: 'field', value: 'dateA' }, b: { kind: 'field', value: 'dateB' }, type: 'date', tolerance: { type: 'days', value: 1 } },
      ],
    };
    const result = reconcile({
      rule: tolerantRule,
      rowsA: [{ InvoiceNumber: ' inv-1 ', amountA: 100, dateA: '2026-01-01' }],
      rowsB: [{ Invoice_No: 'INV-1', amountB: 100.5, dateB: '2026-01-02' }],
    });
    expect(result.summary.passed).toBe(true);
  });

  it('compares run findings by their stable fingerprint', () => {
    const first = reconcile({ rule, rowsA: [{ InvoiceNumber: 'A', Customer: 'Left', NetAmount: 1 }], rowsB: [] }).findings;
    const second = reconcile({ rule, rowsA: [{ InvoiceNumber: 'A', Customer: 'Left', NetAmount: 1 }, { InvoiceNumber: 'B', Customer: 'New', NetAmount: 2 }], rowsB: [] }).findings;
    const diff = compareFindings(first, second);
    expect(diff.stillFailing).toHaveLength(1);
    expect(diff.newlyFailing.map((finding) => finding.businessKey)).toEqual(['B']);
    expect(diff.fixed).toHaveLength(0);
  });
});