import AsyncStorage from '@react-native-async-storage/async-storage';

export const LEGACY_GENERATION_MODEL_CATALOG_SCHEMA_VERSION = 1;
export const GENERATION_MODEL_CATALOG_SCHEMA_VERSION = 2;
export const GENERATION_MODEL_CATALOG_CACHE_KEY = 'generation-model-catalog:v2';

export type GenerationModelCatalogSchemaVersion = 1 | 2;
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

export type CatalogConditionOperator =
  | 'equals'
  | 'notEquals'
  | 'in'
  | 'notIn'
  | 'greaterThan'
  | 'greaterThanOrEqual';

export interface CatalogCondition {
  source: 'setting' | 'inputCount';
  key: string;
  operator: CatalogConditionOperator;
  value: CatalogPrimitive | CatalogPrimitive[];
}

export type CatalogInputSlotKind = 'image' | 'video' | 'audio' | 'character' | 'preparedVoice';
export type CatalogInputSlotRole = 'reference' | 'startFrame' | 'endFrame';

export interface CatalogInputSlot {
  key: string;
  kind: CatalogInputSlotKind;
  role: CatalogInputSlotRole;
  label: string;
  min: number;
  max: number;
  supportsNaming?: boolean;
  durationMetadata?: 'optional' | 'required';
  maxDurationSeconds?: number;
  conditions?: CatalogCondition[];
}

export interface CatalogInputMode {
  key: string;
  label: string;
  default: boolean;
  conditions?: CatalogCondition[];
  slots: CatalogInputSlot[];
}

export interface CatalogInputConstraint {
  type: 'total-count' | 'weighted-count' | 'combined-duration';
  slotKeys: string[];
  max: number;
  weights?: Record<string, number>;
  conditions?: CatalogCondition[];
  message: string;
}

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
  /**
   * Kept in v2 so transition clients can continue using the v1 creation
   * surface while inputModes/slots become the source of truth.
   */
  inputs: {
    imageReferences: { max: number; supportsNaming: boolean } | null;
    videoReferences: { max: number } | null;
    audioReferences: { max: number } | null;
    preparedAudioReferences?: { max: number } | null;
    characterReferences?: { max: number } | null;
    startFrame: boolean;
    endFrame: boolean;
    combineFramesWithReferences?: boolean;
  };
  availability?: { web: boolean; mobile: boolean };
  inputModes?: CatalogInputMode[];
  inputConstraints?: CatalogInputConstraint[];
}

export interface GenerationModelCatalog {
  schemaVersion: GenerationModelCatalogSchemaVersion;
  revision: string;
  defaults: Record<GenerationModelKind, string | null>;
  models: GenerationModelDescriptor[];
}

export interface GenerationModelCatalogV2 extends GenerationModelCatalog {
  schemaVersion: 2;
}

export interface GenerationModelCatalogCacheEnvelope {
  catalog: GenerationModelCatalog;
  etag: string | null;
  fetchedAt: number;
}

export interface GenerationInputSlotMetadata {
  count?: number;
  durationsSeconds?: number[];
}

export interface GenerationModelQuoteRequest {
  schemaVersion?: GenerationModelCatalogSchemaVersion;
  kind: GenerationModelKind;
  modelId: string;
  settings: Record<string, unknown>;
  inputCounts: {
    images: number;
    videos: number;
    audios: number;
    preparedAudios?: number;
    characters?: number;
  };
  inputMetadata?: {
    slots?: Record<string, GenerationInputSlotMetadata>;
    referenceVideoDurationsSeconds?: number[];
  };
  catalogRevision?: string | null;
}

export interface GenerationModelQuote {
  modelId: string;
  catalogRevision: string;
  normalizedSettings: Record<string, CatalogPrimitive>;
  costCredits: number;
}

export interface CatalogGenerationInputAsset {
  slot: string;
  kind: CatalogInputSlotKind;
  url?: string | null;
  assetId?: string | null;
  storagePath?: string | null;
  label?: string | null;
  handle?: string | null;
  durationSeconds?: number | null;
  sourceGenerationId?: string | null;
}

export interface CatalogGenerationShot {
  prompt: string;
  duration?: number;
  settings?: Record<string, CatalogPrimitive>;
}

