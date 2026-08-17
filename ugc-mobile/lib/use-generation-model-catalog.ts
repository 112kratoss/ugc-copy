import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import type { createApiClient } from './api-client';
import {
  GENERATION_MODEL_CATALOG_SCHEMA_VERSION,
  loadCachedGenerationModelCatalogEnvelope,
  saveCachedGenerationModelCatalog,
  type GenerationModelCatalogV2,
  type GenerationModelCatalogCacheEnvelope,
} from './generation-model-catalog';

const CATALOG_STALE_TIME_MS = 5 * 60 * 1000;
const QUERY_KEY = ['generation-model-catalog', GENERATION_MODEL_CATALOG_SCHEMA_VERSION] as const;

type GenerationCatalogApi = Pick<ReturnType<typeof createApiClient>, 'fetchGenerationModels'>;

export function useGenerationModelCatalog(api: GenerationCatalogApi) {
  const queryClient = useQueryClient();
  const [cachedCatalog, setCachedCatalog] = useState<GenerationModelCatalogV2 | null>(null);
  const [hasNetworkCatalog, setHasNetworkCatalog] = useState(false);
  const [cacheReady, setCacheReady] = useState(false);
  const cacheEnvelopeRef = useRef<GenerationModelCatalogCacheEnvelope | null>(null);
  const forceRefreshRef = useRef(false);

  useEffect(() => {
    let active = true;
    void loadCachedGenerationModelCatalogEnvelope(
      undefined,
      GENERATION_MODEL_CATALOG_SCHEMA_VERSION,
    ).then((envelope) => {
      if (!active || !envelope) return;
      cacheEnvelopeRef.current = envelope;
      const catalog = envelope.catalog as GenerationModelCatalogV2;
      setCachedCatalog(catalog);
      if (!queryClient.getQueryData(QUERY_KEY)) {
        queryClient.setQueryData(QUERY_KEY, envelope.catalog, {
          updatedAt: envelope.fetchedAt,
        });
      }
    }).finally(() => {
      if (active) setCacheReady(true);
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
      const catalog = (response.catalog ?? cacheEnvelopeRef.current?.catalog) as GenerationModelCatalogV2 | undefined;
      if (!catalog) throw new Error('The saved model catalog could not be restored.');
      const envelope = {
        catalog,
        etag: response.etag,
        fetchedAt: Date.now(),
      } satisfies GenerationModelCatalogCacheEnvelope;
      cacheEnvelopeRef.current = envelope;
      setCachedCatalog(catalog);
      await saveCachedGenerationModelCatalog(catalog, undefined, envelope);
      setHasNetworkCatalog(true);
      return catalog;
    },
    enabled: cacheReady,
    staleTime: CATALOG_STALE_TIME_MS,
    retry: 1,
  });

  const dataUpdatedAt = query.dataUpdatedAt;
  const refetch = query.refetch;
  useEffect(() => AppState.addEventListener('change', (state) => {
    const lastFetch = Math.max(dataUpdatedAt, cacheEnvelopeRef.current?.fetchedAt ?? 0);
    if (state === 'active' && (!lastFetch || Date.now() - lastFetch >= CATALOG_STALE_TIME_MS)) {
      void refetch();
    }
  }).remove, [dataUpdatedAt, refetch]);

  const forceRefetch = useCallback(() => {
    forceRefreshRef.current = true;
    return refetch();
  }, [refetch]);

  const catalog = (query.data ?? cachedCatalog) as GenerationModelCatalogV2 | null;
  const unavailableError = !catalog && query.error instanceof Error ? query.error : null;
  return {
    catalog,
    isLoading: !catalog && query.isPending,
    isRefreshing: Boolean(catalog && query.isFetching),
    isUnavailable: Boolean(cacheReady && !catalog && !query.isPending),
    status: !catalog
      ? query.isPending ? 'loading' as const : 'unavailable' as const
      : query.isFetching ? 'refreshing' as const : 'ready' as const,
    error: unavailableError,
    refreshError: catalog && query.error instanceof Error ? query.error : null,
    refetch: forceRefetch,
    retry: forceRefetch,
    isUsingCache: Boolean(cachedCatalog && !hasNetworkCatalog),
  };
}
