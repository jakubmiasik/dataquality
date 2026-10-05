import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { AuthProvider } from '@/hooks/AuthContext';
import { useAuth } from '@/hooks/AuthContext';
import type { IAuthService } from '@/services/IAuthService';

const stubAuthService: IAuthService = {
  fabricAuthEnabled: false,
  async signIn() {
    return { id: 'u1', email: 'dev@contoso.com', name: 'dev' };
  },
  async signOut() {},
  async getCurrentUser() {
    return null;
  },
  async initEmbeddedAuth() {
    return null;
  },
};

describe('AuthProvider', () => {
  it('renders children once initial auth check completes', async () => {
    render(
      <AuthProvider authService={stubAuthService}>
        <div data-testid="content">ready</div>
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('content')).toHaveTextContent('ready');
    });
  });

  it('keeps the login route mounted while Fabric authentication is pending', async () => {
    let finishSignIn!: (user: { id: string; email: string; name: string }) => void;
    const pendingAuthService: IAuthService = {
      ...stubAuthService,
      signIn: () => new Promise((resolve) => { finishSignIn = resolve; }),
    };

    function SignInHarness() {
      const { loading, signIn } = useAuth();
      return <button type="button" onClick={() => void signIn()}>Loading: {String(loading)}</button>;
    }

    render(<AuthProvider authService={pendingAuthService}><SignInHarness /></AuthProvider>);
    const button = await screen.findByRole('button', { name: 'Loading: false' });
    await userEvent.click(button);
    expect(button).toBeInTheDocument();

    finishSignIn({ id: 'u2', email: 'ada@contoso.com', name: 'Ada' });
    await waitFor(() => expect(button).toBeInTheDocument());
  });
});
