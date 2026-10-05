import { describe, expect, it } from 'vitest';

import { describeBusy } from '@/services/busyMessages';

describe('describeBusy', () => {
  it('says nothing while the page is idle', () => {
    expect(describeBusy('')).toBeNull();
  });

  it('describes the well-known one-off actions', () => {
    expect(describeBusy('run-selected')).toBe('Running selected rules...');
    expect(describeBusy('save-rule')).toBe('Saving rule...');
    expect(describeBusy('settings')).toBe('Saving configuration...');
  });

  it('describes the keys that carry a record id', () => {
    expect(describeBusy('run:rule-1')).toBe('Running rule...');
    expect(describeBusy('exception:exc-9')).toBe('Updating exception...');
    expect(describeBusy('delete-run:run-3')).toBe('Deleting run...');
  });

  it('still reports activity for an unrecognised key', () => {
    expect(describeBusy('something-new')).toBe('Working...');
  });
});
