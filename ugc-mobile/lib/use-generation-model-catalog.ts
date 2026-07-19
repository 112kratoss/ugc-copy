import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import type { createApiClient } from './api-client';
import {
  loadCachedGenerationModelCatalogEnvelope,
  saveCachedGenerationModelCatalog,
  type GenerationModelCatalog,
  type GenerationModelCatalogCacheEnvelope,
} from './generation-model-catalog';

const CATALOG_STALE_TIME_MS = 5 * 60 * 1000;
const QUERY_KEY = ['generation-model-catalog', 1] as const;

type GenerationCatalogApi = Pick<ReturnType<typeof createApiClient>, 'fetchGenerationModels'>;

export function useGenerationModelCatalog(api: GenerationCatalogApi) {
  const queryClient = useQueryClient();
  const [cachedCatalog, setCachedCatalog] = useState<GenerationModelCatalog | null>(null);
  const cacheEnvelopeRef = useRef<GenerationModelCatalogCacheEnvelope | null>(null);
  const forceRefreshRef = useRef(false);

  useEffect(() => {
    let active = true;
    void loadCachedGenerationModelCatalogEnvelope().then((envelope) => {
      if (!active || !envelope) return;
      cacheEnvelopeRef.current = envelope;
      setCachedCatalog(envelope.catalog);
      if (!queryClient.getQueryData(QUERY_KEY)) queryClient.setQueryData(QUERY_KEY, envelope.catalog);
    });
    return () => {
      active = false;
    };
  }, [queryClient]);

  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const forceRefresh = forceRefreshRef.current;
      forceRefreshRef.current = false;
      const response = await api.fetchGenerationModels({
        etag: cacheEnvelopeRef.current?.etag ?? null,
        forceRefresh,
      });
      const catalog = response.catalog ?? cacheEnvelopeRef.current?.catalog;
      if (!catalog) throw new Error('The saved model catalog could not be restored.');
      const envelope = {
        catalog,
        etag: response.etag,
        fetchedAt: Date.now(),
      } satisfies GenerationModelCatalogCacheEnvelope;
      cacheEnvelopeRef.current = envelope;
      setCachedCatalog(catalog);
      await saveCachedGenerationModelCatalog(catalog, undefined, envelope);
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

  const forceRefetch = useCallback(() => {
    forceRefreshRef.current = true;
    return refetch();
  }, [refetch]);

  const catalog = query.data ?? cachedCatalog;
  return {
    catalog,
    isLoading: !catalog && query.isPending,
    error: !catalog && query.error instanceof Error ? query.error : null,
    refetch: forceRefetch,
    isUsingCache: Boolean(cachedCatalog && !query.data),
  };
}
