import type { SupabaseClient } from '@supabase/supabase-js';

import {
  enforceBackendRateLimit,
  MEDIA_GENERATION_RATE_LIMIT,
} from '@/lib/backend-rate-limit';
import {
  CatalogError,
  quoteGenerationModel,
  type CatalogPlatform,
  type CatalogPrimitive,
  type GenerationModelDescriptor,
  type GenerationModelKind,
  type GenerationModelQuoteInput,
} from '@/lib/generation-model-catalog';
import {
  GenerationModelCatalogSchemaUnavailableError,
  loadPublishedGenerationModelCatalog,
  type PublishedGenerationModelCatalogSnapshot,
} from '@/lib/generation-model-catalog-store';
import type {
  CatalogGenerationInputAsset,
  CatalogGenerationInputKind,
  CatalogGenerationShot,
} from '@/lib/generation-model-adapters';
import {
  GenerationProviderAdapterError,
} from '@/lib/generation-model-adapters';
import type { GenerationModelOperationalConfig } from '@/lib/generation-model-runtime';
import {
  resolveGenerationMediaSource,
  startCatalogGeneration,
  startImageGeneration,
  startMotionGeneration,
  startVideoGeneration,
  type VideoMultiPromptInput,
} from '@/lib/generation-services';
import {
  getGenerationStartIdempotencyKey,
  getGenerationStartLockOwner,
  hashGenerationStartRequest,
  withGenerationStartIdempotency,
} from '@/lib/generation-start-idempotency';
import type {
  ImageModelId,
  ImageOutputFormat,
  ImageQualityMode,
  ImageResolution,
  MotionModelId,
  VideoModelId,
} from '@/lib/models';
import { resolveSourceGenerationId } from '@/lib/source-generation';
import { probeMediaDurationSeconds } from '@/lib/video-rendition';

const INPUT_KINDS = new Set<CatalogGenerationInputKind>([
  'image',
  'video',
  'audio',
  'character',
  'preparedVoice',
]);
const SLOT_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const MAX_INPUT_ASSETS = 64;
const MAX_SHOTS = 20;

export class UnifiedGenerationRequestError extends Error {
  readonly status: number;
  readonly fieldErrors: Record<string, string>;

  constructor(
    message: string,
    status = 422,
    fieldErrors: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'UnifiedGenerationRequestError';
    this.status = status;
    this.fieldErrors = fieldErrors;
  }
}

export const REFERENCE_DURATION_CHANGED_CODE = 'REFERENCE_DURATION_CHANGED';

export type VerifiedInputDuration = {
  index: number;
  slot: string;
  durationSeconds: number;
};

/**
 * The measured length of a reference raised the price above the quote the
 * caller accepted. Nothing was charged: the caller should take the measured
 * lengths, quote again, and let the viewer confirm the new cost.
 */
export class ReferenceDurationChangedError extends Error {
  readonly status = 409;
  readonly code = REFERENCE_DURATION_CHANGED_CODE;
  readonly inputs: VerifiedInputDuration[];
  readonly quotedCostCredits: number;
  readonly costCredits: number;

  constructor(inputs: VerifiedInputDuration[], quotedCostCredits: number, costCredits: number) {
    super('Your reference media runs longer than the length this price was based on. Check the updated cost, then generate again.');
    this.name = 'ReferenceDurationChangedError';
    this.inputs = inputs;
    this.quotedCostCredits = quotedCostCredits;
    this.costCredits = costCredits;
  }
}

export type UnifiedGenerationRequest = {
  kind: GenerationModelKind;
  modelId: string;
  catalogRevision: string;
  settings: Record<string, CatalogPrimitive>;
  prompt: string;
  shots: CatalogGenerationShot[];
  inputs: CatalogGenerationInputAsset[];
  sourceGenerationId: string | null;
};

