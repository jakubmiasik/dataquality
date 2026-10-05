import { compareFindings, validateCompareFields, type CompareField, type ReconciliationFinding, type ReconciliationRule, type ReconciliationResult } from './reconciliationEngine';
import { getRayfinClient } from './rayfinClient';
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

export interface RuleDraft extends Omit<StoredRule, 'id' | 'status' | 'version' | 'enabled' | 'updatedAt'> {
  id?: string;
  compareFields: CompareField[];
}

const listLimit = 10000;

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
    .where({ itemId: { eq: item.id }, user_id: { eq: userId } }).first(1).execute();
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
    snapshot: JSON.stringify(snapshot),
    changeNote,
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
      user_id: userId,
    });
  }
}

export async function loadReconciliationData(userId: string) {
  const client = getRayfinClient();
  const [sources, rules, runs, exceptions] = await Promise.all([
    client.data.ReconciliationSource.select(['id', 'workspaceId', 'workspaceName', 'itemId', 'itemName', 'itemType', 'sqlEndpoint', 'objectCount', 'schemaJson', 'user_id'])
      .where({ user_id: { eq: userId } }).first(listLimit).execute(),
    client.data.ReconciliationRule.select(['id', 'name', 'description', 'businessArea', 'owner', 'priority', 'status', 'version', 'sourceAId', 'sourceBId', 'datasetA', 'datasetB', 'keyFieldA', 'keyFieldB', 'ruleGroup', 'duplicateHandling', 'incompleteKeyHandling', 'rowLimit', 'enabled', 'updatedAt', 'user_id'])
      .where({ user_id: { eq: userId } }).orderBy({ updatedAt: 'desc' }).first(listLimit).execute(),
    client.data.ReconciliationRun.select(['id', 'rule_id', 'ruleVersion', 'ruleName', 'status', 'recordsA', 'recordsB', 'keysCompared', 'matched', 'exceptionCount', 'summaryJson', 'errorMessage', 'startedAt', 'completedAt', 'runBy', 'user_id'])
      .where({ user_id: { eq: userId } }).orderBy({ startedAt: 'desc' }).first(listLimit).execute(),
    client.data.ReconciliationException.select(['id', 'rule_id', 'lastRunId', 'fingerprint', 'businessKey', 'outcome', 'severity', 'status', 'owner', 'detailJson', 'firstSeen', 'lastSeen', 'occurrenceCount', 'user_id'])
      .where({ user_id: { eq: userId } }).orderBy({ lastSeen: 'desc' }).first(listLimit).execute(),
  ]);
  return { sources, rules: rules as unknown as StoredRule[], runs: runs as StoredRun[], exceptions: exceptions as unknown as StoredException[] };
}

export async function loadRuleFields(ruleId: string, userId: string) {
  const rows = await getRayfinClient().data.ReconciliationRuleField.select([
    'id', 'rule_id', 'ordinal', 'label', 'valueType', 'aKind', 'aValue', 'aFunction', 'aValueKind',
    'bKind', 'bValue', 'bFunction', 'bValueKind', 'toleranceType', 'toleranceValue', 'user_id',
  ]).where({ rule_id: { eq: ruleId }, user_id: { eq: userId } }).orderBy({ ordinal: 'asc' }).first(500).execute();
  return rows.map((row) => ({
    label: row.label,
    type: row.valueType,
    a: { kind: row.aKind, value: row.aValue, ...(row.aFunction ? { fn: row.aFunction } : {}), ...(row.aValueKind ? { valueKind: row.aValueKind } : {}) },
    b: { kind: row.bKind, value: row.bValue, ...(row.bFunction ? { fn: row.bFunction } : {}), ...(row.bValueKind ? { valueKind: row.bValueKind } : {}) },
    ...(row.toleranceType !== 'none' && row.toleranceValue !== null ? { tolerance: { type: row.toleranceType, value: Number(row.toleranceValue) } } : {}),
  })) as CompareField[];
}

