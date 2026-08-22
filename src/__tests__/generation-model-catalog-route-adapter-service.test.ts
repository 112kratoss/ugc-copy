import { describe, expect, it, vi } from 'vitest';

import {
  buildGenerationModelCatalogEtag,
  getGenerationModelCatalogRouteResponse,
} from '@/lib/generation-model-catalog-route-adapter-service';
import {
  buildGenerationModelCatalog,
  type GenerationModelCatalog,
} from '@/lib/generation-model-catalog';

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
      'public, max-age=300, s-maxage=300, stale-while-revalidate=3600',
    );
    expect(response.headers.get('ETag')).toBe(
      buildGenerationModelCatalogEtag(createCatalog('catalog-mobile-1'), 'mobile'),
    );
    expect(response.headers.get('x-request-id')).toBe('catalog-adapter-mobile-1');
    expect(buildGenerationModelCatalog).toHaveBeenCalledWith({
      platform: 'mobile',
      schemaVersion: 1,
    });
    await expect(response.json()).resolves.toEqual(createCatalog('catalog-mobile-1'));
  });

  it('returns 304 when the request already has the current catalog revision', async () => {
    const catalog = createCatalog('catalog-web-1');
    const etag = buildGenerationModelCatalogEtag(catalog, 'web');
    const response = await getGenerationModelCatalogRouteResponse({
      request: new Request('http://localhost/api/generation-models?platform=web', {
        headers: {
          'If-None-Match': etag,
          'x-vercel-id': 'iad1::catalog-adapter-304',
        },
      }),
      dependencies: {
        buildGenerationModelCatalog: vi.fn(() => catalog),
      },
    });

    expect(response.status).toBe(304);
    expect(response.headers.get('ETag')).toBe(etag);
    expect(response.headers.get('x-request-id')).toBe('iad1::catalog-adapter-304');
    expect(await response.text()).toBe('');
  });

  it('keeps v2 intact and serves a compact v3 payload below the response budget', async () => {
    const v3Catalog = buildGenerationModelCatalog({ platform: 'web', schemaVersion: 3 });
    const v3Response = await getGenerationModelCatalogRouteResponse({
      request: new Request(
        'http://localhost/api/generation-models?platform=web&schemaVersion=3',
      ),
      dependencies: { buildGenerationModelCatalog },
    });
    const v3Body = await v3Response.text();
    const v3 = JSON.parse(v3Body) as GenerationModelCatalog;

    expect(v3.schemaVersion).toBe(3);
    expect(v3Body.length).toBeLessThanOrEqual(57_344);
    expect(v3.models.length).toBe(v3Catalog.models.length);
    expect(v3.models.every((model) => !Object.hasOwn(model, 'inputs'))).toBe(true);
    expect(v3.models.every((model) => Array.isArray(model.inputModes))).toBe(true);

    const v2Response = await getGenerationModelCatalogRouteResponse({
      request: new Request(
        'http://localhost/api/generation-models?platform=web&schemaVersion=2',
      ),
      dependencies: { buildGenerationModelCatalog },
    });
    const v2 = await v2Response.json() as GenerationModelCatalog;
    expect(v2.schemaVersion).toBe(2);
    expect(v2.models.every((model) => Object.hasOwn(model, 'inputs'))).toBe(true);
  });
});