export type UnifiedGenerationStartPayload = {
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

type UnifiedGenerationClient = SupabaseClient;

type StartUnifiedGenerationInput = {
  request: Request;
  body: Record<string, unknown>;
  userId: string;
  supabase: UnifiedGenerationClient;
  adminSupabase: UnifiedGenerationClient;
};

type UnifiedGenerationDependencies = {
  loadCatalog?: typeof loadPublishedGenerationModelCatalog;
  quoteModel?: typeof quoteGenerationModel;
  startCatalog?: typeof startCatalogGeneration;
  startImage?: typeof startImageGeneration;
  startVideo?: typeof startVideoGeneration;
  startMotion?: typeof startMotionGeneration;
  resolveSource?: typeof resolveSourceGenerationId;
  enforceRateLimit?: typeof enforceBackendRateLimit;
  /** Turns an input URL into the source the provider will fetch, as the adapters do. */
  resolveInputSource?: (supabase: SupabaseClient, url: string, userId: string) => Promise<string>;
  probeInputDuration?: (url: string) => Promise<number | null>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readRequiredString(
  value: unknown,
  field: string,
  fieldErrors: Record<string, string>,
): string {
  if (typeof value !== 'string' || !value.trim()) {
    fieldErrors[field] = `${field} is required.`;
    return '';
  }
  return value.trim();
}

function parseSettings(value: unknown, field: string): Record<string, CatalogPrimitive> {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw new UnifiedGenerationRequestError('Invalid generation request.', 422, {
      [field]: `${field} must be an object.`,
    });
  }

  const settings: Record<string, CatalogPrimitive> = {};
  for (const [key, setting] of Object.entries(value)) {
    if (
      typeof setting !== 'string'
      && typeof setting !== 'boolean'
      && !(typeof setting === 'number' && Number.isFinite(setting))
    ) {
      throw new UnifiedGenerationRequestError('Invalid generation request.', 422, {
        [`${field}.${key}`]: 'Settings must be strings, numbers, or booleans.',
      });
    }
    settings[key] = setting;
  }
  return settings;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseInputs(value: unknown): CatalogGenerationInputAsset[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_INPUT_ASSETS) {
    throw new UnifiedGenerationRequestError('Invalid generation request.', 422, {
      inputs: `inputs must contain at most ${MAX_INPUT_ASSETS} assets.`,
    });
  }

  return value.map((rawAsset, index) => {
    if (!isRecord(rawAsset)) {
      throw new UnifiedGenerationRequestError('Invalid generation request.', 422, {
        [`inputs.${index}`]: 'Each input must be an object.',
      });
    }
    const rawSlot = rawAsset.slot ?? rawAsset.slotKey;
    const slot = typeof rawSlot === 'string' ? rawSlot.trim() : '';
    if (!SLOT_KEY_PATTERN.test(slot)) {
      throw new UnifiedGenerationRequestError('Invalid generation request.', 422, {
        [`inputs.${index}.slot`]: 'Input slot is invalid.',
      });
    }
    if (!INPUT_KINDS.has(rawAsset.kind as CatalogGenerationInputKind)) {
      throw new UnifiedGenerationRequestError('Invalid generation request.', 422, {
        [`inputs.${index}.kind`]: 'Input kind is invalid.',
      });
    }
    const url = optionalString(rawAsset.url);
    const assetId = optionalString(rawAsset.assetId ?? rawAsset.id);
    if (!url && !assetId) {
      throw new UnifiedGenerationRequestError('Invalid generation request.', 422, {
        [`inputs.${index}`]: 'An input URL or asset ID is required.',
      });
    }
    const rawDuration = rawAsset.durationSeconds;
    const durationSeconds = rawDuration === undefined || rawDuration === null
      ? null
      : Number(rawDuration);
    if (
      durationSeconds !== null
      && (!Number.isFinite(durationSeconds) || durationSeconds < 0)
    ) {
      throw new UnifiedGenerationRequestError('Invalid generation request.', 422, {
        [`inputs.${index}.durationSeconds`]: 'Duration must be a non-negative number.',
      });
    }

    return {
      slot,
      kind: rawAsset.kind as CatalogGenerationInputKind,
      url,
      assetId,
      durationSeconds,
      label: optionalString(rawAsset.label ?? rawAsset.displayName),
      handle: optionalString(rawAsset.handle),
      storagePath: optionalString(rawAsset.storagePath),
      sourceGenerationId: optionalString(rawAsset.sourceGenerationId),
    };
  });
}

function parseShots(value: unknown): CatalogGenerationShot[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_SHOTS) {
    throw new UnifiedGenerationRequestError('Invalid generation request.', 422, {
      shots: `shots must contain at most ${MAX_SHOTS} entries.`,
    });
  }

  return value.map((rawShot, index) => {
    if (!isRecord(rawShot) || typeof rawShot.prompt !== 'string') {
      throw new UnifiedGenerationRequestError('Invalid generation request.', 422, {
        [`shots.${index}`]: 'Each shot needs a prompt.',
      });
    }
    const duration = rawShot.duration === undefined || rawShot.duration === null
      ? null
      : Number(rawShot.duration);
    if (duration !== null && (!Number.isFinite(duration) || duration <= 0)) {
      throw new UnifiedGenerationRequestError('Invalid generation request.', 422, {
        [`shots.${index}.duration`]: 'Shot duration must be greater than zero.',
      });
    }
    return {
      prompt: rawShot.prompt.trim(),
      duration,
      settings: parseSettings(rawShot.settings, `shots.${index}.settings`),
    };
  });
}

