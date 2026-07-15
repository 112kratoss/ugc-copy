import { describe, expect, it, vi } from 'vitest';

import {
  getProfileForRoute,
  updateProfileForRoute,
  type ProfileRouteClient,
  type ProfileRouteUser,
} from '@/lib/profile-route-service';

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

const user: ProfileRouteUser = {
  id: '11111111-1111-1111-1111-111111111111',
  email: 'creator@example.test',
  user_metadata: { full_name: 'Creator Metadata', avatar_url: 'https://example.test/avatar.png' },
};

function createClient({
  profiles = [] as ProfileRow[],
  rateLimitAllowed = true,
  upsertError = null as { code?: string; message?: string } | null,
} = {}) {
  const rows = [...profiles];
  const rpc = vi.fn(async () => ({
    data: {
      allowed: rateLimitAllowed,
      limit: 30,
      remaining: rateLimitAllowed ? 29 : 0,
      retryAfterSeconds: rateLimitAllowed ? 0 : 40,
      resetAt: '2026-06-22T06:30:00.000Z',
    },
    error: null,
  }));
  const upserts: Record<string, unknown>[] = [];

  const from = vi.fn((table: string) => {
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
        const match = rows.find((profile) =>
          Object.entries(filters).every(([key, value]) => (profile as Record<string, unknown>)[key] === value) &&
          (!excludedId || profile.id !== excludedId)
        ) ?? null;

        return { data: match, error: null };
      },
      upsert(values: Record<string, unknown>) {
        upserts.push(values);
        return {
          select() {
            return {
              async single() {
                if (upsertError) {
                  return { data: null, error: upsertError };
                }

                const profileId = values.id as string;
                const index = rows.findIndex((profile) => profile.id === profileId);
                const nextProfile: ProfileRow = {
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
                  credits: index === -1 ? null : rows[index].credits,
                };

                if (index === -1) {
                  rows.push(nextProfile);
                } else {
                  rows[index] = nextProfile;
                }

                return { data: nextProfile, error: null };
              },
            };
          },
        };
      },
    };

    return query;
  });

  return {
    client: { rpc, from } as unknown as ProfileRouteClient,
    rpc,
    from,
    rows,
    upserts,
  };
}

describe('profile route service', () => {
  it('returns a starter profile payload when no profile row exists', async () => {
    const client = createClient();

    await expect(getProfileForRoute({ user, client: client.client })).resolves.toEqual({
      ok: true,
      response: {
        id: user.id,
        username: null,
        suggestedUsername: 'creator-11111111',
        displayName: 'Creator Metadata',
        bio: null,
        avatarUrl: 'https://example.test/avatar.png',
        coverUrl: null,
        websiteUrl: null,
        twitterHandle: null,
        instagramHandle: null,
        tiktokHandle: null,
        location: null,
        credits: null,
      },
    });
  });

  it('rate limits profile updates before validation and persistence', async () => {
    const client = createClient({ rateLimitAllowed: false });

    const result = await updateProfileForRoute({
      userId: user.id,
      body: {
        username: 'taken-name',
        displayName: 'Creator Name',
      },
      client: client.client,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 429,
      code: 'RATE_LIMITED',
      retryAfterSeconds: 40,
    });
    expect(client.rpc).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'profile:update',
      p_subject_key: user.id,
      p_limit: 30,
      p_window_seconds: 600,
    });
    expect(client.from).not.toHaveBeenCalled();
    expect(client.upserts).toHaveLength(0);
  });

  it('validates, normalizes, and upserts profile updates', async () => {
    const client = createClient({
      profiles: [{
        id: user.id,
        username: null,
        display_name: 'Existing',
        bio: null,
        avatar_url: null,
        cover_url: null,
        website_url: null,
        twitter_handle: null,
        instagram_handle: null,
        tiktok_handle: null,
        location: null,
        credits: 25,
      }],
    });
    const invalidateFeedCache = vi.fn();

    const result = await updateProfileForRoute({
      userId: user.id,
      body: {
        username: 'Creator-Name',
        displayName: 'Creator Name',
        bio: 'UGC creator for product demos.',
      },
      client: client.client,
      invalidateFeedCache,
    });

    expect(client.upserts[0]).toMatchObject({
      id: user.id,
      username: 'creator-name',
      display_name: 'Creator Name',
      bio: 'UGC creator for product demos.',
    });
    expect(result).toMatchObject({
      ok: true,
      response: {
        id: user.id,
        username: 'creator-name',
        suggestedUsername: 'creator-11111111',
        displayName: 'Creator Name',
        credits: 25,
      },
    });
    expect(invalidateFeedCache).toHaveBeenCalledOnce();
  });

  it('returns stable username conflict errors from profile upserts', async () => {
    const client = createClient({
      upsertError: { code: '23505', message: 'duplicate key' },
    });
    const invalidateFeedCache = vi.fn();

    await expect(updateProfileForRoute({
      userId: user.id,
      body: {
        username: 'creator-name',
        displayName: 'Creator Name',
      },
      client: client.client,
      invalidateFeedCache,
    })).resolves.toEqual({
      ok: false,
      status: 409,
      error: 'That username is already taken.',
      fieldErrors: { username: 'That username is already taken.' },
    });
    expect(invalidateFeedCache).not.toHaveBeenCalled();
  });
});
