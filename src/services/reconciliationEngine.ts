export type OperandKind = 'field' | 'expression' | 'constant' | 'aggregate';
export type CompareType = 'string' | 'number' | 'date' | 'boolean';

export interface Operand {
  kind: OperandKind;
  value: string;
  fn?: 'sum' | 'count' | 'countDistinct' | 'avg' | 'min' | 'max';
  valueKind?: 'field' | 'expression';
}

export interface CompareField {
  label: string;
  a: Operand;
  b: Operand;
  type: CompareType;
  tolerance?: { type: 'absolute' | 'percent' | 'days'; value: number };
  caseInsensitive?: boolean;
  trim?: boolean;
}

export interface ReconciliationRule {
  id?: string;
  keyFieldA: string;
  keyFieldB: string;
  compareFields: CompareField[];
  priority?: 'low' | 'medium' | 'high';
  duplicateHandling?: 'exception' | 'first' | 'ignore';
  incompleteKeyHandling?: 'exception' | 'ignore';
}

export interface SourceSelection extends Operand {
  alias: string;
}

export interface PlannedRule {
  selectionsA: SourceSelection[];
  selectionsB: SourceSelection[];
  engineRule: ReconciliationRule & { aggregatedA: boolean; aggregatedB: boolean };
}

export type ReconciliationOutcome =
  | 'missing_from_a'
  | 'missing_from_b'
  | 'value_mismatch'
  | 'duplicate'
  | 'invalid_key';

export interface ReconciliationFinding {
  fingerprint: string;
  businessKey: string;
  /** Distinguishes findings that share a business key, e.g. several rows with no key at all. */
  discriminator?: string;
  outcome: ReconciliationOutcome;
  severity: 'high' | 'medium' | 'low';
  side?: 'A' | 'B';
  valuesA: Record<string, unknown> | null;
  valuesB: Record<string, unknown> | null;
  differences: Array<{
    field: string;
    valueA?: unknown;
    valueB?: unknown;
    difference?: number | null;
    reason?: string;
  }>;
  countA?: number;
  countB?: number;
}

export interface ReconciliationResult {
  summary: {
    recordsA: number;
    recordsB: number;
    keysCompared: number;
    matched: number;
    exceptions: number;
    counts: Record<ReconciliationOutcome, number>;
    duplicatesIgnored: number;
    invalidKeysIgnored: number;
    passed: boolean;
  };
  findings: ReconciliationFinding[];
}

/** Largest number of rows the gateway will ever project from a source. */
export const MAX_ROW_LIMIT = 10000;
export const DEFAULT_ROW_LIMIT = 10000;

const aggregateFunctions = {
  sum: 'SUM',
  count: 'COUNT',
  countDistinct: 'COUNT',
  avg: 'AVG',
  min: 'MIN',
  max: 'MAX',
} as const;

const outcomeSeverity: Record<ReconciliationOutcome, ReconciliationFinding['severity']> = {
  missing_from_a: 'high',
  missing_from_b: 'high',
  value_mismatch: 'medium',
  duplicate: 'medium',
  invalid_key: 'low',
};

export function validateSqlExpression(value: string): string | null {
  const expression = value.trim();
  if (!expression) return 'The expression is empty.';
  if (expression.length > 1000) return 'The expression exceeds 1000 characters.';

  let depth = 0;
  let searchable = '';
  for (let index = 0; index < expression.length; index += 1) {
    const char = expression[index];
    const next = expression[index + 1];
    if ((char === '-' && next === '-') || (char === '/' && next === '*')) {
      return 'SQL comments are not allowed.';
    }
    if (char === ';') return 'Statement separators are not allowed.';
    if (char === "'" || char === '"' || char === '[') {
      const close = char === '[' ? ']' : char;
      let closed = false;
      for (index += 1; index < expression.length; index += 1) {
        if (expression[index] !== close) continue;
        if (expression[index + 1] === close && close !== ']') {
          index += 1;
          continue;
        }
        if (expression[index + 1] === ']' && close === ']') {
          index += 1;
          continue;
        }
        closed = true;
        break;
      }
      if (!closed) return 'The expression contains an unclosed quote or identifier.';
      searchable += ' ';
      continue;
    }
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (depth < 0) return 'The expression has unbalanced parentheses.';
    searchable += char;
  }
  if (depth !== 0) return 'The expression has unbalanced parentheses.';
  if (/\b(select|from|insert|update|delete|merge|drop|alter|create|truncate|exec(?:ute)?|grant|revoke|backup|restore|shutdown|waitfor|openrowset|openquery|union)\b/i.test(searchable)) {
    return 'Only read-only scalar expressions are allowed.';
  }
  return null;
}

