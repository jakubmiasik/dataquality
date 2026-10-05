import { PublicClientApplication } from '@azure/msal-browser';

import { getSettingValue, requireSettingValue } from './appSettings';

const FABRIC_API_ORIGIN = 'https://api.fabric.microsoft.com';
const FABRIC_SCOPES = [
  'https://api.fabric.microsoft.com/Workspace.Read.All',
  'https://api.fabric.microsoft.com/Lakehouse.Read.All',
  'https://api.fabric.microsoft.com/Warehouse.Read.All',
];
const SQL_SCOPES = ['https://database.windows.net//user_impersonation'];

function getRedirectUri() {
  return `${window.location.origin}/auth-redirect.html`;
}

function getPopupRelayUri() {
  return `${window.location.origin}/popup-relay.html`;
}

export interface FabricWorkspace {
  id: string;
  displayName: string;
  description?: string;
  type: string;
}

export interface FabricItem {
  id: string;
  displayName: string;
  description?: string;
  type: string;
  workspaceId: string;
}

export interface WorkspaceResources {
  workspace: FabricWorkspace;
  items: FabricItem[];
  lakehouses: FabricItem[];
  warehouses: FabricItem[];
  error?: string;
}

interface WorkspacePage {
  value: FabricWorkspace[];
  continuationUri?: string;
}

interface ItemPage {
  value: FabricItem[];
  continuationUri?: string;
}

export interface SqlObjectColumn {
  name: string;
  dataType: string;
  nullable: boolean;
}

export interface SqlObject {
  schema: string;
  name: string;
  type: 'TABLE' | 'VIEW';
  fields: SqlObjectColumn[];
}

export interface FabricSqlSource {
  workspaceId: string;
  workspaceName: string;
  itemId: string;
  itemName: string;
  itemType: 'Lakehouse' | 'Warehouse';
}

function getEntraConfig() {
  return {
    clientId: requireSettingValue('fabricEntraClientId'),
    tenantId: requireSettingValue('fabricEntraTenantId'),
  };
}

let client: PublicClientApplication | undefined;
let clientKey = '';

async function getClient() {
  const { clientId, tenantId } = getEntraConfig();
  // The MSAL instance is bound to one registration. Rebuild it when an
  // operator corrects the IDs in the Configuration tab, otherwise the app
  // would keep using the registration it started with until a full reload.
  const key = `${clientId}|${tenantId}`;
  if (!client || clientKey !== key) {
    client = new PublicClientApplication({
      auth: {
        clientId,
        authority: `https://login.microsoftonline.com/${tenantId}`,
        redirectUri: getRedirectUri(),
        popupRelayUri: getPopupRelayUri(),
      },
      cache: { cacheLocation: 'sessionStorage' },
    });
    await client.initialize();
    clientKey = key;
  }
  return client;
}

async function acquireToken(loginHint: string, scopes: string[]) {
  const msal = await getClient();
  const request = { scopes, loginHint };
  try {
    return (await msal.ssoSilent(request)).accessToken;
  } catch {
    // A Fabric app is commonly hosted in an iframe. Silent SSO depends on a
    // hidden iframe and can time out when third-party cookies are blocked.
    // Continue to the user-initiated popup flow in that case.
  }
  const account = msal.getAllAccounts().find((candidate) => candidate.username.toLowerCase() === loginHint.toLowerCase());
  if (account) {
    try {
      return (await msal.acquireTokenSilent({ ...request, account })).accessToken;
    } catch {
      // An interactive popup below can satisfy consent, MFA, or cookie limits.
    }
  }
  return (await msal.acquireTokenPopup(request)).accessToken;
}

async function acquireFabricToken(loginHint: string) {
  return acquireToken(loginHint, FABRIC_SCOPES);
}

function assertFabricApiUrl(url: string) {
  const parsed = new URL(url);
  if (parsed.origin !== FABRIC_API_ORIGIN) throw new Error('Fabric returned an unexpected continuation URL.');
  return parsed.toString();
}

async function getPage<T>(url: string, accessToken: string): Promise<T> {
  const response = await fetch(assertFabricApiUrl(url), { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw new Error(`Fabric API request failed (${response.status}). ${await response.text()}`);
  return response.json() as Promise<T>;
}

/** Lists every Fabric workspace the signed-in user can access. */
export async function listAccessibleWorkspaces(loginHint: string) {
  const accessToken = await acquireFabricToken(loginHint);
  return listWorkspaces(accessToken);
}

async function listWorkspaces(accessToken: string) {
  const workspaces: FabricWorkspace[] = [];
  let nextUrl: string | undefined = `${FABRIC_API_ORIGIN}/v1/workspaces`;
  while (nextUrl) {
    const page = await getPage<WorkspacePage>(nextUrl, accessToken);
    workspaces.push(...page.value);
    nextUrl = page.continuationUri;
  }
  return workspaces.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

async function listItems(workspaceId: string, accessToken: string) {
  const items: FabricItem[] = [];
  let nextUrl: string | undefined = new URL(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/items`,
    FABRIC_API_ORIGIN
  ).toString();
  while (nextUrl) {
    const page = await getPage<ItemPage>(nextUrl, accessToken);
    items.push(...page.value);
    nextUrl = page.continuationUri;
  }

  return items
    .map((item) => ({ ...item, workspaceId }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

async function mapWithConcurrency<T, R>(
  values: T[],
  limit: number,
  mapper: (value: T) => Promise<R>
) {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await mapper(values[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
}

/** Lists every item returned by Fabric for each workspace the user can access. */
export async function listWorkspaceResources(loginHint: string) {
  const accessToken = await acquireFabricToken(loginHint);
  const workspaces = await listWorkspaces(accessToken);
  return mapWithConcurrency(workspaces, 4, async (workspace): Promise<WorkspaceResources> => {
    try {
      const items = await listItems(workspace.id, accessToken);
      return {
        workspace,
        items,
        lakehouses: items.filter((item) => item.type === 'Lakehouse'),
        warehouses: items.filter((item) => item.type === 'Warehouse'),
      };
    } catch (error) {
      return {
        workspace,
        items: [],
        lakehouses: [],
        warehouses: [],
        error: error instanceof Error ? error.message : 'Unable to load workspace items.',
      };
    }
  });
}

export async function callReconciliationGateway<T>(route: 'catalog' | 'execute', loginHint: string, body: unknown): Promise<T> {
  const baseUrl = getSettingValue('reconciliationGatewayUrl') || (import.meta.env.DEV ? '/gateway-api' : '');
  if (!baseUrl) throw new Error('The reconciliation gateway URL is not set. Open the Configuration tab and enter the Azure Functions origin.');
  const [accessToken, sqlAccessToken] = await Promise.all([
    acquireFabricToken(loginHint),
    acquireToken(loginHint, SQL_SCOPES),
  ]);
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const url = base.startsWith('/')
    ? new URL(`${base}reconciliation/${route}`, window.location.origin)
    : new URL(`/api/reconciliation/${route}`, base);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'x-sql-access-token': sqlAccessToken,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error || `Reconciliation gateway failed (${response.status}).`);
  return result;
}
