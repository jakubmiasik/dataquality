import { useEffect, useMemo, useState } from 'react';

import { useAuth } from '@/hooks/AuthContext';
import { useScheduleSweeper } from '@/hooks/useScheduleSweeper';
import {
  callReconciliationGateway,
  listWorkspaceResources,
  type FabricItem,
  type SqlObject,
  type WorkspaceResources,
} from '@/services/fabricWorkspaces';
import {
  addExceptionComment,
  assignException,
  bulkSetRuleStatus,
  bulkUpdateExceptions,
  compareRuns as compareStoredRuns,
  completeRun,
  createRun,
  deleteRun,
  deleteSchedule,
  failRun,
  findOrphans,
  loadExceptionEvents,
  loadRunFindings,
  loadReconciliationData,
  loadRuleFields,
  loadRuleVersions,
  purgeOrphans,
  retireRule,
  saveReconciliationSource,
  saveRule,
  saveSchedule,
  setRuleEnabled,
  setScheduleEnabled,
  updateExceptionStatus,
  type RuleDraft,
  type StoredException,
  type StoredRule,
  type StoredRun,
} from '@/services/reconciliationRepository';
import {
  emptySettingValues,
  loadAppSettings,
  saveAppSettings,
  settingDefinitions,
  validateSettings,
  type AppSettingsState,
  type SettingKey,
  type SettingValues,
} from '@/services/appSettings';
import type { CompareField, Operand, ReconciliationFinding, ReconciliationResult } from '@/services/reconciliationEngine';
import { summariseSweep } from '@/services/reconciliationScheduler';
import { describeSchedule, nextOccurrence, validateSchedule, type ScheduleDefinition } from '@/services/reconciliationSchedule';

type Tab = 'overview' | 'sources' | 'rules' | 'schedules' | 'exceptions' | 'runs' | 'compare' | 'settings';
type AppData = Awaited<ReturnType<typeof loadReconciliationData>>;
type ComparisonResult = Awaited<ReturnType<typeof compareStoredRuns>>;
type OrphanReport = Awaited<ReturnType<typeof findOrphans>>;
type ExceptionFilter = { status: string; severity: string; outcome: string; ruleId: string; ruleGroup: string; runId: string; owner: string };
type ScheduleDraft = ScheduleDefinition & { id?: string; ruleId: string; enabled: boolean };

interface CatalogResponse {
  source: { sqlEndpoint: string; database: string };
  objects: SqlObject[];
}

const defaultTabCaption = 'Read-only SQL checks across accessible Fabric sources.';
const tabs: Array<{ id: Tab; label: string; caption?: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'sources', label: 'Sources' },
  { id: 'rules', label: 'Rules' },
  { id: 'schedules', label: 'Schedules' },
  { id: 'exceptions', label: 'Exceptions' },
  { id: 'runs', label: 'Runs' },
  { id: 'compare', label: 'Compare runs' },
  { id: 'settings', label: 'Configuration', caption: 'Connection details for Fabric and the reconciliation gateway.' },
];

const ruleGroups = [
  ['start_to_start', 'Start-to-Start'], ['start_to_end', 'Start-to-End'], ['end_to_end', 'End-to-End'],
  ['point_to_point', 'Point-to-Point'], ['left_to_right', 'Left-to-Right'], ['right_to_left', 'Right-to-Left'],
  ['aggregate_to_detail', 'Aggregate-to-Detail'], ['period_over_period', 'Period-over-Period'], ['ungrouped', 'Ungrouped'],
] as const;

const statuses: StoredException['status'][] = ['open', 'acknowledged', 'investigating', 'resolved', 'accepted'];
const severities: StoredException['severity'][] = ['high', 'medium', 'low'];
const aggregateFunctions: Array<NonNullable<Operand['fn']>> = ['sum', 'count', 'countDistinct', 'avg', 'min', 'max'];
const supportedTypes = ['Lakehouse', 'Warehouse'];
const button = 'inline-flex min-h-9 items-center justify-center gap-2 rounded-lg border px-3.5 py-1.5 text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 disabled:cursor-not-allowed disabled:opacity-50';
const primaryButton = `${button} border-transparent bg-gradient-to-b from-brand-500 to-brand-600 text-white shadow-sm shadow-brand-600/25 hover:from-brand-600 hover:to-brand-700 hover:shadow-md hover:shadow-brand-600/30 disabled:shadow-none`;
const secondaryButton = `${button} border-slate-200 bg-white text-slate-700 shadow-sm hover:border-slate-300 hover:bg-slate-50 hover:text-slate-900`;
const dangerButton = `${button} border-transparent bg-rose-600 text-white shadow-sm shadow-rose-600/20 hover:bg-rose-700`;
/* Colour is kept out of the base so the invalid variant does not rely on
   Tailwind source order to beat the default border and ring utilities. */
const inputBase = 'min-h-9 w-full rounded-lg border bg-white px-3 py-1.5 text-sm text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:ring-4';
const input = `${inputBase} border-slate-200 focus:border-brand-400 focus:ring-brand-500/15`;
const invalidInput = `${inputBase} border-rose-300 focus:border-rose-400 focus:ring-rose-500/15`;
const labelClass = 'mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500';
/* Shared surface for every panel section, so elevation and radius stay consistent. */
const card = 'overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-card card-hover';

type MetricAccent = 'brand' | 'teal' | 'rose' | 'amber' | 'slate';
const metricAccents: Record<MetricAccent, { chip: string; dot: string }> = {
  brand: { chip: 'bg-brand-50', dot: 'bg-brand-500' },
  teal: { chip: 'bg-teal-50', dot: 'bg-teal-500' },
  rose: { chip: 'bg-rose-50', dot: 'bg-rose-500' },
  amber: { chip: 'bg-amber-50', dot: 'bg-amber-500' },
  slate: { chip: 'bg-slate-100', dot: 'bg-slate-400' },
};
/* Identity used to mark a Metric as display-only. */
const noop = () => undefined;

function blankOperand(): Operand {
  return { kind: 'field', value: '' };
}

function blankField(index: number): CompareField {
  return { label: `Value ${index + 1}`, type: 'string', a: blankOperand(), b: blankOperand(), caseInsensitive: false, trim: true };
}

function blankRule(): RuleDraft {
  return {
    name: '', description: '', businessArea: '', owner: '', priority: 'medium',
    sourceAId: '', sourceBId: '', datasetA: '', datasetB: '', keyFieldA: '', keyFieldB: '',
    ruleGroup: 'ungrouped', duplicateHandling: 'exception', incompleteKeyHandling: 'exception',
    rowLimit: 10000, compareFields: [blankField(0)],
  };
}

function objectName(object: SqlObject) {
  return `${object.schema}.${object.name}`;
}

function parseObjects(source: { schemaJson: string }): SqlObject[] {
  try { return JSON.parse(source.schemaJson) as SqlObject[]; }
  catch { return []; }
}

function formatDate(value: Date | string | undefined) {
  return value ? new Date(value).toLocaleString() : 'Not completed';
}

function humanOutcome(value: string) {
  return value.replaceAll('_', ' ');
}

function parseExceptionDetail(exception: StoredException) {
  try {
    return JSON.parse(exception.detailJson) as {
      valuesA?: Record<string, unknown> | null;
      valuesB?: Record<string, unknown> | null;
      differences?: Array<{ field: string; valueA?: unknown; valueB?: unknown; difference?: number | null; reason?: string }>;
    };
  } catch {
    return { valuesA: null, valuesB: null, differences: [] };
  }
}

