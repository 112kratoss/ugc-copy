import { describe, expect, it, vi } from 'vitest';

import { getGenerationModelCatalogRouteResponse } from '@/lib/generation-model-catalog-route-adapter-service';
import type { GenerationModelCatalog } from '@/lib/generation-model-catalog';

function createCatalog(revision = 'catalog-revision-1'): GenerationModelCatalog {
  return {
    schemaVersion: 1,
    revision,
    defaults: {
      image: null,
      video: null,
      motion: null,
    },
    models: [],
  };
}

describe('generation model catalog route adapter service', () => {
  it('builds a public cacheable catalog from platform and schema query params', async () => {
    const buildGenerationModelCatalog = vi.fn(() => createCatalog('catalog-mobile-1'));
    const request = new Request(
      'http://localhost/api/generation-models?platform=mobile&schemaVersion=1',
      { headers: { 'x-request-id': 'catalog-adapter-mobile-1' } },
    );

    const response = await getGenerationModelCatalogRouteResponse({
      request,
      dependencies: {
        buildGenerationModelCatalog,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe(
      'public, max-age=300, stale-while-revalidate=3600',
    );
    expect(response.headers.get('ETag')).toBe('"catalog-mobile-1"');
    expect(response.headers.get('x-request-id')).toBe('catalog-adapter-mobile-1');
    expect(buildGenerationModelCatalog).toHaveBeenCalledWith({
      platform: 'mobile',
      schemaVersion: 1,
    });
    await expect(response.json()).resolves.toEqual(createCatalog('catalog-mobile-1'));
  });

  it('returns 304 when the request already has the current catalog revision', async () => {
    const response = await getGenerationModelCatalogRouteResponse({
      request: new Request('http://localhost/api/generation-models?platform=web', {
        headers: {
          'If-None-Match': '"catalog-web-1"',
          'x-vercel-id': 'iad1::catalog-adapter-304',
        },
      }),
      dependencies: {
        buildGenerationModelCatalog: vi.fn(() => createCatalog('catalog-web-1')),
      },
    });

    expect(response.status).toBe(304);
    expect(response.headers.get('ETag')).toBe('"catalog-web-1"');
    expect(response.headers.get('x-request-id')).toBe('iad1::catalog-adapter-304');
    expect(await response.text()).toBe('');
  });
});
