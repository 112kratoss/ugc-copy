'use client';

import { createContext, useCallback, useEffect, useMemo, useState } from 'react';
import { ModelCatalogSession, type CatalogSessionState } from '../../ugc-mobile/lib/model-catalog/session';
import type { ModelCatalogKind, ModelCatalogSummary } from '../../ugc-mobile/lib/model-catalog/protocol';

import { IMAGE_MODELS, MOTION_MODELS, VIDEO_MODELS } from '@/lib/client-generation-models';
import type {
  CatalogGenerationInputAsset,
  CatalogGenerationRequestPayload,
} from '@/lib/generation-model-adapters';
import type {
  CatalogControl,
  GenerationModelCatalog,
  GenerationModelDescriptor,
  GenerationModelQuote,
  GenerationModelQuoteInput,
} from '@/lib/generation-model-catalog';

const WEB_CATALOG_SCHEMA_VERSION = 3;
/** The single-fetch cache written before the paged transport; removed once on mount. */
const LEGACY_WEB_CATALOG_CACHE_KEY = `generation-model-catalog:v${WEB_CATALOG_SCHEMA_VERSION}`;

type Registry = Record<string, Record<string, unknown>>;
type CatalogRegistries = { image: Registry; video: Registry; motion: Registry };

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

function deriveLegacyInputsFromInputModes(
  value: unknown,
): GenerationModelDescriptor['inputs'] | undefined {
  if (!Array.isArray(value)) return undefined;
  let imageMax = 0;
  let imageSupportsNaming = false;
  let videoMax = 0;
  let audioMax = 0;
  let preparedAudioMax = 0;
  let characterMax = 0;
  let startFrame = false;
  let endFrame = false;
  let combineFramesWithReferences = false;

  for (const rawMode of value) {
    if (!isRecord(rawMode) || !Array.isArray(rawMode.slots)) return undefined;
    let modeHasFrame = false;
    let modeHasImageReference = false;
    for (const rawSlot of rawMode.slots) {
      if (
        !isRecord(rawSlot)
        || !Number.isInteger(rawSlot.max)
        || (rawSlot.max as number) < 0
        || !isString(rawSlot.kind)
        || !isString(rawSlot.role)
      ) return undefined;
      const max = rawSlot.max as number;
      if (rawSlot.role === 'startFrame') {
        startFrame ||= max > 0;
        modeHasFrame ||= max > 0;
      } else if (rawSlot.role === 'endFrame') {
        endFrame ||= max > 0;
        modeHasFrame ||= max > 0;
      } else if (rawSlot.role === 'reference') {
        if (rawSlot.kind === 'image') {
          imageMax = Math.max(imageMax, max);
          imageSupportsNaming ||= rawSlot.supportsNaming === true;
          modeHasImageReference ||= max > 0;
        } else if (rawSlot.kind === 'video') {
          videoMax = Math.max(videoMax, max);
        } else if (rawSlot.kind === 'audio') {
          audioMax = Math.max(audioMax, max);
        } else if (rawSlot.kind === 'preparedVoice') {
          preparedAudioMax = Math.max(preparedAudioMax, max);
        } else if (rawSlot.kind === 'character') {
          characterMax = Math.max(characterMax, max);
        } else {
          return undefined;
        }
      } else {
        return undefined;
      }
    }
    combineFramesWithReferences ||= modeHasFrame && modeHasImageReference;
  }

  return {
    imageReferences: imageMax > 0 ? { max: imageMax, supportsNaming: imageSupportsNaming } : null,
    videoReferences: videoMax > 0 ? { max: videoMax } : null,
    audioReferences: audioMax > 0 ? { max: audioMax } : null,
    preparedAudioReferences: preparedAudioMax > 0 ? { max: preparedAudioMax } : null,
    characterReferences: characterMax > 0 ? { max: characterMax } : null,
    startFrame,
    endFrame,
    combineFramesWithReferences,
  };
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
  if (
    !isRecord(value)
    || (value.schemaVersion !== 1 && value.schemaVersion !== 2 && value.schemaVersion !== 3)
    || typeof value.revision !== 'string'
    || !isRecord(value.defaults)
    || !Array.isArray(value.models)
  ) {
    throw new Error('Invalid generation model catalog.');
  }
  const models = value.schemaVersion === 3
    ? value.models.map((model) => (
        isRecord(model)
          ? { ...model, inputs: deriveLegacyInputsFromInputModes(model.inputModes) }
          : model
      ))
    : value.models;
  if (!models.every(isDescriptor)) throw new Error('Invalid generation model catalog.');
  const catalog = { ...value, models } as unknown as GenerationModelCatalog;
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
  },
  complete = true,
) {
  if (complete) markRetired(registries.image, activeIds(catalog, 'image'));
  if (complete) markRetired(registries.video, activeIds(catalog, 'video'));
  if (complete) markRetired(registries.motion, activeIds(catalog, 'motion'));

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
        catalogDescriptor: model,
        catalogSortOrder: model.sortOrder,
        catalogRecommended: model.recommended,
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
        catalogDescriptor: model,
        catalogSortOrder: model.sortOrder,
        catalogRecommended: model.recommended,
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
      catalogDescriptor: model,
      catalogSortOrder: model.sortOrder,
      catalogRecommended: model.recommended,
    };
  }
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
  return null;
}