export function parseUnifiedGenerationRequest(
  body: Record<string, unknown>,
): UnifiedGenerationRequest {
  const fieldErrors: Record<string, string> = {};
  const kind = body.kind;
  if (kind !== 'image' && kind !== 'video' && kind !== 'motion') {
    fieldErrors.kind = 'kind must be image, video, or motion.';
  }
  const modelId = readRequiredString(body.modelId, 'modelId', fieldErrors);
  const catalogRevision = readRequiredString(
    body.catalogRevision,
    'catalogRevision',
    fieldErrors,
  );
  if (Object.keys(fieldErrors).length > 0) {
    throw new UnifiedGenerationRequestError(
      'Invalid generation request.',
      422,
      fieldErrors,
    );
  }

  return {
    kind: kind as GenerationModelKind,
    modelId,
    catalogRevision,
    settings: parseSettings(body.settings, 'settings'),
    prompt: typeof body.prompt === 'string' ? body.prompt : '',
    shots: parseShots(body.shots),
    inputs: parseInputs(body.inputs),
    sourceGenerationId: optionalString(body.sourceGenerationId),
  };
}

export function buildUnifiedGenerationQuoteInput(
  request: UnifiedGenerationRequest,
): GenerationModelQuoteInput {
  const slots: Record<string, { count: number; durationsSeconds?: number[] }> = {};
  for (const asset of request.inputs) {
    const slot = slots[asset.slot] ?? { count: 0 };
    slot.count += 1;
    if (typeof asset.durationSeconds === 'number') {
      slot.durationsSeconds = [...(slot.durationsSeconds ?? []), asset.durationSeconds];
    }
    slots[asset.slot] = slot;
  }
  const referenceVideoDurationsSeconds = request.inputs
    .filter((asset) => asset.kind === 'video')
    .flatMap((asset) => (
      typeof asset.durationSeconds === 'number' ? [asset.durationSeconds] : []
    ));

  return {
    schemaVersion: 2,
    kind: request.kind,
    modelId: request.modelId,
    settings: request.settings,
    inputCounts: {
      images: request.inputs.filter((asset) => asset.kind === 'image').length,
      videos: request.inputs.filter((asset) => asset.kind === 'video').length,
      audios: request.inputs.filter((asset) => asset.kind === 'audio').length,
      preparedAudios: request.inputs.filter((asset) => asset.kind === 'preparedVoice').length,
      characters: request.inputs.filter((asset) => asset.kind === 'character').length,
    },
    inputMetadata: {
      slots,
      referenceVideoDurationsSeconds,
    },
    catalogRevision: request.catalogRevision,
  };
}

