import { getRayfinClient } from './rayfinClient';

/**
 * Runtime configuration that used to live only in `rayfin/.env`.
 *
 * Vite inlines `import.meta.env` at build time, so a wrong or missing value
 * could only be corrected by rebuilding and redeploying. These settings are
 * stored in the Rayfin data service instead, so an operator can fix them from
 * the Configuration tab of the running app. The build-time variables are kept
 * as a fallback so existing deployments keep working unchanged.
 */
export type SettingKey =
  | 'fabricEntraClientId'
  | 'fabricEntraTenantId'
  | 'reconciliationGatewayUrl';

export interface SettingDefinition {
  key: SettingKey;
  label: string;
  description: string;
  placeholder: string;
  /** The build-time variable this setting replaces, shown as a hint in the UI. */
  envName: string;
  validate: (value: string) => string | null;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateGuid(label: string) {
  return (value: string) => {
    if (!value) return `${label} is required.`;
    return GUID.test(value) ? null : `${label} must be a GUID, for example 00000000-0000-0000-0000-000000000000.`;
  };
}

function validateOrigin(value: string) {
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return 'Enter an absolute URL, for example https://my-gateway.azurewebsites.net.';
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return 'The gateway URL must use http or https.';
  }
  return null;
}

export const settingDefinitions: SettingDefinition[] = [
  {
    key: 'fabricEntraClientId',
    label: 'Entra application (client) ID',
    description: 'The app registration used to request Fabric and SQL tokens on behalf of the signed-in user.',
    placeholder: '00000000-0000-0000-0000-000000000000',
    envName: 'RAYFIN_PUBLIC_FABRIC_ENTRA_CLIENT_ID',
    validate: validateGuid('The client ID'),
  },
  {
    key: 'fabricEntraTenantId',
    label: 'Entra directory (tenant) ID',
    description: 'The directory that hosts the app registration and the Fabric workspaces you reconcile.',
    placeholder: '00000000-0000-0000-0000-000000000000',
    envName: 'RAYFIN_PUBLIC_FABRIC_ENTRA_TENANT_ID',
    validate: validateGuid('The tenant ID'),
  },
  {
    key: 'reconciliationGatewayUrl',
    label: 'Reconciliation gateway URL',
    description: 'Origin of the Azure Functions app that reads SQL endpoints. Leave empty to use the local dev proxy.',
    placeholder: 'https://my-gateway.azurewebsites.net',
    envName: 'RAYFIN_PUBLIC_RECONCILIATION_GATEWAY_URL',
    validate: validateOrigin,
  },
];

export type SettingValues = Record<SettingKey, string>;

/** Where the values currently in memory came from. */
export type SettingsSource = 'service' | 'browser';

export interface AppSettingsState {
  values: SettingValues;
  source: SettingsSource;
  /** Set when the shared store was unavailable and the browser copy is in use. */
  warning?: string;
}

const BROWSER_STORAGE_KEY = 'reconciliation.appSettings';

const envNames: Record<SettingKey, string> = {
  fabricEntraClientId: 'VITE_RAYFIN_FABRIC_ENTRA_CLIENT_ID',
  fabricEntraTenantId: 'VITE_RAYFIN_FABRIC_ENTRA_TENANT_ID',
  reconciliationGatewayUrl: 'VITE_RAYFIN_RECONCILIATION_GATEWAY_URL',
};

/* Read on demand rather than captured at module load, so a build-time value
   can be observed even if the module is evaluated before the env is applied. */
function envFallback(key: SettingKey): string {
  const value = (import.meta.env as Record<string, string | undefined>)[envNames[key]];
  return typeof value === 'string' ? value.trim() : '';
}

export function emptySettingValues(): SettingValues {
  return { fabricEntraClientId: '', fabricEntraTenantId: '', reconciliationGatewayUrl: '' };
}

function readBrowserCopy(): SettingValues {
  try {
    const raw = globalThis.localStorage?.getItem(BROWSER_STORAGE_KEY);
    if (!raw) return emptySettingValues();
    const parsed = JSON.parse(raw) as Partial<SettingValues>;
    const values = emptySettingValues();
    for (const definition of settingDefinitions) {
      const value = parsed[definition.key];
      if (typeof value === 'string') values[definition.key] = value;
    }
    return values;
  } catch {
    return emptySettingValues();
  }
}

