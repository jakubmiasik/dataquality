import sql from 'mssql';

import type { ReconciliationRule } from '../../src/services/reconciliationEngine.js' with { 'resolution-mode': 'import' };

export interface FabricSourceReference {
  workspaceId: string;
  itemId: string;
  itemType: 'Lakehouse' | 'Warehouse';
}

export interface GatewayRule extends ReconciliationRule {
  datasetA: string;
  datasetB: string;
  rowLimit: number;
}

export interface ReconciliationQueryRequest {
  source: FabricSourceReference;
}

export interface ReconciliationExecutionRequest {
  sources: { a: FabricSourceReference; b: FabricSourceReference };
  rule: GatewayRule;
}

const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const endpoint = /^[a-z0-9][a-z0-9.-]*\.datawarehouse\.(?:fabric\.microsoft\.com|pbidedicated\.windows\.net)$/i;
const fabricApi = 'https://api.fabric.microsoft.com';

function isSource(value: unknown): value is FabricSourceReference {
  if (!value || typeof value !== 'object') return false;
  const source = value as Partial<FabricSourceReference>;
  return !!source.workspaceId && guid.test(source.workspaceId)
    && !!source.itemId && guid.test(source.itemId)
    && (source.itemType === 'Lakehouse' || source.itemType === 'Warehouse');
}

export function validateCatalogRequest(value: unknown): { request?: ReconciliationQueryRequest; error?: string } {
  if (!value || typeof value !== 'object' || !isSource((value as { source?: unknown }).source)) {
    return { error: 'Choose a valid Fabric Lakehouse or Warehouse.' };
  }
  return { request: { source: (value as { source: FabricSourceReference }).source } };
}

export async function validateRequest(value: unknown): Promise<{ request?: ReconciliationExecutionRequest; error?: string }> {
  if (!value || typeof value !== 'object') return { error: 'A JSON request body is required.' };
  const request = value as Partial<ReconciliationExecutionRequest>;
  if (!request.sources || !isSource(request.sources.a) || !isSource(request.sources.b)) {
    return { error: 'Choose a valid Fabric source on each side.' };
  }
  const rule = request.rule as GatewayRule | undefined;
  if (!rule || !rule.datasetA?.trim() || !rule.datasetB?.trim() || !rule.keyFieldA?.trim() || !rule.keyFieldB?.trim()) {
    return { error: 'The rule must define both datasets and business keys.' };
  }
  const rowLimit = rule.rowLimit ?? 10000;
  if (!Number.isInteger(rowLimit) || rowLimit < 1 || rowLimit > 10000) {
    return { error: 'rowLimit must be between 1 and 10000.' };
  }
  const engine = await import('../../src/services/reconciliationEngine.js');
  const problems = engine.validateCompareFields(rule.compareFields ?? []);
  if (problems.length) return { error: problems.join(' ') };
  try { engine.planRule(rule); }
  catch (error) { return { error: error instanceof Error ? error.message : 'The rule is invalid.' }; }
  return { request: { sources: request.sources, rule: { ...rule, rowLimit } } };
}

interface FabricItemDetails {
  id: string;
  displayName: string;
  workspaceId: string;
  properties?: {
    connectionString?: string;
    sqlEndpointProperties?: { connectionString?: string; provisioningStatus?: string };
  };
}

interface ResolvedFabricSource extends FabricSourceReference {
  connectionString: string;
  database: string;
}

