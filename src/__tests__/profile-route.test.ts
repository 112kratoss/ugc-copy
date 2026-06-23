import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ProfileRow = {
  id: string;
  username: string | null;
  display_name: string | null;
  bio: string | null;
  avatar_url: string | null;
  cover_url: string | null;
  website_url: string | null;
  twitter_handle: string | null;
  instagram_handle: string | null;
  tiktok_handle: string | null;
  location: string | null;
  credits: number | null;
};

let profilesState: ProfileRow[] = [];
const authUserId = '11111111-1111-1111-1111-111111111111';
const rateLimitRpcMock = vi.fn();

function createAdminClient() {
  return {
    rpc: rateLimitRpcMock,
    from(table: string) {
      if (table !== 'profiles') {
        throw new Error(`Unexpected table: ${table}`);
      }

      const filters: Record<string, unknown> = {};
      let excludedId: string | null = null;

      const query = {
        select() {
          return query;
        },
        eq(column: string, value: unknown) {
          filters[column] = value;
          return query;
        },
        neq(column: string, value: unknown) {
          if (column === 'id') {
            excludedId = String(value);
          }
          return query;
        },
        async maybeSingle() {
          const match =
            profilesState.find((profile) =>
              Object.entries(filters).every(([key, value]) => (profile as Record<string, unknown>)[key] === value) &&
              (!excludedId || profile.id !== excludedId)
            ) ?? null;

          return { data: match, error: null };
        },
      };

      return {
        ...query,
        update(values: Record<string, unknown>) {
          return {
            eq(column: string, value: unknown) {
              return {
                select() {
                  return {
                    async single() {
                      const index = profilesState.findIndex(
                        (profile) => (profile as Record<string, unknown>)[column] === value
                      );

                      if (index === -1) {
                        return { data: null, error: { message: 'Missing profile' } };
                      }

                      profilesState[index] = {
                        ...profilesState[index],
                        ...values,
                      };

                      return { data: profilesState[index], error: null };
                    },
                  };
                },
              };
            },
          };
        },
        upsert(values: Record<string, unknown>) {
          return {
            select() {
              return {
                async single() {
                  const profileId = values.id as string;
                  const index = profilesState.findIndex((profile) => profile.id === profileId);
                  const nextProfile = {
                    id: profileId,
                    username: (values.username as string | null) ?? null,
                    display_name: (values.display_name as string | null) ?? null,
                    bio: (values.bio as string | null) ?? null,
                    avatar_url: (values.avatar_url as string | null) ?? null,
                    cover_url: (values.cover_url as string | null) ?? null,
                    website_url: (values.website_url as string | null) ?? null,
                    twitter_handle: (values.twitter_handle as string | null) ?? null,
                    instagram_handle: (values.instagram_handle as string | null) ?? null,
                    tiktok_handle: (values.tiktok_handle as string | null) ?? null,
                    location: (values.location as string | null) ?? null,
                    credits: index === -1 ? null : profilesState[index].credits,
                  };

                  if (index === -1) {
                    profilesState.push(nextProfile);
                  } else {
                    profilesState[index] = {
                      ...profilesState[index],
                      ...nextProfile,
                    };
                  }

                  return { data: nextProfile, error: null };
                },
              };
            },
          };
        },
      };
    },
  };
}

const createUserClientMock = vi.fn((): unknown => ({
  auth: {
    getUser: vi.fn(async () => ({
      data: {
        user: { id: authUserId },
      },
      error: null,
    })),
  },
}));
const createServiceClientMock = vi.fn(() => createAdminClient());

vi.mock('@/lib/server-helpers', () => ({
  createUserClient: () => createUserClientMock(),
  createServiceClient: () => createServiceClientMock(),
}));

function expectPrivateNoStoreTraceHeaders(response: Response, requestId: string) {
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('x-request-id')).toBe(requestId);
}

