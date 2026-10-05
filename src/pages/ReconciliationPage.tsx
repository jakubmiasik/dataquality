import { useEffect, useMemo, useState } from 'react';

import { useAuth } from '@/hooks/AuthContext';
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
  compareRuns as compareStoredRuns,
  completeRun,
  createRun,
  failRun,
  loadExceptionEvents,
  loadRunFindings,
  loadReconciliationData,
  loadRuleFields,
  loadRuleVersions,
  saveReconciliationSource,
  saveRule,
  setRuleEnabled,
  updateExceptionStatus,
  type RuleDraft,
  type StoredException,
  type StoredRule,
  type StoredRun,
} from '@/services/reconciliationRepository';
import type { CompareField, Operand, ReconciliationFinding, ReconciliationResult } from '@/services/reconciliationEngine';

type Tab = 'overview' | 'sources' | 'rules' | 'exceptions' | 'runs' | 'compare';
type AppData = Awaited<ReturnType<typeof loadReconciliationData>>;

interface CatalogResponse {
  source: { sqlEndpoint: string; database: string };
  objects: SqlObject[];
}

interface ComparisonResult {
  newlyFailing: ReconciliationFinding[];
  fixed: ReconciliationFinding[];
  stillFailing: ReconciliationFinding[];
  metrics: { recordsA: number; recordsB: number; matched: number; exceptionCount: number };
}

const tabs: Array<{ id: Tab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'sources', label: 'Sources' },
  { id: 'rules', label: 'Rules' },
  { id: 'exceptions', label: 'Exceptions' },
  { id: 'runs', label: 'Runs' },
  { id: 'compare', label: 'Compare runs' },
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
const button = 'inline-flex min-h-9 items-center justify-center gap-2 border px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50';
const primaryButton = `${button} border-blue-700 bg-blue-700 text-white hover:bg-blue-800`;
const secondaryButton = `${button} border-slate-300 bg-white text-slate-700 hover:bg-slate-50`;
const input = 'min-h-9 w-full border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100';
const labelClass = 'mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500';

function blankOperand(): Operand {
  return { kind: 'field', value: '' };
}