export type WebCatalogGenerationDraft = {
  kind: GenerationModelDescriptor['kind'];
  modelId: string;
  catalogRevision: string | null;
  settings: Record<string, string | number | boolean>;
  prompt: string;
  inputs: CatalogGenerationInputAsset[];
};

export function getCatalogDescriptorDefaultSettings(
  descriptor: GenerationModelDescriptor,
): Record<string, string | number | boolean> {
  return Object.fromEntries(descriptor.controls.map((control) => [
    control.key,
    control.defaultValue,
  ]));
}

function isCompatibleControlValue(
  control: CatalogControl,
  value: unknown,
): value is string | number | boolean {
  if (control.type === 'choice') {
    return typeof value === 'string'
      && control.options.some((option) => option.value === value);
  }
  if (control.type === 'boolean') return typeof value === 'boolean';
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= control.min
    && value <= control.max
    && (value - control.min) % control.step === 0;
}

function descriptorSlotKeys(descriptor: GenerationModelDescriptor): Set<string> {
  const descriptorV2 = descriptor as GenerationModelDescriptor & {
    inputModes?: Array<{ slots?: Array<{ key?: unknown }> }>;
  };
  const keys = new Set<string>();
  for (const mode of descriptorV2.inputModes ?? []) {
    for (const slot of mode.slots ?? []) {
      if (typeof slot.key === 'string' && slot.key) keys.add(slot.key);
    }
  }
  if (keys.size > 0) return keys;

  if (descriptor.inputs.startFrame) keys.add('startFrame');
  if (descriptor.inputs.endFrame) keys.add('endFrame');
  if (descriptor.inputs.imageReferences) keys.add('imageReferences');
  if (descriptor.inputs.videoReferences) keys.add('videoReferences');
  if (descriptor.inputs.audioReferences) keys.add('audioReferences');
  if (descriptor.inputs.preparedAudioReferences) keys.add('preparedVoices');
  if (descriptor.inputs.characterReferences) keys.add('characters');
  return keys;
}

export function reconcileWebCatalogGenerationDraft(
  catalog: GenerationModelCatalog,
  draft: WebCatalogGenerationDraft,
): WebCatalogGenerationDraft | null {
  const modelId = resolveCatalogModelId(catalog, draft.kind, draft.modelId);
  if (!modelId) return null;
  const descriptor = catalog.models.find((model) => (
    model.id === modelId && model.kind === draft.kind
  ));
  if (!descriptor) return null;

  const settings = getCatalogDescriptorDefaultSettings(descriptor);
  for (const control of descriptor.controls) {
    const draftValue = draft.settings[control.key];
    if (isCompatibleControlValue(control, draftValue)) {
      settings[control.key] = draftValue;
    }
  }
  const slotKeys = descriptorSlotKeys(descriptor);
  return {
    ...draft,
    modelId,
    catalogRevision: catalog.revision,
    settings,
    inputs: draft.inputs.filter((input) => slotKeys.has(input.slot)),
  };
}

