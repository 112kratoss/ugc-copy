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

  it('uses the verified user for service-role reads without touching the cookie session user', async () => {
    const verifiedUser = {
      id: 'verified-user',
      aud: 'authenticated',
      role: 'authenticated',
      email: 'verified@example.com',
      app_metadata: {},
      user_metadata: { name: 'Verified Creator' },
      identities: [],
      created_at: '2026-07-05T00:00:00.000Z',
    };
    const cookieSession = {
      access_token: 'verified-access-token',
      refresh_token: 'verified-refresh-token',
      expires_in: 3600,
      expires_at: 1_800_000_000,
      token_type: 'bearer' as const,
      get user(): never {
        throw new Error('untrusted session user was accessed');
      },
    };
    mocks.getUser.mockResolvedValue({ data: { user: verifiedUser }, error: null });
    mocks.getSession.mockResolvedValue({ data: { session: cookieSession }, error: null });

    const { getServerAuthState } = await import('@/lib/supabase-server');
    const result = await getServerAuthState();

    expect(result).toMatchObject({
      session: {
        access_token: 'verified-access-token',
        user: verifiedUser,
      },
      credits: 42,
    });
    expect(mocks.profileQuery.eq).toHaveBeenCalledWith('id', 'verified-user');
  });

  it('rejects a cookie session when the auth server cannot verify its user', async () => {
    mocks.getUser.mockResolvedValue({
      data: { user: null },
      error: new Error('invalid token'),
    });
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

    const { getServerAuthState } = await import('@/lib/supabase-server');
    await expect(getServerAuthState()).resolves.toEqual({
      session: null,
      credits: null,
    });
    expect(mocks.getSession).not.toHaveBeenCalled();
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
