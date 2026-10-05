import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getRayfinClient } = vi.hoisted(() => ({ getRayfinClient: vi.fn() }));
vi.mock('@/services/rayfinClient', () => ({ getRayfinClient }));

import { SettingsPanel } from '@/pages/ReconciliationPage';
import { emptySettingValues, type AppSettingsState, type SettingValues } from '@/services/appSettings';

const CLIENT_ID = '11111111-2222-3333-4444-555555555555';

function state(values: Partial<SettingValues> = {}, warning?: string): AppSettingsState {
  return { values: { ...emptySettingValues(), ...values }, source: warning ? 'browser' : 'service', warning };
}

function setup(overrides: Partial<Parameters<typeof SettingsPanel>[0]> = {}) {
  const onChange = vi.fn();
  const onSave = vi.fn();
  const onReset = vi.fn();
  const props = {
    state: state(),
    values: emptySettingValues(),
    errors: {},
    busy: false,
    onChange,
    onSave,
    onReset,
    ...overrides,
  };
  render(<SettingsPanel {...props} />);
  return { onChange, onSave, onReset };
}

beforeEach(() => vi.clearAllMocks());

describe('SettingsPanel', () => {
  it('shows a placeholder until the settings have loaded', () => {
    setup({ state: null });
    expect(screen.getByText(/Loading configuration/)).toBeInTheDocument();
  });

  it('renders an input for every setting, seeded with the current value', () => {
    setup({ values: { ...emptySettingValues(), fabricEntraClientId: CLIENT_ID } });
    expect(screen.getByLabelText(/client\) ID/)).toHaveValue(CLIENT_ID);
    expect(screen.getByLabelText(/tenant\) ID/)).toHaveValue('');
    expect(screen.getByLabelText(/gateway URL/)).toHaveValue('');
  });

  it('reports edits through onChange', async () => {
    const { onChange } = setup();
    await userEvent.type(screen.getByLabelText(/client\) ID/), 'ab');
    expect(onChange).toHaveBeenCalledWith('fabricEntraClientId', 'a');
    expect(onChange).toHaveBeenCalledWith('fabricEntraClientId', 'b');
  });

  it('submits the form through onSave', async () => {
    const { onSave } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Save configuration' }));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('shows a validation message in place of the field description', () => {
    setup({ errors: { fabricEntraClientId: 'The client ID must be a GUID.' } });
    const field = screen.getByLabelText(/client\) ID/);
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('The client ID must be a GUID.')).toBeInTheDocument();
  });

  it('enables discard only while the form differs from what was loaded', async () => {
    const { onReset } = setup({
      state: state({ fabricEntraClientId: CLIENT_ID }),
      values: { ...emptySettingValues(), fabricEntraClientId: CLIENT_ID },
    });
    expect(screen.getByRole('button', { name: 'Discard changes' })).toBeDisabled();
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
    expect(onReset).not.toHaveBeenCalled();
  });

  it('flags unsaved edits and allows discarding them', async () => {
    const { onReset } = setup({
      state: state({ fabricEntraClientId: CLIENT_ID }),
      values: { ...emptySettingValues(), fabricEntraClientId: 'edited' },
    });
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('disables both actions while a save is in flight', () => {
    setup({ busy: true, values: { ...emptySettingValues(), fabricEntraClientId: 'edited' } });
    expect(screen.getByRole('button', { name: 'Saving...' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Discard changes' })).toBeDisabled();
  });

  it('surfaces the browser-only warning when the shared table is unavailable', () => {
    setup({ state: state({}, 'The shared settings table is not available.') });
    expect(screen.getByText('The shared settings table is not available.')).toBeInTheDocument();
  });

  it('names the build-time variable each setting falls back to', () => {
    setup();
    expect(screen.getByText('RAYFIN_PUBLIC_FABRIC_ENTRA_CLIENT_ID')).toBeInTheDocument();
    expect(screen.getByText('RAYFIN_PUBLIC_RECONCILIATION_GATEWAY_URL')).toBeInTheDocument();
  });
});
