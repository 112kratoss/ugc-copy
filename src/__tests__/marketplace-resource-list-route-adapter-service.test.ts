import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mockRequestIdPassthrough } from '@/__tests__/fixtures/request-id-passthrough';

import { getMarketplaceResourceListRouteResponse } from '@/lib/marketplace-resource-list-route-adapter-service';
import { filterMarketplaceItemsForViewer } from '@/lib/marketplace-viewer-filter';
import type { MarketplaceResourceListItem } from '@/lib/post-resource-bundles-server';

function createRequest(search = '', headers: Record<string, string> = {}) {
  return new Request(`http://localhost/api/marketplace/resources${search}`, {
    headers,
  });
}

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

function listItem(id: string, sellerId: string) {
  return { id, seller: { id: sellerId } } as unknown as MarketplaceResourceListItem;
}

function storefrontPage() {
  return {
    items: [
      listItem('resource-1', 'creator-1'),
      listItem('resource-2', 'creator-blocked'),
      listItem('resource-3', 'creator-2'),
    ],
    pageInfo: { hasMore: true, limit: 3, nextOffset: 3, offset: 0 },
  };
}

// The real filter, over a block set in which the viewer and `creator-blocked`
// block each other.
function filterWithBlocks(loadBlockedCreatorIds = vi.fn(async () => new Set(['creator-blocked']))) {
  return {
    loadBlockedCreatorIds,
    filter: ((items, viewerUserId) => filterMarketplaceItemsForViewer(items, viewerUserId, {
      createServiceClient: () => ({ service: 'admin' }) as unknown as SupabaseClient,
      loadBlockedCreatorIds,
    })) as typeof filterMarketplaceItemsForViewer,
  };
}

