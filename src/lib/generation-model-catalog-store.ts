import 'server-only';
import { logBackendError, logBackendWarning } from '@/lib/backend-logger';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  CatalogError,
  GENERATION_MODEL_CATALOG_SCHEMA_VERSION,
  buildGenerationModelCatalog,
  projectGenerationModelDescriptor,
  quoteGenerationModel,
  type CatalogCondition,
  type CatalogControl,
  type CatalogInputConstraint,
  type CatalogInputMode,
  type CatalogInputSlot,
  type CatalogPlatform,
  type CatalogPrimitive,
  type GenerationModelCatalog,
  type GenerationModelDescriptor,
  type GenerationModelKind,
  type GenerationModelQuote,
  type GenerationModelQuoteInput,
} from '@/lib/generation-model-catalog';
import {
  GENERATION_MODEL_ADAPTER_KEYS,
  GENERATION_MODEL_PRICING_STRATEGIES,
  GENERATION_MODEL_VALIDATION_STRATEGIES,
  buildCodeGenerationModelOperations,
  type GenerationModelOperationalConfig,
} from '@/lib/generation-model-runtime';
import { createServiceClient } from '@/lib/server-helpers';

export type GenerationModelCatalogSource = 'code' | 'shadow' | 'database';

export class GenerationModelCatalogSchemaUnavailableError extends Error {
  readonly requestedSchemaVersion: number;
  readonly releaseSchemaVersion: number;

  constructor(requestedSchemaVersion: number, releaseSchemaVersion: number) {
    super(`A schema-v${requestedSchemaVersion} generation model catalog has not been published yet.`);
    this.name = 'GenerationModelCatalogSchemaUnavailableError';
    this.requestedSchemaVersion = requestedSchemaVersion;
    this.releaseSchemaVersion = releaseSchemaVersion;
  }
}

export type PublishedGenerationModelCatalogSnapshot = {
  catalog: GenerationModelCatalog;
  operations: Map<string, GenerationModelOperationalConfig>;
  source: GenerationModelCatalogSource;
  releaseId: string | null;
  releaseSchemaVersion?: number;
};

type ReleaseRow = {
  id: string;
  schema_version: number;
  revision: string;
  status?: string;
  defaults: unknown;
};

type EntryRow = {
  model_id: string;
  public_descriptor: unknown;
  web_enabled: boolean;
  mobile_enabled: boolean;
  adapter_key: string;
  adapter_config?: unknown;
  provider_model_map: unknown;
  pricing_strategy: string;
  pricing_config: unknown;
  validation_strategy: string;
  validation_config: unknown;
  verification_config: unknown;
};

type DatabaseReleaseSnapshot = {
  release: ReleaseRow;
  entries: EntryRow[];
};

const DATABASE_CACHE_TTL_MS = 60 * 1000;
const MAX_REVISION_CACHE_ENTRIES = 10;
let cachedDatabaseRelease: { expiresAt: number; snapshot: DatabaseReleaseSnapshot } | null = null;
let pendingDatabaseRelease: Promise<DatabaseReleaseSnapshot> | null = null;
const cachedDatabaseRevisions = new Map<string, DatabaseReleaseSnapshot>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isGenerationModelKind(value: unknown): value is GenerationModelKind {
  return value === 'image' || value === 'video' || value === 'motion';
}

