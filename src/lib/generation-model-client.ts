'use client';

import { useCallback, useEffect, useState } from 'react';

import { IMAGE_MODELS, MOTION_MODELS, VIDEO_MODELS } from '@/lib/client-generation-models';
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

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function parseControl(value: unknown): CatalogControl | null {
  if (!isRecord(value) || !isString(value.key) || !isString(value.label)) return null;
  if (value.type === 'choice') {
    if ((value.presentation !== 'chips' && value.presentation !== 'select') || !isString(value.defaultValue) || !Array.isArray(value.options)) return null;
    const options = value.options.filter((option): option is { value: string; label: string } => (
      isRecord(option) && isString(option.value) && isString(option.label)
    ));
    if (options.length !== value.options.length || options.length === 0) return null;
    if (!options.some((option) => option.value === value.defaultValue)) return null;
    return { key: value.key, label: value.label, type: 'choice', presentation: value.presentation, defaultValue: value.defaultValue, options };
  }
  if (value.type === 'boolean') {
    if (value.presentation !== 'toggle' || typeof value.defaultValue !== 'boolean') return null;
    return { key: value.key, label: value.label, type: 'boolean', presentation: 'toggle', defaultValue: value.defaultValue };
  }
  if (value.type === 'integer') {
    if (value.presentation !== 'stepper' || typeof value.defaultValue !== 'number' || typeof value.min !== 'number' || typeof value.max !== 'number' || typeof value.step !== 'number') return null;
    if (!Number.isFinite(value.defaultValue) || !Number.isFinite(value.min) || !Number.isFinite(value.max) || !Number.isFinite(value.step)) return null;
    if (value.step <= 0 || value.min > value.max || value.defaultValue < value.min || value.defaultValue > value.max) return null;
    return {
      key: value.key,
      label: value.label,
      type: 'integer',
      presentation: 'stepper',
      defaultValue: value.defaultValue,
      min: value.min,
      max: value.max,
      step: value.step,
      ...(typeof value.unit === 'string' ? { unit: value.unit } : {}),
    };
  }
  return null;
}

function parseReferenceLimit(value: unknown, includeNaming: boolean) {
  if (value === null) return null;
  if (!isRecord(value) || !Number.isInteger(value.max) || (value.max as number) < 0) return undefined;
  if (includeNaming && typeof value.supportsNaming !== 'boolean') return undefined;
  return includeNaming
    ? { max: value.max as number, supportsNaming: value.supportsNaming as boolean }
    : { max: value.max as number };
}

function isDescriptor(value: unknown): value is GenerationModelDescriptor {
  if (!isRecord(value) || !isString(value.id) || (value.kind !== 'image' && value.kind !== 'video' && value.kind !== 'motion')) return false;
  if (!isString(value.displayName) || typeof value.description !== 'string' || !isNullableString(value.badge)) return false;
  if (typeof value.recommended !== 'boolean' || typeof value.sortOrder !== 'number' || typeof value.minClientSchemaVersion !== 'number') return false;
  if (!Array.isArray(value.controls) || !isRecord(value.capabilities) || !isRecord(value.inputs)) return false;
  const controls = value.controls.map(parseControl);
  if (controls.some((control) => !control)) return false;
  const capabilityKeys = ['multiShot', 'sound', 'fixedLens', 'googleSearch', 'outputFormat'];
  if (capabilityKeys.some((key) => typeof (value.capabilities as Record<string, unknown>)[key] !== 'boolean')) return false;
  const imageReferences = parseReferenceLimit(value.inputs.imageReferences, true);
  const videoReferences = parseReferenceLimit(value.inputs.videoReferences, false);
  const audioReferences = parseReferenceLimit(value.inputs.audioReferences, false);
  const preparedAudioReferences = value.inputs.preparedAudioReferences === undefined
    ? null
    : parseReferenceLimit(value.inputs.preparedAudioReferences, false);
  const characterReferences = value.inputs.characterReferences === undefined
    ? null
    : parseReferenceLimit(value.inputs.characterReferences, false);
  return imageReferences !== undefined
    && videoReferences !== undefined
    && audioReferences !== undefined
    && preparedAudioReferences !== undefined
    && characterReferences !== undefined
    && typeof value.inputs.startFrame === 'boolean'
    && typeof value.inputs.endFrame === 'boolean'
    && (value.inputs.combineFramesWithReferences === undefined || typeof value.inputs.combineFramesWithReferences === 'boolean');
}

function defaultMatchesCatalog(
  models: GenerationModelDescriptor[],
  kind: GenerationModelDescriptor['kind'],
  modelId: unknown
) {
  return modelId === null || (typeof modelId === 'string' && models.some((model) => model.kind === kind && model.id === modelId));
}

