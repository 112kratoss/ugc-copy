import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getShowcaseFeedPageMock = vi.fn(async (_options?: unknown) => {
  void _options;
  return {
    items: [],
    pageInfo: {
      hasMore: false,
      nextOffset: null,
      limit: 12,
      offset: 0,
    },
  };
});

const getUserMock = vi.fn(async () => ({
  data: {
    user: { id: 'user-1' },
  },
}));

vi.mock('@/lib/showcase-feed', () => ({
  getShowcaseFeedPage: (options: unknown) => getShowcaseFeedPageMock(options),
}));

vi.mock('@/lib/server-helpers', () => ({
  createUserClient: () => ({
    auth: {
      getUser: () => getUserMock(),
    },
  }),
}));

describe('/api/showcase/feed route', () => {
  beforeEach(() => {
    vi.resetModules();
    getShowcaseFeedPageMock.mockClear();
    getUserMock.mockClear();
    getShowcaseFeedPageMock.mockResolvedValue({
      items: [],
      pageInfo: {
        hasMore: false,
        nextOffset: null,
        limit: 12,
        offset: 0,
      },
    });
    getUserMock.mockResolvedValue({
      data: {
        user: { id: 'user-1' },
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a public cache header for anonymous feed requests', async () => {
    const { GET } = await import('@/app/api/showcase/feed/route');
    const response = await GET(new NextRequest('http://localhost/api/showcase/feed'));

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, s-maxage=60, stale-while-revalidate=300');
    expect(getShowcaseFeedPageMock).toHaveBeenCalledWith({
      category: 'all',
      sort: 'recent',
      offset: 0,
      limit: 12,
      viewerUserId: null,
      tool: null,
      unlock: 'all',
      resource: 'all',
    });
  });

  it('disables shared caching for personalized feed requests', async () => {
    const { GET } = await import('@/app/api/showcase/feed/route');
    const response = await GET(
      new NextRequest('http://localhost/api/showcase/feed', {
        headers: {
          Authorization: 'Bearer test-token',
        },
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(getUserMock).toHaveBeenCalledTimes(1);
    expect(getShowcaseFeedPageMock).toHaveBeenCalledWith({
      category: 'all',
      sort: 'recent',
      offset: 0,
      limit: 12,
      viewerUserId: 'user-1',
      tool: null,
      unlock: 'all',
      resource: 'all',
    });
  });
});