export function quoteIdentifier(value: string): string {
  const parts = value.trim().split('.');
  if (!parts.length || parts.some((part) => !/^[A-Za-z0-9_#$@ -]+$/.test(part.trim()))) {
    throw new Error(`Unsupported SQL identifier: ${value}`);
  }
  return parts.map((part) => `[${part.trim()}]`).join('.');
}

function aggregateSql(operand: Operand): string {
  const fn = aggregateFunctions[operand.fn ?? 'sum'];
  if (!fn) throw new Error('Unsupported aggregate function.');
  if (!operand.value.trim()) {
    if (operand.fn !== 'count') throw new Error(`${operand.fn ?? 'sum'} needs a field or expression.`);
    return 'COUNT(*)';
  }
  const target = operand.valueKind === 'expression'
    ? `(${operand.value.trim()})`
    : quoteIdentifier(operand.value);
  return `${fn}(${operand.fn === 'countDistinct' ? 'DISTINCT ' : ''}${target})`;
}

function selectionSql(selection: SourceSelection): { projection: string; groupBy?: string } {
  const alias = quoteIdentifier(selection.alias);
  if (selection.kind === 'aggregate') return { projection: `${aggregateSql(selection)} AS ${alias}` };
  if (selection.kind === 'expression') {
    const error = validateSqlExpression(selection.value);
    if (error) throw new Error(error);
    const expression = `(${selection.value.trim()})`;
    return { projection: `${expression} AS ${alias}`, groupBy: expression };
  }
  const field = quoteIdentifier(selection.value);
  return { projection: `${field} AS ${alias}`, groupBy: field };
}

export function buildSelectSql({
  dataset,
  selections,
  rowLimit = DEFAULT_ROW_LIMIT,
}: {
  dataset: string;
  selections: SourceSelection[];
  rowLimit?: number;
}): string {
  if (!selections.length) throw new Error('At least one source selection is required.');
  const limit = Number.isInteger(rowLimit) ? Math.min(Math.max(rowLimit, 1), MAX_ROW_LIMIT) : DEFAULT_ROW_LIMIT;
  const parts = selections.map(selectionSql);
  const hasAggregate = selections.some((selection) => selection.kind === 'aggregate');
  const groups = parts.flatMap((part) => part.groupBy ? [part.groupBy] : []);
  const sql = `SELECT TOP (${limit}) ${parts.map((part) => part.projection).join(', ')} FROM ${quoteIdentifier(dataset)}`;
  return hasAggregate && groups.length ? `${sql} GROUP BY ${groups.join(', ')}` : sql;
}

export function validateCompareFields(fields: CompareField[]): string[] {
  const problems: string[] = [];
  if (!fields.length) problems.push('Add at least one value to compare.');
  const normalized = fields.map((field, index) => ({
    ...field,
    label: field.label.trim() || `Value ${index + 1}`,
  }));

  for (const [index, field] of normalized.entries()) {
    for (const side of ['a', 'b'] as const) {
      const operand = field[side];
      const label = `Value ${index + 1} (${field.label}), source ${side.toUpperCase()}`;
      if (operand.kind === 'constant') continue;
      if (!operand.value.trim() && !(operand.kind === 'aggregate' && operand.fn === 'count')) {
        problems.push(`${label}: choose a field or expression.`);
        continue;
      }
      if (operand.kind === 'expression' || (operand.kind === 'aggregate' && operand.valueKind === 'expression')) {
        const error = validateSqlExpression(operand.value);
        if (error) problems.push(`${label}: ${error}`);
      } else if (operand.kind === 'field') {
        try { quoteIdentifier(operand.value); } catch (error) { problems.push(`${label}: ${(error as Error).message}`); }
      } else if (operand.kind === 'aggregate') {
        if (!(operand.fn && operand.fn in aggregateFunctions)) problems.push(`${label}: unsupported aggregate function.`);
        if (operand.value && operand.valueKind !== 'expression') {
          try { quoteIdentifier(operand.value); } catch (error) { problems.push(`${label}: ${(error as Error).message}`); }
        }
      }
    }
    if (field.a.kind === 'constant' && field.b.kind === 'constant') {
      problems.push(`Value ${index + 1}: both operands are constants.`);
    }
    const tolerance = field.tolerance;
    if (tolerance) {
      const label = `Value ${index + 1} (${field.label}) tolerance`;
      if (!Number.isFinite(tolerance.value)) {
        problems.push(`${label}: enter a number.`);
      } else if (tolerance.value < 0) {
        problems.push(`${label}: cannot be negative.`);
      } else if (tolerance.type === 'percent' && tolerance.value > 100) {
        problems.push(`${label}: a percentage tolerance cannot exceed 100.`);
      } else if (tolerance.type === 'days' && field.type !== 'date') {
        problems.push(`${label}: a day tolerance only applies to dates.`);
      } else if (tolerance.type !== 'days' && field.type === 'date') {
        problems.push(`${label}: dates only support a tolerance in days.`);
      } else if (tolerance.value > 0 && field.type !== 'number' && field.type !== 'date') {
        problems.push(`${label}: only numbers and dates support a tolerance.`);
      }
    }
  }

  for (const side of ['a', 'b'] as const) {
    const operands = normalized.map((field) => field[side]).filter((operand) => operand.kind !== 'constant');
    const hasAggregate = operands.some((operand) => operand.kind === 'aggregate');
    if (hasAggregate && operands.some((operand) => operand.kind !== 'aggregate')) {
      problems.push(`Source ${side.toUpperCase()}: every non-constant value must aggregate when one value aggregates.`);
    }
  }
  return problems;
}

export function planRule(rule: ReconciliationRule): PlannedRule {
  if (!rule.keyFieldA.trim() || !rule.keyFieldB.trim()) throw new Error('Choose a business key on both sides.');
  const problems = validateCompareFields(rule.compareFields);
  if (problems.length) throw new Error(problems.join(' '));
  const selectionsA: SourceSelection[] = [{ alias: 'recon_key', kind: 'field', value: rule.keyFieldA }];
  const selectionsB: SourceSelection[] = [{ alias: 'recon_key', kind: 'field', value: rule.keyFieldB }];
  const compareFields = rule.compareFields.map((field, index) => {
    const aliasA = `recon_c${index}a`;
    const aliasB = `recon_c${index}b`;
    if (field.a.kind !== 'constant') selectionsA.push({ ...field.a, alias: aliasA });
    if (field.b.kind !== 'constant') selectionsB.push({ ...field.b, alias: aliasB });
    return {
      ...field,
      a: field.a.kind === 'constant' ? field.a : { ...field.a, value: aliasA },
      b: field.b.kind === 'constant' ? field.b : { ...field.b, value: aliasB },
    };
  });
  return {
    selectionsA,
    selectionsB,
    engineRule: {
      ...rule,
      keyFieldA: 'recon_key',
      keyFieldB: 'recon_key',
      compareFields,
      aggregatedA: selectionsA.some((selection) => selection.kind === 'aggregate'),
      aggregatedB: selectionsB.some((selection) => selection.kind === 'aggregate'),
    },
  };
}

function normalizedKey(value: unknown, caseInsensitive = true): string {
  const text = value === null || value === undefined ? '' : String(value).trim();
  return caseInsensitive ? text.toLocaleLowerCase() : text;
}

const truthyText = new Set(['true', 't', 'yes', 'y', '1']);
const falsyText = new Set(['false', 'f', 'no', 'n', '0']);

function toBoolean(value: unknown): boolean | null {
  if (value === true || value === false) return value;
  if (value === 1) return true;
  if (value === 0) return false;
  if (value === null || value === undefined) return null;
  const text = String(value).trim().toLowerCase();
  if (truthyText.has(text)) return true;
  if (falsyText.has(text)) return false;
  return null;
}

function compareValues(valueA: unknown, valueB: unknown, field: CompareField) {
  if (field.type === 'number') {
    const a = Number(valueA);
    const b = Number(valueB);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return { equal: false, difference: null, reason: 'One side is not a usable number.' };
    const difference = b - a;
    const tolerance = field.tolerance;
    const allowed = tolerance?.type === 'percent'
      ? Math.abs(a) * tolerance.value / 100
      : tolerance?.type === 'absolute' ? tolerance.value : 0;
    return { equal: Math.abs(difference) <= allowed, difference };
  }
  if (field.type === 'date') {
    const a = Date.parse(String(valueA));
    const b = Date.parse(String(valueB));
    if (!Number.isFinite(a) || !Number.isFinite(b)) return { equal: false, difference: null, reason: 'One side is not a usable date.' };
    const toleranceDays = field.tolerance?.type === 'days' ? field.tolerance.value : 0;
    const elapsedMs = b - a;
    const difference = Math.round((elapsedMs / 86400000) * 1000) / 1000;
    return { equal: Math.abs(elapsedMs) <= toleranceDays * 86400000, difference };
  }
  if (field.type === 'boolean') {
    const a = toBoolean(valueA);
    const b = toBoolean(valueB);
    if (a === null || b === null) {
      return { equal: false, difference: null, reason: 'One side is not a recognisable true/false value.' };
    }
    return { equal: a === b, difference: null };
  }
  const prepare = (value: unknown) => {
    const text = value === null || value === undefined ? '' : String(value);
    const trimmed = field.trim === false ? text : text.trim();
    return field.caseInsensitive === true ? trimmed.toLocaleLowerCase() : trimmed;
  };
  return { equal: prepare(valueA) === prepare(valueB), difference: null };
}

function selectedValues(row: Record<string, unknown> | undefined, fields: CompareField[], side: 'a' | 'b') {
  if (!row) return null;
  return Object.fromEntries(fields.map((field) => {
    const operand = field[side];
    return [field.label, operand.kind === 'constant' ? operand.value : row[operand.value]];
  }));
}

export function exceptionFingerprint(ruleId: string | undefined, finding: Pick<ReconciliationFinding, 'outcome' | 'businessKey' | 'side' | 'discriminator'>): string {
  return [
    ruleId ?? 'rule',
    finding.outcome,
    finding.businessKey.trim().toLocaleLowerCase(),
    finding.side ?? '',
    finding.discriminator ?? '',
  ].join('|');
}

/** Small, stable, non-cryptographic digest used only to keep fingerprints distinct. */
export function stableDigest(value: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + code, 0x85ebca6b) >>> 0;
  }
  return (h1.toString(36) + h2.toString(36)).slice(0, 16);
}