export async function saveRule(draft: RuleDraft, userId: string, actor: string, note?: string) {
  if (!draft.name.trim()) throw new Error('Enter a rule name.');
  if (!draft.sourceAId || !draft.sourceBId || !draft.datasetA || !draft.datasetB) throw new Error('Choose both sources and datasets.');
  if (!draft.keyFieldA.trim() || !draft.keyFieldB.trim()) throw new Error('Choose a business key on each side.');
  const problems = validateCompareFields(draft.compareFields);
  if (problems.length) throw new Error(problems.join(' '));

  const client = getRayfinClient();
  const now = new Date();
  const current = draft.id
    ? await client.data.ReconciliationRule.findById(draft.id)
    : null;
  if (draft.id && (!current || current.user_id !== userId)) throw new Error('Rule not found.');
  const version = current ? current.version + 1 : 1;
  const values = {
    name: draft.name.trim(),
    description: draft.description || undefined,
    businessArea: draft.businessArea || undefined,
    owner: draft.owner || undefined,
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
    rowLimit: Math.min(Math.max(draft.rowLimit || 10000, 1), 10000),
    updatedAt: now,
    updatedBy: actor,
    user_id: userId,
  };
  const saved = current
    ? await client.data.ReconciliationRule.update({ id: draft.id! }, values)
    : await client.data.ReconciliationRule.create({ ...values, status: 'draft', enabled: false, createdAt: now, createdBy: actor });
  const ruleId = current ? draft.id! : saved.id;

  if (current) {
    const oldFields = await client.data.ReconciliationRuleField.select(['id'])
      .where({ rule_id: { eq: ruleId }, user_id: { eq: userId } }).first(500).execute();
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
      user_id: userId,
    });
  }
  const snapshot = { ...values, id: ruleId, status: current?.status ?? 'draft' };
  await writeRuleVersion(ruleId, version, snapshot, draft.compareFields, note || 'Rule definition saved', actor, userId);
  return ruleId;
}

