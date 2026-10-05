/**
 * Theme preference resolution.
 *
 * Kept free of React and of direct `window` access so the decision rules can be
 * unit tested, and so the same logic can run from the pre-paint inline script
 * in index.html.
 */

/** What the user asked for. `system` defers to the OS setting. */
export type ThemePreference = 'light' | 'dark' | 'system';
/** What actually gets painted. */
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'reconciliation.theme';

const PREFERENCES: ThemePreference[] = ['light', 'dark', 'system'];

/** Guards against stale or hand-edited localStorage values. */
export function normalizePreference(value: unknown): ThemePreference {
  return PREFERENCES.includes(value as ThemePreference) ? (value as ThemePreference) : 'system';
}

export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  if (preference === 'system') return systemPrefersDark ? 'dark' : 'light';
  return preference;
}

/**
 * The toggle always flips away from what is currently on screen, and commits an
 * explicit preference. Returning `system` here would make the button a no-op
 * whenever the OS already matches the chosen side.
 */
export function togglePreference(preference: ThemePreference, systemPrefersDark: boolean): ThemePreference {
  return resolveTheme(preference, systemPrefersDark) === 'dark' ? 'light' : 'dark';
}

/** Applies the resolved theme to a root element. Safe to call repeatedly. */
export function applyTheme(theme: ResolvedTheme, root: HTMLElement): void {
  root.classList.toggle('dark', theme === 'dark');
  root.style.colorScheme = theme;
}

export function readStoredPreference(storage: Pick<Storage, 'getItem'>): ThemePreference {
  try {
    return normalizePreference(storage.getItem(THEME_STORAGE_KEY));
  } catch {
    // Storage can throw in locked-down embeddings; fall back to the OS setting.
    return 'system';
  }
}

export function writeStoredPreference(storage: Pick<Storage, 'setItem'>, preference: ThemePreference): void {
  try {
    storage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Non-fatal: the choice simply will not survive a reload.
  }
}
