import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { getCreatorProfileRouteResponse } from '@/lib/creator-profile-route-adapter-service';
import type { getCreatorProfilePageData } from '@/lib/creator-profile';
import type { ShowcaseFeedItem } from '@/lib/showcase';

// The read limiter needs a service client these tests deliberately do not
// build. Its behaviour is asserted directly in the feed and post-detail adapter
// tests; here it only has to stay out of the way.
vi.mock('@/lib/backend-rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/backend-rate-limit')>()),
  enforceBackendRateLimit: vi.fn(),
}));

function createUserClient(userId: string | null) {
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: userId ? { id: userId } : null },
        error: null,
      })),
    },
  } as unknown as SupabaseClient;
}

type Row = Record<string, unknown>;

/**
 * The service client the block check and the viewer pass read: `user_blocks`,
 * `post_saves` and `post_resource_bundle_purchases`, filtered as PostgREST
 * would filter them.
 */
function createAdminClient({
  userBlocks = [],
  postSaves = [],
  bundlePurchases = [],
}: {
  userBlocks?: Array<{ blocker_user_id: string; blocked_user_id: string }>;
  postSaves?: Array<{ user_id: string; post_id: string }>;
  bundlePurchases?: Array<{ buyer_user_id: string; bundle_id: string }>;
} = {}) {
  const tables: Record<string, Row[]> = {
    user_blocks: userBlocks,
    post_saves: postSaves,
    post_resource_bundle_purchases: bundlePurchases,
  };
  const from = vi.fn((table: string) => {
    const rows = tables[table];
    if (!rows) throw new Error(`Unexpected table: ${table}`);
    const filters: Array<(row: Row) => boolean> = [];
    const query = {
      select() {
        return query;
      },
      eq(column: string, value: unknown) {
        filters.push((row) => row[column] === value);
        return query;
      },
      in(column: string, values: unknown[]) {
        filters.push((row) => values.includes(row[column]));
        return query;
      },
      then<TResult1 = { data: Row[]; error: null }, TResult2 = never>(
        onfulfilled?: ((value: { data: Row[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ) {
        return Promise.resolve({
          data: rows.filter((row) => filters.every((filter) => filter(row))),
          error: null as null,
        }).then(onfulfilled, onrejected);
      },
    };
    return query;
  });

  return { client: { from } as unknown as SupabaseClient, from };
}

function createItem(id: string, overrides: Partial<ShowcaseFeedItem> = {}): ShowcaseFeedItem {
  return {
    id,
    mediaUrl: `https://cdn.example.com/${id}.png`,
    mediaKind: 'image',
    model: 'nano-banana-2',
    title: id,
    prompt: '',
    body: '',
    category: 'image',
    postFormat: 'media',
    saveCount: 0,
    remixCount: 0,
    commentCount: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
    creator: { id: 'creator-1', username: 'luna', name: 'Luna Studio', avatar: null },
    sourceKind: 'magicbooklet',
    sourceTool: null,
    generationId: `gen-${id}`,
    asset: null,
    canRemix: true,
    ...overrides,
  };
}

function createRecipe(id: string, postId: string): NonNullable<ShowcaseFeedItem['asset']> {
  return {
    id,
    postId,
    title: 'Launch hook recipe',
    accessMode: 'paid',
    priceUsdCents: 500,
    previewText: 'Buy to unlock the full prompt.',
    allowRemix: true,
  };
}

function createProfileData(profileId = 'creator-1') {
  return {
    profile: {
      id: profileId,
      username: 'luna',
      displayName: 'Luna Studio',
      bio: 'Creator portfolio',
      avatarUrl: 'https://cdn.example.com/avatar.jpg',
      coverUrl: 'https://cdn.example.com/cover.jpg',
      websiteUrl: 'https://luna.example',
      twitterHandle: null,
      instagramHandle: 'lunastudio',
      tiktokHandle: null,
      location: 'Kochi',
    },
    stats: {
      publicCreations: 1,
      totalSaves: 12,
      totalRemixes: 3,
      unlocks: 1,
      totalUnlockSales: 2,
      toolsUsed: [{ slug: 'runway', label: 'Runway', count: 1 }],
    },
    items: [] as ShowcaseFeedItem[],
    pageInfo: {
      hasMore: false,
      nextLimit: null as number | null,
      nextOffset: null as number | null,
      limit: 48,
      offset: 0,
    },
  };
}

const noBlock = { creatorBlockedViewer: false, viewerBlockedCreator: false };

function signedInRequest(path = 'http://localhost/api/creators/luna') {
  return new Request(path, {
    headers: { Authorization: 'Bearer viewer-token' },
  });
}

describe('creator profile route adapter service', () => {
  it('loads anonymous creator profiles with public viewer-aware caching', async () => {
    const getCreatorProfilePageDataMock = vi.fn(async () => ({
      ...createProfileData(),
      items: [createItem('post-1')],
    }));
    const createUserClientMock = vi.fn();
    const loadCreatorBlockRelationship = vi.fn();

    const response = await getCreatorProfileRouteResponse({
      request: new Request('http://localhost/api/creators/luna?limit=48&offset=24', {
        headers: {
          'x-request-id': 'creator-profile-anon-1',
          'x-vercel-ip-country': 'IN',
        },
      }),
      context: { params: Promise.resolve({ username: 'luna' }) },
      dependencies: {
        createServiceClient: vi.fn(() => ({}) as SupabaseClient),
        createUserClient: createUserClientMock,
        getCreatorProfilePageData: getCreatorProfilePageDataMock as unknown as typeof getCreatorProfilePageData,
        loadCreatorBlockRelationship,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, s-maxage=60, stale-while-revalidate=300');
    expect(response.headers.get('Vary')).toBe('Authorization, x-vercel-ip-country');
    expect(response.headers.get('x-request-id')).toBe('creator-profile-anon-1');
    const body = await response.json();
    expect(body).toMatchObject({
      profile: { id: 'creator-1', username: 'luna' },
      viewer: { isOwner: false, isFollowing: false, blockedByViewer: false },
    });
    // A publicly cached answer carries no one's saved state.
    expect(body.items[0]).not.toHaveProperty('isSaved');
    expect(createUserClientMock).not.toHaveBeenCalled();
    expect(loadCreatorBlockRelationship).not.toHaveBeenCalled();
    expect(getCreatorProfilePageDataMock).toHaveBeenCalledWith('luna', {
      limit: 48,
      offset: 24,
      countryCode: 'IN',
    });
  });

  it('adds owner and follow state for authenticated creator profile requests', async () => {
    const getCreatorProfilePageDataMock = vi.fn(async () => createProfileData());
    const getCreatorFollowStateForRoute = vi.fn(async () => ({
      ok: true as const,
      body: { following: true },
    }));

    const response = await getCreatorProfileRouteResponse({
      request: new Request('http://localhost/api/creators/luna', {
        headers: {
          Authorization: 'Bearer viewer-token',
          'x-request-id': 'creator-profile-auth-1',
        },
      }),
      context: { params: Promise.resolve({ username: 'luna' }) },
      dependencies: {
        createServiceClient: vi.fn(() => ({ kind: 'admin' }) as unknown as SupabaseClient),
        createUserClient: vi.fn(() => createUserClient('viewer-1')),
        getCreatorFollowStateForRoute,
        getCreatorProfilePageData: getCreatorProfilePageDataMock as unknown as typeof getCreatorProfilePageData,
        loadCreatorBlockRelationship: vi.fn(async () => noBlock),
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Vary')).toBe('Authorization, x-vercel-ip-country');
    await expect(response.json()).resolves.toMatchObject({
      viewer: { isOwner: false, isFollowing: true, blockedByViewer: false },
    });
    expect(getCreatorFollowStateForRoute).toHaveBeenCalledWith(expect.objectContaining({
      followerId: 'viewer-1',
      followingId: 'creator-1',
    }));
  });

  it('returns not found for unknown creator usernames', async () => {
    const response = await getCreatorProfileRouteResponse({
      request: new Request('http://localhost/api/creators/missing'),
      context: { params: Promise.resolve({ username: 'missing' }) },
      dependencies: {
        createServiceClient: vi.fn(() => ({}) as SupabaseClient),
        getCreatorProfilePageData: vi.fn(async () => null) as unknown as typeof getCreatorProfilePageData,
      },
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Creator not found.' });
  });

  describe('a blocked pair', () => {
    it.each([
      {
        kind: 'the creator blocked the viewer',
        userBlocks: [{ blocker_user_id: 'creator-1', blocked_user_id: 'viewer-1' }],
      },
      {
        // The creator's block wins: the viewer's own block does not reopen
        // a page the creator closed to them.
        kind: 'each blocked the other',
        userBlocks: [
          { blocker_user_id: 'creator-1', blocked_user_id: 'viewer-1' },
          { blocker_user_id: 'viewer-1', blocked_user_id: 'creator-1' },
        ],
      },
    ])('answers not found when $kind', async ({ userBlocks }) => {
      const admin = createAdminClient({ userBlocks });
      const getCreatorFollowStateForRoute = vi.fn();

      const response = await getCreatorProfileRouteResponse({
        request: signedInRequest(),
        context: { params: Promise.resolve({ username: 'luna' }) },
        dependencies: {
          createServiceClient: vi.fn(() => admin.client),
          createUserClient: vi.fn(() => createUserClient('viewer-1')),
          getCreatorFollowStateForRoute,
          getCreatorProfilePageData: vi.fn(async () => ({
            ...createProfileData(),
            items: [createItem('post-1')],
          })) as unknown as typeof getCreatorProfilePageData,
        },
      });

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: 'Creator not found.' });
      expect(getCreatorFollowStateForRoute).not.toHaveBeenCalled();
    });

    it('gives the viewer who blocked the creator the header, the totals and no posts', async () => {
      const admin = createAdminClient({
        userBlocks: [{ blocker_user_id: 'viewer-1', blocked_user_id: 'creator-1' }],
      });
      const getCreatorFollowStateForRoute = vi.fn();
      const data = {
        ...createProfileData(),
        items: [createItem('post-1'), createItem('post-2')],
        pageInfo: { hasMore: true, nextLimit: 48, nextOffset: 24, limit: 24, offset: 0 },
      };

      const response = await getCreatorProfileRouteResponse({
        request: signedInRequest(),
        context: { params: Promise.resolve({ username: 'luna' }) },
        dependencies: {
          createServiceClient: vi.fn(() => admin.client),
          createUserClient: vi.fn(() => createUserClient('viewer-1')),
          getCreatorFollowStateForRoute,
          getCreatorProfilePageData: vi.fn(async () => data) as unknown as typeof getCreatorProfilePageData,
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
      await expect(response.json()).resolves.toEqual({
        profile: data.profile,
        stats: data.stats,
        items: [],
        pageInfo: { hasMore: false, nextLimit: null, nextOffset: null, limit: 24, offset: 0 },
        viewer: { isOwner: false, isFollowing: false, blockedByViewer: true },
      });
      // A block removes both follows, so there is no follow state to read,
      // and no saved state for posts that are not sent.
      expect(getCreatorFollowStateForRoute).not.toHaveBeenCalled();
      expect(admin.from.mock.calls.map(([table]) => table)).toEqual(['user_blocks']);
    });

    it('serves the page as usual when neither has blocked the other', async () => {
      const admin = createAdminClient({
        userBlocks: [{ blocker_user_id: 'viewer-1', blocked_user_id: 'someone-else' }],
      });

      const response = await getCreatorProfileRouteResponse({
        request: signedInRequest(),
        context: { params: Promise.resolve({ username: 'luna' }) },
        dependencies: {
          createServiceClient: vi.fn(() => admin.client),
          createUserClient: vi.fn(() => createUserClient('viewer-1')),
          getCreatorFollowStateForRoute: vi.fn(async () => ({
            ok: true as const,
            body: { following: false },
          })),
          getCreatorProfilePageData: vi.fn(async () => ({
            ...createProfileData(),
            items: [createItem('post-1')],
          })) as unknown as typeof getCreatorProfilePageData,
        },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.items.map((item: ShowcaseFeedItem) => item.id)).toEqual(['post-1']);
      expect(body.viewer).toEqual({ isOwner: false, isFollowing: false, blockedByViewer: false });
    });

    it('fails closed when the block check cannot be read', async () => {
      const logError = vi.fn();

      const response = await getCreatorProfileRouteResponse({
        request: signedInRequest(),
        context: { params: Promise.resolve({ username: 'luna' }) },
        dependencies: {
          createServiceClient: vi.fn(() => ({ kind: 'admin' }) as unknown as SupabaseClient),
          createUserClient: vi.fn(() => createUserClient('viewer-1')),
          getCreatorProfilePageData: vi.fn(async () => createProfileData()) as unknown as typeof getCreatorProfilePageData,
          loadCreatorBlockRelationship: vi.fn(async () => {
            throw new Error('user_blocks unavailable');
          }),
          logError,
        },
      });

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: 'Failed to fetch creator profile.' });
      expect(logError).toHaveBeenCalledWith(
        'Creator profile route error:',
        expect.objectContaining({ message: 'user_blocks unavailable' }),
      );
    });
  });

  it('marks saved posts and bought recipes for the viewer on later pages too', async () => {
    const admin = createAdminClient({
      postSaves: [
        { user_id: 'viewer-1', post_id: 'post-25' },
        { user_id: 'someone-else', post_id: 'post-26' },
      ],
      bundlePurchases: [{ buyer_user_id: 'viewer-1', bundle_id: 'bundle-26' }],
    });
    const getCreatorProfilePageDataMock = vi.fn(async () => ({
      ...createProfileData(),
      // Later pages carry no totals.
      stats: undefined,
      items: [
        createItem('post-25'),
        createItem('post-26', { asset: createRecipe('bundle-26', 'post-26') }),
        createItem('post-27', { asset: createRecipe('bundle-27', 'post-27') }),
      ],
      pageInfo: { hasMore: false, nextLimit: null, nextOffset: null, limit: 24, offset: 24 },
    }));

    const response = await getCreatorProfileRouteResponse({
      request: signedInRequest('http://localhost/api/creators/luna?limit=24&offset=24'),
      context: { params: Promise.resolve({ username: 'luna' }) },
      dependencies: {
        createServiceClient: vi.fn(() => admin.client),
        createUserClient: vi.fn(() => createUserClient('viewer-1')),
        getCreatorFollowStateForRoute: vi.fn(async () => ({
          ok: true as const,
          body: { following: false },
        })),
        getCreatorProfilePageData: getCreatorProfilePageDataMock as unknown as typeof getCreatorProfilePageData,
      },
    });

    expect(response.status).toBe(200);
    expect(getCreatorProfilePageDataMock).toHaveBeenCalledWith('luna', expect.objectContaining({ offset: 24 }));
    const body = await response.json();
    expect(body).not.toHaveProperty('stats');
    expect(body.items).toEqual([
      expect.objectContaining({ id: 'post-25', isSaved: true }),
      // Bought: the recipe's remix is open to this viewer.
      expect.objectContaining({ id: 'post-26', isSaved: false, canRemix: true, remixCapability: 'public' }),
      expect.objectContaining({ id: 'post-27', isSaved: false, canRemix: false, remixCapability: 'unlock_required' }),
    ]);
  });
});
