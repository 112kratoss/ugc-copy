'use client';

import { useCallback, useEffect, useState } from 'react';

import { IMAGE_MODELS, MOTION_MODELS, VIDEO_MODELS } from '@/lib/models';
import type {
  CatalogControl,
  GenerationModelCatalog,
  GenerationModelDescriptor,
  GenerationModelQuote,
  GenerationModelQuoteInput,
} from '@/lib/generation-model-catalog';

const WEB_CATALOG_CACHE_KEY = 'generation-model-catalog:v1';

type Registry = Record<string, Record<string, unknown>>;
type CatalogRegistries = { image: Registry; video: Registry; motion: Registry };
type WebStorage = Pick<Storage, 'getItem' | 'setItem'>;

let catalogRequest: Promise<GenerationModelCatalog> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isDescriptor(value: unknown): value is GenerationModelDescriptor {
  return isRecord(value)
    && typeof value.id === 'string'
    && (value.kind === 'image' || value.kind === 'video' || value.kind === 'motion')
    && typeof value.displayName === 'string'
    && typeof value.description === 'string'
    && Array.isArray(value.controls)
    && isRecord(value.capabilities)
    && isRecord(value.inputs);
}

export function parseClientGenerationModelCatalog(value: unknown): GenerationModelCatalog {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.revision !== 'string' || !isRecord(value.defaults) || !Array.isArray(value.models)) {
    throw new Error('Invalid generation model catalog.');
  }
  if (!value.models.every(isDescriptor)) throw new Error('Invalid generation model catalog.');
  return value as unknown as GenerationModelCatalog;
}

function choiceControl(model: GenerationModelDescriptor, key: string) {
  return model.controls.find((control): control is Extract<CatalogControl, { type: 'choice' }> => control.key === key && control.type === 'choice');
}

function integerControl(model: GenerationModelDescriptor, key: string) {
  return model.controls.find((control): control is Extract<CatalogControl, { type: 'integer' }> => control.key === key && control.type === 'integer');
}

function choiceValues(model: GenerationModelDescriptor, key: string) {
  return choiceControl(model, key)?.options.map((option) => option.value) ?? [];
}

function activeIds(catalog: GenerationModelCatalog, kind: GenerationModelDescriptor['kind']) {
  return new Set(catalog.models.filter((model) => model.kind === kind).map((model) => model.id));
}

function markRetired(registry: Registry, active: Set<string>) {
  for (const id of Object.keys(registry)) {
    if (!active.has(id)) registry[id] = { ...registry[id], catalogActive: false };
  }
}

export function applyGenerationModelCatalogToRegistries(
  catalog: GenerationModelCatalog,
  registries: CatalogRegistries = {
    image: IMAGE_MODELS as unknown as Registry,
    video: VIDEO_MODELS as unknown as Registry,
    motion: MOTION_MODELS as unknown as Registry,
  }
) {
  markRetired(registries.image, activeIds(catalog, 'image'));
  markRetired(registries.video, activeIds(catalog, 'video'));
  markRetired(registries.motion, activeIds(catalog, 'motion'));

  for (const model of catalog.models) {
    if (model.kind === 'image') {
      const existing = registries.image[model.id] ?? {};
      const resolutions = choiceValues(model, 'resolution');
      registries.image[model.id] = {
        ...existing,
        id: model.id,
        displayName: model.displayName,
        description: model.description,
        badge: model.badge ?? '',
        badgeColor: existing.badgeColor ?? 'from-sky-500 to-cyan-500',
        accentColor: existing.accentColor ?? 'blue',
        maxImages: model.inputs.imageReferences?.max ?? 0,
        supportsGoogleSearch: model.capabilities.googleSearch,
        supportsOutputFormat: model.capabilities.outputFormat,
        aspectRatios: choiceValues(model, 'aspectRatio'),
        resolutions,
        outputFormats: choiceValues(model, 'outputFormat').length > 0 ? choiceValues(model, 'outputFormat') : ['jpg'],
        pricing: existing.pricing ?? Object.fromEntries(resolutions.map((resolution) => [resolution, 0])),
        qualityPricing: existing.qualityPricing ?? { standard: 0, quality: 0, imageToImage: 0 },
        catalogManaged: true,
        catalogActive: true,
        catalogInputs: model.inputs,
      };
      continue;
    }

    if (model.kind === 'video') {
      const existing = registries.video[model.id] ?? {};
      const durationChoice = choiceControl(model, 'duration');
      const durationInteger = integerControl(model, 'duration');
      const durations = durationChoice
        ? durationChoice.options.map((option) => Number(option.value)).filter(Number.isFinite)
        : durationInteger ? [durationInteger.defaultValue] : [5];
      const modeControl = choiceControl(model, 'mode');
      registries.video[model.id] = {
        ...existing,
        id: model.id,
        displayName: model.displayName,
        description: model.description,
        provider: existing.provider ?? 'catalog',
        apiModelId: existing.apiModelId ?? '',
        enhancerModelId: existing.enhancerModelId ?? model.id,
        supportsMultiShot: model.capabilities.multiShot,
        supportsSound: model.capabilities.sound,
        supportsFixedLens: model.capabilities.fixedLens,
        aspectRatios: choiceValues(model, 'aspectRatio'),
        durations,
        ...(durationInteger ? { singleShotDurationRange: { min: durationInteger.min, max: durationInteger.max, default: durationInteger.defaultValue } } : {}),
        resolutions: choiceValues(model, 'resolution'),
        modeOptions: modeControl?.options ?? [],
        pricing: existing.pricing ?? {},
        catalogManaged: true,
        catalogActive: true,
        catalogInputs: model.inputs,
      };
      continue;
    }

    const existing = registries.motion[model.id] ?? {};
    const duration = integerControl(model, 'duration');
    const resolutions = choiceValues(model, 'resolution');
    registries.motion[model.id] = {
      ...existing,
      id: model.id,
      displayName: model.displayName,
      description: model.description,
      badge: model.badge ?? '',
      badgeColor: existing.badgeColor ?? 'from-violet-500 to-indigo-500',
      apiModelId: existing.apiModelId ?? '',
      maxDuration: duration?.max ?? 30,
      maxVideoDuration: duration?.max ?? 30,
      characterOrientations: choiceValues(model, 'characterOrientation'),
      resolutions,
      pricing: existing.pricing ?? Object.fromEntries(resolutions.map((resolution) => [resolution, 0])),
      catalogManaged: true,
      catalogActive: true,
      catalogInputs: model.inputs,
    };
  }
}

