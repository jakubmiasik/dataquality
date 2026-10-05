import { compareFindings, metricDelta, validateCompareFields, MAX_ROW_LIMIT, UNLIMITED_ROW_LIMIT, type CompareField, type ReconciliationFinding, type ReconciliationRule, type ReconciliationResult } from './reconciliationEngine';
import { getRayfinClient } from './rayfinClient';
import { nextOccurrence, validateSchedule, type ScheduleDefinition } from './reconciliationSchedule';
import type { FabricItem } from './fabricWorkspaces';

export type StoredRule = Omit<ReconciliationRule, 'compareFields'> & {
  id: string;
  name: string;
  description?: string;
  businessArea?: string;
  owner?: string;
  priority: 'low' | 'medium' | 'high';
  status: 'draft' | 'active' | 'disabled' | 'retired';
  version: number;
  sourceAId: string;
  sourceBId: string;
  datasetA: string;
  datasetB: string;
  ruleGroup: string;
  rowLimit: number;
  enabled: boolean;
  updatedAt: Date;
};

export type StoredRun = {
  id: string;
  rule_id: string;
  ruleVersion: number;
  ruleName: string;
  status: 'running' | 'completed' | 'failed';
  recordsA: number;
  recordsB: number;
  keysCompared: number;
  matched: number;
  exceptionCount: number;
  summaryJson: string;
  errorMessage?: string;
  startedAt: Date;
  completedAt?: Date;
  runBy: string;
};

export type StoredException = {
  id: string;
  rule_id: string;
  lastRunId: string;
  fingerprint: string;
  businessKey: string;
  outcome: ReconciliationFinding['outcome'];
  severity: 'high' | 'medium' | 'low';
  status: 'open' | 'acknowledged' | 'investigating' | 'resolved' | 'accepted';
  owner?: string;
  detailJson: string;
  firstSeen: Date;
  lastSeen: Date;
  occurrenceCount: number;
};

export type StoredSchedule = {
  id: string;
  rule_id: string;
  ruleName: string;
  enabled: boolean;
  cadence: 'hourly' | 'daily' | 'weekly';
  intervalCount: number;
  hourUtc: number;
  minuteUtc: number;
  dayOfWeek?: number;
  nextDueAt: Date;
  lastTriggeredAt?: Date;
  lastRunId?: string;
  lastStatus: 'idle' | 'queued' | 'running' | 'succeeded' | 'failed';
  lastError?: string;
};

export interface RuleDraft extends Omit<StoredRule, 'id' | 'status' | 'version' | 'enabled' | 'updatedAt'> {
  id?: string;
  compareFields: CompareField[];
}

const pageSize = 500;

/** DAB caps `.execute()` at one page, so every unbounded read must walk the cursor. */
interface PagedQuery<T> {
  after(cursor: string): PagedQuery<T>;
  executePaginated(): Promise<{ items: T[]; hasNextPage: boolean; endCursor?: string | null }>;
}

async function fetchAll<T>(build: () => PagedQuery<T>): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | null = null;
  for (;;) {
    const query: PagedQuery<T> = cursor ? build().after(cursor) : build();
    const page = await query.executePaginated();
    all.push(...page.items);
    if (!page.hasNextPage || !page.endCursor) return all;
    cursor = page.endCursor;
  }
}

/**
 * `findById` asks DAB for the primary key alone, so every other column comes back
 * undefined. Any read that inspects more than the id must name its columns.
 */
async function fetchOne<T>(build: () => PagedQuery<T>): Promise<T | null> {
  const [record] = await fetchAll(build);
  return record ?? null;
}

/** Every rule column, for reads whose result is snapshotted into a version row. */
const ruleColumns = [
  'id', 'name', 'description', 'businessArea', 'owner', 'priority', 'status', 'version',
  'sourceAId', 'sourceBId', 'datasetA', 'datasetB', 'keyFieldA', 'keyFieldB', 'ruleGroup',
  'duplicateHandling', 'incompleteKeyHandling', 'rowLimit', 'enabled',
  'createdAt', 'createdBy', 'updatedAt', 'updatedBy', 'user_id',
] as const;

/** Every column `nextOccurrence` needs to recompute a schedule's next slot. */
const scheduleColumns = [
  'id', 'rule_id', 'ruleName', 'enabled', 'cadence', 'intervalCount', 'hourUtc', 'minuteUtc',
  'dayOfWeek', 'nextDueAt', 'lastTriggeredAt', 'lastRunId', 'lastStatus', 'lastError', 'user_id',
] as const;

/**
 * An omitted row limit keeps the capped default, while an explicit zero or
 * negative value is the caller asking for every row.
 */
export function normalizeRowLimit(value: unknown): number {
  if (value === undefined || value === null || value === '') return MAX_ROW_LIMIT;
  const numeric = Math.trunc(Number(value));
  if (!Number.isFinite(numeric) || numeric <= 0) return UNLIMITED_ROW_LIMIT;
  return Math.min(numeric, MAX_ROW_LIMIT);
}

/**
 * Rayfin stores these columns as NVARCHAR with a hard cap, so an oversized
 * payload would be rejected or silently truncated. Replace it with a marker
 * that still records why the detail is unavailable.
 */
export function clampJson(value: unknown, max: number): string {
  const serialized = JSON.stringify(value);
  if (serialized.length <= max) return serialized;
  const notice = JSON.stringify({
    truncated: true,
    originalLength: serialized.length,
    reason: `The payload exceeded the ${max} character storage limit.`,
  });
  return notice.length <= max ? notice : '{"truncated":true}';
}

