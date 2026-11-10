import { act, render, waitFor } from '@testing-library/react';
import type { Session } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const inviteCode = vi.hoisted(() => ({
  forget: vi.fn(),
  hold: vi.fn(),
  prime: vi.fn(async () => 'code'),
}));

const supabaseAuth = vi.hoisted(() => ({
  onAuthStateChange: vi.fn(),
  getSession: vi.fn(),
  getUser: vi.fn(),
}));

vi.mock('@/lib/invite-share-code', () => ({
  forgetInviteShareCode: inviteCode.forget,
  holdStoredInviteShareCode: inviteCode.hold,
  primeInviteShareCode: inviteCode.prime,
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: supabaseAuth,
    from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { credits: 10 } }) }) }) }),
  },
}));

vi.mock('@/components/useSupabaseAuthCookieHint', () => ({
  useSupabaseAuthCookieHint: () => true,
  useHasHydratedSupabaseAuthCookieHint: () => true,
}));

import { AuthProvider } from '@/components/AuthProvider';

function sessionOf(user: Record<string, unknown>, accessToken = 'access-token-1'): Session {
  return {
    access_token: accessToken,
    refresh_token: 'refresh-token',
    expires_in: 3600,
    token_type: 'bearer',
    user: { app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '2026-01-01T00:00:00.000Z', ...user },
  } as unknown as Session;
}

const account = sessionOf({ id: 'user-1', email: 'creator@example.com' });
const guest = sessionOf({ id: 'guest-1', is_anonymous: true });

// The idle callback, held so a test decides when the browser is idle.
let idle: Array<() => void> = [];

// A share has to go out in the click that asked for it, so the provider puts
// the account's invite code within reach ahead of time: what the browser stored
// at once, the server's answer in idle time. And it lets the code go when the
// account does, so no link shared afterwards carries it.
describe('AuthProvider and the signed-in account’s invite code', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    idle = [];
    vi.stubGlobal('requestIdleCallback', (callback: IdleRequestCallback) => {
      idle.push(() => callback({ didTimeout: false, timeRemaining: () => 50 }));
      return idle.length;
    });
    vi.stubGlobal('cancelIdleCallback', vi.fn());
    supabaseAuth.onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const runIdle = () => act(() => { idle.splice(0).forEach((callback) => callback()); });

  it('holds the stored code as the account is known and asks the server only when idle', async () => {
    render(<AuthProvider initialSession={account} hasResolvedInitialState><span /></AuthProvider>);

    expect(inviteCode.hold).toHaveBeenCalledWith('user-1');
    expect(inviteCode.prime).not.toHaveBeenCalled();

    await runIdle();

    expect(inviteCode.prime).toHaveBeenCalledWith({ userId: 'user-1', accessToken: 'access-token-1' });
    expect(inviteCode.forget).not.toHaveBeenCalled();
  });

  it('holds nothing for a visitor', async () => {
    render(<AuthProvider initialSession={null} hasResolvedInitialState><span /></AuthProvider>);
    await runIdle();

    expect(inviteCode.forget).toHaveBeenCalled();
    expect(inviteCode.hold).not.toHaveBeenCalled();
    expect(inviteCode.prime).not.toHaveBeenCalled();
  });

  it('holds nothing for a guest, who has no invite and whom the link route refuses', async () => {
    render(<AuthProvider initialSession={guest} hasResolvedInitialState><span /></AuthProvider>);
    await runIdle();

    expect(inviteCode.forget).toHaveBeenCalled();
    expect(inviteCode.hold).not.toHaveBeenCalled();
    expect(inviteCode.prime).not.toHaveBeenCalled();
  });

  it('lets the code go when the account signs out', async () => {
    let authChanged: (event: string, session: Session | null) => void = () => undefined;
    supabaseAuth.onAuthStateChange.mockImplementation((callback) => {
      authChanged = callback;
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    });
    render(<AuthProvider initialSession={account} hasResolvedInitialState><span /></AuthProvider>);
    // The provider subscribes to the browser's auth events in idle time too.
    await runIdle();
    await waitFor(() => expect(supabaseAuth.onAuthStateChange).toHaveBeenCalled());
    expect(inviteCode.forget).not.toHaveBeenCalled();

    await act(async () => { authChanged('SIGNED_OUT', null); });

    await waitFor(() => expect(inviteCode.forget).toHaveBeenCalled());
  });
});
