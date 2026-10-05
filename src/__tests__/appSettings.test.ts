import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getRayfinClient } = vi.hoisted(() => ({ getRayfinClient: vi.fn() }));
vi.mock('@/services/rayfinClient', () => ({ getRayfinClient }));

import {
  emptySettingValues,
  getSettingValue,
  loadAppSettings,
  requireSettingValue,
  saveAppSettings,
  validateSettings,
  __setSettingsCacheForTests,
} from '@/services/appSettings';

const CLIENT_ID = '11111111-2222-3333-4444-555555555555';
const TENANT_ID = '66666666-7777-8888-9999-aaaaaaaaaaaa';

function valid() {
  return {
    fabricEntraClientId: CLIENT_ID,
    fabricEntraTenantId: TENANT_ID,
    reconciliationGatewayUrl: 'https://gateway.example.com',
  };
}

/** Stands in for the Rayfin data client with an in-memory AppSetting table. */
function stubClient(rows: Array<{ id: string; settingKey: string; settingValue: string }> = []) {
  const table = [...rows];
  const create = vi.fn(async (record: { settingKey: string; settingValue: string }) => {
    const row = { id: `row-${table.length + 1}`, settingKey: record.settingKey, settingValue: record.settingValue };
    table.push(row);
    return row;
  });
  const update = vi.fn(async (where: { id: string }, record: { settingValue: string }) => {
    const row = table.find((candidate) => candidate.id === where.id);
    if (row) row.settingValue = record.settingValue;
  });
  getRayfinClient.mockReturnValue({
    data: { AppSetting: { select: () => ({ execute: async () => table }), create, update } },
  });
  return { table, create, update };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  // The developer's own .env.local would otherwise leak in as a fallback.
  vi.stubEnv('VITE_RAYFIN_FABRIC_ENTRA_CLIENT_ID', '');
  vi.stubEnv('VITE_RAYFIN_FABRIC_ENTRA_TENANT_ID', '');
  vi.stubEnv('VITE_RAYFIN_RECONCILIATION_GATEWAY_URL', '');
  __setSettingsCacheForTests(emptySettingValues());
});

describe('validateSettings', () => {
  it('accepts well-formed values', () => {
    expect(validateSettings(valid())).toEqual({});
  });

  it('rejects an identifier that is not a GUID', () => {
    const errors = validateSettings({ ...valid(), fabricEntraClientId: 'not-a-guid' });
    expect(errors.fabricEntraClientId).toMatch(/GUID/);
    expect(errors.fabricEntraTenantId).toBeUndefined();
  });

  it('requires both Entra identifiers', () => {
    const errors = validateSettings({ ...emptySettingValues() });
    expect(errors.fabricEntraClientId).toMatch(/required/);
    expect(errors.fabricEntraTenantId).toMatch(/required/);
  });

  it('rejects a gateway value that is not an absolute http URL', () => {
    expect(validateSettings({ ...valid(), reconciliationGatewayUrl: 'gateway.example.com' }).reconciliationGatewayUrl)
      .toMatch(/absolute URL/);
    expect(validateSettings({ ...valid(), reconciliationGatewayUrl: 'ftp://gateway.example.com' }).reconciliationGatewayUrl)
      .toMatch(/http/);
  });

  it('treats an empty gateway URL as optional', () => {
    expect(validateSettings({ ...valid(), reconciliationGatewayUrl: '' }).reconciliationGatewayUrl).toBeUndefined();
  });
});

describe('loadAppSettings', () => {
  it('reads stored values from the data service', async () => {
    stubClient([
      { id: 'row-1', settingKey: 'fabricEntraClientId', settingValue: CLIENT_ID },
      { id: 'row-2', settingKey: 'fabricEntraTenantId', settingValue: TENANT_ID },
    ]);
    const state = await loadAppSettings();
    expect(state.source).toBe('service');
    expect(state.warning).toBeUndefined();
    expect(getSettingValue('fabricEntraClientId')).toBe(CLIENT_ID);
  });

  it('ignores rows whose key is not a known setting', async () => {
    stubClient([{ id: 'row-1', settingKey: 'somethingElse', settingValue: 'x' }]);
    const state = await loadAppSettings();
    expect(state.values.fabricEntraClientId).toBe('');
  });

  it('falls back to the browser copy when the shared table is unavailable', async () => {
    localStorage.setItem('reconciliation.appSettings', JSON.stringify({ fabricEntraClientId: CLIENT_ID }));
    getRayfinClient.mockImplementation(() => { throw new Error('Invalid object name AppSetting.'); });
    const state = await loadAppSettings();
    expect(state.source).toBe('browser');
    expect(state.warning).toMatch(/db apply/);
    expect(state.values.fabricEntraClientId).toBe(CLIENT_ID);
  });
});

describe('saveAppSettings', () => {
  it('creates missing rows and updates existing ones', async () => {
    const { table, create, update } = stubClient([
      { id: 'row-1', settingKey: 'fabricEntraClientId', settingValue: 'stale' },
    ]);
    const state = await saveAppSettings(valid(), 'user-1', 'Ada');
    expect(state.source).toBe('service');
    expect(update).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(2);
    expect(table.find((row) => row.settingKey === 'fabricEntraClientId')?.settingValue).toBe(CLIENT_ID);
  });

  it('trims input before storing it', async () => {
    const { table } = stubClient();
    await saveAppSettings({ ...valid(), fabricEntraClientId: `  ${CLIENT_ID}  ` }, 'user-1', 'Ada');
    expect(table.find((row) => row.settingKey === 'fabricEntraClientId')?.settingValue).toBe(CLIENT_ID);
  });

  it('refuses invalid values before touching the data service', async () => {
    const { create } = stubClient();
    await expect(saveAppSettings({ ...valid(), fabricEntraTenantId: 'nope' }, 'user-1', 'Ada')).rejects.toThrow(/GUID/);
    expect(create).not.toHaveBeenCalled();
  });

  it('keeps the values in this browser when the shared table is unavailable', async () => {
    getRayfinClient.mockImplementation(() => { throw new Error('Invalid object name AppSetting.'); });
    const state = await saveAppSettings(valid(), 'user-1', 'Ada');
    expect(state.source).toBe('browser');
    expect(getSettingValue('fabricEntraTenantId')).toBe(TENANT_ID);
    expect(JSON.parse(localStorage.getItem('reconciliation.appSettings') ?? '{}')).toMatchObject({
      fabricEntraTenantId: TENANT_ID,
    });
  });
});

describe('requireSettingValue', () => {
  it('points the operator at the Configuration tab when a value is missing', () => {
    expect(() => requireSettingValue('fabricEntraClientId')).toThrow(/Configuration tab/);
  });

  it('falls back to the build-time variable when nothing is stored', () => {
    vi.stubEnv('VITE_RAYFIN_FABRIC_ENTRA_CLIENT_ID', CLIENT_ID);
    expect(requireSettingValue('fabricEntraClientId')).toBe(CLIENT_ID);
  });

  it('prefers a stored value over the build-time variable', async () => {
    vi.stubEnv('VITE_RAYFIN_FABRIC_ENTRA_CLIENT_ID', TENANT_ID);
    stubClient([{ id: 'row-1', settingKey: 'fabricEntraClientId', settingValue: CLIENT_ID }]);
    await loadAppSettings();
    expect(requireSettingValue('fabricEntraClientId')).toBe(CLIENT_ID);
  });
});