function clampText(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export async function saveReconciliationSource(
  item: FabricItem,
  workspaceName: string,
  sqlEndpoint: string,
  objectCount: number,
  userId: string
) {
  const itemType = item.type;
  if (itemType !== 'Lakehouse' && itemType !== 'Warehouse') throw new Error('Only Lakehouses and Warehouses expose supported SQL endpoints.');
  const client = getRayfinClient();
  const existing = await client.data.ReconciliationSource.select(['id'])
    .where({ itemId: { eq: item.id } }).first(1).execute();
  const values = {
    workspaceId: item.workspaceId,
    workspaceName,
    itemId: item.id,
    itemName: item.displayName,
    itemType: itemType as 'Lakehouse' | 'Warehouse',
    sqlEndpoint,
    objectCount,
    schemaJson: '[]',
    user_id: userId,
  };
  if (existing[0]) {
    await client.data.ReconciliationSource.update({ id: existing[0].id }, values);
    return existing[0].id;
  }
  return (await client.data.ReconciliationSource.create(values)).id;
}

function parseDetail(detailJson: string) {
  try { return JSON.parse(detailJson) as Pick<ReconciliationFinding, 'valuesA' | 'valuesB' | 'differences' | 'side' | 'countA' | 'countB'>; }
  catch { return { valuesA: null, valuesB: null, differences: [] }; }
}

function eventBase(exceptionId: string, action: 'identified' | 'status_changed' | 'assigned' | 'commented' | 'severity_changed', actor: string, userId: string) {
  return { exception_id: exceptionId, action, actor, occurredAt: new Date(), user_id: userId };
}

async function writeRuleVersion(
  ruleId: string,
  version: number,
  snapshot: Record<string, unknown>,
  compareFields: CompareField[],
  changeNote: string,
  actor: string,
  userId: string
) {
  const client = getRayfinClient();
  const now = new Date();
  const versionRow = await client.data.ReconciliationRuleVersion.create({
    rule_id: ruleId,
    version,
    snapshot: clampJson(snapshot, 4000),
    changeNote: clampText(changeNote, 1000),
    changedAt: now,
    changedBy: actor,
    user_id: userId,
  });
  for (const [ordinal, field] of compareFields.entries()) {
    await client.data.ReconciliationRuleVersionField.create({
      rule_id: ruleId,
      version_id: versionRow.id,
      ordinal,
      label: field.label,
      valueType: field.type,
      aKind: field.a.kind,
      aValue: field.a.value,
      aFunction: field.a.fn ?? undefined,
      aValueKind: field.a.valueKind ?? undefined,
      bKind: field.b.kind,
      bValue: field.b.value,
      bFunction: field.b.fn ?? undefined,
      bValueKind: field.b.valueKind ?? undefined,
      toleranceType: field.tolerance?.type ?? 'none',
      toleranceValue: field.tolerance?.value ?? undefined,
      caseInsensitive: field.caseInsensitive === true,
      trimValues: field.trim !== false,
      user_id: userId,
    });
  }
}

export async function loadReconciliationData(_userId?: string) {
  const client = getRayfinClient();
  const [sources, rules, runs, exceptions, schedules] = await Promise.all([
    fetchAll(() => client.data.ReconciliationSource.select(['id', 'workspaceId', 'workspaceName', 'itemId', 'itemName', 'itemType', 'sqlEndpoint', 'objectCount', 'schemaJson', 'user_id'])
      .orderBy({ itemName: 'asc' }).first(pageSize)),
    fetchAll(() => client.data.ReconciliationRule.select(['id', 'name', 'description', 'businessArea', 'owner', 'priority', 'status', 'version', 'sourceAId', 'sourceBId', 'datasetA', 'datasetB', 'keyFieldA', 'keyFieldB', 'ruleGroup', 'duplicateHandling', 'incompleteKeyHandling', 'rowLimit', 'enabled', 'updatedAt', 'user_id'])
      .orderBy({ updatedAt: 'desc' }).first(pageSize)),
    fetchAll(() => client.data.ReconciliationRun.select(['id', 'rule_id', 'ruleVersion', 'ruleName', 'status', 'recordsA', 'recordsB', 'keysCompared', 'matched', 'exceptionCount', 'summaryJson', 'errorMessage', 'startedAt', 'completedAt', 'runBy', 'user_id'])
      .orderBy({ startedAt: 'desc' }).first(pageSize)),
    fetchAll(() => client.data.ReconciliationException.select(['id', 'rule_id', 'lastRunId', 'fingerprint', 'businessKey', 'outcome', 'severity', 'status', 'owner', 'detailJson', 'firstSeen', 'lastSeen', 'occurrenceCount', 'user_id'])
      .orderBy({ lastSeen: 'desc' }).first(pageSize)),
    fetchAll(() => client.data.ReconciliationSchedule.select(['id', 'rule_id', 'ruleName', 'enabled', 'cadence', 'intervalCount', 'hourUtc', 'minuteUtc', 'dayOfWeek', 'nextDueAt', 'lastTriggeredAt', 'lastRunId', 'lastStatus', 'lastError', 'user_id'])
      .orderBy({ nextDueAt: 'asc' }).first(pageSize)),
  ]);
  return {
    sources,
    rules: rules as unknown as StoredRule[],
    runs: runs as unknown as StoredRun[],
    exceptions: exceptions as unknown as StoredException[],
    schedules: schedules as unknown as StoredSchedule[],
  };
}

export async function loadRuleFields(ruleId: string, _userId?: string) {
  const client = getRayfinClient();
  const rows = await fetchAll(() => client.data.ReconciliationRuleField.select([
    'id', 'rule_id', 'ordinal', 'label', 'valueType', 'aKind', 'aValue', 'aFunction', 'aValueKind',
    'bKind', 'bValue', 'bFunction', 'bValueKind', 'toleranceType', 'toleranceValue', 'caseInsensitive', 'trimValues', 'user_id',
  ]).where({ rule_id: { eq: ruleId } }).orderBy({ ordinal: 'asc' }).first(pageSize));
  return rows.map((row) => ({
    label: row.label,
    type: row.valueType,
    a: { kind: row.aKind, value: row.aValue, ...(row.aFunction ? { fn: row.aFunction } : {}), ...(row.aValueKind ? { valueKind: row.aValueKind } : {}) },
    b: { kind: row.bKind, value: row.bValue, ...(row.bFunction ? { fn: row.bFunction } : {}), ...(row.bValueKind ? { valueKind: row.bValueKind } : {}) },
    caseInsensitive: row.caseInsensitive === true,
    trim: row.trimValues !== false,
    ...(row.toleranceType !== 'none' && row.toleranceValue !== null ? { tolerance: { type: row.toleranceType, value: Number(row.toleranceValue) } } : {}),
  })) as CompareField[];
}

export async function saveRule(draft: RuleDraft, userId: string, actor: string, note?: string) {
  if (!draft.name.trim()) throw new Error('Enter a rule name.');
  if (draft.name.trim().length > 255) throw new Error('The rule name cannot exceed 255 characters.');
  if (!draft.sourceAId || !draft.sourceBId || !draft.datasetA || !draft.datasetB) throw new Error('Choose both sources and datasets.');
  if (!draft.keyFieldA.trim() || !draft.keyFieldB.trim()) throw new Error('Choose a business key on each side.');
  if (draft.keyFieldA.trim().length > 255 || draft.keyFieldB.trim().length > 255) throw new Error('Business key names cannot exceed 255 characters.');
  if (draft.datasetA.length > 512 || draft.datasetB.length > 512) throw new Error('Dataset names cannot exceed 512 characters.');
  if (draft.rowLimit !== undefined && draft.rowLimit !== null && !Number.isFinite(Number(draft.rowLimit))) {
    throw new Error('Enter a numeric row limit.');
  }
  const problems = validateCompareFields(draft.compareFields);
  if (problems.length) throw new Error(problems.join(' '));

  const client = getRayfinClient();
  const now = new Date();
  const current = draft.id
    ? await fetchOne(() => client.data.ReconciliationRule.select(['id', 'status', 'version', 'user_id'])
      .where({ id: { eq: draft.id! } }).orderBy({ id: 'asc' }).first(1))
    : null;
  if (draft.id && !current) throw new Error('Rule not found.');
  const version = current ? current.version + 1 : 1;
  const values = {
    name: draft.name.trim(),
    description: clampText(draft.description || undefined, 1000),
    businessArea: clampText(draft.businessArea || undefined, 255),
    owner: clampText(draft.owner || undefined, 255),
    priority: draft.priority,
    version,
    sourceAId: draft.sourceAId,
    sourceBId: draft.sourceBId,
    datasetA: draft.datasetA,
    datasetB: draft.datasetB,
    keyFieldA: draft.keyFieldA.trim(),
    keyFieldB: draft.keyFieldB.trim(),
    ruleGroup: draft.ruleGroup as never,
    duplicateHandling: draft.duplicateHandling ?? 'exception',
    incompleteKeyHandling: draft.incompleteKeyHandling ?? 'exception',
    rowLimit: normalizeRowLimit(draft.rowLimit),
    updatedAt: now,
    updatedBy: actor,
    user_id: current ? current.user_id : userId,
  };
  const saved = current
    ? await client.data.ReconciliationRule.update({ id: draft.id! }, values)
    : await client.data.ReconciliationRule.create({ ...values, status: 'draft', enabled: false, createdAt: now, createdBy: actor });
  const ruleId = current ? draft.id! : saved.id;

  if (current) {
    const oldFields = await fetchAll(() => client.data.ReconciliationRuleField.select(['id'])
      .where({ rule_id: { eq: ruleId } }).orderBy({ ordinal: 'asc' }).first(pageSize));
    for (const field of oldFields) await client.data.ReconciliationRuleField.delete({ id: field.id });
  }
  for (const [ordinal, field] of draft.compareFields.entries()) {
    await client.data.ReconciliationRuleField.create({
      rule_id: ruleId,
      ordinal,
      label: field.label.trim() || `Value ${ordinal + 1}`,
      valueType: field.type,
      aKind: field.a.kind,
      aValue: field.a.value,
      aFunction: field.a.fn ?? undefined,
      aValueKind: field.a.valueKind ?? undefined,
      bKind: field.b.kind,
      bValue: field.b.value,
      bFunction: field.b.fn ?? undefined,
      bValueKind: field.b.valueKind ?? undefined,
      toleranceType: field.tolerance?.type ?? 'none',
      toleranceValue: field.tolerance?.value ?? undefined,
      caseInsensitive: field.caseInsensitive === true,
      trimValues: field.trim !== false,
      user_id: userId,
    });
  }
  const snapshot = { ...values, id: ruleId, status: current?.status ?? 'draft' };
  await writeRuleVersion(ruleId, version, snapshot, draft.compareFields, note || 'Rule definition saved', actor, userId);
  await syncScheduleRuleName(ruleId, values.name);
  return ruleId;
}

export async function setRuleEnabled(rule: StoredRule, compareFields: CompareField[], enabled: boolean, userId: string, actor: string) {
  const client = getRayfinClient();
  const current = await fetchOne(() => client.data.ReconciliationRule.select(ruleColumns)
    .where({ id: { eq: rule.id } }).orderBy({ id: 'asc' }).first(1));
  if (!current) throw new Error('Rule not found.');
  if (enabled) {
    if (!current.sourceAId || !current.sourceBId || !current.datasetA || !current.datasetB || !current.keyFieldA || !current.keyFieldB) {
      throw new Error('Complete both sources, datasets and business keys before enabling this rule.');
    }
    const sources = await fetchAll(() => client.data.ReconciliationSource.select(['id', 'itemType'])
      .orderBy({ id: 'asc' }).first(pageSize));
    const byId = new Map(sources.map((source) => [source.id, source]));
    for (const [side, sourceId] of [['A', current.sourceAId], ['B', current.sourceBId]] as const) {
      const source = byId.get(sourceId);
      if (!source) throw new Error(`Source ${side} no longer exists. Re-register it before enabling this rule.`);
      if (source.itemType !== 'Lakehouse' && source.itemType !== 'Warehouse') {
        throw new Error(`Source ${side} is no longer a Lakehouse or Warehouse.`);
      }
    }
    const problems = validateCompareFields(compareFields);
    if (problems.length) throw new Error(problems.join(' '));
  }
  const nextVersion = current.version + 1;
  const status = enabled ? 'active' : 'disabled';
  const now = new Date();
  await client.data.ReconciliationRule.update({ id: rule.id }, { enabled, status, version: nextVersion, updatedAt: now, updatedBy: actor });
  await writeRuleVersion(rule.id, nextVersion, { ...current, enabled, status, version: nextVersion }, compareFields, enabled ? 'Rule enabled' : 'Rule disabled', actor, userId);
}

/** Moves a rule out of service without deleting its history. */
export async function retireRule(rule: StoredRule, compareFields: CompareField[], userId: string, actor: string, reason?: string) {
  const client = getRayfinClient();
  const current = await fetchOne(() => client.data.ReconciliationRule.select(ruleColumns)
    .where({ id: { eq: rule.id } }).orderBy({ id: 'asc' }).first(1));
  if (!current) throw new Error('Rule not found.');
  if (current.status === 'retired') throw new Error('This rule is already retired.');
  const nextVersion = current.version + 1;
  const now = new Date();
  await client.data.ReconciliationRule.update({ id: rule.id }, { enabled: false, status: 'retired', version: nextVersion, updatedAt: now, updatedBy: actor });
  for (const schedule of await fetchAll(() => client.data.ReconciliationSchedule.select(['id'])
    .where({ rule_id: { eq: rule.id } }).orderBy({ id: 'asc' }).first(pageSize))) {
    await client.data.ReconciliationSchedule.update({ id: schedule.id }, { enabled: false, updatedAt: now, updatedBy: actor });
  }
  await writeRuleVersion(rule.id, nextVersion, { ...current, enabled: false, status: 'retired', version: nextVersion }, compareFields, reason?.trim() || 'Rule retired', actor, userId);
}

/** Applies a status change to many rules at once, reporting per-rule failures. */
export async function bulkSetRuleStatus(
  rules: StoredRule[],
  enabled: boolean,
  userId: string,
  actor: string
): Promise<{ succeeded: string[]; failed: Array<{ ruleId: string; ruleName: string; message: string }> }> {
  const succeeded: string[] = [];
  const failed: Array<{ ruleId: string; ruleName: string; message: string }> = [];
  for (const rule of rules) {
    try {
      const compareFields = await loadRuleFields(rule.id);
      await setRuleEnabled(rule, compareFields, enabled, userId, actor);
      succeeded.push(rule.id);
    } catch (error) {
      failed.push({ ruleId: rule.id, ruleName: rule.name, message: (error as Error).message });
    }
  }
  return { succeeded, failed };
}

export async function createRun(rule: StoredRule, userId: string, actor: string) {
  const now = new Date();
  return getRayfinClient().data.ReconciliationRun.create({
    rule_id: rule.id,
    ruleVersion: rule.version,
    ruleName: rule.name,
    status: 'running',
    recordsA: 0,
    recordsB: 0,
    keysCompared: 0,
    matched: 0,
    exceptionCount: 0,
    summaryJson: '{}',
    startedAt: now,
    runBy: actor,
    user_id: userId,
  });
}

export async function completeRun(runId: string, rule: StoredRule, result: ReconciliationResult, userId: string) {
  const client = getRayfinClient();
  const now = new Date();
  const fingerprints = new Set(result.findings.map((finding) => finding.fingerprint));
  const existingRows = await fetchAll(() => client.data.ReconciliationException.select([
    'id', 'rule_id', 'lastRunId', 'fingerprint', 'businessKey', 'outcome', 'severity', 'status', 'owner', 'detailJson', 'firstSeen', 'lastSeen', 'occurrenceCount', 'user_id',
  ]).where({ rule_id: { eq: rule.id } }).orderBy({ id: 'asc' }).first(pageSize)) as unknown as StoredException[];
  const exceptionByFingerprint = new Map(existingRows.filter((exception) => fingerprints.has(exception.fingerprint)).map((exception) => [exception.fingerprint, exception]));

  for (const finding of result.findings) {
    const existing = exceptionByFingerprint.get(finding.fingerprint);
    const detailJson = clampJson({ valuesA: finding.valuesA, valuesB: finding.valuesB, differences: finding.differences, side: finding.side, countA: finding.countA, countB: finding.countB }, 4000);
    let exceptionId: string;
    if (existing) {
      const reopened = existing.status === 'resolved' || existing.status === 'accepted';
      exceptionId = existing.id;
      // Write the audit event first so a reopened exception can never lose its history.
      if (reopened) {
        await client.data.ReconciliationExceptionEvent.create({
          ...eventBase(exceptionId, 'status_changed', 'reconciliation run', userId),
          fromStatus: existing.status,
          toStatus: 'open',
          reason: clampText(`Observed again by run ${runId}`, 1000),
        });
      }
      await client.data.ReconciliationException.update({ id: existing.id }, {
        lastRunId: runId,
        lastSeen: now,
        occurrenceCount: existing.occurrenceCount + 1,
        detailJson,
        severity: finding.severity,
        status: reopened ? 'open' : existing.status,
      });
    } else {
      const created = await client.data.ReconciliationException.create({
        rule_id: rule.id,
        lastRunId: runId,
        fingerprint: finding.fingerprint,
        businessKey: finding.businessKey.slice(0, 400),
        outcome: finding.outcome,
        severity: finding.severity,
        status: 'open',
        detailJson,
        firstSeen: now,
        lastSeen: now,
        occurrenceCount: 1,
        user_id: userId,
      });
      exceptionId = created.id;
      exceptionByFingerprint.set(finding.fingerprint, { ...(created as unknown as StoredException) });
      await client.data.ReconciliationExceptionEvent.create({
        ...eventBase(exceptionId, 'identified', 'reconciliation run', userId),
        toStatus: 'open',
        comment: clampText(`Identified by run ${runId}`, 1000),
      });
    }
    await client.data.ReconciliationFinding.create({
      run_id: runId,
      rule_id: rule.id,
      exception_id: exceptionId,
      fingerprint: finding.fingerprint,
      businessKey: finding.businessKey.slice(0, 400),
      outcome: finding.outcome,
      severity: finding.severity,
      detailJson,
      recordedAt: now,
      user_id: userId,
    });
  }

  await client.data.ReconciliationRun.update({ id: runId }, {
    status: 'completed',
    recordsA: result.summary.recordsA,
    recordsB: result.summary.recordsB,
    keysCompared: result.summary.keysCompared,
    matched: result.summary.matched,
    exceptionCount: result.findings.length,
    summaryJson: clampJson(result.summary, 4000),
    completedAt: now,
  });
}

export async function failRun(runId: string, message: string) {
  await getRayfinClient().data.ReconciliationRun.update({ id: runId }, {
    status: 'failed',
    errorMessage: message.slice(0, 1900),
    completedAt: new Date(),
  });
}

export async function loadRunFindings(runId: string, _userId?: string) {
  const client = getRayfinClient();
  const rows = await fetchAll(() => client.data.ReconciliationFinding.select([
    'id', 'run_id', 'rule_id', 'exception_id', 'fingerprint', 'businessKey', 'outcome', 'severity', 'detailJson', 'recordedAt', 'user_id',
  ]).where({ run_id: { eq: runId } }).orderBy({ id: 'asc' }).first(pageSize));
  return rows.map((row) => ({
    ...row,
    ...parseDetail(row.detailJson),
  })) as unknown as ReconciliationFinding[];
}

/**
 * Exceptions are long-lived and their `lastRunId` is overwritten every time a
 * later run observes them again, so it cannot answer "what did this run find?".
 * Findings are written once per run and never rewritten, which makes them the
 * durable membership record for a run.
 */
export async function loadRunExceptionIds(runId: string) {
  const client = getRayfinClient();
  const rows = await fetchAll(() => client.data.ReconciliationFinding.select(['id', 'run_id', 'exception_id'])
    .where({ run_id: { eq: runId } }).orderBy({ id: 'asc' }).first(pageSize));
  return [...new Set(rows.map((row) => String(row.exception_id)).filter(Boolean))];
}

export async function compareRuns(from: StoredRun, to: StoredRun, _userId?: string) {
  if (from.rule_id !== to.rule_id) throw new Error('Only runs of the same rule can be compared.');
  // Always report oldest-to-newest so the deltas read in chronological order.
  const [earlier, later] = from.startedAt.valueOf() <= to.startedAt.valueOf() ? [from, to] : [to, from];
  const [findingsFrom, findingsTo] = await Promise.all([
    loadRunFindings(earlier.id),
    loadRunFindings(later.id),
  ]);
  const beforeSummary = JSON.parse(earlier.summaryJson || '{}') as Record<string, number>;
  const afterSummary = JSON.parse(later.summaryJson || '{}') as Record<string, number>;
  const pick = (summary: Record<string, number>, run: StoredRun, key: 'recordsA' | 'recordsB' | 'matched' | 'keysCompared') =>
    summary[key] ?? run[key];
  return {
    from: earlier,
    to: later,
    reversed: earlier.id !== from.id,
    ...compareFindings(findingsFrom, findingsTo),
    metrics: {
      recordsA: metricDelta(pick(beforeSummary, earlier, 'recordsA'), pick(afterSummary, later, 'recordsA')),
      recordsB: metricDelta(pick(beforeSummary, earlier, 'recordsB'), pick(afterSummary, later, 'recordsB')),
      keysCompared: metricDelta(pick(beforeSummary, earlier, 'keysCompared'), pick(afterSummary, later, 'keysCompared')),
      matched: metricDelta(pick(beforeSummary, earlier, 'matched'), pick(afterSummary, later, 'matched')),
      exceptionCount: metricDelta(earlier.exceptionCount, later.exceptionCount),
    },
  };
}

export interface PortfolioRuleComparison {
  ruleId: string;
  ruleName: string;
  result: Awaited<ReturnType<typeof compareRuns>>;
}

export interface PortfolioComparison {
  aggregate: Awaited<ReturnType<typeof compareRuns>>;
  perRule: PortfolioRuleComparison[];
  rulesCompared: number;
  rulesSkipped: number;
}

/**
 * Diffs every rule between two moments at once. Findings are fingerprinted per
 * rule, so runs of different rules can never be diffed directly — instead each
 * rule is paired with its own latest completed run at or before each moment and
 * the per-rule results are summed into one portfolio verdict.
 */
export async function comparePortfolio(runs: StoredRun[], earlierAt: Date, laterAt: Date, userId?: string): Promise<PortfolioComparison> {
  const [low, high] = earlierAt.valueOf() <= laterAt.valueOf() ? [earlierAt, laterAt] : [laterAt, earlierAt];
  const completed = runs.filter((run) => run.status === 'completed');
  const latestAtOrBefore = (candidates: StoredRun[], moment: Date) => candidates
    .filter((run) => run.startedAt.valueOf() <= moment.valueOf())
    .sort((first, second) => second.startedAt.valueOf() - first.startedAt.valueOf())[0];

  const pairs = [...new Set(completed.map((run) => run.rule_id))].flatMap((ruleId) => {
    const forRule = completed.filter((run) => run.rule_id === ruleId);
    const from = latestAtOrBefore(forRule, low);
    const to = latestAtOrBefore(forRule, high);
    // A rule with no run before the earlier moment, or the same run on both
    // sides, has nothing to say about the period and is reported as skipped.
    if (!from || !to || from.id === to.id) return [];
    return [{ ruleId, from, to }];
  });

  const perRule = await Promise.all(pairs.map(async (pair) => ({
    ruleId: pair.ruleId,
    ruleName: pair.to.ruleName,
    result: await compareRuns(pair.from, pair.to, userId),
  })));

  const newlyFailing = perRule.flatMap((entry) => entry.result.newlyFailing);
  const fixed = perRule.flatMap((entry) => entry.result.fixed);
  const stillFailing = perRule.flatMap((entry) => entry.result.stillFailing);
  const changed = perRule.flatMap((entry) => entry.result.changed);
  const metricKeys = ['recordsA', 'recordsB', 'keysCompared', 'matched', 'exceptionCount'] as const;
  const metrics = Object.fromEntries(metricKeys.map((key) => [key, metricDelta(
    perRule.reduce((total, entry) => total + entry.result.metrics[key].from, 0),
    perRule.reduce((total, entry) => total + entry.result.metrics[key].to, 0),
  )])) as Awaited<ReturnType<typeof compareRuns>>['metrics'];

  const beforeCount = fixed.length + stillFailing.length;
  const verdict = !beforeCount && !newlyFailing.length && !stillFailing.length ? 'clean' as const
    : newlyFailing.length && fixed.length ? 'churn' as const
      : newlyFailing.length ? 'worse' as const
        : fixed.length ? 'better' as const
          : changed.length ? 'churn' as const : 'unchanged' as const;

  const sortedFrom = perRule.map((entry) => entry.result.from).sort((first, second) => first.startedAt.valueOf() - second.startedAt.valueOf());
  const sortedTo = perRule.map((entry) => entry.result.to).sort((first, second) => second.startedAt.valueOf() - first.startedAt.valueOf());
  return {
    aggregate: {
      from: sortedFrom[0],
      to: sortedTo[0],
      reversed: earlierAt.valueOf() > laterAt.valueOf(),
      newlyFailing, fixed, stillFailing, changed, verdict, metrics,
    },
    perRule: perRule.sort((first, second) => second.result.newlyFailing.length - first.result.newlyFailing.length),
    rulesCompared: perRule.length,
    rulesSkipped: [...new Set(completed.map((run) => run.rule_id))].length - perRule.length,
  };
}

export async function updateExceptionStatus(exception: StoredException, status: StoredException['status'], userId: string, actor: string, reason?: string, comment?: string) {
  const allowed: Record<StoredException['status'], StoredException['status'][]> = {
    open: ['acknowledged', 'investigating', 'resolved', 'accepted'],
    acknowledged: ['investigating', 'resolved', 'accepted', 'open'],
    investigating: ['resolved', 'accepted', 'open'],
    resolved: ['open'],
    accepted: ['open'],
  };
  if (!allowed[exception.status].includes(status)) throw new Error(`Cannot move an exception from ${exception.status} to ${status}.`);
  if ((status === 'resolved' || status === 'accepted') && !reason?.trim()) throw new Error('Record a reason before closing this exception.');
  const client = getRayfinClient();
  // The event is written first so a status change can never go un-audited.
  await client.data.ReconciliationExceptionEvent.create({
    ...eventBase(exception.id, 'status_changed', actor, userId),
    fromStatus: exception.status,
    toStatus: status,
    ...(reason ? { reason: clampText(reason.trim(), 1000) } : {}),
    ...(comment ? { comment: clampText(comment.trim(), 1000) } : {}),
  });
  await client.data.ReconciliationException.update({ id: exception.id }, { status });
}

export async function assignException(exception: StoredException, owner: string, userId: string, actor: string) {
  const trimmed = owner.trim();
  if (trimmed.length > 255) throw new Error('An owner name cannot exceed 255 characters.');
  const client = getRayfinClient();
  await client.data.ReconciliationExceptionEvent.create({
    ...eventBase(exception.id, 'assigned', actor, userId),
    comment: clampText(trimmed ? `Assigned to ${trimmed}` : 'Assignment cleared', 1000),
  });
  await client.data.ReconciliationException.update({ id: exception.id }, { owner: trimmed });
}

export async function addExceptionComment(exception: StoredException, comment: string, userId: string, actor: string) {
  if (!comment.trim()) throw new Error('Enter a comment.');
  await getRayfinClient().data.ReconciliationExceptionEvent.create({
    ...eventBase(exception.id, 'commented', actor, userId),
    comment: clampText(comment.trim(), 1000),
  });
}

export interface BulkExceptionResult {
  succeeded: string[];
  failed: Array<{ exceptionId: string; businessKey: string; message: string }>;
}

/** Applies one workflow action across a selection, reporting per-exception failures. */
export async function bulkUpdateExceptions(
  exceptions: StoredException[],
  action: { kind: 'status'; status: StoredException['status']; reason?: string; comment?: string }
    | { kind: 'assign'; owner: string }
    | { kind: 'comment'; comment: string },
  userId: string,
  actor: string
): Promise<BulkExceptionResult> {
  const succeeded: string[] = [];
  const failed: BulkExceptionResult['failed'] = [];
  for (const exception of exceptions) {
    try {
      if (action.kind === 'status') await updateExceptionStatus(exception, action.status, userId, actor, action.reason, action.comment);
      else if (action.kind === 'assign') await assignException(exception, action.owner, userId, actor);
      else await addExceptionComment(exception, action.comment, userId, actor);
      succeeded.push(exception.id);
    } catch (error) {
      failed.push({ exceptionId: exception.id, businessKey: exception.businessKey, message: (error as Error).message });
    }
  }
  return { succeeded, failed };
}

export async function loadExceptionEvents(exceptionId: string, _userId?: string) {
  const client = getRayfinClient();
  return fetchAll(() => client.data.ReconciliationExceptionEvent.select([
    'id', 'exception_id', 'action', 'fromStatus', 'toStatus', 'comment', 'reason', 'actor', 'occurredAt', 'user_id',
  ]).where({ exception_id: { eq: exceptionId } }).orderBy({ occurredAt: 'desc' }).first(pageSize));
}

export async function loadRuleVersions(ruleId: string, _userId?: string) {
  const client = getRayfinClient();
  const [versions, fields] = await Promise.all([
    fetchAll(() => client.data.ReconciliationRuleVersion.select([
      'id', 'rule_id', 'version', 'snapshot', 'changeNote', 'changedAt', 'changedBy', 'user_id',
    ]).where({ rule_id: { eq: ruleId } }).orderBy({ version: 'desc' }).first(pageSize)),
    fetchAll(() => client.data.ReconciliationRuleVersionField.select([
      'version_id', 'ordinal', 'label', 'valueType', 'aKind', 'aValue', 'aFunction', 'aValueKind',
      'bKind', 'bValue', 'bFunction', 'bValueKind', 'toleranceType', 'toleranceValue', 'caseInsensitive', 'trimValues', 'user_id',
    ]).where({ rule_id: { eq: ruleId } }).orderBy({ ordinal: 'asc' }).first(pageSize)),
  ]);
  return versions.map((version) => ({
    ...version,
    compareFields: fields.filter((field) => field.version_id === version.id).map((field) => ({
      label: field.label,
      type: field.valueType,
      a: { kind: field.aKind, value: field.aValue, ...(field.aFunction ? { fn: field.aFunction } : {}), ...(field.aValueKind ? { valueKind: field.aValueKind } : {}) },
      b: { kind: field.bKind, value: field.bValue, ...(field.bFunction ? { fn: field.bFunction } : {}), ...(field.bValueKind ? { valueKind: field.bValueKind } : {}) },
      caseInsensitive: field.caseInsensitive === true,
      trim: field.trimValues !== false,
      ...(field.toleranceType !== 'none' && field.toleranceValue !== null ? { tolerance: { type: field.toleranceType, value: Number(field.toleranceValue) } } : {}),
    })),
  }));
}

/* ------------------------------------------------------------------ *
 * Run retention
 * ------------------------------------------------------------------ */

/**
 * Removes a run and its findings. Standing exceptions survive, but any that
 * pointed at this run are re-pointed at their most recent surviving run so the
 * exception list never references a deleted run.
 */
export async function deleteRun(runId: string): Promise<{ findingsDeleted: number; exceptionsRepointed: number }> {
  const client = getRayfinClient();
  const run = await fetchOne(() => client.data.ReconciliationRun.select(['id', 'status'])
    .where({ id: { eq: runId } }).orderBy({ id: 'asc' }).first(1));
  if (!run) throw new Error('Run not found.');
  if (run.status === 'running') throw new Error('Wait for this run to finish before deleting it.');

  const findings = await fetchAll(() => client.data.ReconciliationFinding.select(['id'])
    .where({ run_id: { eq: runId } }).orderBy({ id: 'asc' }).first(pageSize));
  for (const finding of findings) await client.data.ReconciliationFinding.delete({ id: finding.id });

  const affected = await fetchAll(() => client.data.ReconciliationException.select(['id'])
    .where({ lastRunId: { eq: runId } }).orderBy({ id: 'asc' }).first(pageSize));
  let exceptionsRepointed = 0;
  for (const exception of affected) {
    const remaining = await fetchAll(() => client.data.ReconciliationFinding.select(['id', 'run_id', 'recordedAt'])
      .where({ exception_id: { eq: exception.id } }).orderBy({ recordedAt: 'desc' }).first(pageSize));
    const latest = remaining.find((finding) => finding.run_id !== runId);
    await client.data.ReconciliationException.update({ id: exception.id }, { lastRunId: latest ? latest.run_id : '' });
    exceptionsRepointed += 1;
  }

  await client.data.ReconciliationRun.delete({ id: runId });
  return { findingsDeleted: findings.length, exceptionsRepointed };
}

export interface OrphanReport {
  runs: StoredRun[];
  exceptions: StoredException[];
  findings: number;
  schedules: StoredSchedule[];
}

/** Finds rows whose owning rule no longer exists. */
export async function findOrphans(): Promise<OrphanReport> {
  const client = getRayfinClient();
  const [rules, runs, exceptions, findings, schedules] = await Promise.all([
    fetchAll(() => client.data.ReconciliationRule.select(['id']).orderBy({ id: 'asc' }).first(pageSize)),
    fetchAll(() => client.data.ReconciliationRun.select(['id', 'rule_id', 'ruleVersion', 'ruleName', 'status', 'recordsA', 'recordsB', 'keysCompared', 'matched', 'exceptionCount', 'summaryJson', 'errorMessage', 'startedAt', 'completedAt', 'runBy'])
      .orderBy({ startedAt: 'desc' }).first(pageSize)),
    fetchAll(() => client.data.ReconciliationException.select(['id', 'rule_id', 'lastRunId', 'fingerprint', 'businessKey', 'outcome', 'severity', 'status', 'owner', 'detailJson', 'firstSeen', 'lastSeen', 'occurrenceCount'])
      .orderBy({ lastSeen: 'desc' }).first(pageSize)),
    fetchAll(() => client.data.ReconciliationFinding.select(['id', 'rule_id']).orderBy({ id: 'asc' }).first(pageSize)),
    fetchAll(() => client.data.ReconciliationSchedule.select(['id', 'rule_id', 'ruleName', 'enabled', 'cadence', 'intervalCount', 'hourUtc', 'minuteUtc', 'dayOfWeek', 'nextDueAt', 'lastTriggeredAt', 'lastRunId', 'lastStatus', 'lastError'])
      .orderBy({ id: 'asc' }).first(pageSize)),
  ]);
  const live = new Set(rules.map((rule) => rule.id));
  return {
    runs: runs.filter((run) => !live.has(run.rule_id)) as unknown as StoredRun[],
    exceptions: exceptions.filter((exception) => !live.has(exception.rule_id)) as unknown as StoredException[],
    findings: findings.filter((finding) => !live.has(finding.rule_id)).length,
    schedules: schedules.filter((schedule) => !live.has(schedule.rule_id)) as unknown as StoredSchedule[],
  };
}

/** Deletes every row whose owning rule no longer exists. */
export async function purgeOrphans(): Promise<{ runs: number; exceptions: number; findings: number; events: number; schedules: number }> {
  const client = getRayfinClient();
  const rules = await fetchAll(() => client.data.ReconciliationRule.select(['id']).orderBy({ id: 'asc' }).first(pageSize));
  const live = new Set(rules.map((rule) => rule.id));
  const counts = { runs: 0, exceptions: 0, findings: 0, events: 0, schedules: 0 };

  const findings = await fetchAll(() => client.data.ReconciliationFinding.select(['id', 'rule_id']).orderBy({ id: 'asc' }).first(pageSize));
  for (const finding of findings.filter((row) => !live.has(row.rule_id))) {
    await client.data.ReconciliationFinding.delete({ id: finding.id });
    counts.findings += 1;
  }

  const exceptions = await fetchAll(() => client.data.ReconciliationException.select(['id', 'rule_id']).orderBy({ id: 'asc' }).first(pageSize));
  for (const exception of exceptions.filter((row) => !live.has(row.rule_id))) {
    const events = await fetchAll(() => client.data.ReconciliationExceptionEvent.select(['id'])
      .where({ exception_id: { eq: exception.id } }).orderBy({ id: 'asc' }).first(pageSize));
    for (const event of events) {
      await client.data.ReconciliationExceptionEvent.delete({ id: event.id });
      counts.events += 1;
    }
    await client.data.ReconciliationException.delete({ id: exception.id });
    counts.exceptions += 1;
  }

  const runs = await fetchAll(() => client.data.ReconciliationRun.select(['id', 'rule_id']).orderBy({ id: 'asc' }).first(pageSize));
  for (const run of runs.filter((row) => !live.has(row.rule_id))) {
    await client.data.ReconciliationRun.delete({ id: run.id });
    counts.runs += 1;
  }

  const schedules = await fetchAll(() => client.data.ReconciliationSchedule.select(['id', 'rule_id']).orderBy({ id: 'asc' }).first(pageSize));
  for (const schedule of schedules.filter((row) => !live.has(row.rule_id))) {
    await client.data.ReconciliationSchedule.delete({ id: schedule.id });
    counts.schedules += 1;
  }

  return counts;
}

/* ------------------------------------------------------------------ *
 * Schedules
 * ------------------------------------------------------------------ */

async function syncScheduleRuleName(ruleId: string, ruleName: string) {
  const client = getRayfinClient();
  const schedules = await fetchAll(() => client.data.ReconciliationSchedule.select(['id', 'ruleName'])
    .where({ rule_id: { eq: ruleId } }).orderBy({ id: 'asc' }).first(pageSize));
  for (const schedule of schedules) {
    if (schedule.ruleName !== ruleName) {
      await client.data.ReconciliationSchedule.update({ id: schedule.id }, { ruleName });
    }
  }
}

export async function saveSchedule(
  rule: StoredRule,
  definition: ScheduleDefinition & { enabled: boolean; id?: string },
  userId: string,
  actor: string
) {
  const problems = validateSchedule(definition);
  if (problems.length) throw new Error(problems.join(' '));
  const client = getRayfinClient();
  const now = new Date();
  const values = {
    rule_id: rule.id,
    ruleName: rule.name,
    enabled: definition.enabled,
    cadence: definition.cadence,
    intervalCount: definition.intervalCount,
    hourUtc: definition.hourUtc,
    minuteUtc: definition.minuteUtc,
    dayOfWeek: definition.cadence === 'weekly' ? definition.dayOfWeek : undefined,
    nextDueAt: nextOccurrence(definition, now),
    updatedAt: now,
    updatedBy: actor,
  };
  if (definition.id) {
    const current = await client.data.ReconciliationSchedule.findById(definition.id);
    if (!current) throw new Error('Schedule not found.');
    await client.data.ReconciliationSchedule.update({ id: definition.id }, values);
    return definition.id;
  }
  const existing = await fetchAll(() => client.data.ReconciliationSchedule.select(['id'])
    .where({ rule_id: { eq: rule.id } }).orderBy({ id: 'asc' }).first(pageSize));
  if (existing.length) {
    await client.data.ReconciliationSchedule.update({ id: existing[0].id }, values);
    return existing[0].id;
  }
  const created = await client.data.ReconciliationSchedule.create({
    ...values,
    lastStatus: 'idle',
    createdAt: now,
    createdBy: actor,
    user_id: userId,
  });
  return created.id;
}

export async function deleteSchedule(scheduleId: string) {
  await getRayfinClient().data.ReconciliationSchedule.delete({ id: scheduleId });
}

export async function setScheduleEnabled(scheduleId: string, enabled: boolean, actor: string) {
  const client = getRayfinClient();
  const current = await fetchOne(() => client.data.ReconciliationSchedule.select(scheduleColumns)
    .where({ id: { eq: scheduleId } }).orderBy({ id: 'asc' }).first(1));
  if (!current) throw new Error('Schedule not found.');
  const now = new Date();
  await client.data.ReconciliationSchedule.update({ id: scheduleId }, {
    enabled,
    // Re-anchor on resume so a schedule that was off for a while does not fire immediately.
    nextDueAt: enabled ? nextOccurrence(current as unknown as ScheduleDefinition, now) : current.nextDueAt,
    updatedAt: now,
    updatedBy: actor,
  });
}

/** Returns enabled schedules whose next occurrence has already passed. */
export async function loadDueSchedules(now: Date): Promise<StoredSchedule[]> {
  const client = getRayfinClient();
  const schedules = await fetchAll(() => client.data.ReconciliationSchedule.select([
    'id', 'rule_id', 'ruleName', 'enabled', 'cadence', 'intervalCount', 'hourUtc', 'minuteUtc', 'dayOfWeek',
    'nextDueAt', 'lastTriggeredAt', 'lastRunId', 'lastStatus', 'lastError',
  ]).where({ enabled: { eq: true } }).orderBy({ nextDueAt: 'asc' }).first(pageSize));
  return (schedules as unknown as StoredSchedule[])
    .filter((schedule) => new Date(schedule.nextDueAt).getTime() <= now.getTime());
}

/**
 * Claims a due schedule by advancing its next occurrence before the run starts.
 * Returns false when another sweep already claimed the same slot.
 */
export async function claimSchedule(schedule: StoredSchedule, now: Date): Promise<boolean> {
  const client = getRayfinClient();
  const current = await fetchOne(() => client.data.ReconciliationSchedule.select(scheduleColumns)
    .where({ id: { eq: schedule.id } }).orderBy({ id: 'asc' }).first(1));
  if (!current || !current.enabled) return false;
  if (new Date(current.nextDueAt).getTime() !== new Date(schedule.nextDueAt).getTime()) return false;
  await client.data.ReconciliationSchedule.update({ id: schedule.id }, {
    nextDueAt: nextOccurrence(current as unknown as ScheduleDefinition, now),
    lastTriggeredAt: now,
    lastStatus: 'running',
    lastError: undefined,
    updatedAt: now,
    updatedBy: 'scheduler',
  });
  return true;
}

export async function recordScheduleOutcome(
  scheduleId: string,
  outcome: { status: 'succeeded' | 'failed'; runId?: string; error?: string }
) {
  await getRayfinClient().data.ReconciliationSchedule.update({ id: scheduleId }, {
    lastStatus: outcome.status,
    lastRunId: outcome.runId,
    lastError: clampText(outcome.error, 2000),
    updatedAt: new Date(),
    updatedBy: 'scheduler',
  });
}
