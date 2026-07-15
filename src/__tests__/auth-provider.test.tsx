import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Session } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider, useAuth } from '@/app/components/AuthProvider';

const authProviderMocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getUser: vi.fn(),
  onAuthStateChange: vi.fn(),
  from: vi.fn(),
  select: vi.fn(),
  eq: vi.fn(),
  single: vi.fn(),
  unsubscribe: vi.fn(),
}));

const authCookieState = vi.hoisted(() => ({
  hasHint: false,
  hasHydrated: true,
}));

const authenticatedSession = {
  access_token: 'verified-access-token',
  refresh_token: 'refresh-token',
  expires_in: 3600,
  token_type: 'bearer',
  user: {
    id: 'user-1',
    email: 'creator@example.com',
    app_metadata: {},
    user_metadata: {},
    aud: 'authenticated',
    created_at: '2026-01-01T00:00:00.000Z',
  },
} as Session;

let authStateCallback: ((event: string, session: Session | null) => void) | null = null;

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: authProviderMocks.getSession,
      getUser: authProviderMocks.getUser,
      onAuthStateChange: authProviderMocks.onAuthStateChange,
    },
    from: authProviderMocks.from,
  },
}));

vi.mock('@/app/components/useSupabaseAuthCookieHint', () => ({
  useSupabaseAuthCookieHint: () => authCookieState.hasHint,
  useHasHydratedSupabaseAuthCookieHint: () => authCookieState.hasHydrated,
}));

function AuthProbe() {
  const { isLoading, session, credits, refreshSessionState } = useAuth();

  return (
    <div>
      <span data-testid="loading">{String(isLoading)}</span>
      <span data-testid="session">{session ? 'signed-in' : 'signed-out'}</span>
      <span data-testid="credits">{credits ?? 'none'}</span>
      <span data-testid="user-name">{session?.user.user_metadata.display_name ?? 'none'}</span>
      <button type="button" onClick={() => void refreshSessionState()}>Refresh auth</button>
    </div>
  );
}

