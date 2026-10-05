import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PromptDialog } from '@/pages/ReconciliationPage';

describe('PromptDialog', () => {
  it('resolves with the typed value so bulk actions work without window.prompt', () => {
    const onResolve = vi.fn();
    render(<PromptDialog request={{ kind: 'prompt', title: 'Mark 2 exceptions as resolved', label: 'Reason', requireValue: true, confirmLabel: 'Mark resolved', resolve: () => undefined }} onResolve={onResolve} />);

    const confirm = screen.getByRole('button', { name: 'Mark resolved' });
    expect(confirm).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Fixed upstream' } });
    expect(confirm).not.toBeDisabled();
    fireEvent.click(confirm);

    expect(onResolve).toHaveBeenCalledWith('Fixed upstream');
  });

  it('resolves with null when dismissed so the caller can abort', () => {
    const onResolve = vi.fn();
    render(<PromptDialog request={{ kind: 'confirm', title: 'Delete run', message: 'Really?', resolve: () => undefined }} onResolve={onResolve} />);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onResolve).toHaveBeenCalledWith(null);
  });

  it('confirms without a value when there is nothing to type', () => {
    const onResolve = vi.fn();
    render(<PromptDialog request={{ kind: 'confirm', title: 'Purge orphans', confirmLabel: 'Purge', resolve: () => undefined }} onResolve={onResolve} />);

    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Purge' }));
    expect(onResolve).toHaveBeenCalledWith('');
  });

  it('allows an empty value when none is required, so an owner can be cleared', () => {
    const onResolve = vi.fn();
    render(<PromptDialog request={{ kind: 'prompt', title: 'Assign owner', label: 'Owner', defaultValue: '', confirmLabel: 'Assign', resolve: () => undefined }} onResolve={onResolve} />);

    fireEvent.click(screen.getByRole('button', { name: 'Assign' }));
    expect(onResolve).toHaveBeenCalledWith('');
  });

  it('cancels on Escape', () => {
    const onResolve = vi.fn();
    render(<PromptDialog request={{ kind: 'confirm', title: 'Retire rule', resolve: () => undefined }} onResolve={onResolve} />);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onResolve).toHaveBeenCalledWith(null);
  });
});
