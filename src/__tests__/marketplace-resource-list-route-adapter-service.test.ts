import { describe, expect, it, vi } from 'vitest';

import { mockRequestIdPassthrough } from '@/__tests__/fixtures/request-id-passthrough';

import { getMarketplaceResourceListRouteResponse } from '@/lib/marketplace-resource-list-route-adapter-service';
import type { MarketplaceResourceListItem } from '@/lib/post-resource-bundles-server';

function createRequest(search = '', headers: Record<string, string> = {}) {
  return new Request(`http://localhost/api/marketplace/resources${search}`, {
    headers,
  });
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
    expect(response.headers.get('Vary')).toBe('x-vercel-ip-country');
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
