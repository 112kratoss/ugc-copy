import { describe, expect, it, vi } from 'vitest';
import { createModelCatalogRouteHandler } from '@/lib/model-catalog-route-adapter-service';
import { buildGenerationModelCatalog } from '@/lib/generation-model-catalog';
import {
  catalogSummary,
  decodeCatalogCursor,
  ModelCatalogTransportError,
} from '@/lib/model-catalog-transport';

const catalog = buildGenerationModelCatalog({
  platform: 'web',
  schemaVersion: 3,
});
function dependencies(count = 500) {
  const models = Array.from({ length: count }, (_, i) => ({
    ...catalog.models[0],
    kind: 'image' as const,
    id: `model-${String(i).padStart(4, '0')}`,
    sortOrder: Math.floor(i / 3),
  }));
  return {
    current: vi.fn(async () => ({
      transportVersion: 1 as const,
      descriptorSchemaVersion: 3 as const,
      revision: 'published-1',
      defaults: catalog.defaults,
      counts: { image: count, video: 0, motion: 0 },
    })),
    page: vi.fn(
      async ({
        after,
        limit,
      }: {
        after: { id: string; sortOrder: number } | null;
        limit: number;
      }) =>
        models
          .filter(
            (m) =>
              !after ||
              m.sortOrder > after.sortOrder ||
              (m.sortOrder === after.sortOrder && m.id > after.id),
          )
          .slice(0, limit + 1)
          .map(catalogSummary),
    ),
    details: vi.fn(async (_revision: string, ids: string[]) =>
      models.filter((m) => ids.includes(m.id)),
    ),
  };
}
describe('model catalog route', () => {
  it.each([100, 500])(
    'discovers all %i models using bounded keyset pages with ties',
    async (count) => {
      const deps = dependencies(count);
      const handler = createModelCatalogRouteHandler('models', deps);
      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const response = await handler(
          new Request(
            `https://example.test/api/model-catalog/v1/models?revision=published-1&kind=image${cursor ? `&cursor=${cursor}` : ''}`,
          ),
        );
        expect(response.status).toBe(200);
        const text = await response.text();
        expect(Buffer.byteLength(text)).toBeLessThanOrEqual(16384);
        const body = JSON.parse(text);
        ids.push(...body.models.map((m: { id: string }) => m.id));
        cursor = body.nextCursor;
        if (cursor)
          expect(
            decodeCatalogCursor(cursor, 'published-1', 'image'),
          ).toBeTruthy();
      } while (cursor);
      expect(ids).toHaveLength(count);
      expect(new Set(ids).size).toBe(count);
    },
  );
  it('returns weak conditional 304 and short caching only for current', async () => {
    const handler = createModelCatalogRouteHandler('current', dependencies());
    const response = await handler(new Request('https://example.test/current'));
    expect(response.headers.get('cache-control')).not.toContain(
      'stale-while-revalidate',
    );
    expect(response.headers.get('cache-control')).toContain('s-maxage=30');
    const cached = await handler(
      new Request('https://example.test/current', {
        headers: { 'If-None-Match': `W/${response.headers.get('etag')}` },
      }),
    );
    expect(cached.status).toBe(304);
    expect(await cached.text()).toBe('');
  });
  it('scopes every read to the requested platform and binds cursors to it', async () => {
    const deps = dependencies();
    const current = createModelCatalogRouteHandler('current', deps);
    await current(new Request('https://example.test/current'));
    expect(deps.current).toHaveBeenLastCalledWith('web');
    await current(new Request('https://example.test/current?platform=mobile'));
    expect(deps.current).toHaveBeenLastCalledWith('mobile');
    const models = createModelCatalogRouteHandler('models', deps);
    const first = await (
      await models(
        new Request(
          'https://example.test/models?platform=mobile&revision=published-1&kind=image',
        ),
      )
    ).json();
    expect(deps.page).toHaveBeenLastCalledWith(
      expect.objectContaining({ platform: 'mobile', kind: 'image' }),
    );
    expect(
      (
        await models(
          new Request(
            `https://example.test/models?platform=web&revision=published-1&kind=image&cursor=${first.nextCursor}`,
          ),
        )
      ).status,
    ).toBe(400);
    await createModelCatalogRouteHandler('details', deps)(
      new Request(
        'https://example.test/details?platform=mobile&revision=published-1&ids=model-0000',
      ),
    );
    expect(deps.details).toHaveBeenLastCalledWith(
      'published-1',
      ['model-0000'],
      'mobile',
    );
  });
  it('reports missing batch items without returning another model or private fields', async () => {
    const response = await createModelCatalogRouteHandler(
      'details',
      dependencies(),
    )(
      new Request(
        'https://example.test/details?revision=published-1&ids=model-0000,absent',
      ),
    );
    const body = await response.json();
    expect(body.missingIds).toEqual(['absent']);
    expect(body.models).toHaveLength(1);
    expect(body.models[0]).not.toHaveProperty('inputs');
    expect(JSON.stringify(body)).not.toMatch(
      /providerModelMap|pricingConfig|adapterConfig/,
    );
  });
  it('rejects unpublished releases and malformed requests without caching errors', async () => {
    const deps = dependencies();
    deps.details.mockRejectedValue(
      new ModelCatalogTransportError(
        'CATALOG_REVISION_UNAVAILABLE',
        'Unavailable',
        404,
      ),
    );
    const response = await createModelCatalogRouteHandler(
      'details',
      deps,
    )(
      new Request(
        'https://example.test/details?revision=shadow-1&ids=model-0000',
      ),
    );
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    for (const query of [
      'revision=published-1&limit=51',
      'revision=published-1&kind=other',
      'revision=published-1&cursor=bad',
      'revision=published-1&platform=desktop',
      'kind=image',
    ]) {
      expect(
        (
          await createModelCatalogRouteHandler(
            'models',
            deps,
          )(new Request(`https://example.test/models?${query}`))
        ).status,
      ).toBe(400);
    }
    expect(deps.page).not.toHaveBeenCalled();
  });
});
