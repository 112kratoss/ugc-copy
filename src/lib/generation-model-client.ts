'use client';

import { createContext, useCallback, useEffect, useMemo, useState } from 'react';
import { ModelCatalogSession, type CatalogSessionState } from '../../ugc-mobile/lib/model-catalog/session';
import { catalogRunWithShownCost, type ModelCatalogKind, type ModelCatalogSummary } from '../../ugc-mobile/lib/model-catalog/protocol';

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
  // For a caller about to store the revision, such as a workflow run. What this hook returns is as old as the page load or the last picker open.
  const ensureCurrent = useCallback(() => session.ensureCurrent(selectedKey ? selectedKey.split(',') : []), [session, selectedKey]);
  const selectedIds = selectedKey ? selectedKey.split(',') : [];
  const detailsReady = Boolean(current && selectedIds.every(id => details.some(m => m.id === id)));
  const catalog = useMemo(() => current ? { schemaVersion: 3, revision: current.revision, defaults: current.defaults, models: details } : null, [current, details]);
  return { catalog, current: current, summaries: state.summaries, missingIds: state.missingIds,
    detailsReady, isLoadingModels: Boolean(options.pickerOpen && nextCursors[options.kind ?? 'all'] !== null && !error), error: error, isLoading: !current, isLoadingDetails: state.loadingDetails,
    // While the network is asked for the current revision; a catalog read back from the browser stands in meanwhile.
    isCheckingRevision: state.loading,
    revision: current?.revision ?? null, refetch, ensureCurrent };
}

export class WebCatalogRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly fieldErrors: Record<string, string> = {},
    /**
     * The whole error body, for what the fields above leave out: the measured
     * `inputs` and `costCredits` of a REFERENCE_DURATION_CHANGED refusal, the
     * held `generationId` of a submission_pending one.
     */
    public readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'WebCatalogRequestError';
  }
}

export type WebStartTool = 'image' | 'video' | 'motion';

/**
 * A start the page sent but has no answer to: kept, with its key and the exact
 * body, until an answer says whether it started. Each press used to mint a new
 * key and forget it, so after a lost response the next press reached the
 * server as a request it had never seen, and it started and charged a second
 * run. Replaying the same key and body instead answers with the run that
 * started, or starts it once. Mobile keeps the same record
 * (ugc-mobile/lib/generation-attempts.ts).
 */
export type PendingWebStart = {
  version: 1;
  tool: WebStartTool;
  idempotencyKey: string;
  body: Record<string, unknown>;
  catalogRevision: string;
  createdAt: string;
  /**
   * The account that sent it. A tab that changes account must not replay
   * another account's start under its own credits.
   */
  userId?: string | null;
};

const PENDING_WEB_START_STORAGE_PREFIX = 'magicbooklet:pending-generation-start:v1';
/** Past this a start is no longer worth a second look. */
export const PENDING_WEB_START_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function pendingWebStartStorageKey(tool: WebStartTool) {
  return `${PENDING_WEB_START_STORAGE_PREFIX}:${tool}`;
}

// sessionStorage: one tab's attempt, so another tab never replays it, and it
// lasts through the reload a deploy or a lost session can bring.
function getPendingWebStartStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function parsePendingWebStart(raw: string, tool: WebStartTool): PendingWebStart | null {
  try {
    const value = JSON.parse(raw) as Partial<PendingWebStart>;
    if (
      value.version !== 1
      || value.tool !== tool
      || typeof value.idempotencyKey !== 'string' || !value.idempotencyKey
      || !isRecord(value.body)
      || typeof value.catalogRevision !== 'string'
      || typeof value.createdAt !== 'string'
      || (value.userId !== undefined && value.userId !== null && typeof value.userId !== 'string')
    ) {
      return null;
    }
    return value as PendingWebStart;
  } catch {
    return null;
  }
}

/**
 * The tool's unanswered start, or null. Pass the signed-in user's id: a start
 * saved under another account is dropped rather than handed back.
 */
export function loadPendingWebStart(tool: WebStartTool, userId?: string | null): PendingWebStart | null {
  const storage = getPendingWebStartStorage();
  if (!storage) return null;
  const key = pendingWebStartStorageKey(tool);
  let raw: string | null = null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;
  const start = parsePendingWebStart(raw, tool);
  const createdAt = start ? Date.parse(start.createdAt) : Number.NaN;
  if (
    !start
    || !Number.isFinite(createdAt)
    || Date.now() - createdAt > PENDING_WEB_START_MAX_AGE_MS
    || (userId && start.userId && start.userId !== userId)
  ) {
    try {
      storage.removeItem(key);
    } catch {
      // Storage refused: the record stays unreadable to this tab either way.
    }
    return null;
  }
  return start;
}

/**
 * Saves the start before it is sent. False when the browser refused the
 * write; the page then holds the key in memory, which still covers a retry
 * from the same page.
 */
export function savePendingWebStart(start: PendingWebStart): boolean {
  const storage = getPendingWebStartStorage();
  if (!storage) return false;
  try {
    storage.setItem(pendingWebStartStorageKey(start.tool), JSON.stringify(start));
    return true;
  } catch {
    return false;
  }
}