export function ReconciliationPage() {
  const { signOut, user } = useAuth();
  const userId = user?.id;
  const [tab, setTab] = useState<Tab>('overview');
  const [data, setData] = useState<AppData | null>(null);
  const [registrationWorkspaces, setRegistrationWorkspaces] = useState<WorkspaceResources[] | null>(null);
  const [catalogs, setCatalogs] = useState<Record<string, SqlObject[]>>({});
  const [registrationSide, setRegistrationSide] = useState<'A' | 'B' | null>(null);
  const [registrationOpen, setRegistrationOpen] = useState(false);
  const [draft, setDraft] = useState<RuleDraft | null>(null);
  const [selectedException, setSelectedException] = useState<StoredException | null>(null);
  const [selectedRun, setSelectedRun] = useState<StoredRun | null>(null);
  const [runFindings, setRunFindings] = useState<ReconciliationFinding[]>([]);
  const [exceptionEvents, setExceptionEvents] = useState<Array<Record<string, unknown>>>([]);
  const [versionHistory, setVersionHistory] = useState<Array<Record<string, unknown>> | null>(null);
  const [comparison, setComparison] = useState<ComparisonResult | null>(null);
  const [scheduleDraft, setScheduleDraft] = useState<ScheduleDraft | null>(null);
  const [orphanReport, setOrphanReport] = useState<OrphanReport | null>(null);
  const [selectedRuleIds, setSelectedRuleIds] = useState<string[]>([]);
  const [selectedExceptionIds, setSelectedExceptionIds] = useState<string[]>([]);
  const [comparisonRuleId, setComparisonRuleId] = useState('');
  const [fromRunId, setFromRunId] = useState('');
  const [toRunId, setToRunId] = useState('');
  const [registrationFilter, setRegistrationFilter] = useState('');
  const [exceptionFilter, setExceptionFilter] = useState<ExceptionFilter>({ status: 'open', severity: '', outcome: '', ruleId: '', ruleGroup: '', runId: '', owner: '' });
  const [ownerInput, setOwnerInput] = useState('');
  const [commentInput, setCommentInput] = useState('');
  const [closeReason, setCloseReason] = useState('');
  const selectedExceptionId = selectedException?.id;
  const selectedExceptionOwner = selectedException?.owner ?? '';
  const selectedRunId = selectedRun?.id;
  const [loading, setLoading] = useState(false);
  const [registrationLoading, setRegistrationLoading] = useState(false);
  const [busyKey, setBusyKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [settings, setSettings] = useState<AppSettingsState | null>(null);
  const [settingsForm, setSettingsForm] = useState<SettingValues>(emptySettingValues);
  const [settingsErrors, setSettingsErrors] = useState<Partial<Record<SettingKey, string>>>({});

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    loadAppSettings().then((state) => {
      if (cancelled) return;
      setSettings(state);
      setSettingsForm(state.values);
    }).catch(() => { if (!cancelled) setSettings(null); });
    return () => { cancelled = true; };
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    loadReconciliationData(userId)
      .then((result) => { if (!cancelled) setData(result); })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : 'Unable to load reconciliation data.');
      });
    return () => { cancelled = true; };
  }, [userId]);

  useEffect(() => {
    if (!selectedExceptionId || !userId) { setExceptionEvents([]); return; }
    let cancelled = false;
    loadExceptionEvents(selectedExceptionId, userId)
      .then((events) => { if (!cancelled) setExceptionEvents(events as unknown as Array<Record<string, unknown>>); })
      .catch(() => { if (!cancelled) setExceptionEvents([]); });
    setOwnerInput(selectedExceptionOwner);
    setCommentInput('');
    setCloseReason('');
    return () => { cancelled = true; };
  }, [selectedExceptionId, selectedExceptionOwner, userId]);

  useEffect(() => {
    if (!selectedRunId || !userId) { setRunFindings([]); return; }
    let cancelled = false;
    loadRunFindings(selectedRunId, userId)
      .then((findings) => { if (!cancelled) setRunFindings(findings); })
      .catch(() => { if (!cancelled) setRunFindings([]); });
    return () => { cancelled = true; };
  }, [selectedRunId, userId]);

  const sources = data?.sources ?? [];
  const rules = useMemo(() => data?.rules ?? [], [data]);
  const runs = useMemo(() => data?.runs ?? [], [data]);
  const exceptions = useMemo(() => data?.exceptions ?? [], [data]);
  const schedules = useMemo(() => data?.schedules ?? [], [data]);
  const openExceptions = exceptions.filter((exception) => exception.status === 'open' || exception.status === 'acknowledged' || exception.status === 'investigating');

  useScheduleSweeper({
    enabled: Boolean(userId && data),
    rules,
    execute: executeRule,
    onSwept: (executions) => {
      const summary = summariseSweep(executions);
      if (summary) setNotice(summary);
      void refreshData();
    },
  });

  const filteredExceptions = useMemo(() => exceptions.filter((exception) => {
    const rule = rules.find((entry) => entry.id === exception.rule_id);
    return (!exceptionFilter.status || exception.status === exceptionFilter.status)
      && (!exceptionFilter.severity || exception.severity === exceptionFilter.severity)
      && (!exceptionFilter.outcome || exception.outcome === exceptionFilter.outcome)
      && (!exceptionFilter.ruleId || exception.rule_id === exceptionFilter.ruleId)
      && (!exceptionFilter.ruleGroup || rule?.ruleGroup === exceptionFilter.ruleGroup)
      && (!exceptionFilter.runId || exception.lastRunId === exceptionFilter.runId)
      && (!exceptionFilter.owner || (exception.owner ?? '').toLocaleLowerCase().includes(exceptionFilter.owner.toLocaleLowerCase()));
  }), [exceptions, exceptionFilter, rules]);

  const selectedComparisonRuns = useMemo(() => runs.filter((run) =>
    run.rule_id === comparisonRuleId && run.status === 'completed'
  ), [runs, comparisonRuleId]);

  async function refreshData() {
    if (!user) return;
    setLoading(true);
    setError(null);
    try { setData(await loadReconciliationData(user.id)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to refresh reconciliation data.'); }
    finally { setLoading(false); }
  }

  async function saveSettings() {
    if (!user) return;
    const errors = validateSettings(settingsForm);
    setSettingsErrors(errors);
    if (Object.keys(errors).length > 0) return;
    setBusyKey('settings');
    setError(null);
    try {
      const state = await saveAppSettings(settingsForm, user.id, user.name || user.email || user.id);
      setSettings(state);
      setSettingsForm(state.values);
      setNotice(state.source === 'service'
        ? 'Configuration saved for the workspace.'
        : 'Configuration saved in this browser.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to save the configuration.'); }
    finally { setBusyKey(''); }
  }

  async function openSourceRegistration(side: 'A' | 'B' | null = null) {
    if (!user) return;
    setRegistrationSide(side);
    setRegistrationOpen(true);
    setRegistrationWorkspaces(null);
    setRegistrationFilter('');
    setRegistrationLoading(true);
    setError(null);
    try { setRegistrationWorkspaces(await listWorkspaceResources(user.email)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to load source choices.'); }
    finally { setRegistrationLoading(false); }
  }

  async function readCatalog(workspace: WorkspaceResources['workspace'], item: FabricItem): Promise<{ sourceId: string; objects: SqlObject[] } | null> {
    if (!user || !supportedTypes.includes(item.type)) return null;
    setBusyKey(`catalog:${item.id}`);
    setError(null);
    try {
      const result = await callReconciliationGateway<CatalogResponse>('catalog', user.email, {
        source: { workspaceId: workspace.id, itemId: item.id, itemType: item.type },
      });
      const sourceId = await saveReconciliationSource(item, workspace.displayName, result.source.sqlEndpoint, result.objects.length, user.id);
      setCatalogs((current) => ({ ...current, [sourceId]: result.objects }));
      setNotice(`${result.objects.length} SQL tables and views loaded from ${item.displayName}.`);
      await refreshData();
      return { sourceId, objects: result.objects };
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to read the SQL endpoint catalog.');
      return null;
    } finally { setBusyKey(''); }
  }

  async function registerSource(workspace: WorkspaceResources['workspace'], item: FabricItem) {
    const registered = await readCatalog(workspace, item);
    if (registered && registrationSide && draft) {
      const dataset = registered.objects[0] ? objectName(registered.objects[0]) : '';
      setDraft((current) => current ? {
        ...current,
        ...(registrationSide === 'A'
          ? { sourceAId: registered.sourceId, datasetA: dataset, keyFieldA: '' }
          : { sourceBId: registered.sourceId, datasetB: dataset, keyFieldB: '' }),
      } : current);
    }
    if (registered) {
      setRegistrationSide(null);
      setRegistrationOpen(false);
    }
  }

  async function browseRegisteredSource(source: AppData['sources'][number]) {
    await readCatalog(
      { id: source.workspaceId, displayName: source.workspaceName, type: 'Workspace' },
      { id: source.itemId, displayName: source.itemName, type: source.itemType, workspaceId: source.workspaceId }
    );
  }

  async function ensureCatalog(source: AppData['sources'][number]) {
    if (!user) return [];
    if (catalogs[source.id]) return catalogs[source.id];
    setBusyKey(`catalog:${source.id}`);
    try {
      const result = await callReconciliationGateway<CatalogResponse>('catalog', user.email, {
        source: { workspaceId: source.workspaceId, itemId: source.itemId, itemType: source.itemType },
      });
      setCatalogs((current) => ({ ...current, [source.id]: result.objects }));
      return result.objects;
    } finally { setBusyKey(''); }
  }

  function sourceObjects(sourceId: string) {
    if (catalogs[sourceId]) return catalogs[sourceId];
    const source = sources.find((entry) => entry.id === sourceId);
    return source ? parseObjects(source) : [];
  }

  function setDraftValue<K extends keyof RuleDraft>(key: K, value: RuleDraft[K]) {
    setDraft((current) => current ? { ...current, [key]: value } : current);
  }

  function updateField(index: number, update: (field: CompareField) => CompareField) {
    setDraft((current) => current ? {
      ...current,
      compareFields: current.compareFields.map((field, fieldIndex) => fieldIndex === index ? update(field) : field),
    } : current);
  }

  async function selectRuleSource(side: 'A' | 'B', sourceId: string) {
    if (!draft) return;
    const source = sources.find((entry) => entry.id === sourceId);
    const objects = source ? await ensureCatalog(source) : [];
    const first = objects[0] ? objectName(objects[0]) : '';
    setDraft((current) => current ? {
      ...current,
      ...(side === 'A' ? { sourceAId: sourceId, datasetA: first, keyFieldA: '' } : { sourceBId: sourceId, datasetB: first, keyFieldB: '' }),
    } : current);
  }

  function openNewRule() {
    setError(null);
    setNotice(null);
    setVersionHistory(null);
    setDraft(blankRule());
  }

  async function openEditRule(rule: StoredRule) {
    if (!user) return;
    setBusyKey(`rule:${rule.id}`);
    setError(null);
    try {
      const [compareFields] = await Promise.all([
        loadRuleFields(rule.id, user.id),
        ...sources.filter((source) => source.id === rule.sourceAId || source.id === rule.sourceBId).map((source) => ensureCatalog(source)),
      ]);
      setDraft({ ...rule, compareFields, id: rule.id });
      setVersionHistory(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to open this rule.'); }
    finally { setBusyKey(''); }
  }

  async function saveCurrentRule() {
    if (!draft || !user) return;
    setBusyKey('save-rule');
    setError(null);
    try {
      const id = await saveRule(draft, user.id, user.name, draft.id ? 'Rule updated in the reconciliation workspace' : 'Rule created in the reconciliation workspace');
      setDraft(null);
      setNotice(`Rule ${draft.id ? 'updated' : 'created'} as version ${draft.id ? (rules.find((rule) => rule.id === draft.id)?.version ?? 0) + 1 : 1}.`);
      await refreshData();
      const savedRule = (await loadReconciliationData(user.id)).rules.find((rule) => rule.id === id);
      if (savedRule && draft.compareFields.length) setVersionHistory(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to save this rule.'); }
    finally { setBusyKey(''); }
  }

  async function toggleRule(rule: StoredRule) {
    if (!user) return;
    setBusyKey(`rule:${rule.id}`);
    setError(null);
    try {
      const fields = await loadRuleFields(rule.id, user.id);
      await setRuleEnabled(rule, fields, !rule.enabled, user.id, user.name);
      setNotice(`${rule.name} ${rule.enabled ? 'disabled' : 'enabled'}.`);
      await refreshData();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to change rule status.'); }
    finally { setBusyKey(''); }
  }

  async function showVersions(rule: StoredRule) {
    if (!user) return;
    setBusyKey(`versions:${rule.id}`);
    try {
      setVersionHistory(await loadRuleVersions(rule.id, user.id) as unknown as Array<Record<string, unknown>>);
      setDraft(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to load rule history.'); }
    finally { setBusyKey(''); }
  }

  async function executeRule(rule: StoredRule): Promise<{ ok: true; runId: string; matched: number; findings: number } | { ok: false; message: string }> {
    if (!user) return { ok: false, message: 'Sign in before running rules.' };
    const sourceA = sources.find((source) => source.id === rule.sourceAId);
    const sourceB = sources.find((source) => source.id === rule.sourceBId);
    if (!sourceA || !sourceB) return { ok: false, message: 'The rule is missing one of its saved sources.' };
    if (!rule.enabled || rule.status === 'retired') return { ok: false, message: `${rule.name} is not enabled for runs.` };
    const compareFields = await loadRuleFields(rule.id, user.id);
    const run = await createRun(rule, user.id, user.name);
    try {
      const execution = await callReconciliationGateway<{ result: ReconciliationResult }>('execute', user.email, {
        sources: {
          a: { workspaceId: sourceA.workspaceId, itemId: sourceA.itemId, itemType: sourceA.itemType },
          b: { workspaceId: sourceB.workspaceId, itemId: sourceB.itemId, itemType: sourceB.itemType },
        },
        rule: { ...rule, compareFields, rowLimit: Math.min(rule.rowLimit || 10000, 10000) },
      });
      await completeRun(run.id, rule, execution.result, user.id);
      return { ok: true, runId: run.id, matched: execution.result.summary.matched, findings: execution.result.summary.exceptions };
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Reconciliation failed.';
      try { await failRun(run.id, message); } catch { /* Keep reporting the original execution failure. */ }
      return { ok: false, message };
    }
  }

  async function runRule(rule: StoredRule) {
    if (!user) return;
    setBusyKey(`run:${rule.id}`);
    setError(null);
    try {
      const result = await executeRule(rule);
      if (!result.ok) throw new Error(result.message);
      setNotice(`Run completed: ${result.matched} matched, ${result.findings} findings.`);
      await refreshData();
      setTab('runs');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to run this rule.'); }
    finally { setBusyKey(''); }
  }

  async function runSelectedRules() {
    if (!user) return;
    const selected = rules.filter((rule) => selectedRuleIds.includes(rule.id) && rule.enabled && rule.status !== 'retired');
    if (!selected.length) { setError('Select at least one enabled, active rule to run.'); return; }
    setBusyKey('run-selected');
    setError(null);
    let failed = 0;
    try {
      for (const rule of selected) {
        const result = await executeRule(rule);
        if (!result.ok) failed += 1;
      }
      setNotice(`${selected.length} rule${selected.length === 1 ? '' : 's'} run, ${failed} failed.`);
      await refreshData();
      setTab('runs');
    } finally { setBusyKey(''); }
  }

  async function bulkChangeRuleStatus(enabled: boolean) {
    if (!user) return;
    const selected = rules.filter((rule) => selectedRuleIds.includes(rule.id) && rule.status !== 'retired');
    if (!selected.length) { setError('Select at least one non-retired rule.'); return; }
    setBusyKey(`bulk-rules:${enabled ? 'enable' : 'disable'}`);
    setError(null);
    try {
      const result = await bulkSetRuleStatus(selected, enabled, user.id, user.name);
      if (result.succeeded.length) setNotice(`${result.succeeded.length} rule${result.succeeded.length === 1 ? '' : 's'} ${enabled ? 'enabled' : 'disabled'}.`);
      if (result.failed.length) setError(result.failed.map((failure) => `${failure.ruleName}: ${failure.message}`).join(' '));
      await refreshData();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to update selected rules.'); }
    finally { setBusyKey(''); }
  }

  async function retireSelectedRule(rule: StoredRule) {
    if (!user) return;
    if (!window.confirm(`Retire "${rule.name}"? Retired rules cannot be run or re-enabled from this page.`)) return;
    const reason = window.prompt('Optional retirement reason', 'Rule retired from the reconciliation workspace') ?? undefined;
    setBusyKey(`retire:${rule.id}`);
    setError(null);
    try {
      const fields = await loadRuleFields(rule.id, user.id);
      await retireRule(rule, fields, user.id, user.name, reason);
      setNotice(`${rule.name} retired.`);
      await refreshData();
    } catch (reasonValue) { setError(reasonValue instanceof Error ? reasonValue.message : 'Unable to retire this rule.'); }
    finally { setBusyKey(''); }
  }

  async function compareSelectedRuns() {
    if (!user) return;
    const from = runs.find((run) => run.id === fromRunId);
    const to = runs.find((run) => run.id === toRunId);
    if (!from || !to) { setError('Choose two completed runs to compare.'); return; }
    setBusyKey('compare');
    setError(null);
    try { setComparison(await compareStoredRuns(from, to, user.id)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to compare these runs.'); }
    finally { setBusyKey(''); }
  }

  function openNewSchedule() {
    const rule = rules.find((entry) => entry.status === 'active') ?? rules.find((entry) => entry.status !== 'retired');
    setScheduleDraft({ ruleId: rule?.id ?? '', enabled: true, cadence: 'hourly', intervalCount: 1, hourUtc: 0, minuteUtc: 0 });
    setError(null);
  }

  function openEditSchedule(schedule: AppData['schedules'][number]) {
    setScheduleDraft({
      id: schedule.id,
      ruleId: schedule.rule_id,
      enabled: schedule.enabled,
      cadence: schedule.cadence,
      intervalCount: schedule.intervalCount,
      hourUtc: schedule.hourUtc,
      minuteUtc: schedule.minuteUtc,
      dayOfWeek: schedule.dayOfWeek,
    });
    setError(null);
  }

  async function saveCurrentSchedule() {
    if (!user || !scheduleDraft) return;
    const rule = rules.find((entry) => entry.id === scheduleDraft.ruleId);
    if (!rule) { setError('Choose a rule for this schedule.'); return; }
    const problems = validateSchedule(scheduleDraft);
    if (problems.length) { setError(problems.join(' ')); return; }
    setBusyKey('save-schedule');
    setError(null);
    try {
      await saveSchedule(rule, scheduleDraft, user.id, user.name);
      setScheduleDraft(null);
      setNotice(`Schedule ${scheduleDraft.id ? 'updated' : 'created'} for ${rule.name}.`);
      await refreshData();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to save this schedule.'); }
    finally { setBusyKey(''); }
  }

  async function toggleSchedule(scheduleId: string, enabled: boolean) {
    if (!user) return;
    setBusyKey(`schedule:${scheduleId}`);
    setError(null);
    try {
      await setScheduleEnabled(scheduleId, enabled, user.name);
      setNotice(`Schedule ${enabled ? 'enabled' : 'disabled'}.`);
      await refreshData();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to change schedule status.'); }
    finally { setBusyKey(''); }
  }

  async function removeSchedule(scheduleId: string) {
    if (!window.confirm('Delete this schedule?')) return;
    setBusyKey(`schedule:${scheduleId}`);
    setError(null);
    try {
      await deleteSchedule(scheduleId);
      setNotice('Schedule deleted.');
      await refreshData();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to delete this schedule.'); }
    finally { setBusyKey(''); }
  }

  async function bulkExceptionStatus(status: StoredException['status']) {
    if (!user) return;
    const selected = exceptions.filter((exception) => selectedExceptionIds.includes(exception.id));
    if (!selected.length) { setError('Select at least one exception.'); return; }
    const reason = status === 'resolved' || status === 'accepted' ? window.prompt(`Reason for marking ${status}`)?.trim() : undefined;
    if ((status === 'resolved' || status === 'accepted') && !reason) { setError('A reason is required when resolving or accepting exceptions.'); return; }
    await applyBulkExceptionAction(selected, { kind: 'status', status, reason });
  }

  async function bulkExceptionAssign() {
    const selected = exceptions.filter((exception) => selectedExceptionIds.includes(exception.id));
    if (!selected.length) { setError('Select at least one exception.'); return; }
    const owner = window.prompt('Assign selected exceptions to owner (leave blank to clear)', '') ?? '';
    await applyBulkExceptionAction(selected, { kind: 'assign', owner });
  }

  async function bulkExceptionComment() {
    const selected = exceptions.filter((exception) => selectedExceptionIds.includes(exception.id));
    if (!selected.length) { setError('Select at least one exception.'); return; }
    const comment = window.prompt('Comment to add to selected exceptions')?.trim();
    if (!comment) { setError('Enter a comment for the selected exceptions.'); return; }
    await applyBulkExceptionAction(selected, { kind: 'comment', comment });
  }

  async function applyBulkExceptionAction(
    selected: StoredException[],
    action: Parameters<typeof bulkUpdateExceptions>[1]
  ) {
    if (!user) return;
    setBusyKey('bulk-exceptions');
    setError(null);
    try {
      const result = await bulkUpdateExceptions(selected, action, user.id, user.name);
      if (result.succeeded.length) setNotice(`${result.succeeded.length} exception${result.succeeded.length === 1 ? '' : 's'} updated.`);
      if (result.failed.length) setError(result.failed.map((failure) => `${failure.businessKey}: ${failure.message}`).join(' '));
      await refreshData();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to update selected exceptions.'); }
    finally { setBusyKey(''); }
  }

  async function removeRun(run: StoredRun) {
    if (!window.confirm(`Delete run for "${run.ruleName}" started ${formatDate(run.startedAt)}?`)) return;
    setBusyKey(`delete-run:${run.id}`);
    setError(null);
    try {
      const result = await deleteRun(run.id);
      if (selectedRun?.id === run.id) setSelectedRun(null);
      setNotice(`Run deleted. ${result.findingsDeleted} finding${result.findingsDeleted === 1 ? '' : 's'} deleted, ${result.exceptionsRepointed} exception${result.exceptionsRepointed === 1 ? '' : 's'} repointed.`);
      await refreshData();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to delete this run.'); }
    finally { setBusyKey(''); }
  }

  async function checkOrphans() {
    setBusyKey('orphans');
    setError(null);
    try { setOrphanReport(await findOrphans()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to find orphaned reconciliation rows.'); }
    finally { setBusyKey(''); }
  }

  async function purgeOrphanRows() {
    if (!window.confirm('Purge orphaned runs, exceptions, findings, schedules, and events?')) return;
    setBusyKey('purge-orphans');
    setError(null);
    try {
      const result = await purgeOrphans();
      setNotice(`Purged ${result.runs} runs, ${result.exceptions} exceptions, ${result.findings} findings, ${result.events} events, and ${result.schedules} schedules.`);
      setOrphanReport(await findOrphans());
      await refreshData();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to purge orphaned reconciliation rows.'); }
    finally { setBusyKey(''); }
  }

  async function changeExceptionStatus(status: StoredException['status']) {
    if (!user || !selectedException) return;
    setBusyKey(`exception:${selectedException.id}`);
    setError(null);
    try {
      await updateExceptionStatus(selectedException, status, user.id, user.name, closeReason, commentInput);
      setSelectedException({ ...selectedException, status });
      setNotice(`Exception ${selectedException.businessKey} moved to ${status}.`);
      await refreshData();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to change exception status.'); }
    finally { setBusyKey(''); }
  }

  async function saveExceptionOwner() {
    if (!user || !selectedException) return;
    setBusyKey(`exception:${selectedException.id}`);
    setError(null);
    try {
      await assignException(selectedException, ownerInput.trim(), user.id, user.name);
      setSelectedException({ ...selectedException, owner: ownerInput.trim() || undefined });
      setNotice('Exception assignment updated.');
      await refreshData();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to assign exception.'); }
    finally { setBusyKey(''); }
  }

  async function saveExceptionComment() {
    if (!user || !selectedException) return;
    setBusyKey(`exception:${selectedException.id}`);
    setError(null);
    try {
      await addExceptionComment(selectedException, commentInput, user.id, user.name);
      setCommentInput('');
      setExceptionEvents(await loadExceptionEvents(selectedException.id, user.id) as unknown as Array<Record<string, unknown>>);
      setNotice('Comment added to the exception history.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to add comment.'); }
    finally { setBusyKey(''); }
  }

  const userName = user?.name || user?.email || 'Signed-in user';
  /* state.values already folds in the build-time variables, so this reflects what Fabric calls will actually use. */
  const fabricConfigured = Boolean(settings?.values.fabricEntraClientId && settings?.values.fabricEntraTenantId);

  return (
    <div className="app-canvas min-h-screen text-slate-900">
      <header className="sticky top-0 z-30 border-b border-slate-200/70 bg-white/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-7">
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 shadow-md shadow-brand-600/30">
              <svg viewBox="0 0 24 24" fill="none" className="h-6 w-6 text-white" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 7h11l-2.5-2.5" /><path d="M20 17H9l2.5 2.5" /><circle cx="18" cy="7" r="2.5" /><circle cx="6" cy="17" r="2.5" />
              </svg>
            </span>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-brand-600">Fabric data controls</p>
              <h1 className="text-2xl font-bold tracking-tight text-slate-900">Reconciliation</h1>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden text-right sm:block"><p className="text-sm font-semibold text-slate-800">{userName}</p><p className="text-xs text-slate-500">Workspace-shared controls and results</p></div>
            <span aria-hidden="true" className="hidden h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-brand-100 to-brand-200 text-sm font-bold text-brand-700 sm:flex">{userName.trim().charAt(0).toUpperCase()}</span>
            <button type="button" onClick={() => void signOut()} className={secondaryButton}>Sign out</button>
          </div>
        </div>
        <nav className="mx-auto flex max-w-[1440px] gap-1 overflow-x-auto px-4 pb-3 pt-2 sm:px-7" aria-label="Reconciliation sections">
          {tabs.map((entry) => (
            <button key={entry.id} type="button" onClick={() => { setTab(entry.id); setError(null); }}
              aria-current={tab === entry.id ? 'page' : undefined}
              className={`whitespace-nowrap rounded-lg px-3.5 py-2 text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 ${tab === entry.id ? 'bg-brand-50 text-brand-700 shadow-sm ring-1 ring-brand-200' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-900'}`}>
              {entry.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-[1440px] px-4 py-7 sm:px-7">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div><h2 className="text-xl font-bold tracking-tight text-slate-900">{tabs.find((entry) => entry.id === tab)?.label}</h2><p className="mt-1 text-sm text-slate-500">{tabs.find((entry) => entry.id === tab)?.caption ?? defaultTabCaption}</p></div>
          <button type="button" onClick={() => void refreshData()} disabled={loading} className={secondaryButton}>{loading ? 'Refreshing...' : 'Refresh data'}</button>
        </div>
        {settings && !fabricConfigured && tab !== 'settings' && (
          <div role="status" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 shadow-sm">
            <span className="flex items-start gap-2.5"><span aria-hidden="true" className="mt-0.5 font-bold">!</span><span>Fabric access is not configured yet, so sources and rule runs will fail.</span></span>
            <button type="button" onClick={() => { setTab('settings'); setError(null); }} className={secondaryButton}>Open Configuration</button>
          </div>
        )}
        {error && <div role="alert" className="mb-4 flex items-start gap-2.5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 shadow-sm"><span aria-hidden="true" className="mt-0.5 font-bold">!</span><span>{error}</span></div>}
        {notice && <div role="status" className="mb-4 flex items-start gap-2.5 rounded-xl border border-teal-200 bg-teal-50 px-4 py-3 text-sm text-teal-900 shadow-sm"><span aria-hidden="true" className="mt-0.5 font-bold">✓</span><span>{notice}</span></div>}
        {!data && tab !== 'settings' && <div className={`${card} px-5 py-8 text-sm text-slate-600`}>{loading ? 'Loading reconciliation data...' : 'No reconciliation data is available yet. Configure the Rayfin data service and refresh.'}</div>}

        {tab === 'overview' && data && <OverviewPanel
          rules={rules} runs={runs} openExceptions={openExceptions} orphanReport={orphanReport} busyKey={busyKey}
          onNavigate={setTab} onFindOrphans={() => void checkOrphans()} onPurgeOrphans={() => void purgeOrphanRows()}
        />}
        {tab === 'sources' && <SourcesPanel
          sources={sources} catalogs={catalogs} busyKey={busyKey}
          onRegister={() => void openSourceRegistration()} onBrowse={(source) => void browseRegisteredSource(source)}
        />}
        {tab === 'rules' && data && <RulesPanel
          rules={rules} sources={sources} draft={draft} objectsForSource={sourceObjects} busyKey={busyKey}
          selectedRuleIds={selectedRuleIds} onSelectedRuleIds={setSelectedRuleIds}
          versionHistory={versionHistory} onNew={openNewRule} onEdit={openEditRule} onDraft={setDraftValue}
          onSelectSource={selectRuleSource} onUpdateField={updateField} onAddField={() => setDraft((current) => current ? { ...current, compareFields: [...current.compareFields, blankField(current.compareFields.length)] } : current)}
          onRemoveField={(index) => setDraft((current) => current ? { ...current, compareFields: current.compareFields.filter((_, fieldIndex) => fieldIndex !== index) } : current)}
          onSave={() => void saveCurrentRule()} onCancel={() => { setDraft(null); setVersionHistory(null); }}
          onToggle={toggleRule} onVersions={showVersions} onRun={runRule} onRunSelected={() => void runSelectedRules()}
          onBulkStatus={(enabled) => void bulkChangeRuleStatus(enabled)} onRetire={(rule) => void retireSelectedRule(rule)}
          onRegisterSource={(side) => void openSourceRegistration(side)}
        />}
        {tab === 'schedules' && data && <SchedulesPanel
          schedules={schedules} rules={rules} draft={scheduleDraft} busyKey={busyKey}
          onNew={openNewSchedule} onEdit={openEditSchedule} onDraft={setScheduleDraft}
          onSave={() => void saveCurrentSchedule()} onCancel={() => setScheduleDraft(null)}
          onToggle={(schedule, enabled) => void toggleSchedule(schedule.id, enabled)}
          onDelete={(schedule) => void removeSchedule(schedule.id)}
        />}
        {tab === 'exceptions' && data && <ExceptionsPanel
          exceptions={filteredExceptions} allExceptions={exceptions} rules={rules} runs={runs} filter={exceptionFilter} selected={selectedException}
          selectedIds={selectedExceptionIds} events={exceptionEvents} owner={ownerInput} comment={commentInput} reason={closeReason} busyKey={busyKey}
          onFilter={setExceptionFilter} onSelect={setSelectedException} onOwner={setOwnerInput} onComment={setCommentInput}
          onReason={setCloseReason} onAssign={() => void saveExceptionOwner()} onAddComment={() => void saveExceptionComment()}
          onStatus={(status) => void changeExceptionStatus(status)} onSelectedIds={setSelectedExceptionIds}
          onBulkStatus={(status) => void bulkExceptionStatus(status)} onBulkAssign={() => void bulkExceptionAssign()} onBulkComment={() => void bulkExceptionComment()}
        />}
        {tab === 'runs' && data && <RunsPanel runs={runs} selectedRun={selectedRun} findings={runFindings} busyKey={busyKey} onDetails={setSelectedRun} onDelete={(run) => void removeRun(run)} onCompare={(run) => {
          setComparisonRuleId(run.rule_id);
          const sameRule = runs.filter((candidate) => candidate.rule_id === run.rule_id && candidate.status === 'completed');
          setFromRunId(sameRule[1]?.id ?? '');
          setToRunId(sameRule[0]?.id ?? run.id);
          setTab('compare');
        }} />}
        {tab === 'compare' && data && <ComparePanel
          rules={rules} runs={selectedComparisonRuns} ruleId={comparisonRuleId} fromRunId={fromRunId} toRunId={toRunId}
          result={comparison} busy={busyKey === 'compare'} onRule={setComparisonRuleId} onFrom={setFromRunId} onTo={setToRunId}
          onCompare={() => void compareSelectedRuns()}
        />}
        {tab === 'settings' && <SettingsPanel
          state={settings} values={settingsForm} errors={settingsErrors} busy={busyKey === 'settings'}
          onChange={(key, value) => {
            setSettingsForm((current) => ({ ...current, [key]: value }));
            setSettingsErrors((current) => ({ ...current, [key]: undefined }));
          }}
          onSave={() => void saveSettings()}
          onReset={() => { if (settings) { setSettingsForm(settings.values); setSettingsErrors({}); } }}
        />}
      </main>
      {registrationOpen && <SourceRegistrationModal
        workspaces={registrationWorkspaces ?? []} loading={registrationLoading} filter={registrationFilter}
        busyKey={busyKey} onFilter={setRegistrationFilter} onSelect={(workspace, item) => void registerSource(workspace, item)}
        onClose={() => { setRegistrationOpen(false); setRegistrationSide(null); }}
      />}
    </div>
  );
}

function OverviewPanel({
  rules, runs, openExceptions, orphanReport, busyKey, onNavigate, onFindOrphans, onPurgeOrphans,
}: {
  rules: StoredRule[];
  runs: StoredRun[];
  openExceptions: StoredException[];
  orphanReport: OrphanReport | null;
  busyKey: string;
  onNavigate: (tab: Tab) => void;
  onFindOrphans: () => void;
  onPurgeOrphans: () => void;
}) {
  const recentRuns = runs.slice(0, 8);
  const groupCounts = ruleGroups.map(([key, label]) => ({
    key, label,
    total: rules.filter((rule) => rule.ruleGroup === key).length,
    active: rules.filter((rule) => rule.ruleGroup === key && rule.enabled).length,
    exceptions: openExceptions.filter((exception) => rules.find((rule) => rule.id === exception.rule_id)?.ruleGroup === key).length,
  })).filter((group) => group.total > 0);
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Active rules" value={rules.filter((rule) => rule.enabled).length} accent="brand" onClick={() => onNavigate('rules')} />
        <Metric label="Draft rules" value={rules.filter((rule) => rule.status === 'draft').length} accent="slate" onClick={() => onNavigate('rules')} />
        <Metric label="Open exceptions" value={openExceptions.length} accent="rose" onClick={() => onNavigate('exceptions')} />
        <Metric label="Completed runs" value={runs.filter((run) => run.status === 'completed').length} accent="teal" onClick={() => onNavigate('runs')} />
      </div>
      <section className={card}>
        <SectionTitle title="Coverage by rule group" action={<button type="button" onClick={() => onNavigate('rules')} className="text-sm font-semibold text-brand-700 transition hover:text-brand-800 hover:underline">Manage rules</button>} />
        {groupCounts.length ? <div className="grid divide-y divide-slate-100 sm:grid-cols-2 sm:divide-x sm:divide-y-0 xl:grid-cols-3">
          {groupCounts.map((group) => <div key={group.key} className="flex items-center justify-between gap-4 px-4 py-3">
            <div><p className="text-sm font-medium">{group.label}</p><p className="mt-0.5 text-xs text-slate-500">{group.total} rule{group.total === 1 ? '' : 's'}</p></div>
            <div className="flex gap-5 text-right text-xs"><div><p className="font-semibold text-teal-800">{group.active}</p><p className="text-slate-500">enabled</p></div><div><p className="font-semibold text-rose-700">{group.exceptions}</p><p className="text-slate-500">open</p></div></div>
          </div>)}
        </div> : <EmptyMessage>Rule coverage will appear here after you create rules.</EmptyMessage>}
      </section>
      <section className={card}>
        <SectionTitle title="Recent runs" action={<button type="button" onClick={() => onNavigate('runs')} className="text-sm font-semibold text-brand-700 transition hover:text-brand-800 hover:underline">View history</button>} />
        {recentRuns.length ? <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-sm"><thead className="bg-slate-50/80 text-xs font-semibold uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-2.5">Rule</th><th className="px-4 py-2.5">Started</th><th className="px-4 py-2.5">Status</th><th className="px-4 py-2.5 text-right">Matched</th><th className="px-4 py-2.5 text-right">Findings</th><th className="px-4 py-2.5"></th></tr></thead><tbody className="divide-y divide-slate-100 [&>tr]:transition-colors [&>tr:hover]:bg-slate-50/70">
          {recentRuns.map((run) => <tr key={run.id}><td className="px-4 py-3 font-medium">{run.ruleName}<span className="ml-2 text-xs text-slate-400">v{run.ruleVersion}</span></td><td className="px-4 py-3 text-slate-600">{formatDate(run.startedAt)}</td><td className="px-4 py-3"><StatusPill value={run.status} /></td><td className="px-4 py-3 text-right tabular-nums">{run.matched}</td><td className="px-4 py-3 text-right tabular-nums">{run.exceptionCount}</td><td className="px-4 py-3 text-right"><button type="button" onClick={() => onNavigate('runs')} className="text-xs font-semibold text-brand-700 transition hover:text-brand-800 hover:underline">History</button></td></tr>)}
        </tbody></table></div> : <EmptyMessage>No runs have been recorded.</EmptyMessage>}
      </section>
      <section className={card}>
        <SectionTitle title="Priority work" action={<button type="button" onClick={() => onNavigate('exceptions')} className="text-sm font-semibold text-brand-700 transition hover:text-brand-800 hover:underline">Review exceptions</button>} />
        {openExceptions.length ? <ul className="divide-y divide-slate-100">{openExceptions.slice(0, 6).map((exception) => <li key={exception.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"><div><p className="text-sm font-medium">{exception.businessKey}</p><p className="mt-0.5 text-xs text-slate-500">{humanOutcome(exception.outcome)} · last seen {formatDate(exception.lastSeen)}</p></div><div className="flex items-center gap-3"><SeverityPill value={exception.severity} /><span className="text-xs text-slate-500">{exception.occurrenceCount} occurrence{exception.occurrenceCount === 1 ? '' : 's'}</span></div></li>)}</ul> : <EmptyMessage>No active exceptions.</EmptyMessage>}
      </section>
      <section className={card}>
        <SectionTitle title="Maintenance" subtitle="Find and purge reconciliation rows whose owning rule no longer exists." action={<div className="flex gap-2"><button type="button" onClick={onFindOrphans} disabled={busyKey === 'orphans'} className={secondaryButton}>{busyKey === 'orphans' ? 'Checking...' : 'Check orphans'}</button><button type="button" onClick={onPurgeOrphans} disabled={busyKey === 'purge-orphans'} className={dangerButton}>Purge orphans</button></div>} />
        {orphanReport ? <div className="grid gap-4 p-4 sm:grid-cols-2 xl:grid-cols-4">
          <Metric label="Orphan runs" value={orphanReport.runs.length} accent="amber" onClick={noop} />
          <Metric label="Orphan exceptions" value={orphanReport.exceptions.length} accent="amber" onClick={noop} />
          <Metric label="Orphan findings" value={orphanReport.findings} accent="amber" onClick={noop} />
          <Metric label="Orphan schedules" value={orphanReport.schedules.length} accent="amber" onClick={noop} />
        </div> : <EmptyMessage>Run a maintenance check to see orphaned row counts.</EmptyMessage>}
      </section>
    </div>
  );
}

function Metric({ label, value, accent = 'slate', onClick }: { label: string; value: number; accent?: MetricAccent; onClick: () => void }) {
  const tone = metricAccents[accent];
  // Orphan-report metrics are not navigable, so they must not look clickable.
  const interactive = onClick !== noop;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!interactive}
      className={`${card} group flex items-center gap-4 px-4 py-4 text-left ${interactive ? 'hover:border-slate-300' : 'cursor-default'}`}
    >
      <span aria-hidden="true" className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg ${tone.chip}`}>
        <span className={`h-2.5 w-2.5 rounded-full ${tone.dot}`} />
      </span>
      <span className="min-w-0">
        <span className="block text-2xl font-bold tabular-nums tracking-tight text-slate-900">{value}</span>
        <span className="mt-0.5 block truncate text-sm text-slate-500">{label}</span>
      </span>
    </button>
  );
}

function SourcesPanel({ sources, catalogs, busyKey, onRegister, onBrowse }: {
  sources: AppData['sources'];
  catalogs: Record<string, SqlObject[]>;
  busyKey: string;
  onRegister: () => void;
  onBrowse: (source: AppData['sources'][number]) => void;
}) {
  return <section className={card}>
    <SectionTitle title="Registered SQL sources" subtitle="Only registered Lakehouses and Warehouses are offered to rule definitions." action={<button type="button" onClick={onRegister} className={primaryButton}>Register source</button>} />
    {sources.length ? <div className="divide-y divide-slate-100">{sources.map((source) => {
      const objects = catalogs[source.id] ?? parseObjects(source);
      return <details key={source.id} className="group">
        <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-3 px-4 py-3 hover:bg-slate-50">
          <div><p className="text-sm font-semibold">{source.itemName}<span className="ml-2 rounded-full border border-brand-100 bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700">{source.itemType}</span></p><p className="mt-1 text-xs text-slate-500">{source.workspaceName} · {objects.length || source.objectCount} SQL objects</p></div>
          <button type="button" onClick={(event) => { event.preventDefault(); onBrowse(source); }} disabled={busyKey === `catalog:${source.itemId}`} className="text-xs font-semibold text-brand-700 transition hover:text-brand-800 hover:underline">{busyKey === `catalog:${source.itemId}` ? 'Loading...' : 'Refresh tables'}</button>
        </summary>
        {objects.length ? <div className="border-t border-slate-100 bg-slate-50 px-4 py-3"><div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">{objects.map((object) => <div key={objectName(object)} className="rounded-lg border border-slate-200 bg-white p-2.5 shadow-sm"><p className="text-xs font-semibold">{objectName(object)}</p><p className="mt-0.5 text-[11px] text-slate-500">{object.type} · {object.fields.length} columns</p><p className="mt-2 line-clamp-2 text-[11px] text-slate-600">{object.fields.map((field) => field.name).join(', ')}</p></div>)}</div></div> : <p className="px-4 py-3 text-xs text-slate-500">Load tables to make them available in Rule Definition.</p>}
      </details>;
    })}</div> : <div className="px-4 py-6"><p className="mb-3 text-sm text-slate-600">No sources registered yet. Register a Lakehouse or Warehouse here or directly from a rule side.</p><button type="button" onClick={onRegister} className={primaryButton}>Register source</button></div>}
  </section>;
}

function SourceRegistrationModal({ workspaces, loading, filter, busyKey, onFilter, onSelect, onClose }: {
  workspaces: WorkspaceResources[];
  loading: boolean;
  filter: string;
  busyKey: string;
  onFilter: (value: string) => void;
  onSelect: (workspace: WorkspaceResources['workspace'], item: FabricItem) => void;
  onClose: () => void;
}) {
  const query = filter.trim().toLocaleLowerCase();
  const candidates = workspaces.flatMap((workspace) => workspace.items
    .filter((item) => supportedTypes.includes(item.type))
    .filter((item) => !query || `${workspace.workspace.displayName} ${item.displayName} ${item.type}`.toLocaleLowerCase().includes(query))
    .map((item) => ({ workspace, item })));
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section role="dialog" aria-modal="true" aria-labelledby="register-source-heading" className="max-h-[88vh] w-full max-w-3xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
      <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-4 py-4"><div><h2 id="register-source-heading" className="font-semibold">Register a SQL source</h2><p className="mt-1 text-sm text-slate-500">Choose a Lakehouse or Warehouse to load its SQL tables and columns.</p></div><button type="button" onClick={onClose} className="text-sm font-medium text-slate-500 hover:text-slate-900">Close</button></div>
      <div className="border-b border-slate-200 p-4"><label className={labelClass}>Filter sources</label><input className={input} value={filter} onChange={(event) => onFilter(event.target.value)} placeholder="Workspace or item name" /></div>
      <div className="max-h-[60vh] overflow-auto">
        {loading && <EmptyMessage>Loading accessible workspaces and SQL sources...</EmptyMessage>}
        {!loading && candidates.length === 0 && <EmptyMessage>{workspaces.length ? 'No Lakehouses or Warehouses match this filter.' : 'No accessible SQL sources were returned.'}</EmptyMessage>}
        {!loading && candidates.map(({ workspace, item }) => <div key={`${workspace.workspace.id}:${item.id}`} className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-3"><div><p className="text-sm font-semibold">{item.displayName}</p><p className="mt-0.5 text-xs text-slate-500">{workspace.workspace.displayName} · {item.type}</p></div><button type="button" onClick={() => onSelect(workspace.workspace, item)} disabled={busyKey === `catalog:${item.id}`} className={secondaryButton}>{busyKey === `catalog:${item.id}` ? 'Reading tables...' : 'Register and load tables'}</button></div>)}
      </div>
    </section>
  </div>;
}

function RulesPanel({
  rules, sources, draft, objectsForSource, busyKey, selectedRuleIds, versionHistory, onNew, onEdit, onDraft, onSelectSource, onUpdateField, onAddField, onRemoveField, onSave, onCancel, onToggle, onVersions, onRun, onRunSelected, onBulkStatus, onRetire, onRegisterSource, onSelectedRuleIds,
}: {
  rules: StoredRule[];
  sources: AppData['sources'];
  draft: RuleDraft | null;
  objectsForSource: (id: string) => SqlObject[];
  busyKey: string;
  selectedRuleIds: string[];
  versionHistory: Array<Record<string, unknown>> | null;
  onNew: () => void;
  onEdit: (rule: StoredRule) => void;
  onDraft: <K extends keyof RuleDraft>(key: K, value: RuleDraft[K]) => void;
  onSelectSource: (side: 'A' | 'B', id: string) => void;
  onUpdateField: (index: number, update: (field: CompareField) => CompareField) => void;
  onAddField: () => void;
  onRemoveField: (index: number) => void;
  onSave: () => void;
  onCancel: () => void;
  onToggle: (rule: StoredRule) => void;
  onVersions: (rule: StoredRule) => void;
  onRun: (rule: StoredRule) => void;
  onRunSelected: () => void;
  onBulkStatus: (enabled: boolean) => void;
  onRetire: (rule: StoredRule) => void;
  onRegisterSource: (side: 'A' | 'B') => void;
  onSelectedRuleIds: (ids: string[]) => void;
}) {
  const toggleSelection = (ruleId: string, checked: boolean) => onSelectedRuleIds(checked ? [...selectedRuleIds, ruleId] : selectedRuleIds.filter((id) => id !== ruleId));
  const selectableIds = rules.map((rule) => rule.id);
  return <div className="space-y-5">
    <section className={card}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-4"><div><h3 className="font-semibold">Reconciliation rules</h3><p className="mt-1 text-sm text-slate-500">Definitions are versioned on every save or status change.</p></div><div className="flex flex-wrap gap-2"><button type="button" onClick={onRunSelected} disabled={!selectedRuleIds.length || busyKey === 'run-selected'} className={secondaryButton}>{busyKey === 'run-selected' ? 'Running...' : 'Run selected'}</button><button type="button" onClick={() => onBulkStatus(true)} disabled={!selectedRuleIds.length} className={secondaryButton}>Enable selected</button><button type="button" onClick={() => onBulkStatus(false)} disabled={!selectedRuleIds.length} className={secondaryButton}>Disable selected</button><button type="button" onClick={onNew} className={primaryButton}>New rule</button></div></div>
      {rules.length ? <div className="overflow-x-auto"><table className="w-full min-w-[980px] text-left text-sm"><thead className="bg-slate-50/80 text-xs font-semibold uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-2.5"><input type="checkbox" aria-label="Select all rules" checked={selectableIds.length > 0 && selectableIds.every((id) => selectedRuleIds.includes(id))} onChange={(event) => onSelectedRuleIds(event.target.checked ? selectableIds : [])} /></th><th className="px-4 py-2.5">Rule</th><th className="px-4 py-2.5">Group</th><th className="px-4 py-2.5">Status</th><th className="px-4 py-2.5">Owner</th><th className="px-4 py-2.5 text-right">Version</th><th className="px-4 py-2.5 text-right">Actions</th></tr></thead><tbody className="divide-y divide-slate-100 [&>tr]:transition-colors [&>tr:hover]:bg-slate-50/70">
        {rules.map((rule) => <tr key={rule.id} className={rule.status === 'retired' ? 'bg-slate-50 text-slate-500' : ''}><td className="px-4 py-3"><input type="checkbox" aria-label={`Select ${rule.name}`} checked={selectedRuleIds.includes(rule.id)} onChange={(event) => toggleSelection(rule.id, event.target.checked)} /></td><td className="px-4 py-3"><p className="font-medium">{rule.name}</p><p className="text-xs text-slate-500">{rule.businessArea || 'Unassigned area'} · {rule.priority} priority</p></td><td className="px-4 py-3 text-slate-600">{ruleGroups.find(([key]) => key === rule.ruleGroup)?.[1] ?? 'Ungrouped'}</td><td className="px-4 py-3"><StatusPill value={rule.status} /></td><td className="px-4 py-3 text-slate-600">{rule.owner || 'Unassigned'}</td><td className="px-4 py-3 text-right tabular-nums">v{rule.version}</td><td className="px-4 py-3"><div className="flex justify-end gap-3"><button type="button" onClick={() => onEdit(rule)} disabled={busyKey === `rule:${rule.id}`} className="text-xs font-semibold text-brand-700 transition hover:text-brand-800 hover:underline">Edit</button><button type="button" onClick={() => onVersions(rule)} disabled={busyKey === `versions:${rule.id}`} className="text-xs font-semibold text-slate-600 hover:underline">Versions</button>{rule.status !== 'retired' && (rule.enabled ? <button type="button" onClick={() => onToggle(rule)} disabled={busyKey === `rule:${rule.id}`} className="text-xs font-semibold text-amber-800 hover:underline">Disable</button> : <button type="button" onClick={() => onToggle(rule)} disabled={busyKey === `rule:${rule.id}`} className="text-xs font-semibold text-brand-700 transition hover:text-brand-800 hover:underline">Enable</button>)}{rule.enabled && rule.status !== 'retired' && <button type="button" onClick={() => onRun(rule)} disabled={busyKey === `run:${rule.id}`} className="text-xs font-semibold text-blue-800 hover:underline">{busyKey === `run:${rule.id}` ? 'Running...' : 'Run now'}</button>}{rule.status !== 'retired' && <button type="button" onClick={() => onRetire(rule)} disabled={busyKey === `retire:${rule.id}`} className="text-xs font-semibold text-rose-700 hover:underline">Retire</button>}</div></td></tr>)}
      </tbody></table></div> : <EmptyMessage>No rules yet. Create a rule after registering SQL sources.</EmptyMessage>}
    </section>

    {draft && <RuleEditor
      draft={draft} sources={sources} objectsForSource={objectsForSource} busy={busyKey === 'save-rule'}
      onDraft={onDraft} onSelectSource={onSelectSource} onUpdateField={onUpdateField} onAddField={onAddField} onRegisterSource={onRegisterSource}
      onRemoveField={onRemoveField} onSave={onSave} onCancel={onCancel}
    />}
    {versionHistory && <section className={card}><SectionTitle title="Rule version history" action={<button type="button" className="text-sm text-slate-600 hover:underline" onClick={onCancel}>Close</button>} />
      <ul className="divide-y divide-slate-100">{versionHistory.map((version) => {
        const fields = (version.compareFields ?? []) as CompareField[];
        const summarize = (operand: Operand) => operand.kind === 'aggregate' ? `${operand.fn ?? 'sum'}(${operand.value || '*'})` : operand.kind === 'constant' ? `constant ${operand.value}` : operand.value;
        return <li key={String(version.id)} className="px-4 py-3"><details><summary className="flex cursor-pointer flex-wrap justify-between gap-2 text-sm"><span><span className="font-semibold">Version {String(version.version)}</span><span className="ml-2 text-slate-600">{String(version.changeNote || 'Definition saved')}</span><span className="ml-2 text-xs text-slate-500">{fields.length} comparison values</span></span><span className="text-xs text-slate-500">{formatDate(version.changedAt as Date)} · {String(version.changedBy)}</span></summary>{fields.length > 0 && <ul className="mt-3 divide-y divide-slate-100 border-t border-slate-200">{fields.map((field, index) => <li key={`${field.label}-${index}`} className="grid gap-1 py-2 text-xs sm:grid-cols-[minmax(100px,0.6fr)_1fr_1fr_120px]"><span className="font-semibold">{field.label}</span><span className="text-slate-600">Left: {summarize(field.a)}</span><span className="text-slate-600">Right: {summarize(field.b)}</span><span className="text-slate-500">{field.tolerance ? `${field.tolerance.value} ${field.tolerance.type}` : 'Exact'}</span></li>)}</ul>}</details></li>;
      })}</ul>
    </section>}
  </div>;
}

function RuleEditor({
  draft, sources, objectsForSource, busy, onDraft, onSelectSource, onUpdateField, onAddField, onRemoveField, onSave, onCancel, onRegisterSource,
}: {
  draft: RuleDraft;
  sources: AppData['sources'];
  objectsForSource: (id: string) => SqlObject[];
  busy: boolean;
  onDraft: <K extends keyof RuleDraft>(key: K, value: RuleDraft[K]) => void;
  onSelectSource: (side: 'A' | 'B', id: string) => void;
  onUpdateField: (index: number, update: (field: CompareField) => CompareField) => void;
  onAddField: () => void;
  onRemoveField: (index: number) => void;
  onSave: () => void;
  onCancel: () => void;
  onRegisterSource: (side: 'A' | 'B') => void;
}) {
  const objectsA = objectsForSource(draft.sourceAId);
  const objectsB = objectsForSource(draft.sourceBId);
  const selectedA = objectsA.find((object) => objectName(object) === draft.datasetA);
  const selectedB = objectsB.find((object) => objectName(object) === draft.datasetB);
  return <section className={card}>
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 px-4 py-4"><div><h3 className="font-semibold">{draft.id ? 'Edit reconciliation rule' : 'New reconciliation rule'}</h3><p className="mt-1 text-sm text-slate-500">Both sides use their own source, dataset, key, and projection.</p></div><button type="button" onClick={onCancel} className="text-sm text-slate-600 hover:underline">Close</button></div>
    <div className="space-y-5 p-4">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <div><label className={labelClass}>Rule name</label><input className={input} value={draft.name} onChange={(event) => onDraft('name', event.target.value)} /></div>
        <div><label className={labelClass}>Business area</label><input className={input} value={draft.businessArea ?? ''} onChange={(event) => onDraft('businessArea', event.target.value)} placeholder="Finance" /></div>
        <div><label className={labelClass}>Owner</label><input className={input} value={draft.owner ?? ''} onChange={(event) => onDraft('owner', event.target.value)} placeholder="name@company.com" /></div>
        <div><label className={labelClass}>Rule group</label><select className={input} value={draft.ruleGroup} onChange={(event) => onDraft('ruleGroup', event.target.value)}>{ruleGroups.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></div>
        <div className="md:col-span-2 xl:col-span-4"><label className={labelClass}>Description</label><input className={input} value={draft.description ?? ''} onChange={(event) => onDraft('description', event.target.value)} /></div>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <SourceRuleSide side="A" draft={draft} sources={sources} objects={objectsA} selectedObject={selectedA} onSelectSource={onSelectSource} onDraft={onDraft} onRegister={() => onRegisterSource('A')} />
        <SourceRuleSide side="B" draft={draft} sources={sources} objects={objectsB} selectedObject={selectedB} onSelectSource={onSelectSource} onDraft={onDraft} onRegister={() => onRegisterSource('B')} />
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <div><label className={labelClass}>Priority</label><select className={input} value={draft.priority} onChange={(event) => onDraft('priority', event.target.value as RuleDraft['priority'])}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></div>
        <div><label className={labelClass}>Duplicate key handling</label><select className={input} value={draft.duplicateHandling} onChange={(event) => onDraft('duplicateHandling', event.target.value as RuleDraft['duplicateHandling'])}><option value="exception">Raise finding</option><option value="first">Compare first record</option><option value="ignore">Ignore duplicate key</option></select></div>
        <div><label className={labelClass}>Missing key handling</label><select className={input} value={draft.incompleteKeyHandling} onChange={(event) => onDraft('incompleteKeyHandling', event.target.value as RuleDraft['incompleteKeyHandling'])}><option value="exception">Raise finding</option><option value="ignore">Ignore missing key</option></select></div>
        <div><label className={labelClass}>Maximum rows per side</label><input className={input} type="number" min={1} max={10000} value={draft.rowLimit} onChange={(event) => onDraft('rowLimit', Number(event.target.value))} /></div>
      </div>
      <div className="border-t border-slate-200 pt-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3"><div><h4 className="font-semibold">Values to compare</h4><p className="mt-1 text-xs text-slate-500">Operands may be columns, SQL expressions, fixed values, or aggregates.</p></div><button type="button" onClick={onAddField} className={secondaryButton}>Add value</button></div>
        <div className="space-y-3">
          {draft.compareFields.map((field, index) => <div key={`${index}-${field.label}`} className="rounded-lg border border-slate-200 bg-slate-50/50 p-3">
            <div className="mb-3 grid gap-3 md:grid-cols-[minmax(130px,1fr)_150px_150px_120px_auto]">
              <div><label className={labelClass}>Label</label><input className={input} value={field.label} onChange={(event) => onUpdateField(index, (current) => ({ ...current, label: event.target.value }))} /></div>
              <div><label className={labelClass}>Value type</label><select className={input} value={field.type} onChange={(event) => onUpdateField(index, (current) => ({ ...current, type: event.target.value as CompareField['type'] }))}><option value="string">Text</option><option value="number">Number</option><option value="date">Date</option><option value="boolean">Boolean</option></select></div>
              <div><label className={labelClass}>Tolerance</label><select className={input} value={field.tolerance?.type ?? 'none'} onChange={(event) => onUpdateField(index, (current) => ({ ...current, tolerance: event.target.value === 'none' ? undefined : { type: event.target.value as NonNullable<CompareField['tolerance']>['type'], value: current.tolerance?.value ?? 0 } }))}><option value="none">Exact</option><option value="absolute">Absolute</option><option value="percent">Percent</option><option value="days">Days</option></select></div>
              <div><label className={labelClass}>Allowed diff.</label><input className={input} type="number" min="0" step="any" disabled={!field.tolerance} value={field.tolerance?.value ?? ''} onChange={(event) => onUpdateField(index, (current) => ({ ...current, tolerance: current.tolerance ? { ...current.tolerance, value: Number(event.target.value) } : undefined }))} /></div>
              <div className="flex items-end"><button type="button" onClick={() => onRemoveField(index)} disabled={draft.compareFields.length === 1} className="mb-1 text-xs font-medium text-rose-700 hover:underline disabled:opacity-40">Remove</button></div>
            </div>
            {field.type === 'string' && <div className="mb-3 flex flex-wrap gap-4 text-sm">
              <label className="inline-flex items-center gap-2"><input type="checkbox" checked={field.caseInsensitive === true} onChange={(event) => onUpdateField(index, (current) => ({ ...current, caseInsensitive: event.target.checked }))} />Ignore case</label>
              <label className="inline-flex items-center gap-2"><input type="checkbox" checked={field.trim !== false} onChange={(event) => onUpdateField(index, (current) => ({ ...current, trim: event.target.checked }))} />Trim whitespace</label>
            </div>}
            <div className="grid gap-3 lg:grid-cols-2">
              <OperandEditor title="Left side" operand={field.a} object={selectedA} onChange={(operand) => onUpdateField(index, (current) => ({ ...current, a: operand }))} />
              <OperandEditor title="Right side" operand={field.b} object={selectedB} onChange={(operand) => onUpdateField(index, (current) => ({ ...current, b: operand }))} />
            </div>
          </div>)}
        </div>
      </div>
      <div className="flex flex-wrap justify-end gap-2 border-t border-slate-200 pt-4"><button type="button" onClick={onCancel} className={secondaryButton}>Cancel</button><button type="button" onClick={onSave} disabled={busy} className={primaryButton}>{busy ? 'Saving...' : 'Save draft'}</button></div>
    </div>
  </section>;
}

function SourceRuleSide({ side, draft, sources, objects, selectedObject, onSelectSource, onDraft, onRegister }: {
  side: 'A' | 'B';
  draft: RuleDraft;
  sources: AppData['sources'];
  objects: SqlObject[];
  selectedObject?: SqlObject;
  onSelectSource: (side: 'A' | 'B', id: string) => void;
  onDraft: <K extends keyof RuleDraft>(key: K, value: RuleDraft[K]) => void;
  onRegister: () => void;
}) {
  const sourceId = side === 'A' ? draft.sourceAId : draft.sourceBId;
  const dataset = side === 'A' ? draft.datasetA : draft.datasetB;
  const keyField = side === 'A' ? draft.keyFieldA : draft.keyFieldB;
  const columns = selectedObject?.fields ?? [];
  return <fieldset className="space-y-3 rounded-lg border border-slate-200 bg-slate-50/50 p-3"><legend className="px-1 text-sm font-semibold">Source {side}</legend>
    <div><div className="mb-1 flex items-center justify-between gap-2"><label className={`${labelClass} mb-0`}>Registered source</label><button type="button" onClick={onRegister} className="text-xs font-semibold text-brand-700 transition hover:text-brand-800 hover:underline">Register source</button></div><select className={input} value={sourceId} onChange={(event) => onSelectSource(side, event.target.value)}><option value="">Choose a registered source</option>{sources.map((source) => <option key={source.id} value={source.id}>{source.workspaceName} / {source.itemName}</option>)}</select>{sources.length === 0 && <p className="mt-1 text-xs text-amber-800">Register a Lakehouse or Warehouse before defining tables.</p>}</div>
    <div><label className={labelClass}>Table or view</label><select className={input} value={dataset} onChange={(event) => onDraft(side === 'A' ? 'datasetA' : 'datasetB', event.target.value)}><option value="">Choose an object</option>{objects.map((object) => <option key={objectName(object)} value={objectName(object)}>{objectName(object)} · {object.type}</option>)}</select></div>
    <div><label className={labelClass}>Business key</label><select className={input} value={keyField} onChange={(event) => onDraft(side === 'A' ? 'keyFieldA' : 'keyFieldB', event.target.value)}><option value="">Choose a key column</option>{columns.map((column) => <option key={column.name} value={column.name}>{column.name} · {column.dataType}</option>)}</select></div>
  </fieldset>;
}

function OperandEditor({ title, operand, object, onChange }: {
  title: string;
  operand: Operand;
  object?: SqlObject;
  onChange: (operand: Operand) => void;
}) {
  const kind = operand.kind;
  const valueLabel = kind === 'expression' || operand.valueKind === 'expression' ? 'SQL expression' : kind === 'constant' ? 'Fixed value' : 'Column';
  return <fieldset className="grid gap-2 rounded-lg border border-slate-200 bg-slate-50 p-2.5 sm:grid-cols-[130px_minmax(0,1fr)]"><legend className="px-1 text-xs font-semibold text-slate-600">{title}</legend>
    <div><label className={labelClass}>Operand type</label><select className={input} value={kind} onChange={(event) => onChange({ kind: event.target.value as Operand['kind'], value: '' })}><option value="field">Field</option><option value="expression">SQL logic</option><option value="constant">Fixed value</option><option value="aggregate">Aggregate</option></select></div>
    <div className="space-y-2">
      {kind === 'aggregate' && <div className="grid grid-cols-[130px_minmax(0,1fr)] gap-2"><div><label className={labelClass}>Function</label><select className={input} value={operand.fn ?? 'sum'} onChange={(event) => onChange({ ...operand, fn: event.target.value as Operand['fn'] })}>{aggregateFunctions.map((fn) => <option key={fn} value={fn}>{fn === 'countDistinct' ? 'Count distinct' : fn.toUpperCase()}</option>)}</select></div><div><label className={labelClass}>Aggregate input</label><select className={input} value={operand.valueKind ?? 'field'} onChange={(event) => onChange({ ...operand, valueKind: event.target.value as Operand['valueKind'], value: '' })}><option value="field">Column</option><option value="expression">SQL expression</option></select></div></div>}
      {kind === 'field' && <div><label className={labelClass}>{valueLabel}</label><select className={input} value={operand.value} onChange={(event) => onChange({ ...operand, value: event.target.value })}><option value="">Choose a column</option>{object?.fields.map((column) => <option key={column.name} value={column.name}>{column.name} · {column.dataType}</option>)}</select></div>}
      {kind === 'expression' && <div><label className={labelClass}>{valueLabel}</label><input className={input} value={operand.value} onChange={(event) => onChange({ ...operand, value: event.target.value })} placeholder="TRIM(CustomerName)" /></div>}
      {kind === 'constant' && <div><label className={labelClass}>{valueLabel}</label><input className={input} value={operand.value} onChange={(event) => onChange({ ...operand, value: event.target.value })} placeholder="Expected value" /></div>}
      {kind === 'aggregate' && <div><label className={labelClass}>{valueLabel}</label>{operand.valueKind === 'expression' ? <input className={input} value={operand.value} onChange={(event) => onChange({ ...operand, value: event.target.value })} placeholder="CASE WHEN Status = 1 THEN Amount ELSE 0 END" /> : <select className={input} value={operand.value} disabled={operand.fn === 'count' && !operand.value} onChange={(event) => onChange({ ...operand, value: event.target.value })}><option value="">{operand.fn === 'count' ? 'Count rows' : 'Choose a column'}</option>{object?.fields.map((column) => <option key={column.name} value={column.name}>{column.name} · {column.dataType}</option>)}</select>}</div>}
    </div>
  </fieldset>;
}

const weekDays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function SchedulesPanel({ schedules, rules, draft, busyKey, onNew, onEdit, onDraft, onSave, onCancel, onToggle, onDelete }: {
  schedules: AppData['schedules'];
  rules: StoredRule[];
  draft: ScheduleDraft | null;
  busyKey: string;
  onNew: () => void;
  onEdit: (schedule: AppData['schedules'][number]) => void;
  onDraft: (draft: ScheduleDraft | null) => void;
  onSave: () => void;
  onCancel: () => void;
  onToggle: (schedule: AppData['schedules'][number], enabled: boolean) => void;
  onDelete: (schedule: AppData['schedules'][number]) => void;
}) {
  const runnableRules = rules.filter((rule) => rule.status === 'active' || rule.status !== 'retired');
  const preview = (() => {
    if (!draft) return '';
    try { return formatDate(nextOccurrence(draft, new Date())); } catch { return 'Complete the schedule to preview the next occurrence.'; }
  })();
  return <div className="space-y-5">
    <section className={card}>
      <SectionTitle title="Schedules" subtitle="Schedules run while this app is open in a signed-in browser. Claiming a due slot advances the next due time automatically." action={<button type="button" onClick={onNew} className={primaryButton}>New schedule</button>} />
      {schedules.length ? <div className="overflow-x-auto"><table className="w-full min-w-[980px] text-left text-sm"><thead className="bg-slate-50/80 text-xs font-semibold uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-2.5">Rule</th><th className="px-4 py-2.5">Cadence</th><th className="px-4 py-2.5">Enabled</th><th className="px-4 py-2.5">Next due</th><th className="px-4 py-2.5">Last triggered</th><th className="px-4 py-2.5">Last status</th><th className="px-4 py-2.5 text-right">Actions</th></tr></thead><tbody className="divide-y divide-slate-100 [&>tr]:transition-colors [&>tr:hover]:bg-slate-50/70">
        {schedules.map((schedule) => <tr key={schedule.id}><td className="px-4 py-3"><p className="font-medium">{schedule.ruleName}</p>{schedule.lastError && <p className="mt-1 text-xs text-rose-700">{schedule.lastError}</p>}</td><td className="px-4 py-3 text-slate-600">{describeSchedule(schedule)}</td><td className="px-4 py-3"><label className="inline-flex items-center gap-2 text-xs"><input type="checkbox" checked={schedule.enabled} onChange={(event) => onToggle(schedule, event.target.checked)} disabled={busyKey === `schedule:${schedule.id}`} />Enabled</label></td><td className="px-4 py-3 text-xs text-slate-600">{formatDate(schedule.nextDueAt)}</td><td className="px-4 py-3 text-xs text-slate-600">{formatDate(schedule.lastTriggeredAt)}</td><td className="px-4 py-3"><StatusPill value={schedule.lastStatus} /></td><td className="px-4 py-3"><div className="flex justify-end gap-3"><button type="button" onClick={() => onEdit(schedule)} className="text-xs font-semibold text-brand-700 transition hover:text-brand-800 hover:underline">Edit</button><button type="button" onClick={() => onDelete(schedule)} disabled={busyKey === `schedule:${schedule.id}`} className="text-xs font-semibold text-rose-700 hover:underline">Delete</button></div></td></tr>)}
      </tbody></table></div> : <EmptyMessage>No schedules have been created.</EmptyMessage>}
    </section>
    {draft && <section className={card}>
      <SectionTitle title={draft.id ? 'Edit schedule' : 'New schedule'} subtitle={`Next occurrence: ${preview}`} action={<button type="button" onClick={onCancel} className="text-sm text-slate-600 hover:underline">Close</button>} />
      <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-6">
        <div className="xl:col-span-2"><label className={labelClass}>Rule</label><select className={input} value={draft.ruleId} onChange={(event) => onDraft({ ...draft, ruleId: event.target.value })}><option value="">Choose a rule</option>{runnableRules.map((rule) => <option key={rule.id} value={rule.id}>{rule.name}</option>)}</select></div>
        <div><label className={labelClass}>Cadence</label><select className={input} value={draft.cadence} onChange={(event) => onDraft({ ...draft, cadence: event.target.value as ScheduleDefinition['cadence'] })}><option value="hourly">Hourly</option><option value="daily">Daily</option><option value="weekly">Weekly</option></select></div>
        <div><label className={labelClass}>Every</label><input className={input} type="number" min={1} max={52} value={draft.intervalCount} onChange={(event) => onDraft({ ...draft, intervalCount: Number(event.target.value) })} /></div>
        {draft.cadence !== 'hourly' && <div><label className={labelClass}>Hour UTC</label><input className={input} type="number" min={0} max={23} value={draft.hourUtc} onChange={(event) => onDraft({ ...draft, hourUtc: Number(event.target.value) })} /></div>}
        <div><label className={labelClass}>Minute UTC</label><input className={input} type="number" min={0} max={59} value={draft.minuteUtc} onChange={(event) => onDraft({ ...draft, minuteUtc: Number(event.target.value) })} /></div>
        {draft.cadence === 'weekly' && <div><label className={labelClass}>Day of week</label><select className={input} value={draft.dayOfWeek ?? 0} onChange={(event) => onDraft({ ...draft, dayOfWeek: Number(event.target.value) })}>{weekDays.map((day, index) => <option key={day} value={index}>{day}</option>)}</select></div>}
        <div className="flex items-end"><label className="inline-flex min-h-9 items-center gap-2 text-sm"><input type="checkbox" checked={draft.enabled} onChange={(event) => onDraft({ ...draft, enabled: event.target.checked })} />Enabled</label></div>
        <div className="flex items-end justify-end gap-2 xl:col-span-6"><button type="button" onClick={onCancel} className={secondaryButton}>Cancel</button><button type="button" onClick={onSave} disabled={busyKey === 'save-schedule'} className={primaryButton}>{busyKey === 'save-schedule' ? 'Saving...' : 'Save schedule'}</button></div>
      </div>
    </section>}
  </div>;
}

function ExceptionsPanel({ exceptions, allExceptions, rules, runs, filter, selected, selectedIds, events, owner, comment, reason, busyKey, onFilter, onSelect, onOwner, onComment, onReason, onAssign, onAddComment, onStatus, onSelectedIds, onBulkStatus, onBulkAssign, onBulkComment }: {
  exceptions: StoredException[];
  allExceptions: StoredException[];
  rules: StoredRule[];
  runs: StoredRun[];
  filter: ExceptionFilter;
  selected: StoredException | null;
  selectedIds: string[];
  events: Array<Record<string, unknown>>;
  owner: string;
  comment: string;
  reason: string;
  busyKey: string;
  onFilter: (filter: ExceptionFilter) => void;
  onSelect: (exception: StoredException) => void;
  onOwner: (value: string) => void;
  onComment: (value: string) => void;
  onReason: (value: string) => void;
  onAssign: () => void;
  onAddComment: () => void;
  onStatus: (status: StoredException['status']) => void;
  onSelectedIds: (ids: string[]) => void;
  onBulkStatus: (status: StoredException['status']) => void;
  onBulkAssign: () => void;
  onBulkComment: () => void;
}) {
  const outcomes = [...new Set(allExceptions.map((exception) => exception.outcome))];
  const runIds = [...new Set(allExceptions.map((exception) => exception.lastRunId).filter(Boolean))];
  const toggleSelection = (exceptionId: string, checked: boolean) => onSelectedIds(checked ? [...selectedIds, exceptionId] : selectedIds.filter((id) => id !== exceptionId));
  const visibleIds = exceptions.map((exception) => exception.id);
  const allowed: Record<StoredException['status'], StoredException['status'][]> = {
    open: ['acknowledged', 'investigating', 'resolved', 'accepted'],
    acknowledged: ['investigating', 'resolved', 'accepted', 'open'],
    investigating: ['resolved', 'accepted', 'open'],
    resolved: ['open'],
    accepted: ['open'],
  };
  return <div className="grid gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(320px,0.8fr)]">
    <section className={card}>
      <div className="grid gap-3 border-b border-slate-200 p-4 sm:grid-cols-2 xl:grid-cols-4"><div><label className={labelClass}>Status</label><select className={input} value={filter.status} onChange={(event) => onFilter({ ...filter, status: event.target.value })}><option value="">All statuses</option>{statuses.map((status) => <option key={status} value={status}>{status}</option>)}</select></div><div><label className={labelClass}>Severity</label><select className={input} value={filter.severity} onChange={(event) => onFilter({ ...filter, severity: event.target.value })}><option value="">All severities</option>{severities.map((severity) => <option key={severity} value={severity}>{severity}</option>)}</select></div><div><label className={labelClass}>Outcome</label><select className={input} value={filter.outcome} onChange={(event) => onFilter({ ...filter, outcome: event.target.value })}><option value="">All outcomes</option>{outcomes.map((outcome) => <option key={outcome} value={outcome}>{humanOutcome(outcome)}</option>)}</select></div><div><label className={labelClass}>Rule</label><select className={input} value={filter.ruleId} onChange={(event) => onFilter({ ...filter, ruleId: event.target.value })}><option value="">All rules</option>{rules.map((rule) => <option key={rule.id} value={rule.id}>{rule.name}</option>)}</select></div><div><label className={labelClass}>Rule group</label><select className={input} value={filter.ruleGroup} onChange={(event) => onFilter({ ...filter, ruleGroup: event.target.value })}><option value="">All groups</option>{ruleGroups.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></div><div><label className={labelClass}>Run</label><select className={input} value={filter.runId} onChange={(event) => onFilter({ ...filter, runId: event.target.value })}><option value="">All runs</option>{runIds.map((runId) => <option key={runId} value={runId}>{runs.find((run) => run.id === runId)?.ruleName ?? 'Run'} · {runId.slice(0, 8)}</option>)}</select></div><div><label className={labelClass}>Owner contains</label><input className={input} value={filter.owner} onChange={(event) => onFilter({ ...filter, owner: event.target.value })} placeholder="name or team" /></div></div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-2 text-xs text-slate-500"><span>{exceptions.length} of {allExceptions.length} exceptions · {selectedIds.length} selected</span><div className="flex flex-wrap gap-2"><select className={input} value="" aria-label="Bulk status" onChange={(event) => { if (event.target.value) onBulkStatus(event.target.value as StoredException['status']); }} disabled={!selectedIds.length || busyKey === 'bulk-exceptions'}><option value="">Bulk status...</option>{statuses.map((status) => <option key={status} value={status}>{status}</option>)}</select><button type="button" onClick={onBulkAssign} disabled={!selectedIds.length || busyKey === 'bulk-exceptions'} className={secondaryButton}>Assign selected</button><button type="button" onClick={onBulkComment} disabled={!selectedIds.length || busyKey === 'bulk-exceptions'} className={secondaryButton}>Comment selected</button></div></div>
      {exceptions.length ? <div className="max-h-[680px] overflow-auto"><table className="w-full min-w-[760px] text-left text-sm"><thead className="sticky top-0 bg-slate-50/80 text-xs font-semibold uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-2.5"><input type="checkbox" aria-label="Select visible exceptions" checked={visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id))} onChange={(event) => onSelectedIds(event.target.checked ? [...new Set([...selectedIds, ...visibleIds])] : selectedIds.filter((id) => !visibleIds.includes(id)))} /></th><th className="px-4 py-2.5">Business key</th><th className="px-4 py-2.5">Outcome</th><th className="px-4 py-2.5">Severity</th><th className="px-4 py-2.5">Status</th><th className="px-4 py-2.5">Owner</th><th className="px-4 py-2.5">Last seen</th></tr></thead><tbody className="divide-y divide-slate-100 [&>tr]:transition-colors [&>tr:hover]:bg-slate-50/70">{exceptions.map((exception) => <tr key={exception.id} className={selected?.id === exception.id ? 'bg-teal-50' : 'hover:bg-slate-50'}><td className="px-4 py-2.5"><input type="checkbox" aria-label={`Select exception ${exception.businessKey}`} checked={selectedIds.includes(exception.id)} onChange={(event) => toggleSelection(exception.id, event.target.checked)} /></td><td className="px-4 py-2.5"><button type="button" onClick={() => onSelect(exception)} className="text-left font-semibold text-teal-900 hover:underline">{exception.businessKey}</button></td><td className="px-4 py-2.5 text-slate-600">{humanOutcome(exception.outcome)}</td><td className="px-4 py-2.5"><SeverityPill value={exception.severity} /></td><td className="px-4 py-2.5"><StatusPill value={exception.status} /></td><td className="px-4 py-2.5 text-slate-600">{exception.owner || 'Unassigned'}</td><td className="px-4 py-2.5 text-xs text-slate-500">{formatDate(exception.lastSeen)}</td></tr>)}</tbody></table></div> : <EmptyMessage>No exceptions match this filter.</EmptyMessage>}
    </section>
    <section className={card}>
      <SectionTitle title={selected ? `Exception · ${selected.businessKey}` : 'Exception detail'} subtitle={selected ? `${humanOutcome(selected.outcome)} · ${selected.occurrenceCount} sighting${selected.occurrenceCount === 1 ? '' : 's'}` : 'Select a row to inspect and update its history.'} />
      {selected ? <div className="space-y-4 p-4">
        <div className="flex flex-wrap gap-2"><SeverityPill value={selected.severity} /><StatusPill value={selected.status} /><span className="text-xs text-slate-500">First seen {formatDate(selected.firstSeen)}</span></div>
        <ExceptionValues exception={selected} />
        <div><label className={labelClass}>Assigned owner</label><div className="flex gap-2"><input className={input} value={owner} onChange={(event) => onOwner(event.target.value)} placeholder="name@company.com" /><button type="button" onClick={onAssign} disabled={busyKey.startsWith('exception:')} className={secondaryButton}>Save</button></div></div>
        <div><label className={labelClass}>Move to status</label><select className={input} value="" onChange={(event) => { if (event.target.value) onStatus(event.target.value as StoredException['status']); }} disabled={busyKey.startsWith('exception:')}><option value="">Choose transition...</option>{allowed[selected.status].map((status) => <option key={status} value={status}>{status}</option>)}</select></div>
        <div><label className={labelClass}>Closure reason</label><input className={input} value={reason} onChange={(event) => onReason(event.target.value)} placeholder="Required when resolving or accepting" /></div>
        <div><label className={labelClass}>Comment</label><div className="space-y-2"><textarea className={`${input} min-h-20 resize-y`} value={comment} onChange={(event) => onComment(event.target.value)} /><button type="button" onClick={onAddComment} disabled={!comment.trim() || busyKey.startsWith('exception:')} className={secondaryButton}>Add comment</button></div></div>
        <div className="border-t border-slate-200 pt-3"><h4 className="text-sm font-semibold">Audit history</h4><ul className="mt-2 divide-y divide-slate-100">{events.map((entry) => <li key={String(entry.id)} className="py-2 text-xs"><p className="font-medium text-slate-700">{String(entry.action).replaceAll('_', ' ')} · {String(entry.actor)}</p><p className="mt-0.5 text-slate-500">{formatDate(entry.occurredAt as Date)}{entry.reason ? ` · ${String(entry.reason)}` : ''}{entry.comment ? ` · ${String(entry.comment)}` : ''}</p></li>)}</ul>{!events.length && <p className="mt-2 text-xs text-slate-500">No history has been recorded.</p>}</div>
      </div> : <EmptyMessage>Select an exception to view details.</EmptyMessage>}
    </section>
  </div>;
}

function RunsPanel({ runs, selectedRun, findings, busyKey, onDetails, onCompare, onDelete }: { runs: StoredRun[]; selectedRun: StoredRun | null; findings: ReconciliationFinding[]; busyKey: string; onDetails: (run: StoredRun) => void; onCompare: (run: StoredRun) => void; onDelete: (run: StoredRun) => void }) {
  return <section className={card}><SectionTitle title="Run history" subtitle="Every run retains the rule version, counts, and per-item findings." />
    {runs.length ? <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-left text-sm"><thead className="bg-slate-50/80 text-xs font-semibold uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-2.5">Rule</th><th className="px-4 py-2.5">Started</th><th className="px-4 py-2.5">Completed</th><th className="px-4 py-2.5">Status</th><th className="px-4 py-2.5 text-right">Rows A</th><th className="px-4 py-2.5 text-right">Rows B</th><th className="px-4 py-2.5 text-right">Matched</th><th className="px-4 py-2.5 text-right">Findings</th><th className="px-4 py-2.5"></th></tr></thead><tbody className="divide-y divide-slate-100 [&>tr]:transition-colors [&>tr:hover]:bg-slate-50/70">{runs.map((run) => <tr key={run.id} className={selectedRun?.id === run.id ? 'bg-teal-50' : ''}><td className="px-4 py-3 font-medium">{run.ruleName}<span className="ml-2 text-xs text-slate-400">v{run.ruleVersion}</span></td><td className="px-4 py-3 text-xs text-slate-600">{formatDate(run.startedAt)}</td><td className="px-4 py-3 text-xs text-slate-600">{formatDate(run.completedAt)}</td><td className="px-4 py-3"><StatusPill value={run.status} /></td><td className="px-4 py-3 text-right tabular-nums">{run.recordsA}</td><td className="px-4 py-3 text-right tabular-nums">{run.recordsB}</td><td className="px-4 py-3 text-right tabular-nums">{run.matched}</td><td className="px-4 py-3 text-right tabular-nums">{run.exceptionCount}</td><td className="px-4 py-3 text-right"><div className="flex justify-end gap-3"><button type="button" onClick={() => onDetails(run)} className="text-xs font-semibold text-slate-700 hover:underline">Details</button>{run.status === 'completed' && <button type="button" onClick={() => onCompare(run)} className="text-xs font-semibold text-brand-700 transition hover:text-brand-800 hover:underline">Compare</button>}<button type="button" onClick={() => onDelete(run)} disabled={run.status === 'running' || busyKey === `delete-run:${run.id}`} className="text-xs font-semibold text-rose-700 hover:underline disabled:opacity-40">Delete</button></div></td></tr>)}</tbody></table></div> : <EmptyMessage>No runs have been recorded.</EmptyMessage>}
    {selectedRun && <div className="border-t border-slate-200"><SectionTitle title={`Run findings · ${selectedRun.ruleName}`} subtitle={`Version ${selectedRun.ruleVersion} · ${findings.length} findings stored`} />{findings.length ? <div className="divide-y divide-slate-100">{findings.slice(0, 500).map((finding) => <div key={finding.fingerprint} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3"><div><p className="text-sm font-semibold">{finding.businessKey}</p><p className="mt-1 text-xs text-slate-500">{humanOutcome(finding.outcome)}{finding.differences.length ? ` · ${finding.differences.map((difference) => difference.field).join(', ')}` : ''}</p></div><SeverityPill value={finding.severity} /></div>)}</div> : selectedRun.exceptionCount > 0 ? <EmptyMessage>This run has totals but no detailed findings.</EmptyMessage> : <EmptyMessage>This run completed with no findings.</EmptyMessage>}</div>}
  </section>;
}

function ExceptionValues({ exception }: { exception: StoredException }) {
  const detail = parseExceptionDetail(exception);
  if (!detail.differences?.length && !detail.valuesA && !detail.valuesB) return null;
  const display = (value: unknown) => value === null || value === undefined ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return <div className="overflow-hidden rounded-lg border border-slate-200">
    <div className="border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold uppercase text-slate-600">Compared values</div>
    {detail.differences?.length ? <div className="overflow-x-auto"><table className="w-full min-w-[420px] text-left text-xs"><thead className="text-slate-500"><tr><th className="px-3 py-2 font-medium">Field</th><th className="px-3 py-2 font-medium">Left</th><th className="px-3 py-2 font-medium">Right</th><th className="px-3 py-2 font-medium">Difference</th></tr></thead><tbody className="divide-y divide-slate-100 [&>tr]:transition-colors [&>tr:hover]:bg-slate-50/70">{detail.differences.map((difference, index) => <tr key={`${difference.field}-${index}`}><td className="px-3 py-2 font-medium">{difference.field}</td><td className="max-w-40 break-words px-3 py-2">{display(difference.valueA)}</td><td className="max-w-40 break-words px-3 py-2">{display(difference.valueB)}</td><td className="px-3 py-2">{difference.difference ?? difference.reason ?? 'Different'}</td></tr>)}</tbody></table></div> : <div className="grid gap-3 p-3 sm:grid-cols-2"><div><p className={labelClass}>Left</p><pre className="whitespace-pre-wrap break-words text-xs">{JSON.stringify(detail.valuesA, null, 2)}</pre></div><div><p className={labelClass}>Right</p><pre className="whitespace-pre-wrap break-words text-xs">{JSON.stringify(detail.valuesB, null, 2)}</pre></div></div>}
  </div>;
}

function ComparePanel({ rules, runs, ruleId, fromRunId, toRunId, result, busy, onRule, onFrom, onTo, onCompare }: {
  rules: StoredRule[];
  runs: StoredRun[];
  ruleId: string;
  fromRunId: string;
  toRunId: string;
  result: ComparisonResult | null;
  busy: boolean;
  onRule: (id: string) => void;
  onFrom: (id: string) => void;
  onTo: (id: string) => void;
  onCompare: () => void;
}) {
  return <div className="space-y-5">
    <section className={card}><div className="grid gap-3 p-4 md:grid-cols-[1fr_1fr_1fr_auto] md:items-end">
      <div><label className={labelClass}>Rule</label><select className={input} value={ruleId} onChange={(event) => onRule(event.target.value)}><option value="">Choose a rule</option>{rules.map((rule) => <option key={rule.id} value={rule.id}>{rule.name}</option>)}</select></div>
      <div><label className={labelClass}>Earlier run</label><select className={input} value={fromRunId} onChange={(event) => onFrom(event.target.value)}><option value="">Choose a run</option>{runs.map((run) => <option key={run.id} value={run.id}>{formatDate(run.startedAt)} · v{run.ruleVersion} · {run.exceptionCount} findings</option>)}</select></div>
      <div><label className={labelClass}>Later run</label><select className={input} value={toRunId} onChange={(event) => onTo(event.target.value)}><option value="">Choose a run</option>{runs.map((run) => <option key={run.id} value={run.id}>{formatDate(run.startedAt)} · v{run.ruleVersion} · {run.exceptionCount} findings</option>)}</select></div>
      <button type="button" onClick={onCompare} disabled={busy || !fromRunId || !toRunId} className={primaryButton}>{busy ? 'Comparing...' : 'Compare'}</button>
    </div><div className="border-t border-slate-100 px-4 py-3 text-xs text-slate-500">Runs from different rules cannot be compared. Findings are matched by stable business-key fingerprints.</div></section>
    {result && <>
      <section className={card}>
        <SectionTitle title="Comparison verdict" action={<VerdictPill verdict={result.verdict} />} />
        <div className="space-y-3 p-4">
          {result.reversed && <p className="text-sm text-amber-800">The selected runs were reordered into chronological order.</p>}
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">{Object.entries(result.metrics).map(([key, value]) => <MetricDeltaCard key={key} label={key.replace(/([A-Z])/g, ' $1')} value={value} />)}</div>
        </div>
      </section>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Metric label="Newly failing" value={result.newlyFailing.length} accent="rose" onClick={noop} /><Metric label="Fixed" value={result.fixed.length} accent="teal" onClick={noop} /><Metric label="Still failing" value={result.stillFailing.length} accent="amber" onClick={noop} /><Metric label="Changed" value={result.changed.length} accent="brand" onClick={noop} /></div>
      <div className="grid gap-5 xl:grid-cols-4"><FindingList title="Newly failing" findings={result.newlyFailing} tone="red" /><FindingList title="Fixed" findings={result.fixed} tone="teal" /><FindingList title="Still failing" findings={result.stillFailing} tone="amber" /><FindingList title="Changed" findings={result.changed.map((entry) => entry.after)} tone="amber" /></div>
    </>}
  </div>;
}

function VerdictPill({ verdict }: { verdict: ComparisonResult['verdict'] }) {
  const labels: Record<ComparisonResult['verdict'], string> = {
    clean: 'Clean — no findings',
    unchanged: 'Unchanged',
    better: 'Better — findings fixed',
    worse: 'Worse — new breaks appeared',
    churn: 'Churn — findings changed',
  };
  const colors: Record<ComparisonResult['verdict'], string> = {
    clean: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    unchanged: 'border-slate-200 bg-slate-50 text-slate-700',
    better: 'border-teal-200 bg-teal-50 text-teal-800',
    worse: 'border-rose-200 bg-rose-50 text-rose-800',
    churn: 'border-amber-200 bg-amber-50 text-amber-800',
  };
  return <span className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold ${colors[verdict]}`}>{labels[verdict]}</span>;
}

function MetricDeltaCard({ label, value }: { label: string; value: ComparisonResult['metrics'][keyof ComparisonResult['metrics']] }) {
  const color = value.direction === 'up' ? 'text-teal-700' : value.direction === 'down' ? 'text-rose-700' : 'text-slate-600';
  const arrow = value.direction === 'up' ? '▲' : value.direction === 'down' ? '▼' : '—';
  const delta = `${value.delta > 0 ? '+' : ''}${value.delta}`;
  const percent = value.percentChange === null ? '' : ` (${value.percentChange > 0 ? '+' : ''}${value.percentChange}%)`;
  return <div className="rounded-xl border border-slate-200/80 bg-gradient-to-b from-white to-slate-50 p-3.5 shadow-sm"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p><p className="mt-1.5 text-sm font-medium tabular-nums text-slate-900">{value.from} <span className="text-slate-400">→</span> {value.to}</p><p className={`mt-1 text-xs font-bold tabular-nums ${color}`}><span aria-hidden="true">{arrow}</span> {delta}{percent}</p></div>;
}

function FindingList({ title, findings, tone }: { title: string; findings: ReconciliationFinding[]; tone: 'red' | 'teal' | 'amber' }) {
  const colors = { red: 'text-rose-800', teal: 'text-teal-800', amber: 'text-amber-800' };
  return <section className={card}><SectionTitle title={title} subtitle={`${findings.length} item${findings.length === 1 ? '' : 's'}`} />{findings.length ? <ul className="divide-y divide-slate-100">{findings.slice(0, 50).map((finding) => <li key={finding.fingerprint} className="px-4 py-3"><p className={`text-sm font-semibold ${colors[tone]}`}>{finding.businessKey}</p><p className="mt-1 text-xs text-slate-600">{humanOutcome(finding.outcome)}{finding.differences.length ? ` · ${finding.differences.map((difference) => difference.field).join(', ')}` : ''}</p></li>)}</ul> : <EmptyMessage>None</EmptyMessage>}</section>;
}

export function SettingsPanel({
  state, values, errors, busy, onChange, onSave, onReset,
}: {
  state: AppSettingsState | null;
  values: SettingValues;
  errors: Partial<Record<SettingKey, string>>;
  busy: boolean;
  onChange: (key: SettingKey, value: string) => void;
  onSave: () => void;
  onReset: () => void;
}) {
  if (!state) return <section className={`${card} px-5 py-8 text-sm text-slate-600`}>Loading configuration...</section>;
  const dirty = settingDefinitions.some((definition) => values[definition.key].trim() !== state.values[definition.key]);
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
      <section className={card}>
        <SectionTitle
          title="Fabric and gateway connection"
          subtitle="Saved in the workspace, so every user picks these up on their next load."
        />
        <form
          className="space-y-5 px-4 py-5"
          onSubmit={(event) => { event.preventDefault(); onSave(); }}
        >
          {settingDefinitions.map((definition) => {
            const message = errors[definition.key];
            const fieldId = `setting-${definition.key}`;
            return (
              <div key={definition.key}>
                <label className={labelClass} htmlFor={fieldId}>{definition.label}</label>
                <input
                  id={fieldId}
                  className={message ? invalidInput : input}
                  value={values[definition.key]}
                  placeholder={definition.placeholder}
                  spellCheck={false}
                  autoComplete="off"
                  aria-invalid={message ? true : undefined}
                  aria-describedby={`${fieldId}-help`}
                  onChange={(event) => onChange(definition.key, event.target.value)}
                />
                <p id={`${fieldId}-help`} className={`mt-1.5 text-xs ${message ? 'text-rose-700' : 'text-slate-500'}`}>
                  {message ?? definition.description}
                </p>
              </div>
            );
          })}
          <div className="flex flex-wrap items-center gap-2 border-t border-slate-200/80 pt-4">
            <button type="submit" className={primaryButton} disabled={busy}>{busy ? 'Saving...' : 'Save configuration'}</button>
            <button type="button" className={secondaryButton} onClick={onReset} disabled={busy || !dirty}>Discard changes</button>
            {dirty && <span className="text-xs text-amber-700">Unsaved changes</span>}
          </div>
        </form>
      </section>

      <section className={card}>
        <SectionTitle title="How these are used" />
        <div className="space-y-4 px-4 py-5 text-sm text-slate-600">
          {state.warning && (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">{state.warning}</p>
          )}
          <p>
            Saving takes effect immediately for you and on the next load for everyone else. No rebuild or redeploy is
            needed.
          </p>
          <p>
            Each value falls back to the matching build-time variable when it is left empty, so deployments that already
            set these in <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">rayfin/.env</code> keep working.
          </p>
          <dl className="space-y-2 border-t border-slate-200/80 pt-4 text-xs">
            {settingDefinitions.map((definition) => (
              <div key={definition.key}>
                <dt className="font-semibold text-slate-700">{definition.label}</dt>
                <dd className="text-slate-500">Falls back to <code className="rounded bg-slate-100 px-1 py-0.5">{definition.envName}</code></dd>
              </div>
            ))}
          </dl>
        </div>
      </section>
    </div>
  );
}

function SectionTitle({ title, subtitle, action }: { title: string; subtitle?: string; action?: React.ReactNode }) {
  return <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200/80 bg-slate-50/60 px-4 py-3"><div><h3 className="text-sm font-bold tracking-tight text-slate-900">{title}</h3>{subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}</div>{action}</div>;
}

const pill = 'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium capitalize';

function StatusPill({ value }: { value: string }) {
  const className = value === 'active' || value === 'completed' || value === 'resolved' || value === 'succeeded' ? 'border-teal-200 bg-teal-50 text-teal-800'
    : value === 'failed' || value === 'open' ? 'border-rose-200 bg-rose-50 text-rose-800'
    : value === 'investigating' || value === 'acknowledged' || value === 'running' || value === 'queued' ? 'border-amber-200 bg-amber-50 text-amber-800'
    : 'border-slate-200 bg-slate-50 text-slate-700';
  const dot = value === 'active' || value === 'completed' || value === 'resolved' || value === 'succeeded' ? 'bg-teal-500'
    : value === 'failed' || value === 'open' ? 'bg-rose-500'
    : value === 'investigating' || value === 'acknowledged' || value === 'running' || value === 'queued' ? 'bg-amber-500'
    : 'bg-slate-400';
  return <span className={`${pill} ${className}`}><span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${dot}`} />{value.replaceAll('_', ' ')}</span>;
}

function SeverityPill({ value }: { value: string }) {
  const className = value === 'high' ? 'border-rose-200 bg-rose-50 text-rose-800' : value === 'medium' ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-slate-200 bg-slate-50 text-slate-700';
  return <span className={`${pill} ${className}`}>{value}</span>;
}

function EmptyMessage({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-8 text-center text-sm text-slate-500">{children}</p>;
}