function collectDurationSlotKeys(value: unknown, keys: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectDurationSlotKeys(item, keys);
    return;
  }
  if (!isRecord(value)) return;
  if (Array.isArray(value.referenceDurationSlots)) {
    for (const slot of value.referenceDurationSlots) {
      if (typeof slot === 'string') keys.add(slot);
    }
  }
  if (value.type === 'combined-duration' && Array.isArray(value.slotKeys)) {
    for (const slot of value.slotKeys) {
      if (typeof slot === 'string') keys.add(slot);
    }
  }
  for (const nested of Object.values(value)) collectDurationSlotKeys(nested, keys);
}

/**
 * Slot keys whose asset durations the quote reads, to price a run or to hold
 * it to a limit: descriptor slots that declare duration metadata or a cap,
 * combined-duration constraints and rules, and reference-adjustment pricing at
 * any depth of a conditional expression.
 */
export function durationBoundInputSlots(
  descriptor: Pick<GenerationModelDescriptor, 'inputModes' | 'inputConstraints'> | null | undefined,
  operation: Pick<GenerationModelOperationalConfig, 'pricingConfig' | 'validationConfig'>,
): Set<string> {
  const keys = new Set<string>();
  for (const mode of descriptor?.inputModes ?? []) {
    for (const slot of mode.slots) {
      if (slot.durationMetadata !== undefined || slot.maxDurationSeconds !== undefined) {
        keys.add(slot.key);
      }
    }
  }
  collectDurationSlotKeys(descriptor?.inputConstraints ?? [], keys);
  collectDurationSlotKeys(operation.pricingConfig, keys);
  collectDurationSlotKeys(operation.validationConfig, keys);
  return keys;
}

/**
 * Replaces caller-reported reference lengths with measured ones before a run is
 * priced. A caller reporting zero seconds, or nothing, used to shrink the charge
 * for models the provider bills by input seconds and slip past their
 * combined-duration caps (model/post/remix audit, finding A2).
 *
 * Only inputs whose length is read are measured: a slot the price or a limit
 * depends on, every video when a model prices `videoReferences` (how the runtime
 * falls back), and a motion run's reference performance, whose length is the
 * output's length whatever `duration` the request names. The source is resolved
 * the way the adapters resolve it, so the file measured is the file the provider
 * fetches, and only an HTTPS object is ever read.
 */