export function clearPendingWebStart(tool: WebStartTool): void {
  try {
    getPendingWebStartStorage()?.removeItem(pendingWebStartStorageKey(tool));
  } catch {
    // Nothing to clear in a tab whose storage is unavailable.
  }
}

/** Refusals the server makes before it reserves credits or calls the provider. */
const DEFINITIVE_WEB_START_FAILURE_CODES = new Set([
  'insufficient_credits',
  'invalid_input_media',
  'service_misconfigured',
  'provider_busy',
  'provider_unavailable',
  'provider_rejected',
  'prompt_blocked',
  'INVALID_GENERATION_REQUEST',
  'INVALID_MODEL_SETTINGS',
  'MODEL_UNAVAILABLE',
  'CATALOG_CHANGED',
  'REFERENCE_DURATION_CHANGED',
  'RATE_LIMITED',
  'cost_changed',
  // The per-kind routes' answer when the provider key is missing: nothing is held.
  'GENERATION_SERVICE_UNAVAILABLE',
]);
/** Answers that say the start under this key is, or may be, under way. */
const AMBIGUOUS_WEB_START_FAILURE_CODES = new Set([
  'submission_pending',
  'GENERATION_START_IN_PROGRESS',
  'GENERATION_ADAPTER_UNAVAILABLE',
]);

/**
 * Whether a start that threw may still have started a run, so the page must
 * keep its key and replay it rather than mint a new one. Yes for no answer at
 * all (a network failure, an abort, a body that is not JSON), for an answer
 * saying the start is under way, and for a server fault without a refusal
 * code. A refusal the server made before reserving credits is definitive.
 */
export function isAmbiguousWebStartFailure(error: unknown): boolean {
  if (error instanceof TypeError || error instanceof SyntaxError) return true;
  if (!error || typeof error !== 'object') return false;
  const { name, status, code } = error as { name?: unknown; status?: unknown; code?: unknown };
  if (name === 'AbortError') return true;
  if (typeof status !== 'number') return false;
  if (typeof code === 'string') {
    if (AMBIGUOUS_WEB_START_FAILURE_CODES.has(code)) return true;
    if (DEFINITIVE_WEB_START_FAILURE_CODES.has(code) || code.startsWith('IDEMPOTENCY_KEY_')) return false;
  }
  // A 409 is ambiguous unless its code says refusal: the start RPC's own
  // "already starting under this key" answer carries none.
  return status === 0 || status >= 500 || status === 409;
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

/**
 * The run as a web creator sends it to start: with the price on its Generate button
 * (`expectedCostCredits`) when that price is a ready quote of this very run, read off the
 * page's quote state. The rule both creators share is `catalogRunWithShownCost`.
 */
export function webCatalogStartRequest(
  run: CatalogGenerationRequestPayload,
  quote: {
    status: WebGenerationQuoteStatus;
    quote: Pick<GenerationModelQuote, 'costCredits'> | null;
    /** The quote request the state answers, as JSON (`useWebGenerationModelQuote`). */
    key: string | null;
  },
): CatalogGenerationRequestPayload {
  return catalogRunWithShownCost(run, { key: quote.key, status: quote.status, cost: quote.quote?.costCredits });
}

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
  let parsedBody: unknown = null;
  try {
    parsedBody = await response.json();
  } catch {
    // A platform timeout or gateway page instead of JSON. Its status still
    // decides: a 5xx may have started the run, a 200 surely did.
  }
  const body = (isRecord(parsedBody) ? parsedBody : {}) as Partial<WebGenerationStartResponse> & {
    error?: string;
    code?: string;
    fieldErrors?: Record<string, string>;
  };
  if (!response.ok) {
    const fieldErrors = isRecord(body.fieldErrors) ? body.fieldErrors as Record<string, string> : {};
    const fieldMessage = Object.values(fieldErrors)
      .find((message) => typeof message === 'string' && message.trim());
    throw new WebCatalogRequestError(
      fieldMessage ?? (typeof body.error === 'string' && body.error ? body.error : 'Could not start generation.'),
      response.status,
      typeof body.code === 'string' ? body.code : undefined,
      fieldErrors,
      body,
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

export function useWebGenerationModelQuote(
  input: GenerationModelQuoteInput | null,
  accessToken?: string | null,
  /** Bumped by a "Retry quote" press: a failed quote otherwise stayed failed until a setting changed. */
  attempt = 0,
) {
  const serializedInput = input ? JSON.stringify(input) : null;
  const requestKey = serializedInput ? `${accessToken ?? ''}\n${attempt}\n${serializedInput}` : null;
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

  // `key` is the request a state answers, as JSON: a ready quote is the price of exactly
  // that request, which is how a start tells the price shown for its own run.
  if (!requestKey) {
    return { status: 'idle' as const, quote: null, error: null, key: null };
  }
  if (state?.key === requestKey) {
    return { status: state.status, quote: state.quote, error: state.error, key: serializedInput };
  }
  return { status: 'pending' as const, quote: null, error: null, key: serializedInput };
}

export const WorkflowModelCatalogContext = createContext<ReturnType<typeof useWebGenerationModelCatalog> | null>(null);