describe('marketplace resource list route adapter service', () => {
  it('normalizes list filters and returns shared cache headers for anonymous web and mobile clients', async () => {
    const getMarketplaceResourceList = vi.fn(async () => ({
      items: [{ id: 'resource-1' } as unknown as MarketplaceResourceListItem],
      pageInfo: {
        hasMore: false,
        limit: 48,
        nextOffset: null,
        offset: 0,
      },
    }));
    const withProviderFetchRequestId = mockRequestIdPassthrough();

    const response = await getMarketplaceResourceListRouteResponse({
      request: createRequest(
        '?access=paid&resource=prompt&tool=Magic%20Booklet!!&q=%20abc%20&sort=price-high&offset=-10&limit=500',
        {
          'x-request-id': 'resources-list-adapter-1',
          'x-vercel-ip-country': 'IN',
        }
      ),
      dependencies: {
        getMarketplaceResourceList,
        withProviderFetchRequestId,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, s-maxage=60, stale-while-revalidate=300');
    expect(response.headers.get('Vary')).toBe('Authorization, x-vercel-ip-country');
    expect(response.headers.get('x-request-id')).toBe('resources-list-adapter-1');
    await expect(response.json()).resolves.toMatchObject({
      items: [{ id: 'resource-1' }],
    });
    expect(withProviderFetchRequestId).toHaveBeenCalledWith('resources-list-adapter-1', expect.any(Function));
    expect(getMarketplaceResourceList).toHaveBeenCalledWith({
      filter: 'paid',
      resource: 'prompt',
      tool: 'magic-booklet',
      q: 'abc',
      sort: 'price-high',
      offset: 0,
      limit: 48,
      countryCode: 'IN',
    });
  });

  // Blocking promises the person disappears; the storefront was the one list
  // that kept them (2026-10-15 marketplace comparison, finding 02-3).
  it("drops a blocked creator's recipes for a signed-in viewer and keeps the page private", async () => {
    const createUserClientMock = vi.fn(() => createUserClient('viewer-1'));
    const { filter, loadBlockedCreatorIds } = filterWithBlocks();

    const response = await getMarketplaceResourceListRouteResponse({
      request: createRequest('', {
        Authorization: 'Bearer viewer-token',
        'x-request-id': 'resources-list-viewer-1',
      }),
      dependencies: {
        createUserClient: createUserClientMock,
        filterMarketplaceItemsForViewer: filter,
        getMarketplaceResourceList: vi.fn(async () => storefrontPage()),
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Vary')).toBe('Authorization, x-vercel-ip-country');
    const body = await response.json() as { items: MarketplaceResourceListItem[]; pageInfo: unknown };
    expect(body.items.map((item) => item.id)).toEqual(['resource-1', 'resource-3']);
    // The next page still starts after the three the cache returned.
    expect(body.pageInfo).toEqual({ hasMore: true, limit: 3, nextOffset: 3, offset: 0 });
    expect(loadBlockedCreatorIds).toHaveBeenCalledWith(expect.objectContaining({
      creatorIds: ['creator-1', 'creator-blocked', 'creator-2'],
      viewerUserId: 'viewer-1',
    }));
  });

  // Live sweep, 2026-11-17: a signed-in list read took about 1.5 s. The viewer's blocks were read
  // only once the page had come, so every signed-in read paid that round trip after the page's own.
  // They are the viewer's, not the page's: read beside the page, under the same latency both reads end
  // together, and the page is filtered by them with nothing more asked.
  it("reads a signed-in viewer's blocks beside the page, not after it, and filters the page by them", async () => {
    const LATENCY_MS = 40;
    const events: string[] = [];
    const settle = <T,>(name: string, value: T) => {
      events.push(`${name} started`);
      return new Promise<T>((resolve) => setTimeout(() => {
        events.push(`${name} answered`);
        resolve(value);
      }, LATENCY_MS));
    };
    const readMarketplaceViewerBlocks = vi.fn((viewerUserId: string) => settle('blocks', {
      ok: true as const,
      blockedUserIds: new Set(['creator-blocked', viewerUserId === 'viewer-1' ? 'someone-else' : 'unexpected']),
      truncated: false,
    }));
    const loadBlockedCreatorIds = vi.fn(async () => new Set<string>());

    const response = await getMarketplaceResourceListRouteResponse({
      request: createRequest('?sort=recent&offset=4&limit=12', { Authorization: 'Bearer viewer-token' }),
      dependencies: {
        createUserClient: vi.fn(() => createUserClient('viewer-1')),
        getMarketplaceResourceList: vi.fn(() => settle('page', storefrontPage())),
        readMarketplaceViewerBlocks,
        filterMarketplaceItemsForViewer: ((items, viewerUserId, _dependencies, options) => filterMarketplaceItemsForViewer(
          items,
          viewerUserId,
          { createServiceClient: () => ({ service: 'admin' }) as unknown as SupabaseClient, loadBlockedCreatorIds },
          options,
        )) as typeof filterMarketplaceItemsForViewer,
      },
    });

    expect(events).toEqual(['page started', 'blocks started', 'page answered', 'blocks answered']);
    expect(readMarketplaceViewerBlocks).toHaveBeenCalledWith('viewer-1');
    const body = await response.json() as { items: MarketplaceResourceListItem[] };
    expect(body.items.map((item) => item.id)).toEqual(['resource-1', 'resource-3']);
    expect(loadBlockedCreatorIds).not.toHaveBeenCalled();
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('reads no blocks for a signed-out caller', async () => {
    const readMarketplaceViewerBlocks = vi.fn();

    const response = await getMarketplaceResourceListRouteResponse({
      request: createRequest(''),
      dependencies: {
        getMarketplaceResourceList: vi.fn(async () => storefrontPage()),
        readMarketplaceViewerBlocks,
      },
    });

    expect(response.status).toBe(200);
    expect(readMarketplaceViewerBlocks).not.toHaveBeenCalled();
  });

  // What a signed-in read spends its time on, for the production monitor alone, as the feed says it.
  describe('timings', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    const signedInRead = (headers: Record<string, string>) => getMarketplaceResourceListRouteResponse({
      request: createRequest('?sort=recent&offset=4&limit=12', { Authorization: 'Bearer viewer-token', ...headers }),
      dependencies: {
        createUserClient: vi.fn(() => createUserClient('viewer-1')),
        getMarketplaceResourceList: vi.fn(async () => storefrontPage()),
        readMarketplaceViewerBlocks: vi.fn(async () => ({ ok: true as const, blockedUserIds: new Set<string>(), truncated: false })),
      },
    });

    it("say the proxy's admission and each of the route's reads to the performance monitor", async () => {
      const response = await signedInRead({
        'x-performance-monitor': 'warmup',
        'x-magicbooklet-proxy-timing': 'proxy-identity;dur=812.40, proxy-verify;dur=1.10, proxy-lifecycle;dur=810.90',
      });

      const timing = response.headers.get('Server-Timing') ?? '';
      expect(timing).toMatch(/^proxy-identity;dur=812\.40, proxy-verify;dur=1\.10, proxy-lifecycle;dur=810\.90, /);
      for (const phase of ['route-viewer', 'route-blocks', 'route-list', 'route-filter']) {
        expect(timing).toMatch(new RegExp(`${phase};dur=\\d+\\.\\d{2}`));
      }
      expect(response.headers.get('x-scaling-certification-timing')).toBe(timing);
    });

    it('say nothing on an ordinary read, signed in or not', async () => {
      const signedIn = await signedInRead({ 'x-magicbooklet-proxy-timing': 'proxy-identity;dur=812.40' });
      const signedOut = await getMarketplaceResourceListRouteResponse({
        request: createRequest('', { 'x-performance-monitor': 'warmup' }),
        dependencies: { getMarketplaceResourceList: vi.fn(async () => storefrontPage()) },
      });

      for (const response of [signedIn, signedOut]) {
        expect(response.headers.get('Server-Timing')).toBeNull();
        expect(response.headers.get('x-scaling-certification-timing')).toBeNull();
      }
    });
  });

  it('drops nothing for a signed-out caller and reads no identity', async () => {
    const createUserClientMock = vi.fn();
    const { filter, loadBlockedCreatorIds } = filterWithBlocks();

    const response = await getMarketplaceResourceListRouteResponse({
      request: createRequest('', { 'x-request-id': 'resources-list-anon-2' }),
      dependencies: {
        createUserClient: createUserClientMock,
        filterMarketplaceItemsForViewer: filter,
        getMarketplaceResourceList: vi.fn(async () => storefrontPage()),
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, s-maxage=60, stale-while-revalidate=300');
    const body = await response.json() as { items: MarketplaceResourceListItem[] };
    expect(body.items.map((item) => item.id)).toEqual(['resource-1', 'resource-2', 'resource-3']);
    expect(createUserClientMock).not.toHaveBeenCalled();
    expect(loadBlockedCreatorIds).not.toHaveBeenCalled();
  });

  it('returns the public-safe marketplace error response when loading resources fails', async () => {
    const logError = vi.fn();
    const response = await getMarketplaceResourceListRouteResponse({
      request: createRequest('', { 'x-request-id': 'resources-list-error-1' }),
      dependencies: {
        getMarketplaceResourceList: vi.fn(async () => {
          throw new Error('database unavailable');
        }),
        logError,
      },
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'Failed to load marketplace unlocks.' });
    expect(logError).toHaveBeenCalledWith('Failed to load marketplace resources:', expect.any(Error));
  });

  it('rejects offsets beyond the bounded public pagination window', async () => {
    const getMarketplaceResourceList = vi.fn();

    const response = await getMarketplaceResourceListRouteResponse({
      request: createRequest('?offset=961', { 'x-request-id': 'resources-list-offset-1' }),
      dependencies: { getMarketplaceResourceList },
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('resources-list-offset-1');
    await expect(response.json()).resolves.toEqual({ error: 'offset must be at most 960.' });
    expect(getMarketplaceResourceList).not.toHaveBeenCalled();
  });

  it('rejects one- and two-character search queries before touching the catalog', async () => {
    const getMarketplaceResourceList = vi.fn();

    const response = await getMarketplaceResourceListRouteResponse({
      request: createRequest('?q=ab', { 'x-request-id': 'resources-list-query-1' }),
      dependencies: { getMarketplaceResourceList },
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({
      error: 'q must be empty or at least 3 characters.',
    });
    expect(getMarketplaceResourceList).not.toHaveBeenCalled();
  });

  it('does not advertise a next offset beyond the bounded public window', async () => {
    const response = await getMarketplaceResourceListRouteResponse({
      request: createRequest('?offset=960&limit=48'),
      dependencies: {
        getMarketplaceResourceList: vi.fn(async () => ({
          items: [{ id: 'resource-1' } as unknown as MarketplaceResourceListItem],
          pageInfo: {
            hasMore: true,
            limit: 48,
            nextOffset: 1_008,
            offset: 960,
          },
        })),
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      pageInfo: {
        hasMore: false,
        nextOffset: null,
        offset: 960,
      },
    });
  });
});