export function reconcile({ rowsA, rowsB, rule }: { rowsA: Record<string, unknown>[]; rowsB: Record<string, unknown>[]; rule: ReconciliationRule }): ReconciliationResult {
  if (!rule.keyFieldA || !rule.keyFieldB) throw new Error('The rule must define a business key on both sides.');
  const counts: ReconciliationResult['summary']['counts'] = {
    missing_from_a: 0, missing_from_b: 0, value_mismatch: 0, duplicate: 0, invalid_key: 0,
  };
  const findings: ReconciliationFinding[] = [];
  let duplicatesIgnored = 0;
  let invalidKeysIgnored = 0;
  const indexed = (rows: Record<string, unknown>[], keyField: string) => {
    const grouped = new Map<string, { label: string; rows: Record<string, unknown>[] }>();
    const invalid: Record<string, unknown>[] = [];
    for (const row of rows) {
      const raw = row[keyField];
      const key = normalizedKey(raw);
      if (!key) { invalid.push(row); continue; }
      const group = grouped.get(key) ?? { label: String(raw).trim(), rows: [] };
      group.rows.push(row);
      grouped.set(key, group);
    }
    return { grouped, invalid };
  };
  const a = indexed(rowsA, rule.keyFieldA);
  const b = indexed(rowsB, rule.keyFieldB);
  const duplicateHandling = rule.duplicateHandling ?? 'exception';
  const add = (outcome: ReconciliationOutcome, businessKey: string, detail: Omit<ReconciliationFinding, 'fingerprint' | 'businessKey' | 'outcome' | 'severity'>) => {    const baseSeverity = outcomeSeverity[outcome];
    const severity = rule.priority === 'high' && baseSeverity === 'medium' ? 'high'
      : rule.priority === 'low' && baseSeverity === 'high' ? 'medium'
        : baseSeverity;
    const finding: ReconciliationFinding = {
      ...detail,
      businessKey,
      outcome,
      severity,
      fingerprint: '',
    };
    finding.fingerprint = exceptionFingerprint(rule.id, finding);
    counts[outcome] += 1;
    findings.push(finding);
  };

  if (rule.incompleteKeyHandling !== 'ignore') {
    for (const row of a.invalid) {
      const values = selectedValues(row, rule.compareFields, 'a');
      add('invalid_key', '(missing key)', { side: 'A', discriminator: stableDigest(JSON.stringify(values ?? row)), valuesA: values, valuesB: null, differences: [{ field: rule.keyFieldA, reason: 'Business key is missing in source A.' }] });
    }
    for (const row of b.invalid) {
      const values = selectedValues(row, rule.compareFields, 'b');
      add('invalid_key', '(missing key)', { side: 'B', discriminator: stableDigest(JSON.stringify(values ?? row)), valuesA: null, valuesB: values, differences: [{ field: rule.keyFieldB, reason: 'Business key is missing in source B.' }] });
    }
  } else {
    invalidKeysIgnored = a.invalid.length + b.invalid.length;
  }

  let matched = 0;
  const keys = new Set([...a.grouped.keys(), ...b.grouped.keys()]);
  for (const key of keys) {
    const groupA = a.grouped.get(key);
    const groupB = b.grouped.get(key);
    const label = groupA?.label ?? groupB?.label ?? key;
    const duplicates = (groupA?.rows.length ?? 0) > 1 || (groupB?.rows.length ?? 0) > 1;
    if (duplicates && duplicateHandling === 'exception') {
      add('duplicate', label, {
        valuesA: selectedValues(groupA?.rows[0], rule.compareFields, 'a'),
        valuesB: selectedValues(groupB?.rows[0], rule.compareFields, 'b'),
        countA: groupA?.rows.length ?? 0,
        countB: groupB?.rows.length ?? 0,
        differences: [{ field: 'business key', reason: 'The key occurs more than once.' }],
      });
      continue;
    }
    if (duplicates && duplicateHandling === 'ignore') {
      duplicatesIgnored += 1;
      continue;
    }
    if (!groupA) {
      add('missing_from_a', label, { valuesA: null, valuesB: selectedValues(groupB?.rows[0], rule.compareFields, 'b'), differences: [{ field: 'record', reason: 'Present in source B, absent from source A.' }] });
      continue;
    }
    if (!groupB) {
      add('missing_from_b', label, { valuesA: selectedValues(groupA.rows[0], rule.compareFields, 'a'), valuesB: null, differences: [{ field: 'record', reason: 'Present in source A, absent from source B.' }] });
      continue;
    }
    const rowA = groupA.rows[0];
    const rowB = groupB.rows[0];
    const differences = rule.compareFields.flatMap((field) => {
      const valueA = field.a.kind === 'constant' ? field.a.value : rowA[field.a.value];
      const valueB = field.b.kind === 'constant' ? field.b.value : rowB[field.b.value];
      const comparison = compareValues(valueA, valueB, field);
      return comparison.equal ? [] : [{ field: field.label, valueA, valueB, difference: comparison.difference, reason: comparison.reason }];
    });
    if (differences.length) {
      add('value_mismatch', label, { valuesA: selectedValues(rowA, rule.compareFields, 'a'), valuesB: selectedValues(rowB, rule.compareFields, 'b'), differences });
    } else {
      matched += 1;
    }
  }
  findings.sort((left, right) => left.businessKey.localeCompare(right.businessKey) || left.fingerprint.localeCompare(right.fingerprint));
  return {
    summary: {
      recordsA: rowsA.length,
      recordsB: rowsB.length,
      keysCompared: keys.size,
      matched,
      exceptions: findings.length,
      counts,
      duplicatesIgnored,
      invalidKeysIgnored,
      passed: findings.length === 0,
    },
    findings,
  };
}

