import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import AppShellAccount from '@/components/AppShellAccount';
import AppShellAccountFallback from '@/components/AppShellAccountFallback';
import FeedbackViewport from '@/components/FeedbackViewport';
import { APP_NAV_ITEMS } from '@/components/app-shell-nav';
import { resetFeedbackState } from '@/components/feedback-state';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getUser: vi.fn(),
  onAuthStateChange: vi.fn(),
  select: vi.fn(),
  eq: vi.fn(),
  maybeSingle: vi.fn(),
  signOut: vi.fn(),
  clearPersistedCreatorData: vi.fn(),
  router: { push: vi.fn() },
  pathname: '/' as string | null,
}));

const SUPABASE_URL = 'https://project-ref.supabase.co';
const AUTH_COOKIE = 'sb-project-ref-auth-token';

function clearCookies() {
  for (const part of document.cookie.split(';')) {
    const name = part.trim().split('=', 1)[0];
    if (name) document.cookie = `${name}=; Max-Age=0; Path=/`;
  }
}

/** What auth-js returns when Supabase Auth cannot be reached. */
const unreachable = Object.assign(new Error('Failed to fetch'), { name: 'AuthRetryableFetchError', status: 0 });

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
};

let appShellAuthCallback: ((event: string, session: typeof authenticatedSession | null) => void) | null = null;

vi.mock('next/navigation', () => ({
  useRouter: () => mocks.router,
  usePathname: () => mocks.pathname,
}));

vi.mock('@/lib/persisted-media', () => ({
  clearPersistedCreatorData: mocks.clearPersistedCreatorData,
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: mocks.getSession,
      getUser: mocks.getUser,
      onAuthStateChange: mocks.onAuthStateChange,
      signOut: mocks.signOut,
    },
    from: () => ({ select: mocks.select }),
  },
}));

