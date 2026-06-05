import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getShowcaseFeedPageMock = vi.fn(async (_options?: unknown) => {
  void _options;
  return {
    items: [] as unknown[],
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
      countryCode: null,
    });
  });

  it('treats the all tool filter as the unfiltered community feed', async () => {
    const { GET } = await import('@/app/api/showcase/feed/route');
    const response = await GET(new NextRequest('http://localhost/api/showcase/feed?tool=all&offset=12'));

    expect(response.status).toBe(200);
    expect(getShowcaseFeedPageMock).toHaveBeenCalledWith({
      category: 'all',
      sort: 'recent',
      offset: 12,
      limit: 12,
      viewerUserId: null,
      tool: null,
      unlock: 'all',
      resource: 'all',
      countryCode: null,
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
      countryCode: null,
    });
  });

  it('strips raw unlock resource payloads from anonymous feed responses', async () => {
    getShowcaseFeedPageMock.mockResolvedValue({
      items: [
        {
          id: 'post-1',
          mediaUrl: 'https://example.com/image.jpg',
          mediaKind: 'image',
          model: 'nano-banana-2',
          title: 'Paid post',
          prompt: 'Public post prompt',
          body: 'Public post body',
          category: 'image',
          postFormat: 'media',
          saveCount: 0,
          remixCount: 0,
          createdAt: '2026-04-02T10:00:00.000Z',
          creator: {
            id: 'creator-1',
            username: 'creator',
            name: 'Creator',
            avatar: null,
          },
          sourceKind: 'magicbooklet',
          sourceTool: null,
          generationId: 'gen-1',
          canRemix: false,
          asset: {
            id: 'bundle-1',
            postId: 'post-1',
            title: 'Prompt pack',
            accessMode: 'paid',
            priceUsdCents: 900,
            previewText: 'Safe preview text.',
            allowRemix: false,
            resourceKinds: ['prompt', 'notes'],
            lockedPreview: {
              resourceKinds: ['prompt', 'notes'],
              attachmentPreviews: [],
              itemCounts: { prompt: 1, note: 1 },
              itemPreviews: [
                {
                  type: 'prompt',
                  title: 'Prompt',
                  role: 'primary',
                  sectionId: null,
                  remixUse: 'none',
                },
              ],
              hasPrompt: true,
              hasNotes: true,
              hasWorkflow: false,
              hasRemix: false,
              updatedAt: '2026-04-02T10:00:00.000Z',
            },
            resourceItems: [
              {
                type: 'prompt',
                title: 'Prompt',
                textContent: 'SECRET_ROUTE_PROMPT',
                externalUrl: 'https://secret.example/prompt',
                storagePath: 'creator/private/prompt.txt',
                workflowSnapshot: { nodes: [{ id: 'secret-route-node' }] },
              },
            ],
            resourceSections: [
              {
                id: 'secret-section',
                title: 'Secret section',
              },
            ],
          },
        },
      ],
      pageInfo: {
        hasMore: false,
        nextOffset: null,
        limit: 12,
        offset: 0,
      },
    });

    const { GET } = await import('@/app/api/showcase/feed/route');
    const response = await GET(new NextRequest('http://localhost/api/showcase/feed'));
    const responseBody = await response.text();
    const data = JSON.parse(responseBody);

    expect(response.status).toBe(200);
    expect(data.items[0].asset).not.toHaveProperty('resourceItems');
    expect(data.items[0].asset).not.toHaveProperty('resourceSections');
    expect(responseBody).not.toContain('SECRET_ROUTE_PROMPT');
    expect(responseBody).not.toContain('https://secret.example');
    expect(responseBody).not.toContain('creator/private');
    expect(responseBody).not.toContain('workflowSnapshot');
  });
});