export type ComparisonVerdict = 'clean' | 'unchanged' | 'better' | 'worse' | 'churn';

export interface FindingComparison {
  newlyFailing: ReconciliationFinding[];
  fixed: ReconciliationFinding[];
  stillFailing: ReconciliationFinding[];
  /** Same fingerprint present on both sides, but the recorded differences changed. */
  changed: Array<{ before: ReconciliationFinding; after: ReconciliationFinding }>;
  verdict: ComparisonVerdict;
}

function differenceSignature(finding: ReconciliationFinding): string {
  return JSON.stringify(
    finding.differences.map((difference) => [
      difference.field,
      difference.valueA ?? null,
      difference.valueB ?? null,
      difference.difference ?? null,
      difference.reason ?? null,
    ]),
  );
}

export function compareFindings(findingsFrom: ReconciliationFinding[], findingsTo: ReconciliationFinding[]): FindingComparison {
  const before = new Map(findingsFrom.map((finding) => [finding.fingerprint, finding]));
  const after = new Map(findingsTo.map((finding) => [finding.fingerprint, finding]));
  const newlyFailing = findingsTo.filter((finding) => !before.has(finding.fingerprint));
  const fixed = findingsFrom.filter((finding) => !after.has(finding.fingerprint));
  const stillFailing = findingsTo.filter((finding) => before.has(finding.fingerprint));
  const changed = stillFailing.flatMap((finding) => {
    const previous = before.get(finding.fingerprint);
    if (!previous || differenceSignature(previous) === differenceSignature(finding)) return [];
    return [{ before: previous, after: finding }];
  });

  let verdict: ComparisonVerdict;
  if (!findingsFrom.length && !findingsTo.length) verdict = 'clean';
  else if (newlyFailing.length && fixed.length) verdict = 'churn';
  else if (newlyFailing.length) verdict = 'worse';
  else if (fixed.length) verdict = 'better';
  else verdict = changed.length ? 'churn' : 'unchanged';

  return { newlyFailing, fixed, stillFailing, changed, verdict };
}

export interface MetricDelta {
  from: number;
  to: number;
  delta: number;
  percentChange: number | null;
  direction: 'up' | 'down' | 'flat';
}

export function metricDelta(from: number, to: number): MetricDelta {
  const delta = to - from;
  return {
    from,
    to,
    delta,
    percentChange: from === 0 ? (to === 0 ? 0 : null) : Math.round((delta / Math.abs(from)) * 10000) / 100,
    direction: delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat',
  };
}