describe('AuthProvider', () => {
  beforeEach(() => {
    authCookieState.hasHint = false;
    authCookieState.hasHydrated = true;
    authStateCallback = null;
    authProviderMocks.getSession.mockReset();
    authProviderMocks.getUser.mockReset();
    authProviderMocks.onAuthStateChange.mockReset();
    authProviderMocks.from.mockReset();
    authProviderMocks.select.mockReset();
    authProviderMocks.eq.mockReset();
    authProviderMocks.single.mockReset();
    authProviderMocks.unsubscribe.mockReset();

    authProviderMocks.getSession.mockResolvedValue({ data: { session: authenticatedSession } });
    authProviderMocks.getUser.mockResolvedValue({
      data: { user: authenticatedSession.user },
      error: null,
    });
    authProviderMocks.onAuthStateChange.mockImplementation((callback) => {
      authStateCallback = callback;
      queueMicrotask(() => {
        callback('SIGNED_IN', authenticatedSession);
        callback('INITIAL_SESSION', authenticatedSession);
      });
      return {
        data: { subscription: { unsubscribe: authProviderMocks.unsubscribe } },
      };
    });
    authProviderMocks.from.mockReturnValue({ select: authProviderMocks.select });
    authProviderMocks.select.mockReturnValue({ eq: authProviderMocks.eq });
    authProviderMocks.eq.mockReturnValue({ single: authProviderMocks.single });
    authProviderMocks.single.mockResolvedValue({ data: { credits: 1295 } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves a cookie-free visitor without loading the Supabase SDK', () => {
    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>
    );

    expect(screen.getByTestId('loading')).toHaveTextContent('false');
    expect(screen.getByTestId('session')).toHaveTextContent('signed-out');
    expect(authProviderMocks.getSession).not.toHaveBeenCalled();
    expect(authProviderMocks.onAuthStateChange).not.toHaveBeenCalled();
  });

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

  it('preserves verified server auth and deduplicates the matching initial browser events', async () => {
    vi.stubGlobal('requestIdleCallback', (callback: IdleRequestCallback) => {
      queueMicrotask(() => callback({ didTimeout: false, timeRemaining: () => 50 }));
      return 1;
    });
    vi.stubGlobal('cancelIdleCallback', vi.fn());

    render(
      <AuthProvider
        initialSession={authenticatedSession}
        initialCredits={1295}
        hasResolvedInitialState
      >
        <AuthProbe />
      </AuthProvider>
    );

    expect(screen.getByTestId('session')).toHaveTextContent('signed-in');
    expect(screen.getByTestId('credits')).toHaveTextContent('1295');
    await waitFor(() => expect(authProviderMocks.onAuthStateChange).toHaveBeenCalledTimes(1));
    expect(authProviderMocks.getUser).not.toHaveBeenCalled();
    expect(authProviderMocks.from).not.toHaveBeenCalled();
  });

  it('clears verified server auth when the browser SDK authoritatively reports sign-out', async () => {
    vi.stubGlobal('requestIdleCallback', (callback: IdleRequestCallback) => {
      queueMicrotask(() => callback({ didTimeout: false, timeRemaining: () => 50 }));
      return 1;
    });
    vi.stubGlobal('cancelIdleCallback', vi.fn());
    authProviderMocks.onAuthStateChange.mockImplementation((callback) => {
      queueMicrotask(() => callback('INITIAL_SESSION', null));
      return {
        data: { subscription: { unsubscribe: authProviderMocks.unsubscribe } },
      };
    });

    render(
      <AuthProvider
        initialSession={authenticatedSession}
        initialCredits={1295}
        hasResolvedInitialState
      >
        <AuthProbe />
      </AuthProvider>
    );

    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('signed-out'));
    expect(screen.getByTestId('credits')).toHaveTextContent('none');
    expect(authProviderMocks.getUser).not.toHaveBeenCalled();
  });

  it('verifies a cookie-hinted session once before exposing it to consumers', async () => {
    authCookieState.hasHint = true;

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>
    );

    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('signed-in'));
    expect(screen.getByTestId('credits')).toHaveTextContent('1295');
    expect(authProviderMocks.getUser).toHaveBeenCalledWith('verified-access-token');
    expect(authProviderMocks.getSession).not.toHaveBeenCalled();
    expect(authProviderMocks.single).toHaveBeenCalledTimes(1);
  });

  it('clears authenticated state when the auth cookie disappears', async () => {
    authCookieState.hasHint = true;
    const view = render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>
    );
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('signed-in'));

    authCookieState.hasHint = false;
    view.rerender(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>
    );

    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('signed-out'));
    expect(screen.getByTestId('credits')).toHaveTextContent('none');
    expect(authProviderMocks.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('rejects an unverified browser session without loading profile data', async () => {
    authCookieState.hasHint = true;
    authProviderMocks.getUser.mockResolvedValue({
      data: { user: null },
      error: { message: 'Invalid token' },
    });

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>
    );

    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    expect(screen.getByTestId('session')).toHaveTextContent('signed-out');
    expect(authProviderMocks.from).not.toHaveBeenCalled();
  });

  it('keeps a token pending until verification finishes so repeated events do not duplicate work', async () => {
    authCookieState.hasHint = true;
    let resolveVerification!: (value: { data: { user: Session['user'] }; error: null }) => void;
    authProviderMocks.getUser.mockImplementation(() => new Promise((resolve) => {
      resolveVerification = resolve;
    }));
    authProviderMocks.onAuthStateChange.mockImplementation((callback) => {
      authStateCallback = callback;
      queueMicrotask(() => callback('SIGNED_IN', authenticatedSession));
      return {
        data: { subscription: { unsubscribe: authProviderMocks.unsubscribe } },
      };
    });

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>
    );
    await waitFor(() => expect(authProviderMocks.getUser).toHaveBeenCalledTimes(1));

    act(() => authStateCallback?.('INITIAL_SESSION', authenticatedSession));
    await act(async () => Promise.resolve());
    expect(authProviderMocks.getUser).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveVerification({ data: { user: authenticatedSession.user }, error: null });
    });
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('signed-in'));
    expect(authProviderMocks.single).toHaveBeenCalledTimes(1);
  });

  it('refreshes verified user metadata for a same-token USER_UPDATED event', async () => {
    authCookieState.hasHint = true;
    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>
    );
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('signed-in'));

    const updatedUser = {
      ...authenticatedSession.user,
      user_metadata: { display_name: 'Updated Creator' },
    };
    authProviderMocks.getUser.mockResolvedValueOnce({ data: { user: updatedUser }, error: null });
    act(() => authStateCallback?.('USER_UPDATED', {
      ...authenticatedSession,
      user: updatedUser,
    }));

    await waitFor(() => expect(screen.getByTestId('user-name')).toHaveTextContent('Updated Creator'));
    expect(authProviderMocks.getUser).toHaveBeenCalledTimes(2);
  });

  it('does not let a late manual refresh restore auth after SIGNED_OUT', async () => {
    authCookieState.hasHint = true;
    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>
    );
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('signed-in'));

    let resolveRefreshVerification!: (value: { data: { user: Session['user'] }; error: null }) => void;
    authProviderMocks.getUser.mockImplementationOnce(() => new Promise((resolve) => {
      resolveRefreshVerification = resolve;
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh auth' }));
    await waitFor(() => expect(authProviderMocks.getSession).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(authProviderMocks.getUser).toHaveBeenCalledTimes(2));

    act(() => authStateCallback?.('SIGNED_OUT', null));
    expect(screen.getByTestId('session')).toHaveTextContent('signed-out');

    await act(async () => {
      resolveRefreshVerification({ data: { user: authenticatedSession.user }, error: null });
    });
    expect(screen.getByTestId('session')).toHaveTextContent('signed-out');
    expect(screen.getByTestId('credits')).toHaveTextContent('none');
  });

  it('finishes the pending credits load when the token refreshes', async () => {
    authCookieState.hasHint = true;
    let resolveCredits!: (value: { data: { credits: number } }) => void;
    authProviderMocks.single.mockImplementationOnce(() => new Promise((resolve) => {
      resolveCredits = resolve;
    }));

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>
    );
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('signed-in'));
    expect(screen.getByTestId('loading')).toHaveTextContent('true');

    act(() => authStateCallback?.('TOKEN_REFRESHED', {
      ...authenticatedSession,
      access_token: 'refreshed-access-token',
    }));
    await act(async () => {
      resolveCredits({ data: { credits: 777 } });
    });

    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    expect(screen.getByTestId('credits')).toHaveTextContent('777');
  });

  it('queues a same-token USER_UPDATED event that arrives during verification', async () => {
    authCookieState.hasHint = true;
    const updatedUser = {
      ...authenticatedSession.user,
      user_metadata: { display_name: 'Queued Update' },
    };
    let resolveInitialVerification!: (value: {
      data: { user: Session['user'] };
      error: null;
    }) => void;
    authProviderMocks.getUser.mockReset();
    authProviderMocks.getUser
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveInitialVerification = resolve;
      }))
      .mockResolvedValueOnce({ data: { user: updatedUser }, error: null });
    authProviderMocks.onAuthStateChange.mockImplementation((callback) => {
      authStateCallback = callback;
      queueMicrotask(() => callback('SIGNED_IN', authenticatedSession));
      return {
        data: { subscription: { unsubscribe: authProviderMocks.unsubscribe } },
      };
    });

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>
    );
    await waitFor(() => expect(authProviderMocks.getUser).toHaveBeenCalledTimes(1));

    act(() => authStateCallback?.('USER_UPDATED', {
      ...authenticatedSession,
      user: updatedUser,
    }));
    await act(async () => {
      resolveInitialVerification({ data: { user: authenticatedSession.user }, error: null });
    });

    await waitFor(() => expect(screen.getByTestId('user-name')).toHaveTextContent('Queued Update'));
    expect(authProviderMocks.getUser).toHaveBeenCalledTimes(2);
  });
});
