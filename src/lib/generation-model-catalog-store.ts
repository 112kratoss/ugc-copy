import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  GENERATION_MODEL_CATALOG_SCHEMA_VERSION,
  buildGenerationModelCatalog,
  quoteGenerationModel,
  type CatalogControl,
  type CatalogPlatform,
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

export type PublishedGenerationModelCatalogSnapshot = {
  catalog: GenerationModelCatalog;
  operations: Map<string, GenerationModelOperationalConfig>;
  source: GenerationModelCatalogSource;
  releaseId: string | null;
};

type ReleaseRow = {
  id: string;
  schema_version: number;
  revision: string;
  defaults: unknown;
};

type EntryRow = {
  model_id: string;
  public_descriptor: unknown;
  web_enabled: boolean;
  mobile_enabled: boolean;
  adapter_key: string;
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
let cachedDatabaseRelease: { expiresAt: number; snapshot: DatabaseReleaseSnapshot } | null = null;
let pendingDatabaseRelease: Promise<DatabaseReleaseSnapshot> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isGenerationModelKind(value: unknown): value is GenerationModelKind {
  return value === 'image' || value === 'video' || value === 'motion';
}

function parseCatalogControl(value: unknown): CatalogControl | null {
  if (!isRecord(value) || !isString(value.key) || !isString(value.label)) return null;
  if (value.type === 'boolean') {
    return value.presentation === 'toggle' && typeof value.defaultValue === 'boolean'
      ? { key: value.key, label: value.label, type: 'boolean', presentation: 'toggle', defaultValue: value.defaultValue }
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
    return {
      key: value.key,
      label: value.label,
      type: 'choice',
      presentation: value.presentation,
      defaultValue: value.defaultValue,
      options: options.map((option) => ({ value: option.value, label: option.label })),
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

function parseDescriptor(value: unknown, modelId: string): GenerationModelDescriptor {
  if (!isRecord(value) || value.id !== modelId || !isGenerationModelKind(value.kind)) {
    throw new Error(`Invalid public descriptor for ${modelId}.`);
  }
  if (
    !isString(value.displayName)
    || typeof value.description !== 'string'
    || (value.badge !== null && typeof value.badge !== 'string')
    || typeof value.recommended !== 'boolean'
    || !Number.isFinite(value.sortOrder)
    || !Number.isInteger(value.minClientSchemaVersion)
    || !Array.isArray(value.controls)
    || !isRecord(value.capabilities)
    || !isRecord(value.inputs)
  ) {
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
  if (
    imageReferences === undefined
    || videoReferences === undefined
    || audioReferences === undefined
    || preparedAudioReferences === undefined
    || characterReferences === undefined
    || (value.inputs.combineFramesWithReferences !== undefined && typeof value.inputs.combineFramesWithReferences !== 'boolean')
  ) {
    throw new Error(`Invalid input configuration for ${modelId}.`);
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
  return configured === 'database' || configured === 'shadow' ? configured : 'code';
}

function hasServiceConfiguration(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
    && process.env.SUPABASE_SERVICE_ROLE_KEY?.trim(),
  );
}

function isMissingCatalogSchemaError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = 'code' in error && typeof error.code === 'string' ? error.code : '';
  const message = 'message' in error && typeof error.message === 'string' ? error.message : '';
  return code === '42P01' || code === 'PGRST205' || /generation_model_catalog/i.test(message);
}

async function queryDatabaseRelease(client: SupabaseClient): Promise<DatabaseReleaseSnapshot> {
  const { data: releaseData, error: releaseError } = await client
    .from('generation_model_catalog_releases')
    .select('id, schema_version, revision, defaults')
    .eq('status', 'active')
    .maybeSingle();
  if (releaseError) throw releaseError;
  if (!releaseData) throw new Error('No active generation model catalog release is published.');
  const release = releaseData as ReleaseRow;
  const { data: entryData, error: entryError } = await client
    .from('generation_model_catalog_entries')
    .select('model_id, public_descriptor, web_enabled, mobile_enabled, adapter_key, provider_model_map, pricing_strategy, pricing_config, validation_strategy, validation_config, verification_config')
    .eq('release_id', release.id)
    .order('model_id', { ascending: true });
  if (entryError) throw entryError;
  if (!entryData?.length) throw new Error('The active generation model catalog has no entries.');
  return { release, entries: entryData as EntryRow[] };
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
      return snapshot;
    })
    .finally(() => {
      pendingDatabaseRelease = null;
    });
  pendingDatabaseRelease = request;
  return request;
}

function platformDefaults(value: unknown, platform: CatalogPlatform): Record<GenerationModelKind, string | null> {
  const defaults = isRecord(value) && isRecord(value[platform]) ? value[platform] : null;
  if (!defaults) throw new Error(`Catalog defaults are missing for ${platform}.`);
  const result = { image: defaults.image, video: defaults.video, motion: defaults.motion };
  for (const value of Object.values(result)) {
    if (value !== null && typeof value !== 'string') throw new Error(`Catalog defaults are invalid for ${platform}.`);
  }
  return result as Record<GenerationModelKind, string | null>;
}

function projectDatabaseRelease(
  snapshot: DatabaseReleaseSnapshot,
  platform: CatalogPlatform,
  schemaVersion: number,
): PublishedGenerationModelCatalogSnapshot {
  if (snapshot.release.schema_version !== GENERATION_MODEL_CATALOG_SCHEMA_VERSION) {
    throw new Error(`Unsupported published catalog schema ${snapshot.release.schema_version}.`);
  }
  const operations = new Map<string, GenerationModelOperationalConfig>();
  const models = snapshot.entries
    .filter((row) => platform === 'mobile' ? row.mobile_enabled : row.web_enabled)
    .map((row) => {
      const descriptor = parseDescriptor(row.public_descriptor, row.model_id);
      operations.set(row.model_id, parseOperation(row, descriptor));
      return descriptor;
    })
    .filter((descriptor) => descriptor.minClientSchemaVersion <= schemaVersion)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.displayName.localeCompare(b.displayName));
  const modelIds = new Set(models.map((model) => model.id));
  const defaults = platformDefaults(snapshot.release.defaults, platform);
  for (const kind of ['image', 'video', 'motion'] as const) {
    const defaultId = defaults[kind];
    if (defaultId && (!modelIds.has(defaultId) || !models.some((model) => model.id === defaultId && model.kind === kind))) {
      throw new Error(`Published ${platform} default ${defaultId} is unavailable.`);
    }
  }
  return {
    catalog: {
      schemaVersion: GENERATION_MODEL_CATALOG_SCHEMA_VERSION,
      revision: snapshot.release.revision,
      defaults,
      models,
    },
    operations,
    source: 'database',
    releaseId: snapshot.release.id,
  };
}

function codeSnapshot(platform: CatalogPlatform, schemaVersion: number): PublishedGenerationModelCatalogSnapshot {
  return {
    catalog: buildGenerationModelCatalog({ platform, schemaVersion }),
    operations: new Map(buildCodeGenerationModelOperations().map((entry) => [entry.modelId, entry])),
    source: 'code',
    releaseId: null,
  };
}

function compareShadowCatalog(
  code: PublishedGenerationModelCatalogSnapshot,
  database: PublishedGenerationModelCatalogSnapshot,
) {
  const codeProjection = JSON.stringify({ defaults: code.catalog.defaults, models: code.catalog.models });
  const databaseProjection = JSON.stringify({ defaults: database.catalog.defaults, models: database.catalog.models });
  if (codeProjection !== databaseProjection) {
    console.warn(JSON.stringify({
      level: 'warning',
      msg: 'generation_model_catalog_shadow_mismatch',
      codeRevision: code.catalog.revision,
      databaseRevision: database.catalog.revision,
    }));
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
  if (source === 'code' || !hasServiceConfiguration()) return fallback;

  try {
    const database = projectDatabaseRelease(await loadDatabaseRelease(forceRefresh), platform, schemaVersion);
    if (source === 'shadow') {
      compareShadowCatalog(fallback, database);
      return { ...fallback, source: 'shadow' };
    }
    return database;
  } catch (error) {
    if (source === 'shadow' || isMissingCatalogSchemaError(error)) {
      console.warn('Generation model database catalog is not ready; serving the code catalog.', error);
      return { ...fallback, source };
    }
    throw error;
  }
}

export async function quotePublishedGenerationModel(
  input: GenerationModelQuoteInput,
  options: { platform: CatalogPlatform; forceRefresh?: boolean },
): Promise<GenerationModelQuote> {
  const snapshot = await loadPublishedGenerationModelCatalog({
    platform: options.platform,
    schemaVersion: GENERATION_MODEL_CATALOG_SCHEMA_VERSION,
    forceRefresh: options.forceRefresh,
  });
  return quoteGenerationModel(input, {
    catalog: snapshot.catalog,
    operations: snapshot.operations,
  });
}

export async function loadGenerationModelOperationalConfig(
  modelId: string,
  options: { forceRefresh?: boolean } = {},
): Promise<GenerationModelOperationalConfig | null> {
  const snapshot = await loadPublishedGenerationModelCatalog({
    platform: 'web',
    schemaVersion: GENERATION_MODEL_CATALOG_SCHEMA_VERSION,
    forceRefresh: options.forceRefresh,
  });
  return snapshot.operations.get(modelId) ?? null;
}

export function clearGenerationModelCatalogStoreCache() {
  cachedDatabaseRelease = null;
  pendingDatabaseRelease = null;
}
