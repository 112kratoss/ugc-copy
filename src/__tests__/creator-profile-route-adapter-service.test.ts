import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { getCreatorProfileRouteResponse } from '@/lib/creator-profile-route-adapter-service';
import type { getCreatorProfilePageData } from '@/lib/creator-profile';

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
    items: [],
    pageInfo: {
      hasMore: false,
      nextLimit: null,
      nextOffset: null,
      limit: 48,
      offset: 0,
    },
  };
}

describe('creator profile route adapter service', () => {
  it('loads anonymous creator profiles with public viewer-aware caching', async () => {
    const getCreatorProfilePageDataMock = vi.fn(async () => createProfileData());
    const createUserClientMock = vi.fn();

    const response = await getCreatorProfileRouteResponse({
      request: new Request('http://localhost/api/creators/luna?limit=48&offset=24', {
        headers: {
          'x-request-id': 'creator-profile-anon-1',
          'x-vercel-ip-country': 'IN',
        },
      }),
      context: { params: Promise.resolve({ username: 'luna' }) },
      dependencies: {
        createUserClient: createUserClientMock,
        getCreatorProfilePageData: getCreatorProfilePageDataMock as unknown as typeof getCreatorProfilePageData,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, s-maxage=60, stale-while-revalidate=300');
    expect(response.headers.get('Vary')).toBe('Authorization, x-vercel-ip-country');
    expect(response.headers.get('x-request-id')).toBe('creator-profile-anon-1');
    await expect(response.json()).resolves.toMatchObject({
      profile: { id: 'creator-1', username: 'luna' },
      viewer: { isOwner: false, isFollowing: false },
    });
    expect(createUserClientMock).not.toHaveBeenCalled();
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
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Vary')).toBe('Authorization, x-vercel-ip-country');
    await expect(response.json()).resolves.toMatchObject({
      viewer: { isOwner: false, isFollowing: true },
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
        getCreatorProfilePageData: vi.fn(async () => null) as unknown as typeof getCreatorProfilePageData,
      },
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Creator not found.' });
  });
});
