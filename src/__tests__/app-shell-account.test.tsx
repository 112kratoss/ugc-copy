import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AppShellAccount from '@/app/components/AppShellAccount';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getUser: vi.fn(),
  onAuthStateChange: vi.fn(),
  select: vi.fn(),
  eq: vi.fn(),
  maybeSingle: vi.fn(),
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
};

let appShellAuthCallback: ((event: string, session: typeof authenticatedSession | null) => void) | null = null;

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: mocks.getSession,
      getUser: mocks.getUser,
      onAuthStateChange: mocks.onAuthStateChange,
      signOut: vi.fn(),
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
    appShellAuthCallback = null;

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

  it('does not publish a stale or forged browser session as authenticated', async () => {
    mocks.getUser.mockResolvedValue({
      data: { user: null },
      error: { message: 'Invalid token' },
    });

    render(<AppShellAccount />);

    expect(await screen.findByRole('link', { name: 'Sign in' })).toBeInTheDocument();
    expect(mocks.select).not.toHaveBeenCalled();
  });

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
});