function seedCatalogSummaryRegistry(summary: ModelCatalogSummary) {
  const registry = (summary.kind === 'image' ? IMAGE_MODELS : summary.kind === 'video' ? VIDEO_MODELS : MOTION_MODELS) as unknown as Registry;
  // Placeholder metadata is for rendering only. Quote/start remain disabled until details load.
  registry[summary.id] = {
    aspectRatios: [], resolutions: [], durations: [5], modeOptions: [], outputFormats: ['jpg'],
    maxImages: 0, maxDuration: 30, maxVideoDuration: 30, characterOrientations: ['video', 'image'],
    badgeColor: 'from-sky-500 to-cyan-500', accentColor: 'blue',
    ...registry[summary.id], ...summary, badge: summary.badge ?? '', catalogManaged: true,
    catalogActive: true, catalogSortOrder: summary.sortOrder, catalogRecommended: summary.recommended,
  };
}

export function useWebGenerationModelCatalog(options: {
  kind?: ModelCatalogKind; selectedIds?: string[]; pickerOpen?: boolean;
} = {}) {
  const [session] = useState(() => new ModelCatalogSession<GenerationModelDescriptor>(async (path, etag) => {
    const headers = new Headers(); if (etag) headers.set('If-None-Match', etag);
    const response = await fetch(path, { headers });
    if (response.status === 304) return { body: null, etag: response.headers.get('etag') ?? etag ?? null, notModified: true };
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? 'Could not load model settings.');
    return { body, etag: response.headers.get('etag'), notModified: false };
  }, value => parseClientGenerationModelCatalog({ schemaVersion: 3, revision: 'detail', defaults: { image: null, video: null, motion: null }, models: [value] }).models[0],
  typeof window === 'undefined' ? undefined : { getItem: key => window.localStorage.getItem(key), setItem: (key,value) => window.localStorage.setItem(key,value) }, 'web'));
  const [state, setState] = useState<CatalogSessionState<GenerationModelDescriptor>>(session.getSnapshot);
  const [retryVersion, setRetryVersion] = useState(0);
  const selectedKey = (options.selectedIds ?? []).join(',');
  const { current, details, nextCursors, error } = state;
  useEffect(() => {
    let registryRevision: string | null = null;
    const update = () => {
      const next = session.getSnapshot();
      if (next.current && next.current.revision !== registryRevision) {
        registryRevision = next.current.revision;
        for (const registry of [IMAGE_MODELS, VIDEO_MODELS, MOTION_MODELS]) markRetired(registry as unknown as Registry, new Set());
      }
      next.summaries.forEach(seedCatalogSummaryRegistry);
      if (next.current) applyGenerationModelCatalogToRegistries({ schemaVersion: 3, revision: next.current.revision, defaults: next.current.defaults, models: next.details }, undefined, false);
      setState(next);
    };
    try { window.localStorage.removeItem(LEGACY_WEB_CATALOG_CACHE_KEY); } catch { /* Storage is optional. */ }
    const unsubscribe = session.subscribe(update); void session.initialize(); return unsubscribe;
  }, [session]);
  useEffect(() => { if (options.pickerOpen) void session.refresh(); }, [options.pickerOpen, session]);
  useEffect(() => {
    if (!current) return;
    const ids = selectedKey ? selectedKey.split(',') : [];
    const defaultIds = options.kind ? [current.defaults[options.kind]] : Object.values(current.defaults);
    session.pin(ids); void session.ensureDetails([...ids, ...defaultIds.filter((id): id is string => Boolean(id))]);
  }, [session, current, selectedKey, options.kind, retryVersion]);
  useEffect(() => {
    const key = options.kind ?? 'all';
    if (!current || error) return;
    if (nextCursors[key] === undefined || (options.pickerOpen && nextCursors[key])) void session.loadPage(options.kind ?? null);
  }, [session, options.kind, options.pickerOpen, current, nextCursors, error, retryVersion]);
  const refetch = useCallback(() => { void session.retry().then(() => setRetryVersion(v => v + 1)); }, [session]);
  const selectedIds = selectedKey ? selectedKey.split(',') : [];
  const detailsReady = Boolean(current && selectedIds.every(id => details.some(m => m.id === id)));
  const catalog = useMemo(() => current ? { schemaVersion: 3, revision: current.revision, defaults: current.defaults, models: details } : null, [current, details]);
  return { catalog, current: current, summaries: state.summaries, missingIds: state.missingIds,
    detailsReady, isLoadingModels: Boolean(options.pickerOpen && nextCursors[options.kind ?? 'all'] !== null && !error), error: error, isLoading: !current, isLoadingDetails: state.loadingDetails,
    revision: current?.revision ?? null, refetch };
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

