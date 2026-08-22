import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  from: vi.fn(),
  loadPublishedGenerationModelCatalog: vi.fn(),
  unstableCache: vi.fn(),
}));

vi.mock('next/cache', () => ({
  unstable_cache: harness.unstableCache,
}));

vi.mock('@/lib/generation-model-catalog-store', () => ({
  loadPublishedGenerationModelCatalog: harness.loadPublishedGenerationModelCatalog,
}));

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => ({ from: harness.from }),
}));

function queryReturning(result: unknown) {
  const query: Record<string, unknown> & PromiseLike<unknown> = {
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  for (const method of ['eq', 'in', 'order', 'select']) {
    query[method] = vi.fn(() => query);
  }
  return query;
}

describe('source tool catalog cache', () => {
  beforeEach(() => {
    vi.resetModules();
    harness.from.mockReset();
    harness.loadPublishedGenerationModelCatalog.mockReset();
    harness.unstableCache.mockReset();
    harness.unstableCache.mockImplementation((loader) => loader);

    harness.loadPublishedGenerationModelCatalog.mockResolvedValue({
      catalog: { models: [] },
    });
    harness.from.mockImplementation((table: string) => {
      if (table === 'source_tools') {
        return queryReturning({
          data: [{
            aliases: [],
            capabilities: ['image'],
            catalog_tier: 'featured',
            id: 'tool-1',
            label: 'Example tool',
            provider_slug: 'example',
            slug: 'example-tool',
            sort_order: 1,
            status: 'current',
            supported_media_kinds: ['image'],
            tool_type: 'platform',
          }],
          error: null,
        });
      }
      return queryReturning({ data: [], error: null });
    });
  });

  it('uses a shared five-minute cache and retains the process-level fast path', async () => {
    const { listSourceToolsCatalog } = await import('@/lib/source-tools-server');

    const first = await listSourceToolsCatalog();
    const second = await listSourceToolsCatalog();

    expect(first).toEqual(second);
    expect(first[0]?.slug).toBe('example-tool');
    expect(harness.unstableCache).toHaveBeenCalledWith(
      expect.any(Function),
      ['source-tools-catalog-v1'],
      { revalidate: 300 },
    );
    expect(harness.loadPublishedGenerationModelCatalog).toHaveBeenCalledTimes(1);
    expect(harness.from).toHaveBeenCalledTimes(2);
  });
});