function writeBrowserCopy(values: SettingValues) {
  try {
    globalThis.localStorage?.setItem(BROWSER_STORAGE_KEY, JSON.stringify(values));
  } catch {
    // Private browsing and storage quotas can both reject writes. The shared
    // store is the source of truth, so a failed mirror is not fatal.
  }
}

/**
 * Seeded from the browser mirror so a reload resolves settings before the
 * async load finishes, and refreshed from the data service by
 * {@link loadAppSettings}.
 */
let cache: SettingValues = readBrowserCopy();

/** Resolution order: operator-entered value, then the build-time variable. */
export function getSettingValue(key: SettingKey): string {
  return cache[key]?.trim() || envFallback(key);
}

export function requireSettingValue(key: SettingKey): string {
  const value = getSettingValue(key);
  if (!value) {
    const definition = settingDefinitions.find((entry) => entry.key === key);
    throw new Error(`${definition?.label ?? key} is not set. Open the Configuration tab and enter it.`);
  }
  return value;
}

/** Current values with build-time variables applied, for display in the form. */
export function getResolvedSettings(): SettingValues {
  const values = emptySettingValues();
  for (const definition of settingDefinitions) values[definition.key] = getSettingValue(definition.key);
  return values;
}

function applyValues(values: SettingValues) {
  cache = values;
  writeBrowserCopy(values);
}

const UNAVAILABLE_WARNING =
  'The shared settings table is not available, so these values are stored in this browser only. Run `rayfin up db apply` to share them with everyone in the workspace.';

/** Loads the workspace-wide settings, falling back to the browser copy. */
export async function loadAppSettings(): Promise<AppSettingsState> {
  try {
    const rows = await getRayfinClient()
      .data.AppSetting.select(['id', 'settingKey', 'settingValue'])
      .execute();
    const values = emptySettingValues();
    for (const row of rows) {
      if (isSettingKey(row.settingKey)) values[row.settingKey] = row.settingValue ?? '';
    }
    applyValues(values);
    return { values: getResolvedSettings(), source: 'service' };
  } catch {
    applyValues(readBrowserCopy());
    return { values: getResolvedSettings(), source: 'browser', warning: UNAVAILABLE_WARNING };
  }
}

function isSettingKey(value: string): value is SettingKey {
  return settingDefinitions.some((definition) => definition.key === value);
}

/** Validates every setting and returns the first message per key. */
export function validateSettings(values: SettingValues): Partial<Record<SettingKey, string>> {
  const errors: Partial<Record<SettingKey, string>> = {};
  for (const definition of settingDefinitions) {
    const message = definition.validate(values[definition.key].trim());
    if (message) errors[definition.key] = message;
  }
  return errors;
}

/** Persists the settings for the whole workspace, mirroring them locally. */
export async function saveAppSettings(
  values: SettingValues,
  userId: string,
  userName: string
): Promise<AppSettingsState> {
  const errors = validateSettings(values);
  const firstError = settingDefinitions.map((definition) => errors[definition.key]).find(Boolean);
  if (firstError) throw new Error(firstError);

  const trimmed = emptySettingValues();
  for (const definition of settingDefinitions) trimmed[definition.key] = values[definition.key].trim();

  try {
    const client = getRayfinClient();
    const existing = await client.data.AppSetting.select(['id', 'settingKey']).execute();
    for (const definition of settingDefinitions) {
      const row = existing.find((candidate) => candidate.settingKey === definition.key);
      const record = {
        settingKey: definition.key,
        settingValue: trimmed[definition.key],
        updatedAt: new Date(),
        updatedBy: userName,
        user_id: userId,
      };
      if (row) await client.data.AppSetting.update({ id: row.id }, record);
      else await client.data.AppSetting.create(record);
    }
    applyValues(trimmed);
    return { values: getResolvedSettings(), source: 'service' };
  } catch {
    applyValues(trimmed);
    return { values: getResolvedSettings(), source: 'browser', warning: UNAVAILABLE_WARNING };
  }
}

/** Test seam: replaces the in-memory cache without touching the data service. */
export function __setSettingsCacheForTests(values: SettingValues) {
  cache = values;
}