export function getActiveRegistryModels<T extends Record<string, unknown>>(registry: Record<string, T>): T[] {
  return Object.values(registry).filter((model) => model.catalogActive !== false);
}

export function resolveCatalogModelId(
  catalog: GenerationModelCatalog,
  kind: GenerationModelDescriptor['kind'],
  selectedId: string,
  options: { preferDefault?: boolean } = {}
): string | null {
  const defaultId = catalog.defaults[kind];
  if (options.preferDefault && defaultId && catalog.models.some((model) => model.kind === kind && model.id === defaultId)) {
    return defaultId;
  }
  if (catalog.models.some((model) => model.kind === kind && model.id === selectedId)) return selectedId;
  return defaultId && catalog.models.some((model) => model.kind === kind && model.id === defaultId)
    ? defaultId
    : catalog.models.find((model) => model.kind === kind)?.id ?? null;
}

export async function loadWebGenerationModelCatalog({
  fetcher = fetch,
  storage = typeof window !== 'undefined' ? window.localStorage : undefined,
  forceRefresh = false,
}: {
  fetcher?: typeof fetch;
  storage?: WebStorage;
  forceRefresh?: boolean;
} = {}): Promise<GenerationModelCatalog> {
  try {
    const response = await fetcher(
      '/api/generation-models?platform=web&schemaVersion=1',
      forceRefresh ? { cache: 'no-store' } : undefined
    );
    if (!response.ok) throw new Error(`Catalog request failed with ${response.status}.`);
    const catalog = parseClientGenerationModelCatalog(await response.json());
    storage?.setItem(WEB_CATALOG_CACHE_KEY, JSON.stringify(catalog));
    return catalog;
  } catch (error) {
    const cached = forceRefresh ? null : storage?.getItem(WEB_CATALOG_CACHE_KEY);
    if (cached) return parseClientGenerationModelCatalog(JSON.parse(cached));
    throw error;
  }
}

export function useWebGenerationModelCatalog() {
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [state, setState] = useState<{
    catalog: GenerationModelCatalog | null;
    error: Error | null;
  }>({ catalog: null, error: null });

  useEffect(() => {
    let active = true;
    catalogRequest ??= loadWebGenerationModelCatalog({ forceRefresh: refreshVersion > 0 });
    void catalogRequest
      .then((catalog) => {
        if (!active) return;
        applyGenerationModelCatalogToRegistries(catalog);
        setState({ catalog, error: null });
      })
      .catch((error) => {
        if (active) {
          setState((current) => ({
            catalog: current.catalog,
            error: error instanceof Error ? error : new Error('Could not load model settings.'),
          }));
        }
        catalogRequest = null;
      });
    return () => {
      active = false;
    };
  }, [refreshVersion]);

  const refetch = useCallback(() => {
    catalogRequest = null;
    setRefreshVersion((current) => current + 1);
  }, []);

  return {
    ...state,
    isLoading: !state.catalog && !state.error,
    revision: state.catalog?.revision ?? null,
    refetch,
  };
}

export class WebCatalogRequestError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string) {
    super(message);
    this.name = 'WebCatalogRequestError';
  }
}

export async function requestWebGenerationQuote(
  input: GenerationModelQuoteInput,
  accessToken?: string | null,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch
): Promise<GenerationModelQuote> {
  const response = await fetcher('/api/generation-models/quote', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(input),
    signal,
  });
  const body = await response.json() as GenerationModelQuote & { error?: string; code?: string };
  if (!response.ok) throw new WebCatalogRequestError(body.error ?? 'Could not calculate generation cost.', response.status, body.code);
  return body;
}

export function useWebGenerationModelQuote(input: GenerationModelQuoteInput | null, accessToken?: string | null) {
  const serializedInput = input ? JSON.stringify(input) : null;
  const [state, setState] = useState<{
    status: 'idle' | 'pending' | 'ready' | 'error';
    quote: GenerationModelQuote | null;
    error: WebCatalogRequestError | null;
  }>({ status: 'idle', quote: null, error: null });

  useEffect(() => {
    if (!serializedInput) {
      setState({ status: 'idle', quote: null, error: null });
      return;
    }
    const controller = new AbortController();
    setState({ status: 'pending', quote: null, error: null });
    const timer = window.setTimeout(() => {
      void requestWebGenerationQuote(JSON.parse(serializedInput) as GenerationModelQuoteInput, accessToken, controller.signal)
        .then((quote) => {
          if (!controller.signal.aborted) setState({ status: 'ready', quote, error: null });
        })
        .catch((error) => {
          if (controller.signal.aborted) return;
          setState({
            status: 'error',
            quote: null,
            error: error instanceof WebCatalogRequestError
              ? error
              : new WebCatalogRequestError('Could not calculate generation cost.', 0),
          });
        });
    }, 200);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [accessToken, serializedInput]);

  return state;
}