describe('/api/profile route', () => {
  beforeEach(() => {
    vi.resetModules();
    profilesState = [
      {
        id: authUserId,
        username: null,
        display_name: 'Existing Creator',
        bio: null,
        avatar_url: null,
        cover_url: null,
        website_url: null,
        twitter_handle: null,
        instagram_handle: null,
        tiktok_handle: null,
        location: null,
        credits: 25,
      },
      {
        id: '22222222-2222-2222-2222-222222222222',
        username: 'taken-name',
        display_name: 'Taken',
        bio: null,
        avatar_url: null,
        cover_url: null,
        website_url: null,
        twitter_handle: null,
        instagram_handle: null,
        tiktok_handle: null,
        location: null,
        credits: 10,
      },
    ];
    createUserClientMock.mockClear();
    createServiceClientMock.mockClear();
    createServiceClientMock.mockImplementation(() => createAdminClient());
    rateLimitRpcMock.mockReset();
    rateLimitRpcMock.mockResolvedValue({
      data: {
        allowed: true,
        limit: 120,
        remaining: 119,
        retryAfterSeconds: 0,
        resetAt: '2026-06-22T06:30:00.000Z',
      },
      error: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the current profile and suggested username when missing', async () => {
    const { GET } = await import('@/app/api/profile/route');
    const response = await GET(new Request('http://localhost/api/profile', {
      headers: { 'x-request-id': 'profile-get-success-1' },
    }) as never);
    const data = await response.json();

    expect(response.status).toBe(200);
    expectPrivateNoStoreTraceHeaders(response, 'profile-get-success-1');
    expect(data.username).toBeNull();
    expect(data.suggestedUsername).toBe('creator-11111111');
    expect(data.displayName).toBe('Existing Creator');
    expect(data.credits).toBe(25);
  });

  it('does not create an admin client for unauthenticated profile reads', async () => {
    createUserClientMock.mockReturnValueOnce({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: null },
          error: new Error('missing session'),
        })),
      },
    });

    const { GET } = await import('@/app/api/profile/route');
    const response = await GET(new Request('http://localhost/api/profile', {
      headers: { 'x-request-id': 'profile-get-auth-1' },
    }) as never);

    expect(response.status).toBe(401);
    expectPrivateNoStoreTraceHeaders(response, 'profile-get-auth-1');
    expect(createServiceClientMock).not.toHaveBeenCalled();
  });

  it('does not create an admin client for unauthenticated profile updates', async () => {
    createUserClientMock.mockReturnValueOnce({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: null },
          error: new Error('missing session'),
        })),
      },
    });

    const { PATCH } = await import('@/app/api/profile/route');
    const response = await PATCH(
      new Request('http://localhost/api/profile', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'profile-patch-auth-1',
        },
        body: JSON.stringify({ displayName: 'Blocked' }),
      }) as never
    );

    expect(response.status).toBe(401);
    expectPrivateNoStoreTraceHeaders(response, 'profile-patch-auth-1');
    expect(createServiceClientMock).not.toHaveBeenCalled();
  });

  it('returns a starter profile payload when the profile row is missing', async () => {
    profilesState = [];

    const { GET } = await import('@/app/api/profile/route');
    const response = await GET(new Request('http://localhost/api/profile') as never);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.username).toBeNull();
    expect(data.suggestedUsername).toBe('creator-11111111');
    expect(data.displayName).toBe('Creator');
  });

  it('normalizes usernames to lowercase on successful updates', async () => {
    const { PATCH } = await import('@/app/api/profile/route');
    const response = await PATCH(
      new Request('http://localhost/api/profile', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'profile-patch-success-1',
        },
        body: JSON.stringify({
          username: 'Creator-Name',
          displayName: 'Creator Name',
          bio: 'UGC creator for product demos.',
          avatarUrl: 'https://example.com/avatar.jpg',
        }),
      }) as never
    );

    const data = await response.json();
    expect(response.status).toBe(200);
    expectPrivateNoStoreTraceHeaders(response, 'profile-patch-success-1');
    expect(data.username).toBe('creator-name');
    expect(rateLimitRpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'profile:update',
      p_subject_key: authUserId,
      p_limit: 30,
      p_window_seconds: 600,
    });
    expect(profilesState[0].username).toBe('creator-name');
  });

  it('rate limits profile updates before validation and persistence', async () => {
    rateLimitRpcMock.mockResolvedValue({
      data: {
        allowed: false,
        limit: 30,
        remaining: 0,
        retryAfterSeconds: 40,
        resetAt: '2026-06-22T06:30:00.000Z',
      },
      error: null,
    });

    const { PATCH } = await import('@/app/api/profile/route');
    const response = await PATCH(
      new Request('http://localhost/api/profile', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'profile-patch-rate-limit-1',
        },
        body: JSON.stringify({
          username: 'taken-name',
          displayName: 'Creator Name',
        }),
      }) as never
    );
    const data = await response.json();

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('40');
    expectPrivateNoStoreTraceHeaders(response, 'profile-patch-rate-limit-1');
    expect(data).toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 40,
    });
    expect(rateLimitRpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'profile:update',
      p_subject_key: authUserId,
      p_limit: 30,
      p_window_seconds: 600,
    });
    expect(profilesState[0].username).toBeNull();
  });

  it('creates the profile row on first save if it is missing', async () => {
    profilesState = [];

    const { PATCH } = await import('@/app/api/profile/route');
    const response = await PATCH(
      new Request('http://localhost/api/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'First-Creator',
          displayName: 'First Creator',
          bio: 'Launching a creator profile.',
        }),
      }) as never
    );

    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.username).toBe('first-creator');
    expect(profilesState).toHaveLength(1);
    expect(profilesState[0]).toMatchObject({
      id: authUserId,
      username: 'first-creator',
      display_name: 'First Creator',
    });
  });

  it('validates an available username without updating the profile', async () => {
    const { POST } = await import('@/app/api/profile/validate/route');
    const response = await POST(
      new Request('http://localhost/api/profile/validate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'profile-validate-success-1',
        },
        body: JSON.stringify({
          username: 'available-name',
          displayName: 'Creator Name',
        }),
      }) as never
    );

    const data = await response.json();
    expect(response.status).toBe(200);
    expectPrivateNoStoreTraceHeaders(response, 'profile-validate-success-1');
    expect(data.ok).toBe(true);
    expect(rateLimitRpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'profile:validate',
      p_subject_key: authUserId,
      p_limit: 120,
      p_window_seconds: 600,
    });
    expect(profilesState[0].username).toBeNull();
  });

  it('does not create an admin client for unauthenticated profile validation', async () => {
    createUserClientMock.mockReturnValueOnce({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: null },
          error: new Error('missing session'),
        })),
      },
    });

    const { POST } = await import('@/app/api/profile/validate/route');
    const response = await POST(
      new Request('http://localhost/api/profile/validate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'profile-validate-auth-1',
        },
        body: JSON.stringify({ username: 'blocked-name' }),
      }) as never
    );

    expect(response.status).toBe(401);
    expectPrivateNoStoreTraceHeaders(response, 'profile-validate-auth-1');
    expect(createServiceClientMock).not.toHaveBeenCalled();
  });

  it('rate limits profile validation before username uniqueness checks', async () => {
    rateLimitRpcMock.mockResolvedValue({
      data: {
        allowed: false,
        limit: 120,
        remaining: 0,
        retryAfterSeconds: 20,
        resetAt: '2026-06-22T06:30:00.000Z',
      },
      error: null,
    });

    const { POST } = await import('@/app/api/profile/validate/route');
    const response = await POST(
      new Request('http://localhost/api/profile/validate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'profile-validate-rate-limit-1',
        },
        body: JSON.stringify({
          username: 'taken-name',
          displayName: 'Creator Name',
        }),
      }) as never
    );
    const data = await response.json();

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('20');
    expectPrivateNoStoreTraceHeaders(response, 'profile-validate-rate-limit-1');
    expect(data).toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 20,
    });
  });

  it('returns field errors for invalid usernames', async () => {
    const { PATCH } = await import('@/app/api/profile/route');
    const response = await PATCH(
      new Request('http://localhost/api/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'Bad Name!',
          displayName: 'Creator Name',
        }),
      }) as never
    );

    const data = await response.json();
    expect(response.status).toBe(400);
    expect(data.fieldErrors.username).toContain('Use 3-24');
  });

  it('returns field errors when the username is already taken', async () => {
    const { PATCH } = await import('@/app/api/profile/route');
    const response = await PATCH(
      new Request('http://localhost/api/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'taken-name',
          displayName: 'Creator Name',
        }),
      }) as never
    );

    const data = await response.json();
    expect(response.status).toBe(409);
    expect(data.fieldErrors.username).toContain('already taken');
  });
});