describe('AppShellAccount', () => {
  beforeEach(() => {
    mocks.getSession.mockReset();
    mocks.getUser.mockReset();
    mocks.onAuthStateChange.mockReset();
    mocks.select.mockReset();
    mocks.eq.mockReset();
    mocks.maybeSingle.mockReset();
    mocks.signOut.mockReset();
    mocks.clearPersistedCreatorData.mockReset();
    mocks.router.push.mockReset();
    mocks.pathname = '/';
    appShellAuthCallback = null;
    mocks.signOut.mockResolvedValue({ error: null });
    mocks.clearPersistedCreatorData.mockResolvedValue(undefined);

    mocks.getSession.mockResolvedValue({ data: { session: authenticatedSession } });
    mocks.getUser.mockResolvedValue({
      data: { user: authenticatedSession.user },
      error: null,
    });
    mocks.onAuthStateChange.mockImplementation((callback) => {
      appShellAuthCallback = callback;
      queueMicrotask(() => {
        callback('SIGNED_IN', authenticatedSession);
        callback('INITIAL_SESSION', authenticatedSession);
      });
      return {
        data: { subscription: { unsubscribe: vi.fn() } },
      };
    });
    mocks.select.mockReturnValue({ eq: mocks.eq });
    mocks.eq.mockReturnValue({ maybeSingle: mocks.maybeSingle });
    mocks.maybeSingle.mockResolvedValue({
      data: {
        display_name: 'Test Creator',
        avatar_url: null,
        credits: 1295,
      },
    });
  });

  it('loads the real profile fields and displays the stored credit balance', async () => {
    render(<AppShellAccount />);

    expect(await screen.findByText('1295 credits')).toBeInTheDocument();
    expect(mocks.select).toHaveBeenCalledWith('display_name, avatar_url, credits');
    await waitFor(() => expect(mocks.eq).toHaveBeenCalledWith('id', 'user-1'));
    expect(mocks.getUser).toHaveBeenCalledWith('verified-access-token');
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.maybeSingle).toHaveBeenCalledTimes(1);
  });

  it('links the signed-in account menu to Invite & Earn', async () => {
    render(<AppShellAccount />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open account menu for Test Creator' }));

    expect(screen.getByRole('menuitem', { name: /Invite & Earn/i })).toHaveAttribute('href', '/invite');
    expect(screen.getByText('Earn credits')).toBeInTheDocument();
  });

  it('shows the balance in the top bar alone, the number by itself on a phone', async () => {
    render(<AppShellAccount />);

    const balance = await screen.findByRole('link', { name: '1295 credits' });
    expect(balance).toHaveAttribute('href', '/pricing');
    // Drawn at every width now: the phone layout had no balance anywhere.
    expect(balance.className).not.toMatch(/(^|\s)hidden(\s|$)/);
    expect(within(balance).getByText('1295')).toHaveClass('sm:hidden');

    fireEvent.click(screen.getByRole('button', { name: 'Open account menu for Test Creator' }));

    // The balance is the bar's alone: the menu's Profile row used to carry it too.
    const menu = screen.getByRole('menu', { name: 'Account' });
    expect(within(menu).queryByText(/1295/)).not.toBeInTheDocument();
  });

  it('opens the account menu on Profile, in the navigation\'s word and address, and closes on the way', async () => {
    render(<AppShellAccount />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open account menu for Test Creator' }));

    // A rename or move of the navigation's Profile fails here, so the two never drift apart.
    expect(APP_NAV_ITEMS.find((item) => item.id === 'profile')).toMatchObject({ label: 'Profile', href: '/profile' });
    const profile = screen.getByRole('menuitem', { name: 'Profile' });
    expect(profile).toHaveAttribute('href', '/profile');
    expect(screen.getAllByRole('menuitem')[0]).toBe(profile);

    // jsdom cannot load another document; the menu's own click handler still runs.
    const stayOnPage = (event: MouseEvent) => event.preventDefault();
    document.addEventListener('click', stayOnPage);
    try {
      fireEvent.click(profile);
    } finally {
      document.removeEventListener('click', stayOnPage);
    }
    expect(screen.queryByRole('menu', { name: 'Account' })).not.toBeInTheDocument();
  });

  it('links the account menu to the credit history, after Invite & Earn, and closes on the way', async () => {
    render(<AppShellAccount />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open account menu for Test Creator' }));

    const items = screen.getAllByRole('menuitem');
    const creditHistory = screen.getByRole('menuitem', { name: 'Credit history' });
    expect(creditHistory).toHaveAttribute('href', '/credits');
    expect(items.indexOf(creditHistory)).toBe(items.indexOf(screen.getByRole('menuitem', { name: /Invite & Earn/ })) + 1);

    // jsdom cannot load another document; the menu's own click handler still runs.
    const stayOnPage = (event: MouseEvent) => event.preventDefault();
    document.addEventListener('click', stayOnPage);
    try {
      fireEvent.click(creditHistory);
    } finally {
      document.removeEventListener('click', stayOnPage);
    }
    expect(screen.queryByRole('menu', { name: 'Account' })).not.toBeInTheDocument();
  });

  it('does not publish a stale or forged browser session as authenticated', async () => {
    mocks.getUser.mockResolvedValue({
      data: { user: null },
      error: { name: 'AuthApiError', message: 'invalid JWT: unable to parse or verify signature', status: 403, code: 'bad_jwt' },
    });

    render(<AppShellAccount />);

    expect(await screen.findByRole('link', { name: 'Sign in' })).toBeInTheDocument();
    expect(mocks.select).not.toHaveBeenCalled();
  });

  // Audit 01-10: an Auth outage is not a sign-out.
  describe('when Supabase Auth cannot answer the session check', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('keeps the account in the header and checks once more two seconds later', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
      mocks.getUser
        .mockResolvedValueOnce({ data: { user: null }, error: unreachable })
        .mockResolvedValueOnce({ data: { user: authenticatedSession.user }, error: null });

      render(<AppShellAccount />);

      expect(await screen.findByRole('button', { name: 'Open account menu for creator' })).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Sign in' })).toBeNull();
      expect(mocks.select).not.toHaveBeenCalled();
      expect(mocks.getUser).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });

      expect(await screen.findByText('1295 credits')).toBeInTheDocument();
      expect(mocks.getUser).toHaveBeenCalledTimes(2);
    });

    it('signs the header out when the second check is refused, and asks no third time', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
      mocks.getUser
        .mockResolvedValueOnce({ data: { user: null }, error: { ...unreachable, name: 'AuthRetryableFetchError', status: 503 } })
        .mockResolvedValueOnce({ data: { user: null }, error: { name: 'AuthApiError', message: 'Session from session_id claim in JWT does not exist', status: 403, code: 'session_not_found' } });

      render(<AppShellAccount />);
      expect(await screen.findByRole('button', { name: 'Open account menu for creator' })).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });

      expect(await screen.findByRole('link', { name: 'Sign in' })).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(mocks.getUser).toHaveBeenCalledTimes(2);
      expect(mocks.select).not.toHaveBeenCalled();
    });
  });

  // Audit 03-4: a purchase or a reward that lands while the tab is hidden.
  it('re-reads the balance when the tab comes back after half a minute, and not more often', async () => {
    const addDocumentListener = vi.spyOn(document, 'addEventListener');
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const start = new Date('2026-10-15T08:00:00.000Z').getTime();
      vi.setSystemTime(start);
      render(<AppShellAccount />);
      expect(await screen.findByText('1295 credits')).toBeInTheDocument();
      // The balance can be on screen before the effect that listens for the tab
      // has run: effects run after the paint. On main's slower runner the clock
      // was moved first, the listener started its 30 s at +29 s, and the re-read
      // due at +31 s never came. The clock moves only once the listener is armed.
      await waitFor(() => expect(addDocumentListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function)));
      expect(mocks.maybeSingle).toHaveBeenCalledTimes(1);
      mocks.maybeSingle.mockResolvedValue({ data: { credits: 2000 } });
      const comeBack = () => act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });

      vi.setSystemTime(start + 29_000);
      comeBack();
      expect(mocks.maybeSingle).toHaveBeenCalledTimes(1);

      vi.setSystemTime(start + 31_000);
      comeBack();
      expect(await screen.findByText('2000 credits')).toBeInTheDocument();
      expect(mocks.maybeSingle).toHaveBeenCalledTimes(2);

      vi.setSystemTime(start + 45_000);
      comeBack();
      expect(mocks.maybeSingle).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      addDocumentListener.mockRestore();
    }
  }, 15_000);

  it('reveals initials when the account avatar cannot load', async () => {
    mocks.maybeSingle.mockResolvedValue({
      data: {
        display_name: 'Test Creator',
        avatar_url: 'https://broken.example/avatar.png',
        credits: 1295,
      },
    });
    const { container } = render(<AppShellAccount />);
    expect(await screen.findByText('1295 credits')).toBeInTheDocument();

    const avatar = container.querySelector('img');
    expect(avatar).not.toBeNull();
    fireEvent.error(avatar!);

    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('TC')).toBeInTheDocument();
  });

  it('does not let a previous user credit refresh overwrite the next account', async () => {
    render(<AppShellAccount />);
    expect(await screen.findByText('1295 credits')).toBeInTheDocument();

    let resolveOldCredits!: (value: { data: { credits: number } }) => void;
    mocks.maybeSingle
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveOldCredits = resolve;
      }))
      .mockResolvedValueOnce({
        data: {
          display_name: 'Second Creator',
          avatar_url: null,
          credits: 77,
        },
      });

    // `credits_updated` is a one-shot event and the listener only issues a fetch once
    // `session` has landed — `refreshCredits` returns early on a falsy `session.user.id`.
    // Nothing rendered while the menu is closed is derived from `session` alone
    // (`displayName` and `avatarUrl` both fall back to `profile`), so awaiting the credit
    // balance above proves `profile` arrived, not that the listener is live yet. Dispatch
    // until it registers rather than assuming one instant: the listener calls `maybeSingle`
    // synchronously, so the guard below cannot overshoot two calls.
    await waitFor(() => {
      if (mocks.maybeSingle.mock.calls.length < 2) {
        act(() => window.dispatchEvent(new Event('credits_updated')));
      }
      expect(mocks.maybeSingle).toHaveBeenCalledTimes(2);
    });

    const secondSession = {
      ...authenticatedSession,
      access_token: 'second-access-token',
      user: {
        ...authenticatedSession.user,
        id: 'user-2',
        email: 'second@example.com',
      },
    };
    mocks.getUser.mockResolvedValueOnce({ data: { user: secondSession.user }, error: null });
    act(() => appShellAuthCallback?.('SIGNED_IN', secondSession));

    expect(await screen.findByText('77 credits')).toBeInTheDocument();
    await act(async () => {
      resolveOldCredits({ data: { credits: 9999 } });
    });

    expect(screen.getByText('77 credits')).toBeInTheDocument();
    expect(screen.queryByText('9999 credits')).toBeNull();
  });
  it('invalidates a pending credit refresh immediately when another account starts verification', async () => {
    render(<AppShellAccount />);
    expect(await screen.findByText('1295 credits')).toBeInTheDocument();
    let resolveCredits!: (value: { data: { credits: number } }) => void;
    mocks.maybeSingle.mockImplementationOnce(() => new Promise((resolve) => {
      resolveCredits = resolve;
    }));
    await waitFor(() => {
      if (mocks.maybeSingle.mock.calls.length < 2) {
        act(() => window.dispatchEvent(new Event('credits_updated')));
      }
      expect(mocks.maybeSingle).toHaveBeenCalledTimes(2);
    });
    // Hold verification open: effect cleanup cannot protect this interval.
    mocks.getUser.mockImplementationOnce(() => new Promise(() => {}));
    act(() => appShellAuthCallback?.('SIGNED_IN', {
      ...authenticatedSession,
      access_token: 'second-access-token',
      user: { ...authenticatedSession.user, id: 'user-2' },
    }));
    await act(async () => resolveCredits({ data: { credits: 9999 } }));
    expect(screen.queryByText('9999 credits')).toBeNull();
  });

  describe('sign-out', () => {
    async function openAccountMenu() {
      render(<AppShellAccount />);
      fireEvent.click(await screen.findByRole('button', { name: 'Open account menu for Test Creator' }));
    }

    afterEach(() => {
      clearCookies();
      vi.unstubAllEnvs();
    });

    // Audit 04-4: auth-js keeps the session when its logout call fails, and
    // /login sends a browser holding one straight back.
    it('ends the session in this browser and lands on /login when the logout call fails', async () => {
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL);
      document.cookie = `${AUTH_COOKIE}.0=chunk-zero; Path=/`;
      document.cookie = `${AUTH_COOKIE}.1=chunk-one; Path=/`;
      document.cookie = `${AUTH_COOKIE}-code-verifier=verifier; Path=/`;
      document.cookie = 'sb-another-project-auth-token=theirs; Path=/';
      mocks.signOut.mockResolvedValue({ error: unreachable });
      await openAccountMenu();

      fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));

      await waitFor(() => expect(mocks.router.push).toHaveBeenCalledWith('/login'));
      expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' });
      expect(document.cookie).toBe('sb-another-project-auth-token=theirs');
      expect(screen.getByRole('link', { name: 'Sign in' })).toBeInTheDocument();
    });

    it('ends the session in this browser when the sign-out throws', async () => {
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL);
      document.cookie = `${AUTH_COOKIE}=session; Path=/`;
      mocks.signOut.mockRejectedValue(new Error('Lock broken'));
      await openAccountMenu();

      fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));

      await waitFor(() => expect(mocks.router.push).toHaveBeenCalledWith('/login'));
      expect(document.cookie).toBe('');
    });

    it('leaves the cookies to Supabase when it ends the session itself', async () => {
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL);
      document.cookie = `${AUTH_COOKIE}=session; Path=/`;
      await openAccountMenu();

      fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));

      await waitFor(() => expect(mocks.router.push).toHaveBeenCalledWith('/login'));
      // auth-js removes them itself on success; the mock does not.
      expect(document.cookie).toBe(`${AUTH_COOKIE}=session`);
    });

    it('shows that it is signing out while Supabase answers, and signs out once', async () => {
      let resolveSignOut!: (value: { error: null }) => void;
      mocks.signOut.mockImplementation(() => new Promise((resolve) => {
        resolveSignOut = resolve;
      }));
      await openAccountMenu();

      fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));

      const pending = await screen.findByRole('menuitem', { name: 'Signing out…' });
      expect(pending).toBeDisabled();
      expect(pending).toHaveAttribute('aria-busy', 'true');
      await waitFor(() => expect(mocks.signOut).toHaveBeenCalledTimes(1));
      fireEvent.click(pending);
      expect(mocks.router.push).not.toHaveBeenCalled();

      await act(async () => {
        resolveSignOut({ error: null });
      });

      await waitFor(() => expect(mocks.router.push).toHaveBeenCalledWith('/login'));
      expect(mocks.signOut).toHaveBeenCalledTimes(1);
    });

    it('clears the account\'s creator media and drafts before the session ends', async () => {
      const order: string[] = [];
      mocks.clearPersistedCreatorData.mockImplementation(async () => {
        order.push('clear');
      });
      mocks.signOut.mockImplementation(async () => {
        order.push('signOut');
        return { error: null };
      });
      await openAccountMenu();

      fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));

      await waitFor(() => expect(mocks.router.push).toHaveBeenCalledWith('/login'));
      expect(mocks.clearPersistedCreatorData).toHaveBeenCalledWith('user-1');
      expect(order).toEqual(['clear', 'signOut']);
      expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' });
    });

    it('still signs out when the browser storage refuses', async () => {
      mocks.clearPersistedCreatorData.mockRejectedValue(new Error('IndexedDB unavailable'));
      await openAccountMenu();

      fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));

      await waitFor(() => expect(mocks.router.push).toHaveBeenCalledWith('/login'));
      expect(mocks.signOut).toHaveBeenCalledTimes(1);
    });

    it('does not wait more than three seconds on storage that never answers', async () => {
      mocks.clearPersistedCreatorData.mockImplementation(() => new Promise(() => {}));
      await openAccountMenu();
      vi.useFakeTimers();
      try {
        fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2_900);
        });
        expect(mocks.signOut).not.toHaveBeenCalled();

        await act(async () => {
          await vi.advanceTimersByTimeAsync(100);
        });
        expect(mocks.signOut).toHaveBeenCalledTimes(1);
        expect(mocks.router.push).toHaveBeenCalledWith('/login');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // Decision 9 (2026-10-17): an account can end every one of its sessions from
  // the menu. The proxy refuses the other devices' tokens on their next request.
  describe('sign out of all devices', () => {
    const SIGN_OUT_EVERYWHERE_FAILED =
      'Could not sign out of all devices. You’re still signed in here; check your connection and try again.';

    async function chooseSignOutEverywhere() {
      render(
        <>
          <AppShellAccount />
          <FeedbackViewport />
        </>
      );
      fireEvent.click(await screen.findByRole('button', { name: 'Open account menu for Test Creator' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out of all devices' }));
      return screen.findByRole('alertdialog', { name: 'Sign out of all devices?' });
    }

    afterEach(() => {
      resetFeedbackState();
      clearCookies();
      vi.unstubAllEnvs();
    });

    it('asks first, then signs out everywhere and leaves this browser as Sign out does', async () => {
      const dialog = await chooseSignOutEverywhere();

      expect(dialog).toHaveTextContent('You’ll be signed out here and on every other device.');
      expect(mocks.signOut).not.toHaveBeenCalled();

      fireEvent.click(within(dialog).getByRole('button', { name: 'Sign out everywhere' }));

      await waitFor(() => expect(mocks.router.push).toHaveBeenCalledWith('/login'));
      expect(mocks.signOut).toHaveBeenCalledTimes(1);
      expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'global' });
      expect(mocks.clearPersistedCreatorData).toHaveBeenCalledWith('user-1');
      expect(screen.getByRole('link', { name: 'Sign in' })).toBeInTheDocument();
    });

    // The phones lose their session with this and cannot retire their own push
    // tokens afterwards, so the account's go first, with this session's token.
    it('retires the account\'s push tokens before it signs out everywhere', async () => {
      const order: string[] = [];
      const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => {
        order.push('retire');
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      });
      vi.stubGlobal('fetch', fetchMock);
      mocks.signOut.mockImplementation(async () => {
        order.push('signOut');
        return { error: null };
      });
      try {
        const dialog = await chooseSignOutEverywhere();
        fireEvent.click(within(dialog).getByRole('button', { name: 'Sign out everywhere' }));

        await waitFor(() => expect(mocks.router.push).toHaveBeenCalledWith('/login'));
        const retire = fetchMock.mock.calls.find(([url]) => url === '/api/mobile/notifications/unregister');
        expect(retire?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ scope: 'account' }) });
        expect(new Headers(retire?.[1]?.headers).get('Authorization')).toBe('Bearer verified-access-token');
        expect(order.indexOf('retire')).toBeLessThan(order.indexOf('signOut'));
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('does nothing when the person cancels', async () => {
      const dialog = await chooseSignOutEverywhere();

      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

      await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
      expect(mocks.signOut).not.toHaveBeenCalled();
      expect(mocks.clearPersistedCreatorData).not.toHaveBeenCalled();
      expect(mocks.router.push).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Open account menu for Test Creator' })).toBeInTheDocument();
    });

    // auth-js keeps the session when the call fails, and the other devices are
    // still signed in: leaving here would read as done. It says so instead, and
    // the person can try again.
    it.each([
      ['answers with an error', () => mocks.signOut.mockResolvedValue({ error: unreachable })],
      ['throws', () => mocks.signOut.mockRejectedValue(new Error('Lock broken'))],
    ])('keeps this browser signed in and says so when the sign-out %s', async (_name, fail) => {
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL);
      document.cookie = `${AUTH_COOKIE}=session; Path=/`;
      fail();
      const dialog = await chooseSignOutEverywhere();
      const confirm = within(dialog).getByRole('button', { name: 'Sign out everywhere' });

      // A press in the dialog is a press outside the menu, which closes it.
      fireEvent.pointerDown(confirm);
      fireEvent.click(confirm);

      expect(await screen.findByText(SIGN_OUT_EVERYWHERE_FAILED)).toBeInTheDocument();
      expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'global' });
      expect(mocks.router.push).not.toHaveBeenCalled();
      expect(mocks.clearPersistedCreatorData).not.toHaveBeenCalled();
      expect(document.cookie).toBe(`${AUTH_COOKIE}=session`);
      fireEvent.click(screen.getByRole('button', { name: 'Open account menu for Test Creator' }));
      expect(screen.getByRole('menuitem', { name: 'Sign out of all devices' })).toBeEnabled();
    });

    it('is offered to an account, not to a guest, whose one session is this browser', async () => {
      mocks.getUser.mockResolvedValue({
        data: { user: { ...authenticatedSession.user, is_anonymous: true } },
        error: null,
      });
      render(<AppShellAccount />);

      fireEvent.click(await screen.findByRole('button', { name: 'Open account menu for Test Creator' }));

      expect(screen.getByRole('menuitem', { name: 'Sign out' })).toBeInTheDocument();
      expect(screen.queryByRole('menuitem', { name: 'Sign out of all devices' })).not.toBeInTheDocument();
    });
  });
});