export async function setRuleEnabled(rule: StoredRule, compareFields: CompareField[], enabled: boolean, userId: string, actor: string) {
  if (enabled) {
    if (!rule.sourceAId || !rule.sourceBId || !rule.datasetA || !rule.datasetB || !rule.keyFieldA || !rule.keyFieldB) {
      throw new Error('Complete both sources, datasets and business keys before enabling this rule.');
    }
    const problems = validateCompareFields(compareFields);
    if (problems.length) throw new Error(problems.join(' '));
  }
  const client = getRayfinClient();
  const current = await client.data.ReconciliationRule.findById(rule.id);
  if (!current || current.user_id !== userId) throw new Error('Rule not found.');
  const nextVersion = current.version + 1;
  const status = enabled ? 'active' : 'disabled';
  const now = new Date();
  await client.data.ReconciliationRule.update({ id: rule.id }, { enabled, status, version: nextVersion, updatedAt: now, updatedBy: actor });
  await writeRuleVersion(rule.id, nextVersion, { ...current, enabled, status, version: nextVersion }, compareFields, enabled ? 'Rule enabled' : 'Rule disabled', actor, userId);
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
  const existingRows = await client.data.ReconciliationException.select([
    'id', 'rule_id', 'lastRunId', 'fingerprint', 'businessKey', 'outcome', 'severity', 'status', 'owner', 'detailJson', 'firstSeen', 'lastSeen', 'occurrenceCount', 'user_id',
  ]).where({ rule_id: { eq: rule.id }, user_id: { eq: userId } }).first(listLimit).execute() as StoredException[];
  const exceptionByFingerprint = new Map(existingRows.map((exception) => [exception.fingerprint, exception]));

  for (const finding of result.findings) {
    const existing = exceptionByFingerprint.get(finding.fingerprint);
    const detailJson = JSON.stringify({ valuesA: finding.valuesA, valuesB: finding.valuesB, differences: finding.differences, side: finding.side, countA: finding.countA, countB: finding.countB });
    let exceptionId: string;
    if (existing) {
      const reopened = existing.status === 'resolved' || existing.status === 'accepted';
      await client.data.ReconciliationException.update({ id: existing.id }, {
        lastRunId: runId,
        lastSeen: now,
        occurrenceCount: existing.occurrenceCount + 1,
        detailJson,
        severity: finding.severity,
        status: reopened ? 'open' : existing.status,
      });
      exceptionId = existing.id;
      if (reopened) {
        await client.data.ReconciliationExceptionEvent.create({
          ...eventBase(exceptionId, 'status_changed', 'reconciliation run', userId),
          fromStatus: existing.status,
          toStatus: 'open',
          reason: `Observed again by run ${runId}`,
        });
      }
    } else {
      const created = await client.data.ReconciliationException.create({
        rule_id: rule.id,
        lastRunId: runId,
        fingerprint: finding.fingerprint,
        businessKey: finding.businessKey,
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
      await client.data.ReconciliationExceptionEvent.create({
        ...eventBase(exceptionId, 'identified', 'reconciliation run', userId),
        toStatus: 'open',
        comment: `Identified by run ${runId}`,
      });
    }
    await client.data.ReconciliationFinding.create({
      run_id: runId,
      rule_id: rule.id,
      exception_id: exceptionId,
      fingerprint: finding.fingerprint,
      businessKey: finding.businessKey,
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
    summaryJson: JSON.stringify(result.summary),
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

export async function loadRunFindings(runId: string, userId: string) {
  const rows = await getRayfinClient().data.ReconciliationFinding.select([
    'id', 'run_id', 'rule_id', 'exception_id', 'fingerprint', 'businessKey', 'outcome', 'severity', 'detailJson', 'recordedAt', 'user_id',
  ]).where({ run_id: { eq: runId }, user_id: { eq: userId } }).first(listLimit).execute();
  return rows.map((row) => ({
    ...row,
    ...parseDetail(row.detailJson),
  })) as ReconciliationFinding[];
}

export async function compareRuns(from: StoredRun, to: StoredRun, userId: string) {
  if (from.rule_id !== to.rule_id) throw new Error('Only runs of the same rule can be compared.');
  const [findingsFrom, findingsTo] = await Promise.all([
    loadRunFindings(from.id, userId),
    loadRunFindings(to.id, userId),
  ]);
  const beforeSummary = JSON.parse(from.summaryJson || '{}') as Record<string, number>;
  const afterSummary = JSON.parse(to.summaryJson || '{}') as Record<string, number>;
  return {
    ...compareFindings(findingsFrom, findingsTo),
    metrics: {
      recordsA: (afterSummary.recordsA ?? to.recordsA) - (beforeSummary.recordsA ?? from.recordsA),
      recordsB: (afterSummary.recordsB ?? to.recordsB) - (beforeSummary.recordsB ?? from.recordsB),
      matched: (afterSummary.matched ?? to.matched) - (beforeSummary.matched ?? from.matched),
      exceptionCount: to.exceptionCount - from.exceptionCount,
    },
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
  await getRayfinClient().data.ReconciliationException.update({ id: exception.id }, { status });
  await getRayfinClient().data.ReconciliationExceptionEvent.create({
    ...eventBase(exception.id, 'status_changed', actor, userId),
    fromStatus: exception.status,
    toStatus: status,
    ...(reason ? { reason } : {}),
    ...(comment ? { comment } : {}),
  });
}

export async function assignException(exception: StoredException, owner: string, userId: string, actor: string) {
  await getRayfinClient().data.ReconciliationException.update({ id: exception.id }, { owner: owner || '' });
  await getRayfinClient().data.ReconciliationExceptionEvent.create({
    ...eventBase(exception.id, 'assigned', actor, userId),
    comment: owner ? `Assigned to ${owner}` : 'Assignment cleared',
  });
}

export async function addExceptionComment(exception: StoredException, comment: string, userId: string, actor: string) {
  if (!comment.trim()) throw new Error('Enter a comment.');
  await getRayfinClient().data.ReconciliationExceptionEvent.create({
    ...eventBase(exception.id, 'commented', actor, userId),
    comment: comment.trim().slice(0, 1000),
  });
}

export async function loadExceptionEvents(exceptionId: string, userId: string) {
  return getRayfinClient().data.ReconciliationExceptionEvent.select([
    'id', 'exception_id', 'action', 'fromStatus', 'toStatus', 'comment', 'reason', 'actor', 'occurredAt', 'user_id',
  ]).where({ exception_id: { eq: exceptionId }, user_id: { eq: userId } }).orderBy({ occurredAt: 'desc' }).first(1000).execute();
}

export async function loadRuleVersions(ruleId: string, userId: string) {
  const client = getRayfinClient();
  const [versions, fields] = await Promise.all([
    client.data.ReconciliationRuleVersion.select([
    'id', 'rule_id', 'version', 'snapshot', 'changeNote', 'changedAt', 'changedBy', 'user_id',
    ]).where({ rule_id: { eq: ruleId }, user_id: { eq: userId } }).orderBy({ version: 'desc' }).first(500).execute(),
    client.data.ReconciliationRuleVersionField.select([
      'version_id', 'ordinal', 'label', 'valueType', 'aKind', 'aValue', 'aFunction', 'aValueKind',
      'bKind', 'bValue', 'bFunction', 'bValueKind', 'toleranceType', 'toleranceValue', 'user_id',
    ]).where({ rule_id: { eq: ruleId }, user_id: { eq: userId } }).orderBy({ ordinal: 'asc' }).first(listLimit).execute(),
  ]);
  return versions.map((version) => ({
    ...version,
    compareFields: fields.filter((field) => field.version_id === version.id).map((field) => ({
      label: field.label,
      type: field.valueType,
      a: { kind: field.aKind, value: field.aValue, ...(field.aFunction ? { fn: field.aFunction } : {}), ...(field.aValueKind ? { valueKind: field.aValueKind } : {}) },
      b: { kind: field.bKind, value: field.bValue, ...(field.bFunction ? { fn: field.bFunction } : {}), ...(field.bValueKind ? { valueKind: field.bValueKind } : {}) },
      ...(field.toleranceType !== 'none' && field.toleranceValue !== null ? { tolerance: { type: field.toleranceType, value: Number(field.toleranceValue) } } : {}),
    })),
  }));
}