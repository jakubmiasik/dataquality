import { describe, expect, it } from 'vitest';

import {
  applyTheme,
  normalizePreference,
  readStoredPreference,
  resolveTheme,
  togglePreference,
  writeStoredPreference,
  THEME_STORAGE_KEY,
} from '@/services/theme';

describe('theme preferences', () => {
  it('falls back to system for unknown stored values', () => {
    expect(normalizePreference('midnight')).toBe('system');
    expect(normalizePreference(null)).toBe('system');
    expect(normalizePreference('dark')).toBe('dark');
  });

  it('follows the OS only while the preference is system', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('toggles away from what is on screen and commits an explicit side', () => {
    // The trap: with preference 'system' on a dark OS, returning 'system'
    // again would leave the UI unchanged and make the button look broken.
    expect(togglePreference('system', true)).toBe('light');
    expect(togglePreference('system', false)).toBe('dark');
    expect(togglePreference('dark', false)).toBe('light');
    expect(togglePreference('light', false)).toBe('dark');
  });

  it('survives storage that throws', () => {
    const hostile = {
      getItem() { throw new Error('blocked'); },
      setItem() { throw new Error('blocked'); },
    };
    expect(readStoredPreference(hostile)).toBe('system');
    expect(() => writeStoredPreference(hostile, 'dark')).not.toThrow();
  });

  it('round-trips through storage', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
    writeStoredPreference(storage, 'dark');
    expect(store.get(THEME_STORAGE_KEY)).toBe('dark');
    expect(readStoredPreference(storage)).toBe('dark');
  });

  it('applies and removes the dark class idempotently', () => {
    const root = document.createElement('html');
    applyTheme('dark', root);
    applyTheme('dark', root);
    expect(root.classList.contains('dark')).toBe(true);
    expect(root.style.colorScheme).toBe('dark');

    applyTheme('light', root);
    expect(root.classList.contains('dark')).toBe(false);
    expect(root.style.colorScheme).toBe('light');
  });
});