// Audit 01-5: the most used sign-in entry on the web returned everyone to Home.
describe('the header Sign in link', () => {
  /** Puts the browser on a page, as the router does: the path from usePathname, the query in the address bar. */
  function visit(pathname: string, search = '') {
    mocks.pathname = pathname;
    window.history.replaceState(null, '', `${pathname}${search ? `?${search}` : ''}`);
  }

  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it.each([
    ['/showcase/post-1', '', '/login?returnUrl=%2Fshowcase%2Fpost-1'],
    ['/pricing', 'pack=creator', '/login?returnUrl=%2Fpricing%3Fpack%3Dcreator'],
    ['/creators/maya', 'tab=recipes&sort=new', '/login?returnUrl=%2Fcreators%2Fmaya%3Ftab%3Drecipes%26sort%3Dnew'],
    ['/', '', '/login?returnUrl=%2F'],
    ['/login', 'returnUrl=%2Fpricing', '/login?returnUrl=%2F'],
    ['/auth/reset-password', 'next=%2Fcreate', '/login?returnUrl=%2F'],
    ['/auth/auth-code-error', '', '/login?returnUrl=%2F'],
  ])('from %s?%s returns to %s', (pathname, search, href) => {
    visit(pathname, search);

    render(<AppShellAccountFallback />);

    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', href);
  });

  // The router changes a query with history.pushState, which no event reports.
  it('reads a query the page changed after it drew, as the visitor reaches for the link', () => {
    visit('/search', 'q=cats');
    render(<AppShellAccountFallback />);
    const link = screen.getByRole('link', { name: 'Sign in' });
    expect(link).toHaveAttribute('href', '/login?returnUrl=%2Fsearch%3Fq%3Dcats');

    window.history.pushState(null, '', '/search?q=dogs');
    fireEvent.pointerEnter(link);
    expect(link).toHaveAttribute('href', '/login?returnUrl=%2Fsearch%3Fq%3Ddogs');

    window.history.pushState(null, '', '/search?q=birds');
    fireEvent.focus(link);
    expect(link).toHaveAttribute('href', '/login?returnUrl=%2Fsearch%3Fq%3Dbirds');

    window.history.pushState(null, '', '/search?q=fish');
    fireEvent.pointerDown(link);
    expect(link).toHaveAttribute('href', '/login?returnUrl=%2Fsearch%3Fq%3Dfish');
  });

  it('follows the query back and forward through history', () => {
    visit('/search', 'q=cats');
    render(<AppShellAccountFallback />);

    window.history.pushState(null, '', '/search?q=dogs');
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login?returnUrl=%2Fsearch%3Fq%3Ddogs');
  });

  it('returns to Home when the router has no path to give', () => {
    visit('/pricing', 'pack=creator');
    mocks.pathname = null;

    render(<AppShellAccountFallback />);

    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login?returnUrl=%2F');
  });
});
