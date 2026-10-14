import { describe, expect, it, vi } from 'vitest';

import {
  getProfileForRoute,
  loadOwnerProfileTotals,
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

const COUNTS = { creations: 6, posts: 3, archivedPosts: 1, saved: 2 };
const SALES = { earningsUsdCents: 1250, listingCount: 3, salesCount: 4 };

function createClient({
  profiles = [] as ProfileRow[],
  rateLimitAllowed = true,
  upsertError = null as { code?: string; message?: string } | null,
  counts = COUNTS as unknown,
  countsError = null as { message: string } | null,
  sales = SALES as unknown,
  salesError = null as { message: string } | null,
} = {}) {
  const rows = [...profiles];
  const rpc = vi.fn(async (name: string) => {
    if (name === 'owner_profile_counts') return { data: countsError ? null : counts, error: countsError };
    if (name === 'get_owner_post_sales_summary') return { data: salesError ? null : sales, error: salesError };
    return {
      data: {
        allowed: rateLimitAllowed,
        limit: 30,
        remaining: rateLimitAllowed ? 29 : 0,
        retryAfterSeconds: rateLimitAllowed ? 0 : 40,
        resetAt: '2026-06-22T06:30:00.000Z',
      },
      error: null,
    };
  });
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
                // PostgREST's merge upsert: an existing row changes only in the
                // columns the body carries; a new row starts from the defaults.
                const nextProfile = {
                  ...(index === -1 ? emptyProfileRow(profileId) : rows[index]),
                  ...values,
                } as ProfileRow;

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

function emptyProfileRow(id: string): ProfileRow {
  return {
    id,
    username: null,
    display_name: null,
    bio: null,
    avatar_url: null,
    cover_url: null,
    website_url: null,
    twitter_handle: null,
    instagram_handle: null,
    tiktok_handle: null,
    location: null,
    credits: null,
  };
}

function storedProfile(): ProfileRow {
  return {
    id: user.id,
    username: 'luna',
    display_name: 'Luna Dreams',
    bio: null,
    avatar_url: null,
    cover_url: null,
    website_url: null,
    twitter_handle: null,
    instagram_handle: null,
    tiktok_handle: null,
    location: null,
    credits: 12,
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
        stats: COUNTS,
        sales: SALES,
      },
    });
  });

  it('says the library totals and the seller summary beside a stored profile, from the service-role RPCs', async () => {
    const client = createClient({ profiles: [storedProfile()] });

    const result = await getProfileForRoute({ user, client: client.client });

    expect(result).toMatchObject({
      ok: true,
      response: { id: user.id, username: 'luna', credits: 12, stats: COUNTS, sales: SALES },
    });
    expect(client.rpc).toHaveBeenCalledWith('owner_profile_counts', { p_user_id: user.id });
    expect(client.rpc).toHaveBeenCalledWith('get_owner_post_sales_summary', { p_owner_id: user.id });
  });

  it('leaves a total out when its read fails, and still returns the profile', async () => {
    const client = createClient({ profiles: [storedProfile()], countsError: { message: 'count timed out' } });

    const result = await getProfileForRoute({ user, client: client.client });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.response.username).toBe('luna');
    expect(result.response).not.toHaveProperty('stats');
    expect(result.response.sales).toEqual(SALES);
  });

  it('keeps every total a whole, non-negative number whatever the database sends', async () => {
    const client = createClient({
      profiles: [storedProfile()],
      counts: { creations: '7', posts: -2, archivedPosts: 1.6, saved: null },
      sales: { earningsUsdCents: '90', listingCount: undefined },
    });

    const result = await getProfileForRoute({ user, client: client.client });

    expect(result).toMatchObject({
      ok: true,
      response: {
        stats: { creations: 7, posts: 0, archivedPosts: 2, saved: 0 },
        sales: { earningsUsdCents: 90, listingCount: 0, salesCount: 0 },
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

  it('writes only the fields a save carries, so a bio edit keeps the stored links', async () => {
    const client = createClient({
      profiles: [{
        ...storedProfile(),
        website_url: 'https://luna.example',
        instagram_handle: 'luna.dreams',
        location: 'Bengaluru',
      }],
    });

    const result = await updateProfileForRoute({
      userId: user.id,
      body: { username: 'luna', bio: 'Painting with light.' },
      client: client.client,
      invalidateFeedCache: vi.fn(),
    });

    // Absent keys never reach the write, so the database keeps those columns.
    expect(client.upserts).toEqual([{ id: user.id, username: 'luna', bio: 'Painting with light.' }]);
    expect(result).toMatchObject({
      ok: true,
      response: {
        displayName: 'Luna Dreams',
        bio: 'Painting with light.',
        websiteUrl: 'https://luna.example',
        instagramHandle: 'luna.dreams',
        location: 'Bengaluru',
      },
    });
  });

  it('clears a field the save sends as null and keeps the rest', async () => {
    const client = createClient({
      profiles: [{ ...storedProfile(), website_url: 'https://luna.example', location: 'Bengaluru' }],
    });

    const result = await updateProfileForRoute({
      userId: user.id,
      body: { username: 'luna', websiteUrl: null },
      client: client.client,
      invalidateFeedCache: vi.fn(),
    });

    expect(client.upserts).toEqual([{ id: user.id, username: 'luna', website_url: null }]);
    expect(result).toMatchObject({ ok: true, response: { websiteUrl: null, location: 'Bengaluru' } });
    expect(client.rows[0]).toMatchObject({ website_url: null, location: 'Bengaluru', display_name: 'Luna Dreams' });
  });

  it('still saves the full ten-field body the web sends, normalising the links', async () => {
    const client = createClient({
      profiles: [{ ...storedProfile(), website_url: 'https://old.example', twitter_handle: 'old_handle' }],
    });

    const result = await updateProfileForRoute({
      userId: user.id,
      body: {
        username: 'luna',
        displayName: 'Luna Dreams',
        bio: 'Painting with light.',
        avatarUrl: '',
        coverUrl: '',
        websiteUrl: 'https://luna.example',
        twitterHandle: '@luna_dreams',
        instagramHandle: 'https://www.instagram.com/luna.dreams/',
        tiktokHandle: '',
        location: ' Bengaluru ',
      },
      client: client.client,
      invalidateFeedCache: vi.fn(),
    });

    expect(client.upserts).toEqual([{
      id: user.id,
      username: 'luna',
      display_name: 'Luna Dreams',
      bio: 'Painting with light.',
      avatar_url: null,
      cover_url: null,
      website_url: 'https://luna.example',
      twitter_handle: 'luna_dreams',
      instagram_handle: 'luna.dreams',
      tiktok_handle: null,
      location: 'Bengaluru',
    }]);
    expect(result).toMatchObject({
      ok: true,
      response: {
        websiteUrl: 'https://luna.example',
        twitterHandle: 'luna_dreams',
        instagramHandle: 'luna.dreams',
        tiktokHandle: null,
        location: 'Bengaluru',
        credits: 12,
      },
    });
  });

  it('refuses a social link to another site with a field error and writes nothing', async () => {
    const client = createClient({ profiles: [storedProfile()] });

    await expect(updateProfileForRoute({
      userId: user.id,
      body: { username: 'luna', instagramHandle: 'https://evil.example/luna' },
      client: client.client,
      invalidateFeedCache: vi.fn(),
    })).resolves.toEqual({
      ok: false,
      status: 400,
      error: 'Please fix the highlighted fields.',
      fieldErrors: { instagramHandle: 'Enter your Instagram username or profile link.' },
    });
    expect(client.upserts).toHaveLength(0);
  });

  it('refuses a newly claimed reserved handle before any write', async () => {
    const client = createClient({ profiles: [storedProfile()] });
    const invalidateFeedCache = vi.fn();

    await expect(updateProfileForRoute({
      userId: user.id,
      body: { username: 'Support', displayName: 'Luna Dreams' },
      client: client.client,
      invalidateFeedCache,
    })).resolves.toEqual({
      ok: false,
      status: 400,
      error: 'That handle is reserved.',
      fieldErrors: { username: 'That handle is reserved.' },
    });
    expect(client.upserts).toHaveLength(0);
    expect(invalidateFeedCache).not.toHaveBeenCalled();
  });

  it('lets an account that already holds a reserved handle keep it through an unrelated edit', async () => {
    const client = createClient({ profiles: [{ ...storedProfile(), username: 'support' }] });

    const result = await updateProfileForRoute({
      userId: user.id,
      body: { username: 'support', bio: 'Answers within a day.' },
      client: client.client,
      invalidateFeedCache: vi.fn(),
    });

    expect(result).toMatchObject({ ok: true, response: { username: 'support', bio: 'Answers within a day.' } });
  });

  it('exports the totals loader the web profile page reads', async () => {
    const client = createClient();

    await expect(loadOwnerProfileTotals(client.client, user.id)).resolves.toEqual({ stats: COUNTS, sales: SALES });
    expect(client.from).not.toHaveBeenCalled();
  });
});
