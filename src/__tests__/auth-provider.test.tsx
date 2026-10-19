import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Session } from '@supabase/supabase-js';
import { Activity } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider, useAuth } from '@/components/AuthProvider';

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

/** What auth-js returns when Supabase Auth cannot be reached. */
const unreachable = Object.assign(new Error('Failed to fetch'), { name: 'AuthRetryableFetchError', status: 0 });
const refused = { name: 'AuthApiError', message: 'invalid JWT: unable to parse or verify signature', status: 403, code: 'bad_jwt' };

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

vi.mock('@/components/useSupabaseAuthCookieHint', () => ({
  useSupabaseAuthCookieHint: () => authCookieState.hasHint,
  useHasHydratedSupabaseAuthCookieHint: () => authCookieState.hasHydrated,
}));

function AuthProbe() {
  const { isLoading, session, credits, marketplaceSpendableCredits, refreshSessionState } = useAuth();

  return (
    <div>
      <span data-testid="loading">{String(isLoading)}</span>
      <span data-testid="session">{session ? 'signed-in' : 'signed-out'}</span>
      <span data-testid="credits">{credits ?? 'none'}</span>
      <span data-testid="spendable">{marketplaceSpendableCredits ?? 'none'}</span>
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
    vi.useRealTimers();
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
    expect(screen.getByTestId('spendable')).toHaveTextContent('none');
    expect(authProviderMocks.unsubscribe).toHaveBeenCalledTimes(1);
  });

  // Welcome and referral credits are in the total but the credit unlock will
  // not spend them (02-1), so the recipe surfaces read this figure instead.
  describe('the part of the balance a recipe can spend', () => {
    function CreditProbe() {
      const { credits, marketplaceSpendableCredits, updateCredits } = useAuth();
      return (
        <div>
          <span data-testid="credits">{credits ?? 'none'}</span>
          <span data-testid="spendable">{marketplaceSpendableCredits ?? 'none'}</span>
          <button type="button" onClick={() => updateCredits(1400)}>Spend 100</button>
          <button type="button" onClick={() => updateCredits(1700)}>Grant 300</button>
          <button type="button" onClick={() => updateCredits(800, { marketplaceSpendableCredits: 500 })}>
            Unlock a recipe
          </button>
        </div>
      );
    }

    it('reads the promotional credits with the balance and leaves them out', async () => {
      authCookieState.hasHint = true;
      authProviderMocks.single.mockResolvedValue({ data: { credits: 1200, promotional_credits: 1200 } });

      render(
        <AuthProvider>
          <AuthProbe />
        </AuthProvider>
      );

      await waitFor(() => expect(screen.getByTestId('credits')).toHaveTextContent('1200'));
      expect(screen.getByTestId('spendable')).toHaveTextContent('0');
      expect(authProviderMocks.select).toHaveBeenCalledWith('credits, promotional_credits');

      authProviderMocks.single.mockResolvedValue({ data: { credits: 1500, promotional_credits: 300 } });
      fireEvent.click(screen.getByRole('button', { name: 'Refresh auth' }));
      await waitFor(() => expect(screen.getByTestId('credits')).toHaveTextContent('1500'));
      expect(screen.getByTestId('spendable')).toHaveTextContent('1200');
      expect(authProviderMocks.select).toHaveBeenLastCalledWith('credits, promotional_credits');
    });

    it('keeps it in step with the total, and takes the figure an answer carries', async () => {
      authCookieState.hasHint = true;
      authProviderMocks.single.mockResolvedValue({ data: { credits: 1500, promotional_credits: 300 } });
      render(
        <AuthProvider>
          <CreditProbe />
        </AuthProvider>
      );
      await waitFor(() => expect(screen.getByTestId('spendable')).toHaveTextContent('1200'));

      // A generation's spend: the database took it from the promotional
      // credits first, so the spendable part stands.
      fireEvent.click(screen.getByRole('button', { name: 'Spend 100' }));
      expect(screen.getByTestId('credits')).toHaveTextContent('1400');
      expect(screen.getByTestId('spendable')).toHaveTextContent('1200');

      // A rise the server did not split (the welcome grant) is not spendable.
      fireEvent.click(screen.getByRole('button', { name: 'Grant 300' }));
      expect(screen.getByTestId('credits')).toHaveTextContent('1700');
      expect(screen.getByTestId('spendable')).toHaveTextContent('1200');

      fireEvent.click(screen.getByRole('button', { name: 'Unlock a recipe' }));
      expect(screen.getByTestId('credits')).toHaveTextContent('800');
      expect(screen.getByTestId('spendable')).toHaveTextContent('500');

      // Another reader of the balance broadcasts the same way.
      act(() => {
        window.dispatchEvent(new CustomEvent('credits_updated', {
          detail: { credits: 700, marketplaceSpendableCredits: 400 },
        }));
      });
      expect(screen.getByTestId('spendable')).toHaveTextContent('400');
      act(() => {
        window.dispatchEvent(new CustomEvent('credits_updated', { detail: { credits: 650 } }));
      });
      expect(screen.getByTestId('credits')).toHaveTextContent('650');
      expect(screen.getByTestId('spendable')).toHaveTextContent('400');
      // A spend that takes the total below the spendable part lowers it.
      act(() => {
        window.dispatchEvent(new CustomEvent('credits_updated', { detail: { credits: 300 } }));
      });
      expect(screen.getByTestId('spendable')).toHaveTextContent('300');
      expect(authProviderMocks.single).toHaveBeenCalledTimes(1);
    });

    it('starts from the figure the server resolved, without reading the profile again', () => {
      render(
        <AuthProvider
          initialSession={authenticatedSession}
          initialCredits={1200}
          initialMarketplaceSpendableCredits={0}
          hasResolvedInitialState
        >
          <AuthProbe />
        </AuthProvider>
      );

      expect(screen.getByTestId('credits')).toHaveTextContent('1200');
      expect(screen.getByTestId('spendable')).toHaveTextContent('0');
      expect(authProviderMocks.from).not.toHaveBeenCalled();
    });
  });

  // Whether the account was told, on record, that creators can see who saved:
  // read with the page, so it holds only for the account the page was drawn
  // for. Another account signed in since is unknown, never the first one's.
  describe('the saver notice record the page was drawn with', () => {
    function SaverNoticeProbe() {
      const { saverNoticeSeen, session } = useAuth();
      return (
        <div>
          <span data-testid="account">{session?.user.id ?? 'none'}</span>
          <span data-testid="saver-notice-seen">{String(saverNoticeSeen)}</span>
        </div>
      );
    }

    const otherSession = {
      ...authenticatedSession,
      access_token: 'other-access-token',
      user: { ...authenticatedSession.user, id: 'user-2', email: 'other@example.com' },
    } as Session;

    beforeEach(() => {
      vi.stubGlobal('requestIdleCallback', (callback: IdleRequestCallback) => {
        queueMicrotask(() => callback({ didTimeout: false, timeRemaining: () => 50 }));
        return 1;
      });
      vi.stubGlobal('cancelIdleCallback', vi.fn());
      authProviderMocks.getUser.mockImplementation(async (accessToken: string) => ({
        data: { user: accessToken === otherSession.access_token ? otherSession.user : authenticatedSession.user },
        error: null,
      }));
    });

    it.each([true, false])('hands the initial account its record (%s), and no other account', async (seen) => {
      render(
        <AuthProvider
          initialSession={authenticatedSession}
          initialCredits={1295}
          initialSaverNoticeSeen={seen}
          hasResolvedInitialState
        >
          <SaverNoticeProbe />
        </AuthProvider>
      );

      expect(screen.getByTestId('account')).toHaveTextContent('user-1');
      expect(screen.getByTestId('saver-notice-seen')).toHaveTextContent(String(seen));
      await waitFor(() => expect(authStateCallback).not.toBeNull());

      // Another account signs in on this page, without a reload.
      act(() => authStateCallback?.('SIGNED_IN', otherSession));
      await waitFor(() => expect(screen.getByTestId('account')).toHaveTextContent('user-2'));
      expect(screen.getByTestId('saver-notice-seen')).toHaveTextContent('null');

      act(() => authStateCallback?.('SIGNED_OUT', null));
      await waitFor(() => expect(screen.getByTestId('account')).toHaveTextContent('none'));
      expect(screen.getByTestId('saver-notice-seen')).toHaveTextContent('null');
    });

    it('knows nothing of it when the page could not read the record', () => {
      render(
        <AuthProvider initialSession={authenticatedSession} hasResolvedInitialState>
          <SaverNoticeProbe />
        </AuthProvider>
      );

      expect(screen.getByTestId('account')).toHaveTextContent('user-1');
      expect(screen.getByTestId('saver-notice-seen')).toHaveTextContent('null');
    });

    it('knows nothing of it for a visitor', () => {
      render(
        <AuthProvider initialSession={null} initialSaverNoticeSeen={false} hasResolvedInitialState>
          <SaverNoticeProbe />
        </AuthProvider>
      );

      expect(screen.getByTestId('saver-notice-seen')).toHaveTextContent('null');
    });
  });

  it('rejects an unverified browser session without loading profile data', async () => {
    authCookieState.hasHint = true;
    authProviderMocks.getUser.mockResolvedValue({
      data: { user: null },
      error: refused,
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

  // Audit 01-10: an Auth outage is not a sign-out. The app never concludes
  // anything from a check Supabase could not answer, and nor does the web now.
  describe('when Supabase Auth cannot answer the session check', () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
      authCookieState.hasHint = true;
    });

    it('keeps the session and checks it once more two seconds later', async () => {
      authProviderMocks.getUser
        .mockResolvedValueOnce({ data: { user: null }, error: unreachable })
        .mockResolvedValueOnce({ data: { user: authenticatedSession.user }, error: null });

      render(
        <AuthProvider>
          <AuthProbe />
        </AuthProvider>
      );

      await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('signed-in'));
      expect(authProviderMocks.getUser).toHaveBeenCalledTimes(1);
      expect(authProviderMocks.from).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });

      await waitFor(() => expect(screen.getByTestId('credits')).toHaveTextContent('1295'));
      expect(screen.getByTestId('loading')).toHaveTextContent('false');
      expect(authProviderMocks.getUser).toHaveBeenCalledTimes(2);
    });

    it('clears the session when the second check is refused', async () => {
      authProviderMocks.getUser
        .mockResolvedValueOnce({ data: { user: null }, error: { name: 'AuthRetryableFetchError', message: 'Service Unavailable', status: 503 } })
        .mockResolvedValueOnce({ data: { user: null }, error: refused });

      render(
        <AuthProvider>
          <AuthProbe />
        </AuthProvider>
      );
      await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('signed-in'));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });

      await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('signed-out'));
      expect(authProviderMocks.from).not.toHaveBeenCalled();
    });

    it('stays signed in, without a third check, when the second cannot be answered either', async () => {
      authProviderMocks.getUser
        .mockResolvedValueOnce({ data: { user: null }, error: { name: 'AuthApiError', message: 'Request rate limit reached', status: 429, code: 'over_request_rate_limit' } })
        .mockResolvedValueOnce({ data: { user: null }, error: unreachable });

      render(
        <AuthProvider>
          <AuthProbe />
        </AuthProvider>
      );
      await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('signed-in'));
      expect(screen.getByTestId('loading')).toHaveTextContent('true');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });

      expect(screen.getByTestId('session')).toHaveTextContent('signed-in');
      expect(authProviderMocks.getUser).toHaveBeenCalledTimes(2);
    });

    it('keeps the session when a manual refresh cannot reach Supabase Auth', async () => {
      render(
        <AuthProvider>
          <AuthProbe />
        </AuthProvider>
      );
      await waitFor(() => expect(screen.getByTestId('credits')).toHaveTextContent('1295'));

      authProviderMocks.getUser.mockResolvedValueOnce({ data: { user: null }, error: unreachable });
      fireEvent.click(screen.getByRole('button', { name: 'Refresh auth' }));

      await waitFor(() => expect(authProviderMocks.getUser).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
      expect(screen.getByTestId('session')).toHaveTextContent('signed-in');
    });

    // A hidden <Activity> runs every cleanup, then every effect again.
    it('drops the pending check when hidden, and checks again when shown', async () => {
      authProviderMocks.getUser.mockResolvedValueOnce({ data: { user: null }, error: unreachable });
      const inActivity = (mode: 'visible' | 'hidden') => (
        <Activity mode={mode}>
          <AuthProvider>
            <AuthProbe />
          </AuthProvider>
        </Activity>
      );
      const { rerender } = render(inActivity('visible'));
      await waitFor(() => expect(authProviderMocks.getUser).toHaveBeenCalledTimes(1));

      rerender(inActivity('hidden'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(authProviderMocks.getUser).toHaveBeenCalledTimes(1);

      rerender(inActivity('visible'));
      await waitFor(() => expect(screen.getByTestId('credits')).toHaveTextContent('1295'));
      expect(authProviderMocks.getUser).toHaveBeenCalledTimes(2);
      expect(authProviderMocks.onAuthStateChange).toHaveBeenCalledTimes(2);
      expect(authProviderMocks.unsubscribe).toHaveBeenCalledTimes(1);
    });
  });
});
