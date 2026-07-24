import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: storage,
}));

vi.mock('react-native', () => ({
  AppState: {
    addEventListener: vi.fn(() => ({ remove: vi.fn() })),
  },
}));

import {
  GENERATION_MODEL_CATALOG_CACHE_KEY,
} from '../lib/generation-model-catalog';
import { useGenerationModelCatalog } from '../lib/use-generation-model-catalog';
import { catalogV2 } from './generation-model-catalog-v2-fixtures';

function CatalogProbe({
  api,
}: {
  api: Parameters<typeof useGenerationModelCatalog>[0];
}) {
  const state = useGenerationModelCatalog(api);
  return React.createElement(
    'catalog-state',
    {
      revision: state.catalog?.revision ?? null,
      status: state.status,
      isUsingCache: state.isUsingCache,
    },
  );
}

describe('useGenerationModelCatalog', () => {
  it('hydrates stale cache before fetching so the conditional request reuses its ETag', async () => {
    const catalog = catalogV2();
    storage.getItem.mockReset();
    storage.setItem.mockReset();
    storage.getItem.mockResolvedValue(JSON.stringify({
      catalog,
      etag: '"cached-v2"',
      fetchedAt: 1,
    }));
    const api = {
      fetchGenerationModels: vi.fn().mockResolvedValue({
        catalog: null,
        etag: '"cached-v2"',
        notModified: true,
      }),
    };
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { gcTime: 0 },
      },
    });
    let tree: renderer.ReactTestRenderer | undefined;

    await renderer.act(async () => {
      tree = renderer.create(
        <QueryClientProvider client={queryClient}>
          <CatalogProbe api={api} />
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });
    await renderer.act(async () => {
      await vi.waitFor(() => expect(api.fetchGenerationModels).toHaveBeenCalledTimes(1));
    });

    expect(storage.getItem).toHaveBeenCalledWith(GENERATION_MODEL_CATALOG_CACHE_KEY);
    expect(api.fetchGenerationModels).toHaveBeenCalledWith({
      etag: '"cached-v2"',
      forceRefresh: false,
    });
    expect(tree!.root.find((node) => String(node.type) === 'catalog-state').props).toMatchObject({
      revision: 'catalog-v2-revision',
      status: 'ready',
      isUsingCache: false,
    });
    expect(storage.setItem).toHaveBeenCalled();

    renderer.act(() => tree!.unmount());
    queryClient.clear();
  });
});
