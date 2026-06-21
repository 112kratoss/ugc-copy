import AsyncStorage from '@react-native-async-storage/async-storage';

export const GENERATION_MODEL_CATALOG_SCHEMA_VERSION = 1;
export const GENERATION_MODEL_CATALOG_CACHE_KEY = 'generation-model-catalog:v1';

export type GenerationModelKind = 'image' | 'video' | 'motion';
export type CatalogPrimitive = string | number | boolean;

export interface CatalogChoiceControl {
  key: string;
  label: string;
  type: 'choice';
  presentation: 'chips' | 'select';
  defaultValue: string;
  options: Array<{ value: string; label: string }>;
}

export interface CatalogBooleanControl {
  key: string;
  label: string;
  type: 'boolean';
  presentation: 'toggle';
  defaultValue: boolean;
}

export interface CatalogIntegerControl {
  key: string;
  label: string;
  type: 'integer';
  presentation: 'stepper';
  defaultValue: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
}

export type CatalogControl = CatalogChoiceControl | CatalogBooleanControl | CatalogIntegerControl;

export interface GenerationModelDescriptor {
  id: string;
  kind: GenerationModelKind;
  displayName: string;
  description: string;
  badge: string | null;
  recommended: boolean;
  sortOrder: number;
  minClientSchemaVersion: number;
  controls: CatalogControl[];
  capabilities: {
    multiShot: boolean;
    sound: boolean;
    fixedLens: boolean;
    googleSearch: boolean;
    outputFormat: boolean;
  };
  inputs: {
    imageReferences: { max: number; supportsNaming: boolean } | null;
    videoReferences: { max: number } | null;
    audioReferences: { max: number } | null;
    startFrame: boolean;
    endFrame: boolean;
  };
}

export interface GenerationModelCatalog {
  schemaVersion: 1;
  revision: string;
  defaults: Record<GenerationModelKind, string | null>;
  models: GenerationModelDescriptor[];
}

export interface GenerationModelQuoteRequest {
  kind: GenerationModelKind;
  modelId: string;
  settings: Record<string, unknown>;
  inputCounts: { images: number; videos: number; audios: number };
  catalogRevision?: string | null;
}

export interface GenerationModelQuote {
  modelId: string;
  catalogRevision: string;
  normalizedSettings: Record<string, CatalogPrimitive>;
  costCredits: number;
}

interface CatalogStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isKind(value: unknown): value is GenerationModelKind {
  return value === 'image' || value === 'video' || value === 'motion';
}

