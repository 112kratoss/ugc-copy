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

function createAdminClient() {
  return {
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
      };
    },
  };
}

const createUserClientMock = vi.fn(() => ({
  auth: {
    getUser: vi.fn(async () => ({
      data: {
        user: { id: authUserId },
      },
      error: null,
    })),
  },
}));

vi.mock('@/lib/server-helpers', () => ({
  createUserClient: () => createUserClientMock(),
  createServiceClient: () => createAdminClient(),
}));

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
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the current profile and suggested username when missing', async () => {
    const { GET } = await import('@/app/api/profile/route');
    const response = await GET(new Request('http://localhost/api/profile') as never);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.username).toBeNull();
    expect(data.suggestedUsername).toBe('creator-11111111');
    expect(data.displayName).toBe('Existing Creator');
    expect(data.credits).toBe(25);
  });

  it('normalizes usernames to lowercase on successful updates', async () => {
    const { PATCH } = await import('@/app/api/profile/route');
    const response = await PATCH(
      new Request('http://localhost/api/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
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
    expect(data.username).toBe('creator-name');
    expect(profilesState[0].username).toBe('creator-name');
  });

  it('validates an available username without updating the profile', async () => {
    const { POST } = await import('@/app/api/profile/validate/route');
    const response = await POST(
      new Request('http://localhost/api/profile/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'available-name',
          displayName: 'Creator Name',
        }),
      }) as never
    );

    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(profilesState[0].username).toBeNull();
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
