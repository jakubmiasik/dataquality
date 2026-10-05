import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getRayfinClient } = vi.hoisted(() => ({ getRayfinClient: vi.fn() }));
vi.mock('@/services/rayfinClient', () => ({ getRayfinClient }));

import { DismissibleBanner, RedirectUriHint } from '@/pages/ReconciliationPage';

beforeEach(() => vi.clearAllMocks());

describe('DismissibleBanner', () => {
  it('calls onDismiss when the close control is used', async () => {
    const onDismiss = vi.fn();
    render(<DismissibleBanner tone="success" onDismiss={onDismiss}>Configuration saved for the workspace.</DismissibleBanner>);

    await userEvent.click(screen.getByRole('button', { name: /dismiss/i }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('exposes a close control on error banners too', async () => {
    const onDismiss = vi.fn();
    render(<DismissibleBanner tone="error" onDismiss={onDismiss}>Something failed.</DismissibleBanner>);

    expect(screen.getByRole('alert')).toHaveTextContent('Something failed.');
    await userEvent.click(screen.getByRole('button', { name: /dismiss/i }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('announces success as a status and errors as an alert', () => {
    const { unmount } = render(<DismissibleBanner tone="success" onDismiss={vi.fn()}>Saved.</DismissibleBanner>);
    expect(screen.getByRole('status')).toHaveTextContent('Saved.');
    unmount();

    render(<DismissibleBanner tone="error" onDismiss={vi.fn()}>Broke.</DismissibleBanner>);
    expect(screen.getByRole('alert')).toHaveTextContent('Broke.');
  });
});

describe('RedirectUriHint', () => {
  it('shows the redirect URI for the current origin', () => {
    render(<RedirectUriHint />);

    expect(screen.getByText(`${window.location.origin}/auth-redirect.html`)).toBeInTheDocument();
    expect(screen.getByText(/AADSTS50011/)).toBeInTheDocument();
  });

  it('copies the redirect URI and confirms it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<RedirectUriHint />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy' }));

    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/auth-redirect.html`);
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('stays usable when clipboard access is blocked', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.assign(navigator, { clipboard: { writeText } });

    render(<RedirectUriHint />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy' }));

    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
  });
});
