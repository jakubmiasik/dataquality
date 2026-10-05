import { describe, expect, it } from 'vitest';

import { buildComparisonRows, parseExceptionDetail } from '@/services/exceptionDetail';
import type { StoredException } from '@/services/reconciliationRepository';

function exceptionWith(detail: unknown): StoredException {
  return { detailJson: JSON.stringify(detail) } as StoredException;
}

describe('exception comparison rows', () => {
  it('keeps the surviving side visible when a record is missing from source A', () => {
    const { rows, recordNote } = buildComparisonRows(parseExceptionDetail(exceptionWith({
      valuesA: null,
      valuesB: { CustomerID: 'C011', Email: 'new@contoso.com' },
      differences: [{ field: 'record', reason: 'Present in source B, absent from source A.' }],
    })));

    expect(recordNote).toBe('Present in source B, absent from source A.');
    expect(rows.map((row) => row.field)).toEqual(['CustomerID', 'Email']);
    const email = rows.find((row) => row.field === 'Email');
    expect(email).toMatchObject({ valueA: null, valueB: 'new@contoso.com', presentA: false, presentB: true });
  });

  it('keeps the surviving side visible when a record is missing from source B', () => {
    const { rows } = buildComparisonRows(parseExceptionDetail(exceptionWith({
      valuesA: { CustomerID: 'C003', Email: 'left@contoso.com' },
      valuesB: null,
      differences: [{ field: 'record', reason: 'Present in source A, absent from source B.' }],
    })));

    expect(rows.find((row) => row.field === 'Email')).toMatchObject({ valueA: 'left@contoso.com', presentA: true, presentB: false });
  });

  it('prefers the per-field difference values over the stored row snapshot', () => {
    const { rows, recordNote } = buildComparisonRows(parseExceptionDetail(exceptionWith({
      valuesA: { Email: 'snapshot-a', Notes: 'same' },
      valuesB: { Email: 'snapshot-b', Notes: 'same' },
      differences: [{ field: 'Email', valueA: 'a@contoso.com', valueB: 'b@contoso.com', reason: 'Values differ' }],
    })));

    expect(recordNote).toBeNull();
    expect(rows[0]).toMatchObject({ field: 'Email', valueA: 'a@contoso.com', valueB: 'b@contoso.com', note: 'Values differ' });
    // Unchanged fields still appear so both sides can be read in full.
    expect(rows[1]).toMatchObject({ field: 'Notes', valueA: 'same', valueB: 'same', note: null });
  });

  it('reports a numeric tolerance breach as the difference note', () => {
    const { rows } = buildComparisonRows(parseExceptionDetail(exceptionWith({
      valuesA: { Amount: 100 },
      valuesB: { Amount: 97 },
      differences: [{ field: 'Amount', valueA: 100, valueB: 97, difference: -3 }],
    })));

    expect(rows[0].note).toBe('-3');
  });

  it('survives unparseable detail payloads', () => {
    const { rows, recordNote } = buildComparisonRows(parseExceptionDetail({ detailJson: 'not json' } as StoredException));
    expect(rows).toEqual([]);
    expect(recordNote).toBeNull();
  });
});
