import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getMarketplaceResourceListMock = vi.fn();

vi.mock('@/lib/post-resource-bundles-server', () => ({
  getMarketplaceResourceList: (options: unknown) => getMarketplaceResourceListMock(options),
}));

describe('/api/marketplace/resources route', () => {
  beforeEach(() => {
    vi.resetModules();
    getMarketplaceResourceListMock.mockReset();
    getMarketplaceResourceListMock.mockResolvedValue({
      items: [],
      pageInfo: {
        hasMore: false,
        nextOffset: null,
        offset: 0,
        limit: 24,
      },
    });
  });

  it('marks anonymous marketplace resource pages as edge-cacheable for web and mobile clients', async () => {
    const { GET } = await import('@/app/api/marketplace/resources/route');
    const response = await GET(
      new NextRequest('http://localhost/api/marketplace/resources?limit=12', {
        headers: {
          'x-vercel-ip-country': 'IN',
        },
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, s-maxage=60, stale-while-revalidate=300');
    expect(response.headers.get('Vary')).toContain('x-vercel-ip-country');
    expect(getMarketplaceResourceListMock).toHaveBeenCalledWith(expect.objectContaining({
      offset: 0,
      limit: 12,
      countryCode: 'IN',
    }));
  });
});
