import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const cookieStore = {
    get: vi.fn((_name: string): { name: string; value: string } | undefined => {
      void _name;
      return undefined;
    }),
    getAll: vi.fn(() => []),
    set: vi.fn(),
  };

  const profileQuery = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn(),
  };
  profileQuery.select.mockReturnValue(profileQuery);
  profileQuery.eq.mockReturnValue(profileQuery);

  return {
    cookieStore,
    profileQuery,
    getUser: vi.fn(),
    getSession: vi.fn(),
    getClaims: vi.fn(),
    createServerClient: vi.fn<(...args: unknown[]) => unknown>(),
    createServiceClient: vi.fn(),
    isE2EAuthBypassEnabled: vi.fn(() => false),
    hasE2EAuthCookie: vi.fn((_value?: string) => {
      void _value;
      return false;
    }),
    createE2ESession: vi.fn(),
  };
});

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return {
    ...actual,
    cache: <T extends (...args: never[]) => unknown>(callback: T) => callback,
  };
});

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => mocks.cookieStore),
}));

vi.mock('@supabase/ssr', () => ({
  createServerClient: (...args: unknown[]) => mocks.createServerClient(...args),
}));

vi.mock('@/lib/e2e-auth', () => ({
  E2E_AUTH_COOKIE_NAME: 'magicbooklet-e2e-auth',
  E2E_AUTH_CREDITS: 2000,
  createE2ESession: () => mocks.createE2ESession(),
  hasE2EAuthCookie: (value: string | undefined) => mocks.hasE2EAuthCookie(value),
  isE2EAuthBypassEnabled: () => mocks.isE2EAuthBypassEnabled(),
}));

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => mocks.createServiceClient(),
}));

const serverSupabase = {
  auth: {
    getUser: mocks.getUser,
    getSession: mocks.getSession,
    getClaims: mocks.getClaims,
  },
};

const adminSupabase = {
  from: vi.fn(() => mocks.profileQuery),
};