function isCatalogPrimitive(value: unknown): value is CatalogPrimitive {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function parseCondition(value: unknown): CatalogCondition | null {
  if (!isRecord(value)
    || (value.source !== 'setting' && value.source !== 'inputCount')
    || !isString(value.key)
    || !['equals', 'notEquals', 'in', 'notIn', 'greaterThan', 'greaterThanOrEqual'].includes(String(value.operator))) {
    return null;
  }
  const expected = value.value;
  if (!isCatalogPrimitive(expected)
    && !(Array.isArray(expected) && expected.every(isCatalogPrimitive))) {
    return null;
  }
  return {
    source: value.source,
    key: value.key,
    operator: value.operator as CatalogCondition['operator'],
    value: expected,
  };
}

function parseConditions(value: unknown): CatalogCondition[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const conditions = value.map(parseCondition);
  return conditions.some((condition) => !condition)
    ? undefined
    : conditions as CatalogCondition[];
}

function parseCatalogControl(value: unknown): CatalogControl | null {
  if (!isRecord(value) || !isString(value.key) || !isString(value.label)) return null;
  const compatibility = {
    ...(value.minClientSchemaVersion === undefined
      ? {}
      : Number.isInteger(value.minClientSchemaVersion) && Number(value.minClientSchemaVersion) > 0
        ? { minClientSchemaVersion: Number(value.minClientSchemaVersion) }
        : { invalid: true }),
    ...(value.conditions === undefined
      ? {}
      : parseConditions(value.conditions)
        ? { conditions: parseConditions(value.conditions) }
        : { invalid: true }),
  };
  if ('invalid' in compatibility) return null;
  if (value.type === 'boolean') {
    return value.presentation === 'toggle' && typeof value.defaultValue === 'boolean'
      ? {
          key: value.key,
          label: value.label,
          type: 'boolean',
          presentation: 'toggle',
          defaultValue: value.defaultValue,
          ...compatibility,
        }
      : null;
  }
  if (value.type === 'choice') {
    if (!((value.presentation === 'chips' || value.presentation === 'select')
      && isString(value.defaultValue)
      && Array.isArray(value.options)
      && value.options.length > 0
      && value.options.every((option) => (
        isRecord(option) && isString(option.value) && isString(option.label)
      )))) return null;
    const options = value.options as Array<{ value: string; label: string }>;
    if (!options.some((option) => option.value === value.defaultValue)) return null;
    if (value.normalizedValueType !== undefined
      && value.normalizedValueType !== 'string'
      && value.normalizedValueType !== 'number') return null;
    return {
      key: value.key,
      label: value.label,
      type: 'choice',
      presentation: value.presentation,
      defaultValue: value.defaultValue,
      options: options.map((option) => ({ value: option.value, label: option.label })),
      ...(value.normalizedValueType ? { normalizedValueType: value.normalizedValueType } : {}),
      ...compatibility,
    };
  }
  if (!(value.type === 'integer'
    && value.presentation === 'stepper'
    && Number.isFinite(value.defaultValue)
    && Number.isFinite(value.min)
    && Number.isFinite(value.max)
    && Number.isFinite(value.step)
    && Number(value.step) > 0
    && Number(value.min) <= Number(value.defaultValue)
    && Number(value.defaultValue) <= Number(value.max))) return null;
  return {
    key: value.key,
    label: value.label,
    type: 'integer',
    presentation: 'stepper',
    defaultValue: Number(value.defaultValue),
    min: Number(value.min),
    max: Number(value.max),
    step: Number(value.step),
    ...(typeof value.unit === 'string' ? { unit: value.unit } : {}),
    ...compatibility,
  };
}

function parseReferenceLimit(value: unknown, supportsNaming: true): { max: number; supportsNaming: boolean } | null | undefined;
function parseReferenceLimit(value: unknown, supportsNaming: false): { max: number } | null | undefined;
function parseReferenceLimit(value: unknown, supportsNaming: boolean) {
  if (value === null) return null;
  if (!isRecord(value) || !Number.isInteger(value.max) || Number(value.max) < 0) return undefined;
  if (supportsNaming && typeof value.supportsNaming !== 'boolean') return undefined;
  return supportsNaming
    ? { max: Number(value.max), supportsNaming: value.supportsNaming as boolean }
    : { max: Number(value.max) };
}

function parseInputSlot(value: unknown): CatalogInputSlot | null {
  if (!isRecord(value)
    || !isString(value.key)
    || !isString(value.label)
    || !['image', 'video', 'audio', 'character', 'preparedVoice'].includes(String(value.kind))
    || !['reference', 'startFrame', 'endFrame'].includes(String(value.role))
    || !Number.isInteger(value.min)
    || !Number.isInteger(value.max)
    || Number(value.min) < 0
    || Number(value.max) < Number(value.min)) {
    return null;
  }
  if (value.supportsNaming !== undefined && typeof value.supportsNaming !== 'boolean') return null;
  if (value.durationMetadata !== undefined
    && value.durationMetadata !== 'optional'
    && value.durationMetadata !== 'required') return null;
  if (value.maxDurationSeconds !== undefined
    && (!Number.isFinite(value.maxDurationSeconds) || Number(value.maxDurationSeconds) <= 0)) return null;
  const conditions = parseConditions(value.conditions);
  if (value.conditions !== undefined && !conditions) return null;
  return {
    key: value.key,
    label: value.label,
    kind: value.kind as CatalogInputSlot['kind'],
    role: value.role as CatalogInputSlot['role'],
    min: Number(value.min),
    max: Number(value.max),
    ...(typeof value.supportsNaming === 'boolean' ? { supportsNaming: value.supportsNaming } : {}),
    ...(value.durationMetadata ? { durationMetadata: value.durationMetadata } : {}),
    ...(value.maxDurationSeconds === undefined ? {} : { maxDurationSeconds: Number(value.maxDurationSeconds) }),
    ...(conditions ? { conditions } : {}),
  };
}

function parseInputMode(value: unknown): CatalogInputMode | null {
  if (!isRecord(value)
    || !isString(value.key)
    || !isString(value.label)
    || typeof value.default !== 'boolean'
    || !Array.isArray(value.slots)) return null;
  const slots = value.slots.map(parseInputSlot);
  const conditions = parseConditions(value.conditions);
  if (slots.some((slot) => !slot) || (value.conditions !== undefined && !conditions)) return null;
  return {
    key: value.key,
    label: value.label,
    default: value.default,
    slots: slots as CatalogInputSlot[],
    ...(conditions ? { conditions } : {}),
  };
}

function parseInputConstraint(value: unknown): CatalogInputConstraint | null {
  if (!isRecord(value)
    || !['total-count', 'weighted-count', 'combined-duration'].includes(String(value.type))
    || !Array.isArray(value.slotKeys)
    || !value.slotKeys.every(isString)
    || !Number.isFinite(value.max)
    || Number(value.max) < 0
    || !isString(value.message)) return null;
  if (value.weights !== undefined
    && (!isRecord(value.weights)
      || Object.values(value.weights).some((weight) => typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0))) {
    return null;
  }
  const conditions = parseConditions(value.conditions);
  if (value.conditions !== undefined && !conditions) return null;
  return {
    type: value.type as CatalogInputConstraint['type'],
    slotKeys: value.slotKeys as string[],
    max: Number(value.max),
    message: value.message,
    ...(value.weights ? { weights: value.weights as Record<string, number> } : {}),
    ...(conditions ? { conditions } : {}),
  };
}

function parseDescriptor(
  value: unknown,
  modelId: string,
  releaseSchemaVersion: number,
  availability: Record<CatalogPlatform, boolean>,
): GenerationModelDescriptor {
  if (!isRecord(value) || value.id !== modelId || !isGenerationModelKind(value.kind)) {
    throw new Error(`Invalid public descriptor for ${modelId}.`);
  }
  if (!isString(value.displayName)
    || typeof value.description !== 'string'
    || (value.badge !== null && typeof value.badge !== 'string')
    || typeof value.recommended !== 'boolean'
    || !Number.isFinite(value.sortOrder)
    || !Number.isInteger(value.minClientSchemaVersion)
    || !Array.isArray(value.controls)
    || !isRecord(value.capabilities)
    || !isRecord(value.inputs)) {
    throw new Error(`Invalid public descriptor for ${modelId}.`);
  }
  const controls = value.controls.map(parseCatalogControl);
  if (controls.some((control) => !control)) throw new Error(`Invalid controls for ${modelId}.`);
  const capabilities = value.capabilities;
  const capabilityKeys = ['multiShot', 'sound', 'fixedLens', 'googleSearch', 'outputFormat'];
  if (capabilityKeys.some((key) => typeof capabilities[key] !== 'boolean')) {
    throw new Error(`Invalid capabilities for ${modelId}.`);
  }
  if (typeof value.inputs.startFrame !== 'boolean' || typeof value.inputs.endFrame !== 'boolean') {
    throw new Error(`Invalid input configuration for ${modelId}.`);
  }
  const imageReferences = parseReferenceLimit(value.inputs.imageReferences, true);
  const videoReferences = parseReferenceLimit(value.inputs.videoReferences, false);
  const audioReferences = parseReferenceLimit(value.inputs.audioReferences, false);
  const preparedAudioReferences = value.inputs.preparedAudioReferences === undefined
    ? null
    : parseReferenceLimit(value.inputs.preparedAudioReferences, false);
  const characterReferences = value.inputs.characterReferences === undefined
    ? null
    : parseReferenceLimit(value.inputs.characterReferences, false);
  if (imageReferences === undefined
    || videoReferences === undefined
    || audioReferences === undefined
    || preparedAudioReferences === undefined
    || characterReferences === undefined
    || (value.inputs.combineFramesWithReferences !== undefined
      && typeof value.inputs.combineFramesWithReferences !== 'boolean')) {
    throw new Error(`Invalid input configuration for ${modelId}.`);
  }
  let inputModes: CatalogInputMode[] | undefined;
  let inputConstraints: CatalogInputConstraint[] | undefined;
  if (releaseSchemaVersion >= 2) {
    if (!Array.isArray(value.inputModes) || !Array.isArray(value.inputConstraints)) {
      throw new Error(`Schema-v2 inputs are missing for ${modelId}.`);
    }
    const parsedModes = value.inputModes.map(parseInputMode);
    const parsedConstraints = value.inputConstraints.map(parseInputConstraint);
    if (parsedModes.some((mode) => !mode) || parsedConstraints.some((constraint) => !constraint)) {
      throw new Error(`Invalid schema-v2 inputs for ${modelId}.`);
    }
    inputModes = parsedModes as CatalogInputMode[];
    inputConstraints = parsedConstraints as CatalogInputConstraint[];
  }
  return {
    id: modelId,
    kind: value.kind,
    displayName: value.displayName,
    description: value.description,
    badge: value.badge,
    recommended: value.recommended,
    sortOrder: Number(value.sortOrder),
    minClientSchemaVersion: Number(value.minClientSchemaVersion),
    controls: controls as CatalogControl[],
    capabilities: {
      multiShot: capabilities.multiShot as boolean,
      sound: capabilities.sound as boolean,
      fixedLens: capabilities.fixedLens as boolean,
      googleSearch: capabilities.googleSearch as boolean,
      outputFormat: capabilities.outputFormat as boolean,
    },
    inputs: {
      imageReferences,
      videoReferences,
      audioReferences,
      preparedAudioReferences,
      characterReferences,
      startFrame: value.inputs.startFrame,
      endFrame: value.inputs.endFrame,
      ...(typeof value.inputs.combineFramesWithReferences === 'boolean'
        ? { combineFramesWithReferences: value.inputs.combineFramesWithReferences }
        : {}),
    },
    ...(releaseSchemaVersion >= 2
      ? {
          availability,
          inputModes,
          inputConstraints,
        }
      : {}),
  };
}

function parseStringRecord(value: unknown, field: string, modelId: string): Record<string, string> {
  if (!isRecord(value) || Object.values(value).some((item) => typeof item !== 'string')) {
    throw new Error(`Invalid ${field} for ${modelId}.`);
  }
  return value as Record<string, string>;
}

function parseObject(value: unknown, field: string, modelId: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Invalid ${field} for ${modelId}.`);
  return value;
}

function parseOperation(row: EntryRow, descriptor: GenerationModelDescriptor): GenerationModelOperationalConfig {
  if (!GENERATION_MODEL_ADAPTER_KEYS.includes(row.adapter_key as GenerationModelOperationalConfig['adapterKey'])) {
    throw new Error(`Unsupported adapter strategy for ${row.model_id}.`);
  }
  if (!GENERATION_MODEL_PRICING_STRATEGIES.includes(row.pricing_strategy as GenerationModelOperationalConfig['pricingStrategy'])) {
    throw new Error(`Unsupported pricing strategy for ${row.model_id}.`);
  }
  if (!GENERATION_MODEL_VALIDATION_STRATEGIES.includes(row.validation_strategy as GenerationModelOperationalConfig['validationStrategy'])) {
    throw new Error(`Unsupported validation strategy for ${row.model_id}.`);
  }
  return {
    modelId: row.model_id,
    kind: descriptor.kind,
    adapterKey: row.adapter_key as GenerationModelOperationalConfig['adapterKey'],
    adapterConfig: row.adapter_config === undefined
      ? {}
      : parseObject(row.adapter_config, 'adapter configuration', row.model_id),
    providerModelMap: parseStringRecord(row.provider_model_map, 'provider model map', row.model_id),
    pricingStrategy: row.pricing_strategy as GenerationModelOperationalConfig['pricingStrategy'],
    pricingConfig: parseObject(row.pricing_config, 'pricing configuration', row.model_id),
    validationStrategy: row.validation_strategy as GenerationModelOperationalConfig['validationStrategy'],
    validationConfig: parseObject(row.validation_config, 'validation configuration', row.model_id),
    verificationConfig: parseObject(row.verification_config, 'verification configuration', row.model_id),
  };
}

function getConfiguredCatalogSource(): GenerationModelCatalogSource {
  const configured = process.env.GENERATION_MODEL_CATALOG_SOURCE?.trim().toLowerCase();
  if (configured === 'code' || configured === 'shadow' || configured === 'database') return configured;
  return process.env.NODE_ENV === 'production' ? 'database' : 'code';
}

function hasServiceConfiguration(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
    && process.env.SUPABASE_SERVICE_ROLE_KEY?.trim(),
  );
}

function isMissingAdapterConfigColumn(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = 'code' in error && typeof error.code === 'string' ? error.code : '';
  const message = 'message' in error && typeof error.message === 'string' ? error.message : '';
  return code === '42703' || code === 'PGRST204' || /adapter_config/i.test(message);
}

async function queryReleaseEntries(
  client: SupabaseClient,
  releaseId: string,
): Promise<EntryRow[]> {
  const baseColumns = 'model_id, public_descriptor, web_enabled, mobile_enabled, adapter_key, provider_model_map, pricing_strategy, pricing_config, validation_strategy, validation_config, verification_config';
  const withAdapter = await client
    .from('generation_model_catalog_entries')
    .select(`${baseColumns}, adapter_config`)
    .eq('release_id', releaseId)
    .order('model_id', { ascending: true });
  if (!withAdapter.error) {
    if (!withAdapter.data?.length) throw new Error('The generation model catalog release has no entries.');
    return withAdapter.data as EntryRow[];
  }
  if (!isMissingAdapterConfigColumn(withAdapter.error)) throw withAdapter.error;
  const legacy = await client
    .from('generation_model_catalog_entries')
    .select(baseColumns)
    .eq('release_id', releaseId)
    .order('model_id', { ascending: true });
  if (legacy.error) throw legacy.error;
  if (!legacy.data?.length) throw new Error('The generation model catalog release has no entries.');
  return legacy.data as EntryRow[];
}

async function queryDatabaseRelease(client: SupabaseClient): Promise<DatabaseReleaseSnapshot> {
  const { data: releaseData, error: releaseError } = await client
    .from('generation_model_catalog_releases')
    .select('id, schema_version, revision, status, defaults')
    .eq('status', 'active')
    .order('schema_version', { ascending: false })
    .order('activated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (releaseError) throw releaseError;
  if (!releaseData) throw new Error('No active generation model catalog release is published.');
  const release = releaseData as ReleaseRow;
  return { release, entries: await queryReleaseEntries(client, release.id) };
}

async function queryDatabaseReleaseByRevision(
  client: SupabaseClient,
  revision: string,
): Promise<DatabaseReleaseSnapshot> {
  const { data: releaseData, error: releaseError } = await client
    .from('generation_model_catalog_releases')
    .select('id, schema_version, revision, status, defaults')
    .eq('revision', revision)
    .in('status', ['active', 'retired', 'shadow'])
    .maybeSingle();
  if (releaseError) throw releaseError;
  if (!releaseData) throw new Error(`Generation model catalog revision ${revision} is unavailable.`);
  const release = releaseData as ReleaseRow;
  return { release, entries: await queryReleaseEntries(client, release.id) };
}

async function loadDatabaseRelease(forceRefresh = false): Promise<DatabaseReleaseSnapshot> {
  const now = Date.now();
  if (!forceRefresh && cachedDatabaseRelease && cachedDatabaseRelease.expiresAt > now) {
    return cachedDatabaseRelease.snapshot;
  }
  if (!forceRefresh && pendingDatabaseRelease) return pendingDatabaseRelease;
  const request = queryDatabaseRelease(createServiceClient())
    .then((snapshot) => {
      cachedDatabaseRelease = { expiresAt: Date.now() + DATABASE_CACHE_TTL_MS, snapshot };
      cachedDatabaseRevisions.set(snapshot.release.revision, snapshot);
      return snapshot;
    })
    .finally(() => {
      pendingDatabaseRelease = null;
    });
  pendingDatabaseRelease = request;
  return request;
}

async function loadDatabaseReleaseByRevision(
  revision: string,
  forceRefresh = false,
): Promise<DatabaseReleaseSnapshot> {
  if (!forceRefresh) {
    const cached = cachedDatabaseRevisions.get(revision);
    if (cached) return cached;
  }
  const snapshot = await queryDatabaseReleaseByRevision(createServiceClient(), revision);
  if (cachedDatabaseRevisions.size >= MAX_REVISION_CACHE_ENTRIES) {
    const oldest = cachedDatabaseRevisions.keys().next().value;
    if (oldest) cachedDatabaseRevisions.delete(oldest);
  }
  cachedDatabaseRevisions.set(revision, snapshot);
  return snapshot;
}

function platformDefaults(value: unknown, platform: CatalogPlatform): Record<GenerationModelKind, string | null> {
  const defaults = isRecord(value) && isRecord(value[platform]) ? value[platform] : null;
  if (!defaults) throw new Error(`Catalog defaults are missing for ${platform}.`);
  const result = { image: defaults.image, video: defaults.video, motion: defaults.motion };
  for (const defaultValue of Object.values(result)) {
    if (defaultValue !== null && typeof defaultValue !== 'string') {
      throw new Error(`Catalog defaults are invalid for ${platform}.`);
    }
  }
  return result as Record<GenerationModelKind, string | null>;
}

function projectDatabaseRelease(
  snapshot: DatabaseReleaseSnapshot,
  platform: CatalogPlatform,
  requestedSchemaVersion: number,
): PublishedGenerationModelCatalogSnapshot {
  if (snapshot.release.schema_version > GENERATION_MODEL_CATALOG_SCHEMA_VERSION) {
    throw new Error(`Unsupported published catalog schema ${snapshot.release.schema_version}.`);
  }
  if (requestedSchemaVersion >= 2 && snapshot.release.schema_version < 2) {
    throw new GenerationModelCatalogSchemaUnavailableError(
      requestedSchemaVersion,
      snapshot.release.schema_version,
    );
  }
  const projectedSchemaVersion = requestedSchemaVersion >= 2 ? 2 : 1;
  const operations = new Map<string, GenerationModelOperationalConfig>();
  const allPlatformDescriptors = snapshot.entries
    .filter((row) => platform === 'mobile' ? row.mobile_enabled : row.web_enabled)
    .map((row) => {
      const descriptor = parseDescriptor(
        row.public_descriptor,
        row.model_id,
        snapshot.release.schema_version,
        { web: row.web_enabled, mobile: row.mobile_enabled },
      );
      operations.set(row.model_id, parseOperation(row, descriptor));
      return descriptor;
    });
  const models = allPlatformDescriptors
    .filter((descriptor) => descriptor.minClientSchemaVersion <= requestedSchemaVersion)
    .map((descriptor) => projectGenerationModelDescriptor(descriptor, projectedSchemaVersion))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.displayName.localeCompare(b.displayName));
  const modelIds = new Set(models.map((model) => model.id));
  const publishedDefaults = platformDefaults(snapshot.release.defaults, platform);
  const defaults = { ...publishedDefaults };
  for (const kind of ['image', 'video', 'motion'] as const) {
    const defaultId = defaults[kind];
    const valid = defaultId
      && modelIds.has(defaultId)
      && models.some((model) => model.id === defaultId && model.kind === kind);
    if (!valid) {
      const publishedDefaultExists = defaultId
        && allPlatformDescriptors.some((model) => model.id === defaultId && model.kind === kind);
      if (!publishedDefaultExists) {
        throw new Error(`Published ${platform} default ${String(defaultId)} is unavailable.`);
      }
      defaults[kind] = models.find((model) => model.kind === kind)?.id ?? null;
    }
  }
  return {
    catalog: {
      schemaVersion: projectedSchemaVersion,
      revision: snapshot.release.revision,
      defaults,
      models,
    },
    operations,
    source: 'database',
    releaseId: snapshot.release.id,
    releaseSchemaVersion: snapshot.release.schema_version,
  };
}

function codeSnapshot(platform: CatalogPlatform, schemaVersion: number): PublishedGenerationModelCatalogSnapshot {
  return {
    catalog: buildGenerationModelCatalog({ platform, schemaVersion }),
    operations: new Map(buildCodeGenerationModelOperations().map((entry) => [entry.modelId, entry])),
    source: 'code',
    releaseId: null,
    releaseSchemaVersion: GENERATION_MODEL_CATALOG_SCHEMA_VERSION,
  };
}

function compareShadowCatalog(
  code: PublishedGenerationModelCatalogSnapshot,
  database: PublishedGenerationModelCatalogSnapshot,
): void {
  const codeProjection = JSON.stringify({ defaults: code.catalog.defaults, models: code.catalog.models });
  const databaseProjection = JSON.stringify({ defaults: database.catalog.defaults, models: database.catalog.models });
  if (codeProjection !== databaseProjection) {
    logBackendError('generation_model_catalog_shadow_mismatch', {
    codeRevision: code.catalog.revision,
      databaseRevision: database.catalog.revision,
  });
  }
}

function assertDatabaseConfiguration(source: GenerationModelCatalogSource): void {
  if (source === 'database' && !hasServiceConfiguration()) {
    throw new Error('The authoritative generation model database catalog is not configured.');
  }
}

export async function loadPublishedGenerationModelCatalog({
  platform,
  schemaVersion,
  forceRefresh = false,
}: {
  platform: CatalogPlatform;
  schemaVersion: number;
  forceRefresh?: boolean;
}): Promise<PublishedGenerationModelCatalogSnapshot> {
  const source = getConfiguredCatalogSource();
  const fallback = codeSnapshot(platform, schemaVersion);
  if (source === 'code') return fallback;
  assertDatabaseConfiguration(source);
  if (!hasServiceConfiguration()) return { ...fallback, source: 'shadow' };
  try {
    const database = projectDatabaseRelease(
      await loadDatabaseRelease(forceRefresh),
      platform,
      schemaVersion,
    );
    if (source === 'shadow') {
      compareShadowCatalog(fallback, database);
      return { ...fallback, source: 'shadow' };
    }
    return database;
  } catch (error) {
    if (source === 'shadow') {
      logBackendWarning('generation_model_database_shadow_catalog_is_unavailable', { error: error });
      return { ...fallback, source: 'shadow' };
    }
    throw error;
  }
}

export async function loadPublishedGenerationModelCatalogByRevision({
  revision,
  platform,
  schemaVersion = 1,
  forceRefresh = false,
}: {
  revision: string;
  platform: CatalogPlatform;
  schemaVersion?: number;
  forceRefresh?: boolean;
}): Promise<PublishedGenerationModelCatalogSnapshot> {
  const source = getConfiguredCatalogSource();
  if (source === 'code' || source === 'shadow') {
    const snapshot = codeSnapshot(platform, schemaVersion);
    if (snapshot.catalog.revision !== revision) {
      throw new Error(`Generation model catalog revision ${revision} is unavailable.`);
    }
    return { ...snapshot, source };
  }
  assertDatabaseConfiguration(source);
  return projectDatabaseRelease(
    await loadDatabaseReleaseByRevision(revision, forceRefresh),
    platform,
    schemaVersion,
  );
}

async function quoteWithSnapshotLoader(
  input: GenerationModelQuoteInput,
  loadSnapshot: (schemaVersion: number) => Promise<PublishedGenerationModelCatalogSnapshot>,
): Promise<GenerationModelQuote> {
  const schemaVersion = input.schemaVersion && input.schemaVersion >= 2 ? 2 : 1;
  const snapshot = await loadSnapshot(schemaVersion);
  let validationCatalog = snapshot.catalog;
  if (schemaVersion === 1 && (snapshot.releaseSchemaVersion ?? 1) >= 2) {
    const requestedDescriptor = snapshot.catalog.models.find((model) => (
      model.id === input.modelId && model.kind === input.kind
    ));
    if (requestedDescriptor) {
      const fullSnapshot = await loadSnapshot(GENERATION_MODEL_CATALOG_SCHEMA_VERSION);
      const fullDescriptor = fullSnapshot.catalog.models.find((model) => (
        model.id === input.modelId && model.kind === input.kind
      ));
      if (fullDescriptor) {
        validationCatalog = {
          ...snapshot.catalog,
          models: snapshot.catalog.models.map((model) => (
            model.id === fullDescriptor.id ? fullDescriptor : model
          )),
        };
      }
    }
  }
  return quoteGenerationModel(input, {
    catalog: validationCatalog,
    operations: snapshot.operations,
  });
}

export async function quotePublishedGenerationModel(
  input: GenerationModelQuoteInput,
  options: { platform: CatalogPlatform; forceRefresh?: boolean },
): Promise<GenerationModelQuote> {
  return quoteWithSnapshotLoader(input, (schemaVersion) => loadPublishedGenerationModelCatalog({
    platform: options.platform,
    schemaVersion,
    forceRefresh: options.forceRefresh,
  }));
}

/**
 * Quotes against the exact catalog release named by `revision` instead of the
 * currently published one. This is the trusted-pin path for the run engines:
 * a template version freezes the revision that priced it, so its runs must
 * keep quoting against that release even after later publishes. Never expose
 * this to client-supplied revisions — that would let a stale or crafted
 * client buy at historical prices.
 */
export async function quotePublishedGenerationModelAtRevision(
  input: GenerationModelQuoteInput,
  options: { platform: CatalogPlatform; revision: string; forceRefresh?: boolean },
): Promise<GenerationModelQuote> {
  const loadSnapshot = async (schemaVersion: number) => {
    try {
      return await loadPublishedGenerationModelCatalogByRevision({
        revision: options.revision,
        platform: options.platform,
        schemaVersion,
        forceRefresh: options.forceRefresh,
      });
    } catch (error) {
      if (error instanceof GenerationModelCatalogSchemaUnavailableError) throw error;
      throw new CatalogError(
        'This item was published against a model catalog release that is no longer available.',
        'CATALOG_CHANGED',
        409,
      );
    }
  };
  return quoteWithSnapshotLoader({ ...input, catalogRevision: options.revision }, loadSnapshot);
}

export async function loadGenerationModelOperationalConfig(
  modelId: string,
  options: {
    catalogRevision?: string;
    schemaVersion?: number;
    forceRefresh?: boolean;
  } = {},
): Promise<GenerationModelOperationalConfig | null> {
  const snapshot = options.catalogRevision
    ? await loadPublishedGenerationModelCatalogByRevision({
        revision: options.catalogRevision,
        platform: 'web',
        schemaVersion: options.schemaVersion ?? GENERATION_MODEL_CATALOG_SCHEMA_VERSION,
        forceRefresh: options.forceRefresh,
      })
    : await loadPublishedGenerationModelCatalog({
        platform: 'web',
        schemaVersion: options.schemaVersion ?? GENERATION_MODEL_CATALOG_SCHEMA_VERSION,
        forceRefresh: options.forceRefresh,
      });
  return snapshot.operations.get(modelId) ?? null;
}

export async function loadGenerationModelOperationByRevision({
  modelId,
  revision,
  platform = 'web',
  schemaVersion = GENERATION_MODEL_CATALOG_SCHEMA_VERSION,
}: {
  modelId: string;
  revision: string;
  platform?: CatalogPlatform;
  schemaVersion?: number;
}): Promise<{
  catalog: GenerationModelCatalog;
  operation: GenerationModelOperationalConfig;
  releaseId: string | null;
}> {
  const snapshot = await loadPublishedGenerationModelCatalogByRevision({
    revision,
    platform,
    schemaVersion,
  });
  const descriptor = snapshot.catalog.models.find((model) => model.id === modelId);
  const operation = snapshot.operations.get(modelId);
  if (!descriptor || !operation) {
    throw new Error(`Model ${modelId} is unavailable in catalog revision ${revision}.`);
  }
  return { catalog: snapshot.catalog, operation, releaseId: snapshot.releaseId };
}

export function clearGenerationModelCatalogStoreCache(): void {
  cachedDatabaseRelease = null;
  pendingDatabaseRelease = null;
  cachedDatabaseRevisions.clear();
}
