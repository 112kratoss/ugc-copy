import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

import type { createApiClient } from './api-client';
import {
  loadCachedGenerationModelCatalog,
  saveCachedGenerationModelCatalog,
  type GenerationModelCatalog,
} from './generation-model-catalog';

const CATALOG_STALE_TIME_MS = 5 * 60 * 1000;
const QUERY_KEY = ['generation-model-catalog', 1] as const;

type GenerationCatalogApi = Pick<ReturnType<typeof createApiClient>, 'listGenerationModels'>;

export function useGenerationModelCatalog(api: GenerationCatalogApi) {
  const queryClient = useQueryClient();
  const [cachedCatalog, setCachedCatalog] = useState<GenerationModelCatalog | null>(null);

  useEffect(() => {
    let active = true;
    void loadCachedGenerationModelCatalog().then((catalog) => {
      if (!active || !catalog) return;
      setCachedCatalog(catalog);
      if (!queryClient.getQueryData(QUERY_KEY)) queryClient.setQueryData(QUERY_KEY, catalog);
    });
    return () => {
      active = false;
    };
  }, [queryClient]);

  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const catalog = await api.listGenerationModels();
      await saveCachedGenerationModelCatalog(catalog);
      return catalog;
    },
    staleTime: CATALOG_STALE_TIME_MS,
    retry: 1,
  });

  const dataUpdatedAt = query.dataUpdatedAt;
  const refetch = query.refetch;
  useEffect(() => AppState.addEventListener('change', (state) => {
    if (state === 'active' && dataUpdatedAt && Date.now() - dataUpdatedAt >= CATALOG_STALE_TIME_MS) {
      void refetch();
    }
  }).remove, [dataUpdatedAt, refetch]);

  const catalog = query.data ?? cachedCatalog;
  return {
    catalog,
    isLoading: !catalog && query.isPending,
    error: !catalog && query.error instanceof Error ? query.error : null,
    refetch: query.refetch,
    isUsingCache: Boolean(cachedCatalog && !query.data),
  };
}