function parseControl(value: unknown): CatalogControl | null {
  if (!isRecord(value) || !isString(value.key) || !isString(value.label)) return null;
  if (value.type === 'choice') {
    if ((value.presentation !== 'chips' && value.presentation !== 'select') || !isString(value.defaultValue) || !Array.isArray(value.options)) return null;
    const options = value.options.filter((option): option is { value: string; label: string } => (
      isRecord(option) && isString(option.value) && isString(option.label)
    ));
    if (options.length !== value.options.length || options.length === 0) return null;
    return { key: value.key, label: value.label, type: 'choice', presentation: value.presentation, defaultValue: value.defaultValue, options };
  }
  if (value.type === 'boolean') {
    if (value.presentation !== 'toggle' || typeof value.defaultValue !== 'boolean') return null;
    return { key: value.key, label: value.label, type: 'boolean', presentation: 'toggle', defaultValue: value.defaultValue };
  }
  if (value.type === 'integer') {
    if (value.presentation !== 'stepper' || typeof value.defaultValue !== 'number' || typeof value.min !== 'number' || typeof value.max !== 'number' || typeof value.step !== 'number') return null;
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

function parseModel(value: unknown): GenerationModelDescriptor | null {
  if (!isRecord(value) || !isString(value.id) || !isKind(value.kind) || !isString(value.displayName) || typeof value.description !== 'string') return null;
  if (!isNullableString(value.badge) || typeof value.recommended !== 'boolean' || typeof value.sortOrder !== 'number' || typeof value.minClientSchemaVersion !== 'number') return null;
  if (!Array.isArray(value.controls) || !isRecord(value.capabilities) || !isRecord(value.inputs)) return null;
  const controls = value.controls.map(parseControl);
  if (controls.some((control) => !control)) return null;
  const capabilities = value.capabilities;
  const capabilityKeys = ['multiShot', 'sound', 'fixedLens', 'googleSearch', 'outputFormat'];
  if (capabilityKeys.some((key) => typeof capabilities[key] !== 'boolean')) return null;
  const imageReferences = parseReferenceLimit(value.inputs.imageReferences, true);
  const videoReferences = parseReferenceLimit(value.inputs.videoReferences, false);
  const audioReferences = parseReferenceLimit(value.inputs.audioReferences, false);
  if (imageReferences === undefined || videoReferences === undefined || audioReferences === undefined || typeof value.inputs.startFrame !== 'boolean' || typeof value.inputs.endFrame !== 'boolean') return null;

  return {
    id: value.id,
    kind: value.kind,
    displayName: value.displayName,
    description: value.description,
    badge: value.badge,
    recommended: value.recommended,
    sortOrder: value.sortOrder,
    minClientSchemaVersion: value.minClientSchemaVersion,
    controls: controls as CatalogControl[],
    capabilities: {
      multiShot: capabilities.multiShot as boolean,
      sound: capabilities.sound as boolean,
      fixedLens: capabilities.fixedLens as boolean,
      googleSearch: capabilities.googleSearch as boolean,
      outputFormat: capabilities.outputFormat as boolean,
    },
    inputs: {
      imageReferences: imageReferences as GenerationModelDescriptor['inputs']['imageReferences'],
      videoReferences,
      audioReferences,
      startFrame: value.inputs.startFrame,
      endFrame: value.inputs.endFrame,
    },
  };
}

export function parseGenerationModelCatalog(value: unknown): GenerationModelCatalog {
  if (!isRecord(value) || value.schemaVersion !== GENERATION_MODEL_CATALOG_SCHEMA_VERSION) {
    throw new Error('Unsupported model catalog schema.');
  }
  if (!isString(value.revision) || !isRecord(value.defaults) || !Array.isArray(value.models)) {
    throw new Error('Invalid model catalog.');
  }
  const defaults = value.defaults;
  if (!isNullableString(defaults.image) || !isNullableString(defaults.video) || !isNullableString(defaults.motion)) {
    throw new Error('Invalid model catalog.');
  }
  const models = value.models.map(parseModel);
  if (models.some((model) => !model)) throw new Error('Invalid model catalog.');

  return {
    schemaVersion: 1,
    revision: value.revision,
    defaults: { image: defaults.image, video: defaults.video, motion: defaults.motion },
    models: models as GenerationModelDescriptor[],
  };
}

export async function loadCachedGenerationModelCatalog(storage: CatalogStorage = AsyncStorage): Promise<GenerationModelCatalog | null> {
  try {
    const cached = await storage.getItem(GENERATION_MODEL_CATALOG_CACHE_KEY);
    return cached ? parseGenerationModelCatalog(JSON.parse(cached)) : null;
  } catch {
    return null;
  }
}

export async function saveCachedGenerationModelCatalog(catalog: GenerationModelCatalog, storage: CatalogStorage = AsyncStorage) {
  await storage.setItem(GENERATION_MODEL_CATALOG_CACHE_KEY, JSON.stringify(catalog));
}

export function getCatalogModels(catalog: GenerationModelCatalog, kind: GenerationModelKind) {
  return catalog.models.filter((model) => model.kind === kind);
}

export function getCatalogModel(catalog: GenerationModelCatalog, modelId: string) {
  return catalog.models.find((model) => model.id === modelId) ?? null;
}

export function getCatalogControl(model: GenerationModelDescriptor, key: string) {
  return model.controls.find((control) => control.key === key) ?? null;
}

export function normalizeCatalogSettings(
  model: GenerationModelDescriptor,
  settings: Record<string, CatalogPrimitive>
): Record<string, CatalogPrimitive> {
  return Object.fromEntries(model.controls.map((control) => {
    const current = settings[control.key];
    if (control.type === 'choice') {
      return [control.key, typeof current === 'string' && control.options.some((option) => option.value === current) ? current : control.defaultValue];
    }
    if (control.type === 'boolean') return [control.key, typeof current === 'boolean' ? current : control.defaultValue];
    return [control.key, typeof current === 'number' && current >= control.min && current <= control.max ? current : control.defaultValue];
  }));
}