export async function resolveBillableInputDurations({
  request,
  descriptor,
  operation,
  resolveInputSource,
  probeInputDuration,
}: {
  request: UnifiedGenerationRequest;
  descriptor: Pick<GenerationModelDescriptor, 'inputModes' | 'inputConstraints'> | null | undefined;
  operation: Pick<GenerationModelOperationalConfig, 'pricingConfig' | 'validationConfig'>;
  resolveInputSource: (url: string) => Promise<string>;
  probeInputDuration: (url: string) => Promise<number | null>;
}): Promise<{ request: UnifiedGenerationRequest; verified: VerifiedInputDuration[] }> {
  const boundSlots = durationBoundInputSlots(descriptor, operation);
  const isBound = (asset: CatalogGenerationInputAsset) => (
    (asset.kind === 'video' || asset.kind === 'audio')
    && (
      boundSlots.has(asset.slot)
      || (asset.kind === 'video' && (boundSlots.has('videoReferences') || request.kind === 'motion'))
    )
  );
  if (!request.inputs.some(isBound)) {
    return { request, verified: [] };
  }

  const unverifiable = (index: number) => new UnifiedGenerationRequestError(
    'The length of a reference file could not be verified. Upload it again, then retry.',
    422,
    { [`inputs.${index}`]: 'This file’s length could not be verified.' },
  );
  const verified: VerifiedInputDuration[] = [];
  const inputs = await Promise.all(request.inputs.map(async (asset, index) => {
    if (!isBound(asset)) return asset;
    if (!asset.url) throw unverifiable(index);
    const source = await resolveInputSource(asset.url);
    if (!/^https:\/\//i.test(source)) throw unverifiable(index);
    const measured = await probeInputDuration(source);
    if (measured === null || !Number.isFinite(measured) || measured <= 0) throw unverifiable(index);

    verified.push({ index, slot: asset.slot, durationSeconds: measured });
    return { ...asset, durationSeconds: measured };
  }));
  verified.sort((first, second) => first.index - second.index);

  let settings = request.settings;
  if (request.kind === 'motion') {
    const performance = inputs.find((asset) => asset.kind === 'video' && typeof asset.durationSeconds === 'number');
    if (performance && typeof performance.durationSeconds === 'number') {
      settings = {
        ...settings,
        duration: Math.max(1, Math.ceil(performance.durationSeconds)),
      };
    }
  }

  return { request: { ...request, inputs, settings }, verified };
}

function platformForRequest(request: Request): CatalogPlatform {
  return request.headers.get('x-magicbooklet-client') === 'mobile'
    ? 'mobile'
    : 'web';
}

export async function loadUnifiedGenerationCatalog(
  loadCatalog: typeof loadPublishedGenerationModelCatalog,
  platform: CatalogPlatform,
): Promise<PublishedGenerationModelCatalogSnapshot> {
  try {
    return await loadCatalog({ platform, schemaVersion: 2 });
  } catch (error) {
    if (!(error instanceof GenerationModelCatalogSchemaUnavailableError)) throw error;
    // A backend can be deployed immediately before the first v2 catalog is
    // published. Continue to use the authoritative database's v1 release for
    // already-compatible models during that narrow rolling transition.
    return loadCatalog({ platform, schemaVersion: 1 });
  }
}

export function buildUnifiedGenerationQuoteInputForCatalog(
  request: UnifiedGenerationRequest,
  snapshot: PublishedGenerationModelCatalogSnapshot,
): GenerationModelQuoteInput {
  const input = buildUnifiedGenerationQuoteInput(request);
  if (snapshot.catalog.schemaVersion >= 2) return input;
  return {
    ...input,
    schemaVersion: 1,
    inputMetadata: {
      referenceVideoDurationsSeconds:
        input.inputMetadata?.referenceVideoDurationsSeconds,
    },
  };
}

function requireOperation(
  snapshot: PublishedGenerationModelCatalogSnapshot,
  modelId: string,
) {
  const operation = snapshot.operations.get(modelId);
  if (!operation) {
    throw new CatalogError(
      'This model is not configured for generation.',
      'MODEL_UNAVAILABLE',
      409,
    );
  }
  return operation;
}

function slotUrl(
  inputs: CatalogGenerationInputAsset[],
  key: string,
): string | null {
  return inputs.find((asset) => asset.slot === key)?.url ?? null;
}

export async function dispatchCatalogGenerationAdapter({
  request,
  quote,
  operation,
  supabase,
  adminSupabase,
  userId,
  clientRequestKeyHash,
  sourceGenerationId,
  dependencies,
}: {
  request: UnifiedGenerationRequest;
  quote: ReturnType<typeof quoteGenerationModel>;
  operation: ReturnType<typeof requireOperation>;
  supabase: UnifiedGenerationClient;
  adminSupabase: UnifiedGenerationClient;
  userId: string;
  clientRequestKeyHash: string | null;
  sourceGenerationId: string | null;
  dependencies: Required<Pick<
    UnifiedGenerationDependencies,
    'startCatalog' | 'startImage' | 'startVideo' | 'startMotion'
  >>;
}) {
  const normalized = quote.normalizedSettings;
  if (operation.adapterKey === 'kie-task-v1') {
    return dependencies.startCatalog({
      supabase,
      creditSupabase: adminSupabase,
      userId,
      clientRequestKeyHash,
      operation,
      catalogRevision: quote.catalogRevision,
      prompt: request.prompt,
      settings: normalized,
      inputs: request.inputs,
      shots: request.shots,
      quotedCostCredits: quote.costCredits,
      sourceGenerationId,
    });
  }

  if (operation.adapterKey === 'image-v1' && request.kind === 'image') {
    const imageInputs = request.inputs
      .filter((asset) => asset.kind === 'image' && asset.url);
    return dependencies.startImage({
      supabase,
      creditSupabase: adminSupabase,
      userId,
      clientRequestKeyHash,
      model: request.modelId as ImageModelId,
      prompt: request.prompt,
      imageUrls: imageInputs.map((asset) => asset.url!),
      elements: imageInputs
        .filter((asset) => asset.handle)
        .map((asset, index) => ({
          id: `${asset.slot}-${index + 1}`,
          displayName: asset.label ?? `Reference ${index + 1}`,
          handle: asset.handle!,
          storagePath: asset.storagePath ?? null,
          sourceGenerationId: asset.sourceGenerationId ?? null,
        })),
      aspectRatio: String(normalized.aspectRatio ?? ''),
      resolution: String(normalized.resolution ?? '1K') as ImageResolution,
      qualityMode: String(normalized.qualityMode ?? 'standard') as ImageQualityMode,
      outputFormat: String(normalized.outputFormat ?? 'jpg') as ImageOutputFormat,
      googleSearch: normalized.googleSearch === true,
      quotedCostCredits: quote.costCredits,
      operationalConfig: operation,
      catalogRevision: quote.catalogRevision,
      sourceGenerationId,
    });
  }

  if (operation.adapterKey === 'video-v1' && request.kind === 'video') {
    const startImageUrl = slotUrl(request.inputs, 'startFrame');
    const endImageUrl = slotUrl(request.inputs, 'endFrame');
    const referenceInputs = request.inputs.filter((asset) => (
      asset.slot !== 'startFrame' && asset.slot !== 'endFrame'
    ));
    const subjectImageInputs = referenceInputs
      .filter((asset) => asset.slot === 'subjectImages' && asset.kind === 'image' && asset.url && asset.handle);
    const referenceImageUrls = referenceInputs
      .filter((asset) => asset.kind === 'image' && asset.url && asset.slot !== 'subjectImages')
      .map((asset) => asset.url!);
    const referenceVideoUrls = referenceInputs
      .filter((asset) => asset.kind === 'video' && asset.url)
      .map((asset) => asset.url!);
    const referenceAudioUrls = referenceInputs
      .filter((asset) => asset.kind === 'audio' && asset.url)
      .map((asset) => asset.url!);
    const preparedAudioIds = referenceInputs
      .filter((asset) => asset.kind === 'preparedVoice' && asset.assetId)
      .map((asset) => asset.assetId!);
    const characterIds = referenceInputs
      .filter((asset) => asset.kind === 'character' && asset.assetId)
      .map((asset) => asset.assetId!);
    const namedImageInputs = referenceInputs
      .filter((asset) => asset.kind === 'image' && asset.url && asset.handle && asset.slot !== 'subjectImages');
    // Group subject images into named subjects by their shared handle, keeping
    // first-seen order for both subjects and their images.
    const klingSubjects: Array<{
      handle: string;
      displayName: string;
      images: Array<{ url: string; storagePath: string | null }>;
    }> = [];
    for (const asset of subjectImageInputs) {
      const existing = klingSubjects.find((subject) => subject.handle === asset.handle);
      const image = { url: asset.url!, storagePath: asset.storagePath ?? null };
      if (existing) {
        existing.images.push(image);
      } else {
        klingSubjects.push({
          handle: asset.handle!,
          displayName: asset.label ?? asset.handle!.replace(/^@/, ''),
          images: [image],
        });
      }
    }
    const videoElementInputs = referenceInputs
      .filter((asset) => (
        asset.kind === 'video'
        && asset.url
        && asset.handle
        && (
          asset.slot === 'videoElements'
          || request.modelId === 'kling-3.0-video'
        )
      ));
    const multiPrompts: VideoMultiPromptInput[] = request.shots.map((shot) => ({
      prompt: shot.prompt,
      duration: typeof shot.duration === 'number' ? shot.duration : 1,
    }));

    return dependencies.startVideo({
      supabase,
      creditSupabase: adminSupabase,
      userId,
      clientRequestKeyHash,
      model: request.modelId as VideoModelId,
      prompt: request.prompt,
      isMultiShot: request.shots.length > 0,
      multiPrompts,
      imageUrls: namedImageInputs.length > 0 ? [] : referenceImageUrls,
      elements: namedImageInputs.map((asset, index) => ({
        id: `${asset.slot}-${index + 1}`,
        displayName: asset.label ?? `Reference ${index + 1}`,
        handle: asset.handle!,
        storagePath: asset.storagePath ?? null,
        sourceGenerationId: asset.sourceGenerationId ?? null,
      })),
      elementImageUrls: namedImageInputs.map((asset) => asset.url!),
      referenceVideoUrls,
      referenceAudioUrls,
      preparedAudioIds,
      characterIds,
      klingVideoElements: videoElementInputs.map((asset, index) => ({
        id: `${asset.slot}-${index + 1}`,
        url: asset.url!,
        handle: asset.handle!,
        displayName: asset.label ?? `Video ${index + 1}`,
        storagePath: asset.storagePath ?? null,
        sourceGenerationId: asset.sourceGenerationId ?? null,
      })),
      klingSubjects,
      startImageUrl,
      endImageUrl,
      mode: String(normalized.mode ?? ''),
      aspectRatio: String(normalized.aspectRatio ?? ''),
      sound: normalized.sound === true,
      duration: Number(normalized.duration ?? 5),
      resolution: String(normalized.resolution ?? ''),
      fixedLens: normalized.fixedLens === true,
      referenceMode: referenceInputs.length > 0 ? 'elements' : 'frames',
      quotedCostCredits: quote.costCredits,
      operationalConfig: operation,
      catalogRevision: quote.catalogRevision,
      sourceGenerationId,
    });
  }

  if (operation.adapterKey === 'motion-v1' && request.kind === 'motion') {
    const character = request.inputs.find((asset) => asset.kind === 'image' || asset.kind === 'character');
    const reference = request.inputs.find((asset) => asset.kind === 'video');
    if (!character?.url || !reference?.url) {
      throw new UnifiedGenerationRequestError(
        'Motion generation requires a character image and reference video.',
        422,
        { inputs: 'Required motion inputs are missing.' },
      );
    }
    return dependencies.startMotion({
      supabase,
      creditSupabase: adminSupabase,
      userId,
      clientRequestKeyHash,
      model: request.modelId as MotionModelId,
      prompt: request.prompt,
      characterImageUrl: character.url,
      referenceVideoUrl: reference.url,
      duration: Number(normalized.duration ?? 1),
      characterOrientation: normalized.characterOrientation === 'image' ? 'image' : 'video',
      mode: normalized.resolution === '1080p' ? '1080p' : '720p',
      quotedCostCredits: quote.costCredits,
      operationalConfig: operation,
      catalogRevision: quote.catalogRevision,
      sourceGenerationId,
    });
  }

  throw new GenerationProviderAdapterError(
    `Adapter ${operation.adapterKey} cannot execute ${request.kind} generations.`,
  );
}

export async function startUnifiedGenerationForRoute(
  {
    request,
    body,
    userId,
    supabase,
    adminSupabase,
  }: StartUnifiedGenerationInput,
  dependencies: UnifiedGenerationDependencies = {},
): Promise<UnifiedGenerationStartPayload> {
  const parsed = parseUnifiedGenerationRequest(body);
  const loadCatalog = dependencies.loadCatalog ?? loadPublishedGenerationModelCatalog;
  const quoteModel = dependencies.quoteModel ?? quoteGenerationModel;
  const resolveSource = dependencies.resolveSource ?? resolveSourceGenerationId;
  const applyRateLimit = dependencies.enforceRateLimit ?? enforceBackendRateLimit;
  await applyRateLimit(adminSupabase, {
    ...MEDIA_GENERATION_RATE_LIMIT,
    key: userId,
  });

  const resolveInputSource = dependencies.resolveInputSource ?? resolveGenerationMediaSource;
  const probeInputDuration = dependencies.probeInputDuration
    ?? ((url: string) => probeMediaDurationSeconds(url));

  const result = await withGenerationStartIdempotency({
    client: adminSupabase,
    userId,
    idempotencyKey: getGenerationStartIdempotencyKey(request, body),
    requestHash: hashGenerationStartRequest(body),
    owner: getGenerationStartLockOwner(request),
    // Accepted attempts replay before mutable catalog/source validation. A
    // later model release or privacy change cannot hide an already-started run.
    start: async (clientRequestKeyHash) => {
      const snapshot = await loadUnifiedGenerationCatalog(loadCatalog, platformForRequest(request));
      const quote = quoteModel(buildUnifiedGenerationQuoteInputForCatalog(parsed, snapshot), {
        catalog: snapshot.catalog,
        operations: snapshot.operations,
      });
      const operation = requireOperation(snapshot, parsed.modelId);
      const sourceGenerationId = await resolveSource(adminSupabase, userId, parsed.sourceGenerationId);
      const billable = await resolveBillableInputDurations({
        request: parsed,
        descriptor: snapshot.catalog.models.find((model) => (
          model.id === parsed.modelId && model.kind === parsed.kind
        )),
        operation,
        resolveInputSource: (url) => resolveInputSource(supabase, url, userId),
        probeInputDuration,
      });
      const billableQuote = billable.verified.length > 0
        ? quoteModel(buildUnifiedGenerationQuoteInputForCatalog(billable.request, snapshot), {
          catalog: snapshot.catalog,
          operations: snapshot.operations,
        })
        : quote;
      // Never charge more than the price the caller saw. A lower price after
      // measuring (an overstated length) is charged as measured.
      if (billableQuote.costCredits > quote.costCredits) {
        throw new ReferenceDurationChangedError(
          billable.verified,
          quote.costCredits,
          billableQuote.costCredits,
        );
      }

      return dispatchCatalogGenerationAdapter({
        request: billable.request,
        quote: billableQuote,
        operation,
        supabase,
        adminSupabase,
        userId,
        clientRequestKeyHash,
        sourceGenerationId,
        dependencies: {
          startCatalog: dependencies.startCatalog ?? startCatalogGeneration,
          startImage: dependencies.startImage ?? startImageGeneration,
          startVideo: dependencies.startVideo ?? startVideoGeneration,
          startMotion: dependencies.startMotion ?? startMotionGeneration,
        },
      });
    },
  });

  return {
    success: true,
    predictionId: result.predictionId,
    generationId: result.generationId ?? null,
    status: 'processing',
    remainingCredits: result.remainingCredits,
    cost: result.cost,
    // The request hash binds a replay to this original revision.
    catalogRevision: parsed.catalogRevision,
    modelId: parsed.modelId,
    ...(result.idempotentReplay ? { idempotentReplay: true } : {}),
  };
}
