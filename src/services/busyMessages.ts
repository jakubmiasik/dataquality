/**
 * Every long action already sets a `busyKey`; mapping it to prose lets one toast
 * tell the user that work is in flight instead of leaving the page silent.
 */
export function describeBusy(busyKey: string): string | null {
  if (!busyKey) return null;
  const exact: Record<string, string> = {
    'bulk-exceptions': 'Updating selected exceptions...',
    compare: 'Comparing runs...',
    orphans: 'Checking for orphaned rows...',
    'purge-orphans': 'Purging orphaned rows...',
    'run-selected': 'Running selected rules...',
    'save-rule': 'Saving rule...',
    'save-schedule': 'Saving schedule...',
    settings: 'Saving configuration...',
  };
  if (exact[busyKey]) return exact[busyKey];
  const prefixes: [string, string][] = [
    ['catalog:', 'Loading tables...'],
    ['versions:', 'Loading rule versions...'],
    ['rule:', 'Opening rule...'],
    ['run:', 'Running rule...'],
    ['bulk-rules:', 'Updating rules...'],
    ['retire:', 'Retiring rule...'],
    ['schedule:', 'Updating schedule...'],
    ['delete-run:', 'Deleting run...'],
    ['exception:', 'Updating exception...'],
  ];
  const match = prefixes.find(([prefix]) => busyKey.startsWith(prefix));
  return match ? match[1] : 'Working...';
}