function blankField(index: number): CompareField {
  return { label: `Value ${index + 1}`, type: 'string', a: blankOperand(), b: blankOperand() };
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
  const [comparisonRuleId, setComparisonRuleId] = useState('');
  const [fromRunId, setFromRunId] = useState('');
  const [toRunId, setToRunId] = useState('');
  const [registrationFilter, setRegistrationFilter] = useState('');
  const [exceptionFilter, setExceptionFilter] = useState<{ status: string; severity: string; outcome: string }>({ status: 'open', severity: '', outcome: '' });
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
  const openExceptions = exceptions.filter((exception) => exception.status === 'open' || exception.status === 'acknowledged' || exception.status === 'investigating');

  const filteredExceptions = useMemo(() => exceptions.filter((exception) =>
    (!exceptionFilter.status || exception.status === exceptionFilter.status)
    && (!exceptionFilter.severity || exception.severity === exceptionFilter.severity)
    && (!exceptionFilter.outcome || exception.outcome === exceptionFilter.outcome)
  ), [exceptions, exceptionFilter]);

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

  async function runRule(rule: StoredRule) {
    if (!user) return;
    const sourceA = sources.find((source) => source.id === rule.sourceAId);
    const sourceB = sources.find((source) => source.id === rule.sourceBId);
    if (!sourceA || !sourceB) { setError('The rule is missing one of its saved sources.'); return; }
    setBusyKey(`run:${rule.id}`);
    setError(null);
    try {
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
        setNotice(`Run completed: ${execution.result.summary.matched} matched, ${execution.result.summary.exceptions} findings.`);
      } catch (reason) {
        await failRun(run.id, reason instanceof Error ? reason.message : 'Reconciliation failed.');
        throw reason;
      }
      await refreshData();
      setTab('runs');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to run this rule.'); }
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

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-7">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-teal-700">Fabric data controls</p>
            <h1 className="mt-1 text-2xl font-semibold">Reconciliation</h1>
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden text-right sm:block"><p className="text-sm font-medium">{userName}</p><p className="text-xs text-slate-500">User-scoped controls and results</p></div>
            <button type="button" onClick={() => void signOut()} className={secondaryButton}>Sign out</button>
          </div>
        </div>
        <nav className="mx-auto flex max-w-[1440px] gap-1 overflow-x-auto px-4 sm:px-7" aria-label="Reconciliation sections">
          {tabs.map((entry) => (
            <button key={entry.id} type="button" onClick={() => { setTab(entry.id); setError(null); }}
              className={`whitespace-nowrap border-b-2 px-3 py-3 text-sm font-medium ${tab === entry.id ? 'border-teal-700 text-teal-800' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>
              {entry.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-[1440px] px-4 py-6 sm:px-7">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div><h2 className="text-lg font-semibold">{tabs.find((entry) => entry.id === tab)?.label}</h2><p className="mt-1 text-sm text-slate-500">Read-only SQL checks across accessible Fabric sources.</p></div>
          <button type="button" onClick={() => void refreshData()} disabled={loading} className={secondaryButton}>{loading ? 'Refreshing...' : 'Refresh data'}</button>
        </div>
        {error && <div role="alert" className="mb-4 border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>}
        {notice && <div role="status" className="mb-4 border border-teal-200 bg-teal-50 px-4 py-3 text-sm text-teal-900">{notice}</div>}
        {!data && <div className="border border-slate-200 bg-white px-5 py-8 text-sm text-slate-600">{loading ? 'Loading reconciliation data...' : 'No reconciliation data is available yet. Configure the Rayfin data service and refresh.'}</div>}

        {tab === 'overview' && data && <OverviewPanel
          rules={rules} runs={runs} openExceptions={openExceptions} onNavigate={setTab}
        />}
        {tab === 'sources' && <SourcesPanel
          sources={sources} catalogs={catalogs} busyKey={busyKey}
          onRegister={() => void openSourceRegistration()} onBrowse={(source) => void browseRegisteredSource(source)}
        />}
        {tab === 'rules' && data && <RulesPanel
          rules={rules} sources={sources} draft={draft} objectsForSource={sourceObjects} busyKey={busyKey}
          versionHistory={versionHistory} onNew={openNewRule} onEdit={openEditRule} onDraft={setDraftValue}
          onSelectSource={selectRuleSource} onUpdateField={updateField} onAddField={() => setDraft((current) => current ? { ...current, compareFields: [...current.compareFields, blankField(current.compareFields.length)] } : current)}
          onRemoveField={(index) => setDraft((current) => current ? { ...current, compareFields: current.compareFields.filter((_, fieldIndex) => fieldIndex !== index) } : current)}
          onSave={() => void saveCurrentRule()} onCancel={() => { setDraft(null); setVersionHistory(null); }}
          onToggle={toggleRule} onVersions={showVersions} onRun={runRule}
          onRegisterSource={(side) => void openSourceRegistration(side)}
        />}
        {tab === 'exceptions' && data && <ExceptionsPanel
          exceptions={filteredExceptions} allExceptions={exceptions} filter={exceptionFilter} selected={selectedException}
          events={exceptionEvents} owner={ownerInput} comment={commentInput} reason={closeReason} busyKey={busyKey}
          onFilter={setExceptionFilter} onSelect={setSelectedException} onOwner={setOwnerInput} onComment={setCommentInput}
          onReason={setCloseReason} onAssign={() => void saveExceptionOwner()} onAddComment={() => void saveExceptionComment()}
          onStatus={(status) => void changeExceptionStatus(status)}
        />}
        {tab === 'runs' && data && <RunsPanel runs={runs} selectedRun={selectedRun} findings={runFindings} onDetails={setSelectedRun} onCompare={(run) => {
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
  rules, runs, openExceptions, onNavigate,
}: {
  rules: StoredRule[];
  runs: StoredRun[];
  openExceptions: StoredException[];
  onNavigate: (tab: Tab) => void;
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
      <div className="grid gap-px border border-slate-200 bg-slate-200 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Active rules" value={rules.filter((rule) => rule.enabled).length} onClick={() => onNavigate('rules')} />
        <Metric label="Draft rules" value={rules.filter((rule) => rule.status === 'draft').length} onClick={() => onNavigate('rules')} />
        <Metric label="Open exceptions" value={openExceptions.length} onClick={() => onNavigate('exceptions')} />
        <Metric label="Completed runs" value={runs.filter((run) => run.status === 'completed').length} onClick={() => onNavigate('runs')} />
      </div>
      <section className="border border-slate-200 bg-white">
        <SectionTitle title="Coverage by rule group" action={<button type="button" onClick={() => onNavigate('rules')} className="text-sm font-medium text-teal-800 hover:underline">Manage rules</button>} />
        {groupCounts.length ? <div className="grid divide-y divide-slate-100 sm:grid-cols-2 sm:divide-x sm:divide-y-0 xl:grid-cols-3">
          {groupCounts.map((group) => <div key={group.key} className="flex items-center justify-between gap-4 px-4 py-3">
            <div><p className="text-sm font-medium">{group.label}</p><p className="mt-0.5 text-xs text-slate-500">{group.total} rule{group.total === 1 ? '' : 's'}</p></div>
            <div className="flex gap-5 text-right text-xs"><div><p className="font-semibold text-teal-800">{group.active}</p><p className="text-slate-500">enabled</p></div><div><p className="font-semibold text-red-700">{group.exceptions}</p><p className="text-slate-500">open</p></div></div>
          </div>)}
        </div> : <EmptyMessage>Rule coverage will appear here after you create rules.</EmptyMessage>}
      </section>
      <section className="border border-slate-200 bg-white">
        <SectionTitle title="Recent runs" action={<button type="button" onClick={() => onNavigate('runs')} className="text-sm font-medium text-teal-800 hover:underline">View history</button>} />
        {recentRuns.length ? <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-sm"><thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-4 py-2.5">Rule</th><th className="px-4 py-2.5">Started</th><th className="px-4 py-2.5">Status</th><th className="px-4 py-2.5 text-right">Matched</th><th className="px-4 py-2.5 text-right">Findings</th><th className="px-4 py-2.5"></th></tr></thead><tbody className="divide-y divide-slate-100">
          {recentRuns.map((run) => <tr key={run.id}><td className="px-4 py-3 font-medium">{run.ruleName}<span className="ml-2 text-xs text-slate-400">v{run.ruleVersion}</span></td><td className="px-4 py-3 text-slate-600">{formatDate(run.startedAt)}</td><td className="px-4 py-3"><StatusPill value={run.status} /></td><td className="px-4 py-3 text-right tabular-nums">{run.matched}</td><td className="px-4 py-3 text-right tabular-nums">{run.exceptionCount}</td><td className="px-4 py-3 text-right"><button type="button" onClick={() => onNavigate('runs')} className="text-xs font-medium text-teal-800 hover:underline">History</button></td></tr>)}
        </tbody></table></div> : <EmptyMessage>No runs have been recorded.</EmptyMessage>}
      </section>
      <section className="border border-slate-200 bg-white">
        <SectionTitle title="Priority work" action={<button type="button" onClick={() => onNavigate('exceptions')} className="text-sm font-medium text-teal-800 hover:underline">Review exceptions</button>} />
        {openExceptions.length ? <ul className="divide-y divide-slate-100">{openExceptions.slice(0, 6).map((exception) => <li key={exception.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"><div><p className="text-sm font-medium">{exception.businessKey}</p><p className="mt-0.5 text-xs text-slate-500">{humanOutcome(exception.outcome)} · last seen {formatDate(exception.lastSeen)}</p></div><div className="flex items-center gap-3"><SeverityPill value={exception.severity} /><span className="text-xs text-slate-500">{exception.occurrenceCount} occurrence{exception.occurrenceCount === 1 ? '' : 's'}</span></div></li>)}</ul> : <EmptyMessage>No active exceptions.</EmptyMessage>}
      </section>
    </div>
  );
}

function Metric({ label, value, onClick }: { label: string; value: number; onClick: () => void }) {
  return <button type="button" onClick={onClick} className="bg-white px-4 py-4 text-left hover:bg-slate-50"><p className="text-2xl font-semibold tabular-nums">{value}</p><p className="mt-1 text-sm text-slate-500">{label}</p></button>;
}

function SourcesPanel({ sources, catalogs, busyKey, onRegister, onBrowse }: {
  sources: AppData['sources'];
  catalogs: Record<string, SqlObject[]>;
  busyKey: string;
  onRegister: () => void;
  onBrowse: (source: AppData['sources'][number]) => void;
}) {
  return <section className="border border-slate-200 bg-white">
    <SectionTitle title="Registered SQL sources" subtitle="Only registered Lakehouses and Warehouses are offered to rule definitions." action={<button type="button" onClick={onRegister} className={primaryButton}>Register source</button>} />
    {sources.length ? <div className="divide-y divide-slate-100">{sources.map((source) => {
      const objects = catalogs[source.id] ?? parseObjects(source);
      return <details key={source.id} className="group">
        <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-3 px-4 py-3 hover:bg-slate-50">
          <div><p className="text-sm font-semibold">{source.itemName}<span className="ml-2 border border-slate-200 bg-white px-2 py-0.5 text-xs font-normal text-slate-600">{source.itemType}</span></p><p className="mt-1 text-xs text-slate-500">{source.workspaceName} · {objects.length || source.objectCount} SQL objects</p></div>
          <button type="button" onClick={(event) => { event.preventDefault(); onBrowse(source); }} disabled={busyKey === `catalog:${source.itemId}`} className="text-xs font-semibold text-teal-800 hover:underline">{busyKey === `catalog:${source.itemId}` ? 'Loading...' : 'Refresh tables'}</button>
        </summary>
        {objects.length ? <div className="border-t border-slate-100 bg-slate-50 px-4 py-3"><div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">{objects.map((object) => <div key={objectName(object)} className="border border-slate-200 bg-white p-2.5"><p className="text-xs font-semibold">{objectName(object)}</p><p className="mt-0.5 text-[11px] text-slate-500">{object.type} · {object.fields.length} columns</p><p className="mt-2 line-clamp-2 text-[11px] text-slate-600">{object.fields.map((field) => field.name).join(', ')}</p></div>)}</div></div> : <p className="px-4 py-3 text-xs text-slate-500">Load tables to make them available in Rule Definition.</p>}
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
    <section role="dialog" aria-modal="true" aria-labelledby="register-source-heading" className="max-h-[88vh] w-full max-w-3xl overflow-hidden border border-slate-200 bg-white shadow-2xl">
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
  rules, sources, draft, objectsForSource, busyKey, versionHistory, onNew, onEdit, onDraft, onSelectSource, onUpdateField, onAddField, onRemoveField, onSave, onCancel, onToggle, onVersions, onRun, onRegisterSource,
}: {
  rules: StoredRule[];
  sources: AppData['sources'];
  draft: RuleDraft | null;
  objectsForSource: (id: string) => SqlObject[];
  busyKey: string;
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
  onRegisterSource: (side: 'A' | 'B') => void;
}) {
  return <div className="space-y-5">
    <section className="border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-4"><div><h3 className="font-semibold">Reconciliation rules</h3><p className="mt-1 text-sm text-slate-500">Definitions are versioned on every save or status change.</p></div><button type="button" onClick={onNew} className={primaryButton}>New rule</button></div>
      {rules.length ? <div className="overflow-x-auto"><table className="w-full min-w-[920px] text-left text-sm"><thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-4 py-2.5">Rule</th><th className="px-4 py-2.5">Group</th><th className="px-4 py-2.5">Status</th><th className="px-4 py-2.5">Owner</th><th className="px-4 py-2.5 text-right">Version</th><th className="px-4 py-2.5 text-right">Actions</th></tr></thead><tbody className="divide-y divide-slate-100">
        {rules.map((rule) => <tr key={rule.id}><td className="px-4 py-3"><p className="font-medium">{rule.name}</p><p className="text-xs text-slate-500">{rule.businessArea || 'Unassigned area'} · {rule.priority} priority</p></td><td className="px-4 py-3 text-slate-600">{ruleGroups.find(([key]) => key === rule.ruleGroup)?.[1] ?? 'Ungrouped'}</td><td className="px-4 py-3"><StatusPill value={rule.status} /></td><td className="px-4 py-3 text-slate-600">{rule.owner || 'Unassigned'}</td><td className="px-4 py-3 text-right tabular-nums">v{rule.version}</td><td className="px-4 py-3"><div className="flex justify-end gap-3"><button type="button" onClick={() => onEdit(rule)} disabled={busyKey === `rule:${rule.id}`} className="text-xs font-semibold text-teal-800 hover:underline">Edit</button><button type="button" onClick={() => onVersions(rule)} disabled={busyKey === `versions:${rule.id}`} className="text-xs font-semibold text-slate-600 hover:underline">Versions</button>{rule.enabled ? <button type="button" onClick={() => onToggle(rule)} disabled={busyKey === `rule:${rule.id}`} className="text-xs font-semibold text-amber-800 hover:underline">Disable</button> : <button type="button" onClick={() => onToggle(rule)} disabled={busyKey === `rule:${rule.id}`} className="text-xs font-semibold text-teal-800 hover:underline">Enable</button>}{rule.enabled && <button type="button" onClick={() => onRun(rule)} disabled={busyKey === `run:${rule.id}`} className="text-xs font-semibold text-blue-800 hover:underline">{busyKey === `run:${rule.id}` ? 'Running...' : 'Run now'}</button>}</div></td></tr>)}
      </tbody></table></div> : <EmptyMessage>No rules yet. Create a rule after registering SQL sources.</EmptyMessage>}
    </section>

    {draft && <RuleEditor
      draft={draft} sources={sources} objectsForSource={objectsForSource} busy={busyKey === 'save-rule'}
      onDraft={onDraft} onSelectSource={onSelectSource} onUpdateField={onUpdateField} onAddField={onAddField} onRegisterSource={onRegisterSource}
      onRemoveField={onRemoveField} onSave={onSave} onCancel={onCancel}
    />}
    {versionHistory && <section className="border border-slate-200 bg-white"><SectionTitle title="Rule version history" action={<button type="button" className="text-sm text-slate-600 hover:underline" onClick={onCancel}>Close</button>} />
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
  return <section className="border border-slate-200 bg-white">
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
          {draft.compareFields.map((field, index) => <div key={`${index}-${field.label}`} className="border border-slate-200 p-3">
            <div className="mb-3 grid gap-3 md:grid-cols-[minmax(130px,1fr)_150px_150px_120px_auto]">
              <div><label className={labelClass}>Label</label><input className={input} value={field.label} onChange={(event) => onUpdateField(index, (current) => ({ ...current, label: event.target.value }))} /></div>
              <div><label className={labelClass}>Value type</label><select className={input} value={field.type} onChange={(event) => onUpdateField(index, (current) => ({ ...current, type: event.target.value as CompareField['type'] }))}><option value="string">Text</option><option value="number">Number</option><option value="date">Date</option><option value="boolean">Boolean</option></select></div>
              <div><label className={labelClass}>Tolerance</label><select className={input} value={field.tolerance?.type ?? 'none'} onChange={(event) => onUpdateField(index, (current) => ({ ...current, tolerance: event.target.value === 'none' ? undefined : { type: event.target.value as NonNullable<CompareField['tolerance']>['type'], value: current.tolerance?.value ?? 0 } }))}><option value="none">Exact</option><option value="absolute">Absolute</option><option value="percent">Percent</option><option value="days">Days</option></select></div>
              <div><label className={labelClass}>Allowed diff.</label><input className={input} type="number" min="0" step="any" disabled={!field.tolerance} value={field.tolerance?.value ?? ''} onChange={(event) => onUpdateField(index, (current) => ({ ...current, tolerance: current.tolerance ? { ...current.tolerance, value: Number(event.target.value) } : undefined }))} /></div>
              <div className="flex items-end"><button type="button" onClick={() => onRemoveField(index)} disabled={draft.compareFields.length === 1} className="mb-1 text-xs font-medium text-red-700 hover:underline disabled:opacity-40">Remove</button></div>
            </div>
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
  return <fieldset className="space-y-3 border border-slate-200 p-3"><legend className="px-1 text-sm font-semibold">Source {side}</legend>
    <div><div className="mb-1 flex items-center justify-between gap-2"><label className={`${labelClass} mb-0`}>Registered source</label><button type="button" onClick={onRegister} className="text-xs font-semibold text-teal-800 hover:underline">Register source</button></div><select className={input} value={sourceId} onChange={(event) => onSelectSource(side, event.target.value)}><option value="">Choose a registered source</option>{sources.map((source) => <option key={source.id} value={source.id}>{source.workspaceName} / {source.itemName}</option>)}</select>{sources.length === 0 && <p className="mt-1 text-xs text-amber-800">Register a Lakehouse or Warehouse before defining tables.</p>}</div>
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
  return <fieldset className="grid gap-2 border border-slate-200 bg-slate-50 p-2.5 sm:grid-cols-[130px_minmax(0,1fr)]"><legend className="px-1 text-xs font-semibold text-slate-600">{title}</legend>
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

function ExceptionsPanel({ exceptions, allExceptions, filter, selected, events, owner, comment, reason, busyKey, onFilter, onSelect, onOwner, onComment, onReason, onAssign, onAddComment, onStatus }: {
  exceptions: StoredException[];
  allExceptions: StoredException[];
  filter: { status: string; severity: string; outcome: string };
  selected: StoredException | null;
  events: Array<Record<string, unknown>>;
  owner: string;
  comment: string;
  reason: string;
  busyKey: string;
  onFilter: (filter: { status: string; severity: string; outcome: string }) => void;
  onSelect: (exception: StoredException) => void;
  onOwner: (value: string) => void;
  onComment: (value: string) => void;
  onReason: (value: string) => void;
  onAssign: () => void;
  onAddComment: () => void;
  onStatus: (status: StoredException['status']) => void;
}) {
  const outcomes = [...new Set(allExceptions.map((exception) => exception.outcome))];
  const allowed: Record<StoredException['status'], StoredException['status'][]> = {
    open: ['acknowledged', 'investigating', 'resolved', 'accepted'],
    acknowledged: ['investigating', 'resolved', 'accepted', 'open'],
    investigating: ['resolved', 'accepted', 'open'],
    resolved: ['open'],
    accepted: ['open'],
  };
  return <div className="grid gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(320px,0.8fr)]">
    <section className="border border-slate-200 bg-white">
      <div className="grid gap-3 border-b border-slate-200 p-4 sm:grid-cols-3"><div><label className={labelClass}>Status</label><select className={input} value={filter.status} onChange={(event) => onFilter({ ...filter, status: event.target.value })}><option value="">All statuses</option>{statuses.map((status) => <option key={status} value={status}>{status}</option>)}</select></div><div><label className={labelClass}>Severity</label><select className={input} value={filter.severity} onChange={(event) => onFilter({ ...filter, severity: event.target.value })}><option value="">All severities</option>{severities.map((severity) => <option key={severity} value={severity}>{severity}</option>)}</select></div><div><label className={labelClass}>Outcome</label><select className={input} value={filter.outcome} onChange={(event) => onFilter({ ...filter, outcome: event.target.value })}><option value="">All outcomes</option>{outcomes.map((outcome) => <option key={outcome} value={outcome}>{humanOutcome(outcome)}</option>)}</select></div></div>
      <div className="border-b border-slate-100 px-4 py-2 text-xs text-slate-500">{exceptions.length} of {allExceptions.length} exceptions</div>
      {exceptions.length ? <div className="max-h-[680px] overflow-auto"><table className="w-full min-w-[700px] text-left text-sm"><thead className="sticky top-0 bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-4 py-2.5">Business key</th><th className="px-4 py-2.5">Outcome</th><th className="px-4 py-2.5">Severity</th><th className="px-4 py-2.5">Status</th><th className="px-4 py-2.5">Owner</th><th className="px-4 py-2.5">Last seen</th></tr></thead><tbody className="divide-y divide-slate-100">{exceptions.map((exception) => <tr key={exception.id} className={selected?.id === exception.id ? 'bg-teal-50' : 'hover:bg-slate-50'}><td className="px-4 py-2.5"><button type="button" onClick={() => onSelect(exception)} className="text-left font-semibold text-teal-900 hover:underline">{exception.businessKey}</button></td><td className="px-4 py-2.5 text-slate-600">{humanOutcome(exception.outcome)}</td><td className="px-4 py-2.5"><SeverityPill value={exception.severity} /></td><td className="px-4 py-2.5"><StatusPill value={exception.status} /></td><td className="px-4 py-2.5 text-slate-600">{exception.owner || 'Unassigned'}</td><td className="px-4 py-2.5 text-xs text-slate-500">{formatDate(exception.lastSeen)}</td></tr>)}</tbody></table></div> : <EmptyMessage>No exceptions match this filter.</EmptyMessage>}
    </section>
    <section className="border border-slate-200 bg-white">
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

function RunsPanel({ runs, selectedRun, findings, onDetails, onCompare }: { runs: StoredRun[]; selectedRun: StoredRun | null; findings: ReconciliationFinding[]; onDetails: (run: StoredRun) => void; onCompare: (run: StoredRun) => void }) {
  return <section className="border border-slate-200 bg-white"><SectionTitle title="Run history" subtitle="Every run retains the rule version, counts, and per-item findings." />
    {runs.length ? <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-left text-sm"><thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-4 py-2.5">Rule</th><th className="px-4 py-2.5">Started</th><th className="px-4 py-2.5">Completed</th><th className="px-4 py-2.5">Status</th><th className="px-4 py-2.5 text-right">Rows A</th><th className="px-4 py-2.5 text-right">Rows B</th><th className="px-4 py-2.5 text-right">Matched</th><th className="px-4 py-2.5 text-right">Findings</th><th className="px-4 py-2.5"></th></tr></thead><tbody className="divide-y divide-slate-100">{runs.map((run) => <tr key={run.id} className={selectedRun?.id === run.id ? 'bg-teal-50' : ''}><td className="px-4 py-3 font-medium">{run.ruleName}<span className="ml-2 text-xs text-slate-400">v{run.ruleVersion}</span></td><td className="px-4 py-3 text-xs text-slate-600">{formatDate(run.startedAt)}</td><td className="px-4 py-3 text-xs text-slate-600">{formatDate(run.completedAt)}</td><td className="px-4 py-3"><StatusPill value={run.status} /></td><td className="px-4 py-3 text-right tabular-nums">{run.recordsA}</td><td className="px-4 py-3 text-right tabular-nums">{run.recordsB}</td><td className="px-4 py-3 text-right tabular-nums">{run.matched}</td><td className="px-4 py-3 text-right tabular-nums">{run.exceptionCount}</td><td className="px-4 py-3 text-right"><div className="flex justify-end gap-3"><button type="button" onClick={() => onDetails(run)} className="text-xs font-semibold text-slate-700 hover:underline">Details</button>{run.status === 'completed' && <button type="button" onClick={() => onCompare(run)} className="text-xs font-semibold text-teal-800 hover:underline">Compare</button>}</div></td></tr>)}</tbody></table></div> : <EmptyMessage>No runs have been recorded.</EmptyMessage>}
    {selectedRun && <div className="border-t border-slate-200"><SectionTitle title={`Run findings · ${selectedRun.ruleName}`} subtitle={`Version ${selectedRun.ruleVersion} · ${findings.length} findings stored`} />{findings.length ? <div className="divide-y divide-slate-100">{findings.slice(0, 500).map((finding) => <div key={finding.fingerprint} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3"><div><p className="text-sm font-semibold">{finding.businessKey}</p><p className="mt-1 text-xs text-slate-500">{humanOutcome(finding.outcome)}{finding.differences.length ? ` · ${finding.differences.map((difference) => difference.field).join(', ')}` : ''}</p></div><SeverityPill value={finding.severity} /></div>)}</div> : selectedRun.exceptionCount > 0 ? <EmptyMessage>This run has totals but no detailed findings.</EmptyMessage> : <EmptyMessage>This run completed with no findings.</EmptyMessage>}</div>}
  </section>;
}

function ExceptionValues({ exception }: { exception: StoredException }) {
  const detail = parseExceptionDetail(exception);
  if (!detail.differences?.length && !detail.valuesA && !detail.valuesB) return null;
  const display = (value: unknown) => value === null || value === undefined ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return <div className="border border-slate-200">
    <div className="border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold uppercase text-slate-600">Compared values</div>
    {detail.differences?.length ? <div className="overflow-x-auto"><table className="w-full min-w-[420px] text-left text-xs"><thead className="text-slate-500"><tr><th className="px-3 py-2 font-medium">Field</th><th className="px-3 py-2 font-medium">Left</th><th className="px-3 py-2 font-medium">Right</th><th className="px-3 py-2 font-medium">Difference</th></tr></thead><tbody className="divide-y divide-slate-100">{detail.differences.map((difference, index) => <tr key={`${difference.field}-${index}`}><td className="px-3 py-2 font-medium">{difference.field}</td><td className="max-w-40 break-words px-3 py-2">{display(difference.valueA)}</td><td className="max-w-40 break-words px-3 py-2">{display(difference.valueB)}</td><td className="px-3 py-2">{difference.difference ?? difference.reason ?? 'Different'}</td></tr>)}</tbody></table></div> : <div className="grid gap-3 p-3 sm:grid-cols-2"><div><p className={labelClass}>Left</p><pre className="whitespace-pre-wrap break-words text-xs">{JSON.stringify(detail.valuesA, null, 2)}</pre></div><div><p className={labelClass}>Right</p><pre className="whitespace-pre-wrap break-words text-xs">{JSON.stringify(detail.valuesB, null, 2)}</pre></div></div>}
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
    <section className="border border-slate-200 bg-white"><div className="grid gap-3 p-4 md:grid-cols-[1fr_1fr_1fr_auto] md:items-end">
      <div><label className={labelClass}>Rule</label><select className={input} value={ruleId} onChange={(event) => onRule(event.target.value)}><option value="">Choose a rule</option>{rules.map((rule) => <option key={rule.id} value={rule.id}>{rule.name}</option>)}</select></div>
      <div><label className={labelClass}>Earlier run</label><select className={input} value={fromRunId} onChange={(event) => onFrom(event.target.value)}><option value="">Choose a run</option>{runs.map((run) => <option key={run.id} value={run.id}>{formatDate(run.startedAt)} · v{run.ruleVersion} · {run.exceptionCount} findings</option>)}</select></div>
      <div><label className={labelClass}>Later run</label><select className={input} value={toRunId} onChange={(event) => onTo(event.target.value)}><option value="">Choose a run</option>{runs.map((run) => <option key={run.id} value={run.id}>{formatDate(run.startedAt)} · v{run.ruleVersion} · {run.exceptionCount} findings</option>)}</select></div>
      <button type="button" onClick={onCompare} disabled={busy || !fromRunId || !toRunId} className={primaryButton}>{busy ? 'Comparing...' : 'Compare'}</button>
    </div><div className="border-t border-slate-100 px-4 py-3 text-xs text-slate-500">Runs from different rules cannot be compared. Findings are matched by stable business-key fingerprints.</div></section>
    {result && <>
      <div className="grid gap-px border border-slate-200 bg-slate-200 sm:grid-cols-2 xl:grid-cols-4"><Metric label="Newly failing" value={result.newlyFailing.length} onClick={() => undefined} /><Metric label="Fixed" value={result.fixed.length} onClick={() => undefined} /><Metric label="Still failing" value={result.stillFailing.length} onClick={() => undefined} /><Metric label="Change in exception count" value={result.metrics.exceptionCount} onClick={() => undefined} /></div>
      <div className="grid gap-5 xl:grid-cols-3"><FindingList title="Newly failing" findings={result.newlyFailing} tone="red" /><FindingList title="Fixed" findings={result.fixed} tone="teal" /><FindingList title="Still failing" findings={result.stillFailing} tone="amber" /></div>
    </>}
  </div>;
}

function FindingList({ title, findings, tone }: { title: string; findings: ReconciliationFinding[]; tone: 'red' | 'teal' | 'amber' }) {
  const colors = { red: 'text-red-800', teal: 'text-teal-800', amber: 'text-amber-800' };
  return <section className="border border-slate-200 bg-white"><SectionTitle title={title} subtitle={`${findings.length} item${findings.length === 1 ? '' : 's'}`} />{findings.length ? <ul className="divide-y divide-slate-100">{findings.slice(0, 50).map((finding) => <li key={finding.fingerprint} className="px-4 py-3"><p className={`text-sm font-semibold ${colors[tone]}`}>{finding.businessKey}</p><p className="mt-1 text-xs text-slate-600">{humanOutcome(finding.outcome)}{finding.differences.length ? ` · ${finding.differences.map((difference) => difference.field).join(', ')}` : ''}</p></li>)}</ul> : <EmptyMessage>None</EmptyMessage>}</section>;
}

function SectionTitle({ title, subtitle, action }: { title: string; subtitle?: string; action?: React.ReactNode }) {
  return <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3"><div><h3 className="text-sm font-semibold">{title}</h3>{subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}</div>{action}</div>;
}

function StatusPill({ value }: { value: string }) {
  const className = value === 'active' || value === 'completed' || value === 'resolved' ? 'border-teal-200 bg-teal-50 text-teal-800'
    : value === 'failed' || value === 'open' ? 'border-red-200 bg-red-50 text-red-800'
    : value === 'investigating' || value === 'acknowledged' || value === 'running' ? 'border-amber-200 bg-amber-50 text-amber-800'
    : 'border-slate-200 bg-slate-50 text-slate-700';
  return <span className={`inline-flex border px-2 py-1 text-xs capitalize ${className}`}>{value.replaceAll('_', ' ')}</span>;
}

function SeverityPill({ value }: { value: string }) {
  const className = value === 'high' ? 'border-red-200 bg-red-50 text-red-800' : value === 'medium' ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-slate-200 bg-slate-50 text-slate-700';
  return <span className={`inline-flex border px-2 py-1 text-xs capitalize ${className}`}>{value}</span>;
}

function EmptyMessage({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-6 text-sm text-slate-500">{children}</p>;
}