async function resolveSource(source: FabricSourceReference, bearerToken: string): Promise<ResolvedFabricSource> {
  const typePath = source.itemType === 'Lakehouse' ? 'lakehouses' : 'warehouses';
  const response = await fetch(`${fabricApi}/v1/workspaces/${source.workspaceId}/${typePath}/${source.itemId}`, {
    headers: { Authorization: `Bearer ${bearerToken}` },
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error('Fabric denied access to this workspace item.');
  }
  if (!response.ok) throw new Error('Fabric could not resolve the selected source item.');
  const item = await response.json() as FabricItemDetails;
  const connectionString = source.itemType === 'Lakehouse'
    ? item.properties?.sqlEndpointProperties?.connectionString
    : item.properties?.connectionString;
  if (!item.displayName || item.id !== source.itemId || item.workspaceId !== source.workspaceId
      || !connectionString || !endpoint.test(connectionString)) {
    throw new Error('Fabric did not return a usable SQL endpoint for the selected item.');
  }
  return { ...source, connectionString, database: item.displayName };
}

function sqlConfig(source: ResolvedFabricSource, accessToken: string): sql.config {
  return {
    server: source.connectionString,
    port: 1433,
    authentication: {
      type: 'azure-active-directory-access-token',
      options: { token: accessToken },
    },
    options: {
      database: source.database,
      encrypt: true,
      trustServerCertificate: false,
      enableArithAbort: true,
    },
    connectionTimeout: 15000,
    requestTimeout: 120000,
  };
}

async function withSqlPool<T>(source: ResolvedFabricSource, accessToken: string, action: (pool: sql.ConnectionPool) => Promise<T>): Promise<T> {
  const pool = await new sql.ConnectionPool(sqlConfig(source, accessToken)).connect();
  try { return await action(pool); }
  finally { await pool.close(); }
}

export async function readSourceCatalog(source: FabricSourceReference, bearerToken: string, sqlAccessToken: string) {
  const resolved = await resolveSource(source, bearerToken);
  return withSqlPool(resolved, sqlAccessToken, async (pool) => {
    const result = await pool.request().query(`
      SELECT s.name AS schemaName, o.name AS objectName,
        CASE WHEN o.type = 'V' THEN 'VIEW' ELSE 'TABLE' END AS objectType,
        c.name AS columnName, t.name AS dataType, c.is_nullable AS isNullable
      FROM sys.objects AS o
      INNER JOIN sys.schemas AS s ON s.schema_id = o.schema_id
      INNER JOIN sys.columns AS c ON c.object_id = o.object_id
      INNER JOIN sys.types AS t ON t.user_type_id = c.user_type_id
      WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0
      ORDER BY s.name, o.name, c.column_id
    `);
    const objects = new Map<string, { schema: string; name: string; type: 'TABLE' | 'VIEW'; fields: Array<{ name: string; dataType: string; nullable: boolean }> }>();
    for (const row of result.recordset as Array<Record<string, unknown>>) {
      const schema = String(row.schemaName);
      const name = String(row.objectName);
      const key = `${schema}.${name}`;
      let object = objects.get(key);
      if (!object) {
        object = { schema, name, type: row.objectType === 'VIEW' ? 'VIEW' : 'TABLE', fields: [] };
        objects.set(key, object);
      }
      object.fields.push({ name: String(row.columnName), dataType: String(row.dataType), nullable: Boolean(row.isNullable) });
    }
    return {
      source: { ...source, sqlEndpoint: resolved.connectionString, database: resolved.database },
      objects: [...objects.values()],
    };
  });
}

export async function executeReconciliation(request: ReconciliationExecutionRequest, bearerToken: string, sqlAccessToken: string) {
  const [sourceA, sourceB] = await Promise.all([
    resolveSource(request.sources.a, bearerToken),
    resolveSource(request.sources.b, bearerToken),
  ]);
  const engine = await import('../../src/services/reconciliationEngine.js');
  const plan = engine.planRule(request.rule);
  const [rowsA, rowsB] = await Promise.all([
    withSqlPool(sourceA, sqlAccessToken, async (pool) => (await pool.request().query(engine.buildSelectSql({
      dataset: request.rule.datasetA,
      selections: plan.selectionsA,
      rowLimit: request.rule.rowLimit,
    }))).recordset as Array<Record<string, unknown>>),
    withSqlPool(sourceB, sqlAccessToken, async (pool) => (await pool.request().query(engine.buildSelectSql({
      dataset: request.rule.datasetB,
      selections: plan.selectionsB,
      rowLimit: request.rule.rowLimit,
    }))).recordset as Array<Record<string, unknown>>),
  ]);
  const result = engine.reconcile({ rowsA, rowsB, rule: plan.engineRule });
  return { result, sources: [sourceA, sourceB].map(({ connectionString: _connectionString, ...source }) => source) };
}

export function bearerTokenFromHeader(header: string | null): string | null {
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

function tokenPrincipal(token: string) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as Record<string, unknown>;
    return { objectId: payload.oid, tenantId: payload.tid };
  } catch {
    return null;
  }
}

export function tokensBelongToSamePrincipal(fabricToken: string, sqlAccessToken: string) {
  const fabricPrincipal = tokenPrincipal(fabricToken);
  const sqlPrincipal = tokenPrincipal(sqlAccessToken);
  return !!fabricPrincipal?.objectId && !!fabricPrincipal.tenantId
    && fabricPrincipal.objectId === sqlPrincipal?.objectId
    && fabricPrincipal.tenantId === sqlPrincipal.tenantId;
}
