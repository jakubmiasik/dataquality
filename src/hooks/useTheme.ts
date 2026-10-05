import { useCallback, useEffect, useState } from 'react';

import {
  applyTheme,
  readStoredPreference,
  resolveTheme,
  togglePreference,
  writeStoredPreference,
  type ResolvedTheme,
  type ThemePreference,
} from '@/services/theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(DARK_QUERY).matches;
}

/**
 * Reads the stored theme preference, keeps the `dark` class on <html> in sync,
 * and follows the OS setting for as long as the user has not picked a side.
 */
export function useTheme(): { theme: ResolvedTheme; preference: ThemePreference; toggle: () => void } {
  const [preference, setPreference] = useState<ThemePreference>(() =>
    typeof window === 'undefined' ? 'system' : readStoredPreference(window.localStorage)
  );
  const [systemDark, setSystemDark] = useState<boolean>(systemPrefersDark);

  // While the preference is `system`, the OS can change under us.
  useEffect(() => {
    const query = window.matchMedia(DARK_QUERY);
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const theme = resolveTheme(preference, systemDark);

  useEffect(() => {
    applyTheme(theme, document.documentElement);
  }, [theme]);

  const toggle = useCallback(() => {
    setPreference((current) => {
      const next = togglePreference(current, systemPrefersDark());
      writeStoredPreference(window.localStorage, next);
      return next;
    });
  }, []);

  return { theme, preference, toggle };
}
