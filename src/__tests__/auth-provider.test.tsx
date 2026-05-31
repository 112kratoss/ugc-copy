import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AuthProvider, useAuth } from '@/app/components/AuthProvider';

const authProviderMocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  onAuthStateChange: vi.fn(),
  from: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: authProviderMocks.getSession,
      onAuthStateChange: authProviderMocks.onAuthStateChange,
    },
    from: authProviderMocks.from,
  },
}));

function AuthProbe() {
  const { isLoading, session, credits } = useAuth();

  return (
    <div>
      <span data-testid="loading">{String(isLoading)}</span>
      <span data-testid="session">{session ? 'signed-in' : 'signed-out'}</span>
      <span data-testid="credits">{credits ?? 'none'}</span>
    </div>
  );
}

describe('AuthProvider', () => {
  it('uses resolved server auth state without immediately touching Supabase', () => {
    authProviderMocks.onAuthStateChange.mockReturnValue({
      data: {
        subscription: {
          unsubscribe: vi.fn(),
        },
      },
    });

    render(
      <AuthProvider initialSession={null} initialCredits={null} hasResolvedInitialState>
        <AuthProbe />
      </AuthProvider>
    );

    expect(screen.getByTestId('loading')).toHaveTextContent('false');
    expect(screen.getByTestId('session')).toHaveTextContent('signed-out');
    expect(screen.getByTestId('credits')).toHaveTextContent('none');
    expect(authProviderMocks.getSession).not.toHaveBeenCalled();
    expect(authProviderMocks.onAuthStateChange).not.toHaveBeenCalled();
    expect(authProviderMocks.from).not.toHaveBeenCalled();
  });
});
