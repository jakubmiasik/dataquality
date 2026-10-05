import type { StoredException } from './reconciliationRepository';

export interface ExceptionDifference {
  field: string;
  valueA?: unknown;
  valueB?: unknown;
  difference?: number | null;
  reason?: string;
}

export interface ExceptionDetail {
  valuesA?: Record<string, unknown> | null;
  valuesB?: Record<string, unknown> | null;
  differences?: ExceptionDifference[];
}

export function parseExceptionDetail(exception: StoredException): ExceptionDetail {
  try {
    return JSON.parse(exception.detailJson) as ExceptionDetail;
  } catch {
    return { valuesA: null, valuesB: null, differences: [] };
  }
}

export interface ComparisonRow {
  field: string;
  valueA: unknown;
  valueB: unknown;
  /** False when the whole record is absent on that side, which reads differently from a null value. */
  presentA: boolean;
  presentB: boolean;
  note: string | null;
}

/**
 * Missing-record findings store the surviving side in `valuesA`/`valuesB` plus a
 * single synthetic `record` difference that carries no values. Rendering the
 * differences alone therefore showed two empty columns, so rows are built from
 * the union of every field the finding knows about and the record-level note is
 * surfaced separately.
 */
export function buildComparisonRows(detail: ExceptionDetail): { rows: ComparisonRow[]; recordNote: string | null } {
  const differences = detail.differences ?? [];
  const valuesA = detail.valuesA ?? null;
  const valuesB = detail.valuesB ?? null;
  const recordDifference = differences.find((difference) => difference.field === 'record');
  const fieldDifferences = differences.filter((difference) => difference.field !== 'record');
  const fields: string[] = [];
  const addField = (field: string) => { if (field && !fields.includes(field)) fields.push(field); };
  fieldDifferences.forEach((difference) => addField(difference.field));
  Object.keys(valuesA ?? {}).forEach(addField);
  Object.keys(valuesB ?? {}).forEach(addField);
  const rows = fields.map((field) => {
    const difference = fieldDifferences.find((candidate) => candidate.field === field);
    const carriesA = difference ? 'valueA' in difference : false;
    const carriesB = difference ? 'valueB' in difference : false;
    return {
      field,
      valueA: (carriesA ? difference?.valueA : valuesA?.[field]) ?? null,
      valueB: (carriesB ? difference?.valueB : valuesB?.[field]) ?? null,
      presentA: Boolean(valuesA) || carriesA,
      presentB: Boolean(valuesB) || carriesB,
      note: difference ? (difference.difference != null ? String(difference.difference) : difference.reason ?? 'Different') : null,
    } satisfies ComparisonRow;
  });
  return { rows, recordNote: recordDifference?.reason ?? null };
}
