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
    });
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
    });
    expect(mocks.createServerClient).not.toHaveBeenCalled();
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
  });
});