export interface CatalogGenerationRequest {
  kind: GenerationModelKind;
  modelId: string;
  catalogRevision: string;
  settings: Record<string, CatalogPrimitive>;
  prompt: string;
  shots?: CatalogGenerationShot[];
  inputs: CatalogGenerationInputAsset[];
  sourceGenerationId?: string | null;
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

function isPrimitive(value: unknown): value is CatalogPrimitive {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function parseControl(value: unknown): CatalogControl | null {
  if (!isRecord(value) || !isString(value.key) || !isString(value.label)) return null;
  if (value.type === 'choice') {
    if (
      (value.presentation !== 'chips' && value.presentation !== 'select')
      || !isString(value.defaultValue)
      || !Array.isArray(value.options)
    ) return null;
    const options = value.options.filter((option): option is { value: string; label: string } => (
      isRecord(option) && isString(option.value) && isString(option.label)
    ));
    if (
      options.length !== value.options.length
      || options.length === 0
      || !options.some((option) => option.value === value.defaultValue)
    ) return null;
    return {
      key: value.key,
      label: value.label,
      type: 'choice',
      presentation: value.presentation,
      defaultValue: value.defaultValue,
      options,
    };
  }
  if (value.type === 'boolean') {
    if (value.presentation !== 'toggle' || typeof value.defaultValue !== 'boolean') return null;
    return {
      key: value.key,
      label: value.label,
      type: 'boolean',
      presentation: 'toggle',
      defaultValue: value.defaultValue,
    };
  }
  if (value.type === 'integer') {
    if (
      value.presentation !== 'stepper'
      || typeof value.defaultValue !== 'number'
      || !Number.isInteger(value.defaultValue)
      || typeof value.min !== 'number'
      || !Number.isInteger(value.min)
      || typeof value.max !== 'number'
      || !Number.isInteger(value.max)
      || typeof value.step !== 'number'
      || !Number.isInteger(value.step)
      || value.min > value.max
      || value.step <= 0
      || value.defaultValue < value.min
      || value.defaultValue > value.max
    ) return null;
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

function parseCondition(value: unknown): CatalogCondition | null {
  if (
    !isRecord(value)
    || (value.source !== 'setting' && value.source !== 'inputCount')
    || !isString(value.key)
    || ![
      'equals',
      'notEquals',
      'in',
      'notIn',
      'greaterThan',
      'greaterThanOrEqual',
    ].includes(String(value.operator))
  ) return null;
  const conditionValue = value.value;
  if (
    !isPrimitive(conditionValue)
    && !(Array.isArray(conditionValue) && conditionValue.length > 0 && conditionValue.every(isPrimitive))
  ) return null;
  return {
    source: value.source,
    key: value.key,
    operator: value.operator as CatalogConditionOperator,
    value: conditionValue,
  };
}

function parseConditions(value: unknown): CatalogCondition[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  const conditions = value.map(parseCondition);
  return conditions.some((condition) => !condition) ? null : conditions as CatalogCondition[];
}

function parseInputSlot(value: unknown): CatalogInputSlot | null {
  if (
    !isRecord(value)
    || !isString(value.key)
    || !['image', 'video', 'audio', 'character', 'preparedVoice'].includes(String(value.kind))
    || !['reference', 'startFrame', 'endFrame'].includes(String(value.role))
    || !isString(value.label)
    || !Number.isInteger(value.min)
    || !Number.isInteger(value.max)
    || (value.min as number) < 0
    || (value.max as number) < (value.min as number)
    || (value.supportsNaming !== undefined && typeof value.supportsNaming !== 'boolean')
    || (
      value.durationMetadata !== undefined
      && value.durationMetadata !== 'optional'
      && value.durationMetadata !== 'required'
    )
    || (
      value.maxDurationSeconds !== undefined
      && (typeof value.maxDurationSeconds !== 'number' || value.maxDurationSeconds <= 0)
    )
  ) return null;
  const conditions = parseConditions(value.conditions);
  if (conditions === null) return null;
  return {
    key: value.key,
    kind: value.kind as CatalogInputSlotKind,
    role: value.role as CatalogInputSlotRole,
    label: value.label,
    min: value.min as number,
    max: value.max as number,
    ...(typeof value.supportsNaming === 'boolean' ? { supportsNaming: value.supportsNaming } : {}),
    ...(value.durationMetadata === 'optional' || value.durationMetadata === 'required'
      ? { durationMetadata: value.durationMetadata }
      : {}),
    ...(typeof value.maxDurationSeconds === 'number'
      ? { maxDurationSeconds: value.maxDurationSeconds }
      : {}),
    ...(conditions ? { conditions } : {}),
  };
}

function parseInputMode(value: unknown): CatalogInputMode | null {
  if (
    !isRecord(value)
    || !isString(value.key)
    || !isString(value.label)
    || typeof value.default !== 'boolean'
    || !Array.isArray(value.slots)
  ) return null;
  const conditions = parseConditions(value.conditions);
  const slots = value.slots.map(parseInputSlot);
  if (conditions === null || slots.some((slot) => !slot)) return null;
  return {
    key: value.key,
    label: value.label,
    default: value.default,
    ...(conditions ? { conditions } : {}),
    slots: slots as CatalogInputSlot[],
  };
}

function parseInputConstraint(value: unknown): CatalogInputConstraint | null {
  if (
    !isRecord(value)
    || !['total-count', 'weighted-count', 'combined-duration'].includes(String(value.type))
    || !Array.isArray(value.slotKeys)
    || value.slotKeys.length === 0
    || !value.slotKeys.every(isString)
    || typeof value.max !== 'number'
    || !Number.isFinite(value.max)
    || value.max < 0
    || !isString(value.message)
  ) return null;
  const conditions = parseConditions(value.conditions);
  if (conditions === null) return null;
  let weights: Record<string, number> | undefined;
  if (value.weights !== undefined) {
    if (
      !isRecord(value.weights)
      || Object.values(value.weights).some((weight) => typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0)
    ) return null;
    weights = value.weights as Record<string, number>;
  }
  if (value.type === 'weighted-count' && !weights) return null;
  return {
    type: value.type as CatalogInputConstraint['type'],
    slotKeys: value.slotKeys as string[],
    max: value.max,
    ...(weights ? { weights } : {}),
    ...(conditions ? { conditions } : {}),
    message: value.message,
  };
}

function parseLegacyInputs(value: Record<string, unknown>) {
  const imageReferences = parseReferenceLimit(value.imageReferences, true);
  const videoReferences = parseReferenceLimit(value.videoReferences, false);
  const audioReferences = parseReferenceLimit(value.audioReferences, false);
  const hasPreparedAudioReferences = value.preparedAudioReferences !== undefined;
  const hasCharacterReferences = value.characterReferences !== undefined;
  const hasCombineFramesWithReferences = value.combineFramesWithReferences !== undefined;
  const preparedAudioReferences = hasPreparedAudioReferences
    ? parseReferenceLimit(value.preparedAudioReferences, false)
    : undefined;
  const characterReferences = hasCharacterReferences
    ? parseReferenceLimit(value.characterReferences, false)
    : undefined;
  if (
    imageReferences === undefined
    || videoReferences === undefined
    || audioReferences === undefined
    || (hasPreparedAudioReferences && preparedAudioReferences === undefined)
    || (hasCharacterReferences && characterReferences === undefined)
    || (hasCombineFramesWithReferences && typeof value.combineFramesWithReferences !== 'boolean')
    || typeof value.startFrame !== 'boolean'
    || typeof value.endFrame !== 'boolean'
  ) return null;
  return {
    imageReferences: imageReferences as GenerationModelDescriptor['inputs']['imageReferences'],
    videoReferences,
    audioReferences,
    ...(hasPreparedAudioReferences ? { preparedAudioReferences } : {}),
    ...(hasCharacterReferences ? { characterReferences } : {}),
    startFrame: value.startFrame,
    endFrame: value.endFrame,
    ...(hasCombineFramesWithReferences
      ? { combineFramesWithReferences: value.combineFramesWithReferences as boolean }
      : {}),
  };
}

function parseModel(
  value: unknown,
  schemaVersion: GenerationModelCatalogSchemaVersion,
): GenerationModelDescriptor | null {
  if (
    !isRecord(value)
    || !isString(value.id)
    || !isKind(value.kind)
    || !isString(value.displayName)
    || typeof value.description !== 'string'
    || !isNullableString(value.badge)
    || typeof value.recommended !== 'boolean'
    || typeof value.sortOrder !== 'number'
    || !Number.isFinite(value.sortOrder)
    || typeof value.minClientSchemaVersion !== 'number'
    || !Number.isInteger(value.minClientSchemaVersion)
    || !Array.isArray(value.controls)
    || !isRecord(value.capabilities)
    || !isRecord(value.inputs)
  ) return null;
  const controls = value.controls.map(parseControl);
  if (controls.some((control) => !control)) return null;
  const controlKeys = new Set((controls as CatalogControl[]).map((control) => control.key));
  if (controlKeys.size !== controls.length) return null;

  const capabilities = value.capabilities;
  const capabilityKeys = ['multiShot', 'sound', 'fixedLens', 'googleSearch', 'outputFormat'];
  if (capabilityKeys.some((key) => typeof capabilities[key] !== 'boolean')) return null;
  const inputs = parseLegacyInputs(value.inputs);
  if (!inputs) return null;

  const descriptor: GenerationModelDescriptor = {
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
    inputs,
  };

  if (schemaVersion === 1) return descriptor;
  if (
    !isRecord(value.availability)
    || typeof value.availability.web !== 'boolean'
    || typeof value.availability.mobile !== 'boolean'
    || !Array.isArray(value.inputModes)
    || !Array.isArray(value.inputConstraints)
  ) return null;
  const inputModes = value.inputModes.map(parseInputMode);
  const inputConstraints = value.inputConstraints.map(parseInputConstraint);
  if (inputModes.some((mode) => !mode) || inputConstraints.some((constraint) => !constraint)) return null;
  const parsedInputModes = inputModes as CatalogInputMode[];
  const parsedInputConstraints = inputConstraints as CatalogInputConstraint[];
  const modeKeys = new Set<string>();
  const slotKeys = new Set<string>();
  let defaultModeCount = 0;
  for (const mode of parsedInputModes) {
    if (modeKeys.has(mode.key)) return null;
    modeKeys.add(mode.key);
    if (mode.default) defaultModeCount += 1;
    const modeSlotKeys = new Set<string>();
    for (const slot of mode.slots) {
      if (modeSlotKeys.has(slot.key)) return null;
      modeSlotKeys.add(slot.key);
      slotKeys.add(slot.key);
    }
  }
  if (defaultModeCount !== 1) return null;
  if (
    parsedInputConstraints.some((constraint) => (
      constraint.slotKeys.length === 0
      || new Set(constraint.slotKeys).size !== constraint.slotKeys.length
      || constraint.slotKeys.some((slotKey) => !slotKeys.has(slotKey))
      || (
        constraint.type === 'weighted-count'
        && (
          !constraint.weights
          || constraint.slotKeys.some((slotKey) => constraint.weights?.[slotKey] === undefined)
        )
      )
    ))
  ) return null;

  return {
    ...descriptor,
    availability: {
      web: value.availability.web,
      mobile: value.availability.mobile,
    },
    inputModes: parsedInputModes,
    inputConstraints: parsedInputConstraints,
  };
}

export function parseGenerationModelCatalog(
  value: unknown,
  expectedSchemaVersion: GenerationModelCatalogSchemaVersion = LEGACY_GENERATION_MODEL_CATALOG_SCHEMA_VERSION,
): GenerationModelCatalog {
  if (!isRecord(value) || value.schemaVersion !== expectedSchemaVersion) {
    throw new Error('Unsupported model catalog schema.');
  }
  if (!isString(value.revision) || !isRecord(value.defaults) || !Array.isArray(value.models)) {
    throw new Error('Invalid model catalog.');
  }
  const defaults = value.defaults;
  if (!isNullableString(defaults.image) || !isNullableString(defaults.video) || !isNullableString(defaults.motion)) {
    throw new Error('Invalid model catalog.');
  }
  const models = value.models.map((model) => parseModel(model, expectedSchemaVersion));
  if (models.some((model) => !model)) throw new Error('Invalid model catalog.');
  const parsedModels = models as GenerationModelDescriptor[];
  const ids = new Set(parsedModels.map((model) => model.id));
  if (ids.size !== parsedModels.length) throw new Error('Invalid model catalog.');
  for (const kind of ['image', 'video', 'motion'] as const) {
    const defaultId = defaults[kind];
    if (defaultId !== null && !parsedModels.some((model) => model.id === defaultId && model.kind === kind)) {
      throw new Error('Invalid model catalog.');
    }
  }

  return {
    schemaVersion: expectedSchemaVersion,
    revision: value.revision,
    defaults: { image: defaults.image, video: defaults.video, motion: defaults.motion },
    models: parsedModels,
  };
}

export async function loadCachedGenerationModelCatalogEnvelope(
  storage: CatalogStorage = AsyncStorage,
  expectedSchemaVersion: GenerationModelCatalogSchemaVersion = LEGACY_GENERATION_MODEL_CATALOG_SCHEMA_VERSION,
): Promise<GenerationModelCatalogCacheEnvelope | null> {
  try {
    const cached = await storage.getItem(GENERATION_MODEL_CATALOG_CACHE_KEY);
    if (!cached) return null;
    const parsed = JSON.parse(cached) as unknown;
    if (isRecord(parsed) && 'catalog' in parsed) {
      return {
        catalog: parseGenerationModelCatalog(parsed.catalog, expectedSchemaVersion),
        etag: typeof parsed.etag === 'string' ? parsed.etag : null,
        fetchedAt: typeof parsed.fetchedAt === 'number' && Number.isFinite(parsed.fetchedAt)
          ? parsed.fetchedAt
          : 0,
      };
    }
    return {
      catalog: parseGenerationModelCatalog(parsed, expectedSchemaVersion),
      etag: null,
      fetchedAt: 0,
    };
  } catch {
    return null;
  }
}

export async function loadCachedGenerationModelCatalog(
  storage: CatalogStorage = AsyncStorage,
  expectedSchemaVersion: GenerationModelCatalogSchemaVersion = LEGACY_GENERATION_MODEL_CATALOG_SCHEMA_VERSION,
): Promise<GenerationModelCatalog | null> {
  return (await loadCachedGenerationModelCatalogEnvelope(storage, expectedSchemaVersion))?.catalog ?? null;
}

export async function saveCachedGenerationModelCatalog(
  catalog: GenerationModelCatalog,
  storage: CatalogStorage = AsyncStorage,
  metadata: { etag?: string | null; fetchedAt?: number } = {},
) {
  await storage.setItem(GENERATION_MODEL_CATALOG_CACHE_KEY, JSON.stringify({
    catalog,
    etag: metadata.etag ?? null,
    fetchedAt: metadata.fetchedAt ?? Date.now(),
  } satisfies GenerationModelCatalogCacheEnvelope));
}

export function getCatalogModels(catalog: GenerationModelCatalog, kind: GenerationModelKind) {
  return catalog.models.filter((model) => (
    model.kind === kind
    && model.minClientSchemaVersion <= catalog.schemaVersion
    && (catalog.schemaVersion === 1 || model.availability?.mobile === true)
  ));
}

export function getCatalogModel(catalog: GenerationModelCatalog, modelId: string) {
  return catalog.models.find((model) => model.id === modelId) ?? null;
}

export function getCatalogControl(model: GenerationModelDescriptor, key: string) {
  return model.controls.find((control) => control.key === key) ?? null;
}

export function normalizeCatalogSettings(
  model: GenerationModelDescriptor,
  settings: Record<string, CatalogPrimitive>,
): Record<string, CatalogPrimitive> {
  return Object.fromEntries(model.controls.map((control) => {
    const current = settings[control.key];
    if (control.type === 'choice') {
      return [
        control.key,
        typeof current === 'string' && control.options.some((option) => option.value === current)
          ? current
          : control.defaultValue,
      ];
    }
    if (control.type === 'boolean') {
      return [control.key, typeof current === 'boolean' ? current : control.defaultValue];
    }
    const isValidInteger = typeof current === 'number'
      && Number.isInteger(current)
      && current >= control.min
      && current <= control.max
      && (current - control.min) % control.step === 0;
    return [control.key, isValidInteger ? current : control.defaultValue];
  }));
}

export function catalogConditionsMatch(
  conditions: CatalogCondition[] | undefined,
  settings: Record<string, CatalogPrimitive>,
  inputCounts: Record<string, number> = {},
) {
  return (conditions ?? []).every((condition) => {
    const actual = condition.source === 'setting'
      ? settings[condition.key]
      : inputCounts[condition.key] ?? 0;
    const expected = condition.value;
    if (condition.operator === 'equals') return actual === expected;
    if (condition.operator === 'notEquals') return actual !== expected;
    const expectedValues = Array.isArray(expected) ? expected : [expected];
    if (condition.operator === 'in') return expectedValues.includes(actual as never);
    if (condition.operator === 'notIn') return !expectedValues.includes(actual as never);
    if (typeof actual !== 'number' || typeof expected !== 'number') return false;
    return condition.operator === 'greaterThan' ? actual > expected : actual >= expected;
  });
}

export function getActiveCatalogInputModes(
  model: GenerationModelDescriptor,
  settings: Record<string, CatalogPrimitive>,
  inputCounts: Record<string, number> = {},
) {
  return (model.inputModes ?? []).filter((mode) => (
    catalogConditionsMatch(mode.conditions, settings, inputCounts)
  ));
}

export function getActiveCatalogInputSlots(
  model: GenerationModelDescriptor,
  settings: Record<string, CatalogPrimitive>,
  inputCounts: Record<string, number> = {},
) {
  return getActiveCatalogInputModes(model, settings, inputCounts)
    .flatMap((mode) => mode.slots)
    .filter((slot) => catalogConditionsMatch(slot.conditions, settings, inputCounts));
}

export function getCatalogDefaultModel(
  catalog: GenerationModelCatalog,
  kind: GenerationModelKind,
): GenerationModelDescriptor | null {
  const models = getCatalogModels(catalog, kind);
  const defaultId = catalog.defaults[kind];
  return models.find((model) => model.id === defaultId)
    ?? models.find((model) => model.recommended)
    ?? models[0]
    ?? null;
}