export function parseClientGenerationModelCatalog(value: unknown): GenerationModelCatalog {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.revision !== 'string' || !isRecord(value.defaults) || !Array.isArray(value.models)) {
    throw new Error('Invalid generation model catalog.');
  }
  if (!value.models.every(isDescriptor)) throw new Error('Invalid generation model catalog.');
  const catalog = value as unknown as GenerationModelCatalog;
  if (
    !defaultMatchesCatalog(catalog.models, 'image', catalog.defaults.image)
    || !defaultMatchesCatalog(catalog.models, 'video', catalog.defaults.video)
    || !defaultMatchesCatalog(catalog.models, 'motion', catalog.defaults.motion)
  ) {
    throw new Error('Invalid generation model catalog.');
  }
  return catalog;
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
        supportsMultiShot: model.capabilities.multiShot,
        supportsSound: model.capabilities.sound,
        supportsFixedLens: model.capabilities.fixedLens,
        aspectRatios: choiceValues(model, 'aspectRatio'),
        durations,
        ...(durationInteger ? { singleShotDurationRange: { min: durationInteger.min, max: durationInteger.max, default: durationInteger.defaultValue } } : {}),
        resolutions: choiceValues(model, 'resolution'),
        modeOptions: modeControl?.options ?? [],
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
      badgeColor: existing.badgeColor ?? 'from-[#ff7a59] to-orange-500',
      maxDuration: duration?.max ?? 30,
      maxVideoDuration: duration?.max ?? 30,
      characterOrientations: choiceValues(model, 'characterOrientation'),
      resolutions,
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
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly fieldErrors: Record<string, string> = {}
  ) {
    super(message);
    this.name = 'WebCatalogRequestError';
  }
}

export type WebGenerationQuoteStatus = 'idle' | 'pending' | 'ready' | 'error';

export function resolveWebGenerationQuoteUi({
  hasCatalog,
  quoteStatus,
  quotedCost,
  quoteErrorMessage,
}: {
  hasCatalog: boolean;
  quoteStatus: WebGenerationQuoteStatus;
  quotedCost: number | null | undefined;
  quoteErrorMessage: string | null | undefined;
}) {
  if (!hasCatalog) {
    return {
      costCredits: null,
      costLabel: 'Unavailable',
      blocksGenerate: true,
      message: 'Model settings are unavailable. Retry before generating.',
    };
  }

  if (quoteStatus === 'ready' && typeof quotedCost === 'number') {
    return {
      costCredits: quotedCost,
      costLabel: `${quotedCost} ${quotedCost === 1 ? 'credit' : 'credits'}`,
      blocksGenerate: false,
      message: null,
    };
  }

  if (quoteStatus === 'error') {
    return {
      costCredits: null,
      costLabel: 'Unavailable',
      blocksGenerate: true,
      message: quoteErrorMessage ?? 'Could not calculate generation cost.',
    };
  }

  return {
    costCredits: null,
    costLabel: 'Calculating...',
    blocksGenerate: true,
    message: 'Wait for the current generation cost before continuing.',
  };
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
  const body = await response.json() as GenerationModelQuote & {
    error?: string;
    code?: string;
    fieldErrors?: Record<string, string>;
  };
  if (!response.ok) {
    const fieldErrors = body.fieldErrors ?? {};
    const fieldMessage = Object.values(fieldErrors).find((message) => typeof message === 'string' && message.trim());
    throw new WebCatalogRequestError(
      fieldMessage ?? body.error ?? 'Could not calculate generation cost.',
      response.status,
      body.code,
      fieldErrors
    );
  }
  return body;
}

export function useWebGenerationModelQuote(input: GenerationModelQuoteInput | null, accessToken?: string | null) {
  const serializedInput = input ? JSON.stringify(input) : null;
  const requestKey = serializedInput ? `${accessToken ?? ''}\n${serializedInput}` : null;
  const [state, setState] = useState<{
    key: string;
    status: 'idle' | 'pending' | 'ready' | 'error';
    quote: GenerationModelQuote | null;
    error: WebCatalogRequestError | null;
  } | null>(null);

  useEffect(() => {
    if (!serializedInput || !requestKey) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void requestWebGenerationQuote(JSON.parse(serializedInput) as GenerationModelQuoteInput, accessToken, controller.signal)
        .then((quote) => {
          if (!controller.signal.aborted) setState({ key: requestKey, status: 'ready', quote, error: null });
        })
        .catch((error) => {
          if (controller.signal.aborted) return;
          setState({
            key: requestKey,
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
  }, [accessToken, requestKey, serializedInput]);

  if (!requestKey) {
    return { status: 'idle' as const, quote: null, error: null };
  }
  if (state?.key === requestKey) {
    return { status: state.status, quote: state.quote, error: state.error };
  }
  return { status: 'pending' as const, quote: null, error: null };
}