export type WebGenerationStartResponse = {
  success: true;
  predictionId: string;
  generationId: string | null;
  status: 'processing';
  remainingCredits: number;
  cost: number;
  catalogRevision: string;
  modelId: string;
  idempotentReplay?: true;
};

export async function requestWebGenerationStart(
  input: CatalogGenerationRequestPayload,
  {
    accessToken,
    idempotencyKey,
    signal,
    fetcher = fetch,
  }: {
    accessToken?: string | null;
    idempotencyKey: string;
    signal?: AbortSignal;
    fetcher?: typeof fetch;
  },
): Promise<WebGenerationStartResponse> {
  if (!input.catalogRevision.trim()) {
    throw new WebCatalogRequestError(
      'Refresh the model catalog before generating.',
      409,
      'CATALOG_CHANGED',
    );
  }
  if (!idempotencyKey.trim()) {
    throw new WebCatalogRequestError(
      'A generation request key is required.',
      400,
      'IDEMPOTENCY_KEY_REQUIRED',
    );
  }

  const response = await fetcher('/api/generations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify({
      schemaVersion: WEB_CATALOG_SCHEMA_VERSION,
      ...input,
    }),
    signal,
  });
  const body = await response.json() as Partial<WebGenerationStartResponse> & {
    error?: string;
    code?: string;
    fieldErrors?: Record<string, string>;
  };
  if (!response.ok) {
    const fieldErrors = body.fieldErrors ?? {};
    const fieldMessage = Object.values(fieldErrors)
      .find((message) => typeof message === 'string' && message.trim());
    throw new WebCatalogRequestError(
      fieldMessage ?? body.error ?? 'Could not start generation.',
      response.status,
      body.code,
      fieldErrors,
    );
  }
  if (
    body.success !== true
    || typeof body.predictionId !== 'string'
    || typeof body.catalogRevision !== 'string'
    || typeof body.modelId !== 'string'
    || typeof body.cost !== 'number'
    || typeof body.remainingCredits !== 'number'
  ) {
    throw new WebCatalogRequestError(
      'The generation service returned an invalid response.',
      502,
    );
  }
  return body as WebGenerationStartResponse;
}

export type WebGenerationQuoteStatus = 'idle' | 'pending' | 'ready' | 'error';

export function resolveWebGenerationQuoteUi({
  hasCatalog,
  catalogLoading = false,
  quoteStatus,
  quotedCost,
  quoteErrorMessage,
}: {
  hasCatalog: boolean;
  catalogLoading?: boolean;
  quoteStatus: WebGenerationQuoteStatus;
  quotedCost: number | null | undefined;
  quoteErrorMessage: string | null | undefined;
}) {
  if (!hasCatalog) {
    return {
      costCredits: null,
      costLabel: catalogLoading ? 'Loading settings…' : 'Unavailable',
      blocksGenerate: true,
      message: catalogLoading ? 'Loading the selected model’s settings…' : 'Model settings are unavailable. Retry before generating.',
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

export const WorkflowModelCatalogContext = createContext<ReturnType<typeof useWebGenerationModelCatalog> | null>(null);
