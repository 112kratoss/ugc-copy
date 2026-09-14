import { useCallback, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { createApiClient } from './api-client';
import { parseModelCatalogDetail, type GenerationModelDescriptor, type GenerationModelCatalogV3 } from './generation-model-catalog';
import { ModelCatalogSession, type CatalogSessionState } from './model-catalog-session';
import type { ModelCatalogKind } from './model-catalog-protocol';

type GenerationCatalogApi = Pick<ReturnType<typeof createApiClient>, 'fetchModelCatalogCurrent' | 'fetchModelCatalogPage' | 'fetchModelCatalogDetails'>;

export function useGenerationModelCatalog(api: GenerationCatalogApi, options: { kind?: ModelCatalogKind; selectedIds?: string[]; pickerOpen?: boolean } = {}) {
  const session = useMemo(() => new ModelCatalogSession<GenerationModelDescriptor>((path,etag) => {
    const query = path.slice(path.indexOf('?') + 1);
    if (path.includes('/current?')) return api.fetchModelCatalogCurrent(query, etag);
    return path.includes('/details?') ? api.fetchModelCatalogDetails(query) : api.fetchModelCatalogPage(query);
  }, parseModelCatalogDetail, AsyncStorage, 'mobile'), [api]);
  const [state, setState] = useState<CatalogSessionState<GenerationModelDescriptor>>(session.getSnapshot);
  const [retryVersion, setRetryVersion] = useState(0);
  const selectedKey = (options.selectedIds ?? []).join(',');
  const { current, details, nextCursors, error } = state;
  useEffect(() => { setState(session.getSnapshot()); const unsubscribe = session.subscribe(() => setState(session.getSnapshot())); void session.initialize(); return unsubscribe; }, [session]);
  // Refresh only on entry or opening model selection. No timer or forced restart.
  useEffect(() => { if (options.pickerOpen) void session.refresh(); }, [options.pickerOpen, session]);
  useEffect(() => {
    if (!current) return;
    const ids = selectedKey ? selectedKey.split(',') : [];
    const defaults = options.kind ? [current.defaults[options.kind]] : Object.values(current.defaults);
    session.pin(ids); void session.ensureDetails([...ids, ...defaults.filter((id): id is string => Boolean(id))]);
  }, [session, current, selectedKey, options.kind, retryVersion]);
  useEffect(() => {
    const key = options.kind ?? 'all'; if (!current || error) return;
    if (nextCursors[key] === undefined || (options.pickerOpen && nextCursors[key])) void session.loadPage(options.kind ?? null);
  }, [session, options.kind, options.pickerOpen, current, nextCursors, error, retryVersion]);
  const refetch = useCallback(() => { void session.retry().then(() => setRetryVersion(v => v + 1)); }, [session]);
  const loadDetails = useCallback(async (ids: string[]) => {
    await session.ensureDetails(ids);
    const next = session.getSnapshot();
    if (!next.current) throw new Error('Model catalog is unavailable.');
    if (ids.some(id => !next.details.some(model => model.id === id) && !next.missingIds.includes(id))) {
      throw new Error(next.error?.message ?? 'Could not load model settings.');
    }
    return { schemaVersion: 3, revision: next.current.revision, defaults: next.current.defaults, models: next.details } as GenerationModelCatalogV3;
  }, [session]);
  const catalog = useMemo(() => current ? { schemaVersion: 3, revision: current.revision, defaults: current.defaults, models: details } as GenerationModelCatalogV3 : null, [current, details]);
  return { catalog, current: current, summaries: state.summaries, missingIds: state.missingIds,
    isLoadingModels: Boolean(options.pickerOpen && nextCursors[options.kind ?? 'all'] !== null && !error),
    isLoading: !catalog && state.loading, isRefreshing: state.loading || state.loadingDetails,
    isUnavailable: Boolean(error && (!catalog || (options.selectedIds ?? []).some(id => !details.some(model => model.id === id)))),
    status: !catalog ? state.loading ? 'loading' as const : 'unavailable' as const : 'ready' as const,
    error: error, refreshError: error, loadDetails, refetch, retry: refetch, isUsingCache: Boolean(catalog && error) };
}