describe('getServerAuthState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isE2EAuthBypassEnabled.mockReturnValue(false);
    mocks.hasE2EAuthCookie.mockReturnValue(false);
    mocks.cookieStore.get.mockReturnValue(undefined);
    mocks.createServerClient.mockReturnValue(serverSupabase);
    mocks.createServiceClient.mockReturnValue(adminSupabase);
    mocks.profileQuery.maybeSingle.mockResolvedValue({
      data: { credits: 42 },
      error: null,
    });
  });

  /**
   * The cookie session used throughout. Its `user` getter throws on purpose:
   * the cookie is client-controlled, and F8 must not start trusting it just
   * because verification moved from a GoTrue call to a local signature check.
   */
  function cookieSessionThatRefusesToBeRead() {
    return {
      access_token: 'verified-access-token',
      refresh_token: 'verified-refresh-token',
      expires_in: 3600,
      expires_at: 1_800_000_000,
      token_type: 'bearer' as const,
      get user(): never {
        throw new Error('untrusted session user was accessed');
      },
    };
  }

  it('builds the user from verified claims and never reads the cookie session user', async () => {
    mocks.getSession.mockResolvedValue({
      data: { session: cookieSessionThatRefusesToBeRead() },
      error: null,
    });
    mocks.getClaims.mockResolvedValue({
      data: {
        claims: {
          sub: 'verified-user',
          aud: 'authenticated',
          role: 'authenticated',
          email: 'verified@example.com',
          app_metadata: {},
          user_metadata: { name: 'Verified Creator' },
        },
      },
      error: null,
    });

    const { getServerAuthState } = await import('@/lib/supabase-server');
    const result = await getServerAuthState();

    expect(result).toMatchObject({
      session: {
        access_token: 'verified-access-token',
        user: {
          id: 'verified-user',
          email: 'verified@example.com',
          user_metadata: { name: 'Verified Creator' },
        },
      },
      credits: 42,
      marketplaceSpendableCredits: 42,
    });
    expect(mocks.profileQuery.eq).toHaveBeenCalledWith('id', 'verified-user');
  });

  // A server-rendered page's provider never reads the profile again, so a
  // recipe's shortfall is judged on this figure until something re-reads it.
  it('leaves welcome and referral credits out of the spendable balance, read with the same row', async () => {
    mocks.getSession.mockResolvedValue({
      data: { session: cookieSessionThatRefusesToBeRead() },
      error: null,
    });
    mocks.getClaims.mockResolvedValue({
      data: { claims: { sub: 'verified-user', aud: 'authenticated' } },
      error: null,
    });
    const { getServerAuthState } = await import('@/lib/supabase-server');

    mocks.profileQuery.maybeSingle.mockResolvedValueOnce({
      data: { credits: 1200, promotional_credits: 1200, display_name: 'Maya' },
      error: null,
    });
    await expect(getServerAuthState()).resolves.toMatchObject({
      credits: 1200,
      marketplaceSpendableCredits: 0,
      displayName: 'Maya',
    });

    mocks.profileQuery.maybeSingle.mockResolvedValueOnce({
      data: { credits: 1500, promotional_credits: 300, display_name: null },
      error: null,
    });
    await expect(getServerAuthState()).resolves.toMatchObject({
      credits: 1500,
      marketplaceSpendableCredits: 1200,
    });

    // No row: both figures are unknown, never a zero balance.
    mocks.profileQuery.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    await expect(getServerAuthState()).resolves.toMatchObject({
      credits: null,
      marketplaceSpendableCredits: null,
    });

    expect(mocks.profileQuery.select).toHaveBeenCalledTimes(3);
    for (const [columns] of mocks.profileQuery.select.mock.calls) {
      expect(columns).toBe('credits, promotional_credits, display_name, saver_notice_seen_at');
    }
  });

  // The web's saver notice starts from this, so a page load never asks for the
  // record on its own: told, not told, or unknown when the row was not read.
  it('says whether the account has been told that creators can see who saved, from the same row', async () => {
    mocks.getSession.mockResolvedValue({
      data: { session: cookieSessionThatRefusesToBeRead() },
      error: null,
    });
    mocks.getClaims.mockResolvedValue({
      data: { claims: { sub: 'verified-user', aud: 'authenticated' } },
      error: null,
    });
    const { getServerAuthState } = await import('@/lib/supabase-server');

    mocks.profileQuery.maybeSingle.mockResolvedValueOnce({
      data: { credits: 10, promotional_credits: 0, display_name: 'Maya', saver_notice_seen_at: '2026-10-19T09:00:00.000Z' },
      error: null,
    });
    await expect(getServerAuthState()).resolves.toMatchObject({ saverNoticeSeen: true });

    mocks.profileQuery.maybeSingle.mockResolvedValueOnce({
      data: { credits: 10, promotional_credits: 0, display_name: 'Maya', saver_notice_seen_at: null },
      error: null,
    });
    await expect(getServerAuthState()).resolves.toMatchObject({ saverNoticeSeen: false });

    mocks.profileQuery.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    const unread = await getServerAuthState();
    expect(unread.session).not.toBeNull();
    expect(unread).not.toHaveProperty('saverNoticeSeen');

    expect(mocks.profileQuery.eq).toHaveBeenCalledWith('id', 'verified-user');
  });

  it('does not call the auth server on the read path', async () => {
    // The whole point of F8. With asymmetric signing keys getClaims() verifies
    // locally through WebCrypto against a cached JWKS, so an authenticated
    // render costs no GoTrue round trip.
    mocks.getSession.mockResolvedValue({
      data: { session: cookieSessionThatRefusesToBeRead() },
      error: null,
    });
    mocks.getClaims.mockResolvedValue({
      data: { claims: { sub: 'verified-user', aud: 'authenticated' } },
      error: null,
    });

    const { getServerAuthState } = await import('@/lib/supabase-server');
    await getServerAuthState();

    expect(mocks.getUser).not.toHaveBeenCalled();
  });

  it('rejects a session whose token fails verification', async () => {
    mocks.getSession.mockResolvedValue({
      data: {
        session: {
          access_token: 'forged-token',
          refresh_token: 'forged-refresh-token',
          expires_in: 3600,
          token_type: 'bearer',
          user: { id: 'victim-user' },
        },
      },
      error: null,
    });
    mocks.getClaims.mockResolvedValue({
      data: null,
      error: new Error('invalid signature'),
    });

    const { getServerAuthState } = await import('@/lib/supabase-server');
    await expect(getServerAuthState()).resolves.toEqual({
      session: null,
      credits: null,
    });
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
  });

  it('rejects verified claims that carry no subject', async () => {
    // A token can verify and still be unusable as an identity. Falling back to
    // the cookie's user id here is exactly the substitution the getter above
    // exists to catch.
    mocks.getSession.mockResolvedValue({
      data: {
        session: {
          access_token: 'subjectless-token',
          refresh_token: 'r',
          expires_in: 3600,
          token_type: 'bearer',
          user: { id: 'victim-user' },
        },
      },
      error: null,
    });
    mocks.getClaims.mockResolvedValue({
      data: { claims: { aud: 'authenticated' } },
      error: null,
    });

    const { getServerAuthState } = await import('@/lib/supabase-server');
    await expect(getServerAuthState()).resolves.toEqual({
      session: null,
      credits: null,
    });
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
  });

  it('preserves the explicit E2E bypass without calling Supabase auth', async () => {
    const e2eSession = {
      access_token: 'e2e-token',
      refresh_token: 'e2e-refresh-token',
      expires_in: 3600,
      token_type: 'bearer' as const,
      user: { id: 'e2e-user' },
    };
    mocks.isE2EAuthBypassEnabled.mockReturnValue(true);
    mocks.hasE2EAuthCookie.mockReturnValue(true);
    mocks.cookieStore.get.mockReturnValue({ name: 'magicbooklet-e2e-auth', value: 'enabled' });
    mocks.createE2ESession.mockReturnValue(e2eSession);

    const { getServerAuthState } = await import('@/lib/supabase-server');
    await expect(getServerAuthState()).resolves.toEqual({
      session: e2eSession,
      credits: 2000,
      marketplaceSpendableCredits: 2000,
    });
    expect(mocks.createServerClient).not.toHaveBeenCalled();
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
  });
});
