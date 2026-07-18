import { createHash } from 'node:crypto';

import {
  IMAGE_MODELS,
  MOTION_MODELS,
  VIDEO_MODELS,
  getDefaultVideoDuration,
  getImageCost,
  getImageQualityModes,
  getImageResolutionOptions,
  getMotionCost,
  getVideoCost,
  getVideoDurationRange,
  getVideoElementSupport,
  isValidVideoDuration,
  type ImageModelId,
  type ImageOutputFormat,
  type ImageQualityMode,
  type ImageResolution,
  type MotionModelId,
  type VideoModelId,
} from '@/lib/models';

export const GENERATION_MODEL_CATALOG_SCHEMA_VERSION = 1;

export type GenerationModelKind = 'image' | 'video' | 'motion';
export type CatalogPlatform = 'web' | 'mobile';
export type CatalogPrimitive = string | number | boolean;

export interface CatalogChoiceOption {
  value: string;
  label: string;
}

export interface CatalogChoiceControl {
  key: string;
  label: string;
  type: 'choice';
  presentation: 'chips' | 'select';
  defaultValue: string;
  options: CatalogChoiceOption[];
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
    preparedAudioReferences?: { max: number } | null;
    characterReferences?: { max: number } | null;
    startFrame: boolean;
    endFrame: boolean;
    combineFramesWithReferences?: boolean;
  };
}

export interface GenerationModelCatalog {
  schemaVersion: number;
  revision: string;
  defaults: Record<GenerationModelKind, string | null>;
  models: GenerationModelDescriptor[];
}

export interface GenerationModelQuoteInput {
  kind: GenerationModelKind;
  modelId: string;
  settings?: Record<string, unknown>;
  inputCounts?: {
    images?: number;
    videos?: number;
    audios?: number;
    preparedAudios?: number;
    characters?: number;
  };
  catalogRevision?: string | null;
}

export interface GenerationModelQuote {
  modelId: string;
  catalogRevision: string;
  normalizedSettings: Record<string, CatalogPrimitive>;
  costCredits: number;
}

type ModelStatus = 'active' | 'retired';

const MODEL_STATUS: Record<string, ModelStatus> = Object.fromEntries([
  ...Object.keys(IMAGE_MODELS),
  ...Object.keys(VIDEO_MODELS),
  ...Object.keys(MOTION_MODELS),
].map((id) => [id, 'active'])) as Record<string, ModelStatus>;

const DEFAULT_MODEL_IDS: Record<GenerationModelKind, string> = {
  image: 'nano-banana-2',
  video: 'kling-3.0-video',
  motion: 'kling-2.6',
};

export class CatalogError extends Error {
  constructor(
    message: string,
    public readonly code: 'INVALID_MODEL_SETTINGS' | 'MODEL_UNAVAILABLE' | 'CATALOG_CHANGED',
    public readonly status: 409 | 422,
    public readonly fieldErrors: Record<string, string> = {}
  ) {
    super(message);
    this.name = 'CatalogError';
  }
}

function labelForValue(value: string | number): string {
  return typeof value === 'number' ? String(value) : value;
}

function choiceControl(
  key: string,
  label: string,
  values: readonly (string | number)[],
  defaultValue: string | number = values[0],
  presentation: CatalogChoiceControl['presentation'] = values.length > 8 ? 'select' : 'chips'
): CatalogChoiceControl {
  return {
    key,
    label,
    type: 'choice',
    presentation,
    defaultValue: String(defaultValue),
    options: values.map((value) => ({ value: String(value), label: labelForValue(value) })),
  };
}

function booleanControl(key: string, label: string, defaultValue = false): CatalogBooleanControl {
  return { key, label, type: 'boolean', presentation: 'toggle', defaultValue };
}

function imageDescriptors(): GenerationModelDescriptor[] {
  return Object.values(IMAGE_MODELS).map((model, index) => {
    const controls: CatalogControl[] = [
      choiceControl('aspectRatio', 'Aspect ratio', model.aspectRatios),
      choiceControl('resolution', 'Resolution', model.resolutions),
    ];

    if (model.supportsOutputFormat) {
      controls.push(choiceControl('outputFormat', 'Output format', model.outputFormats));
    }
    if (model.supportsGoogleSearch) {
      controls.push(booleanControl('googleSearch', 'Google Search'));
    }
    const qualityModes = getImageQualityModes(model.id);
    if (qualityModes.length > 0) {
      controls.push(choiceControl('qualityMode', model.id === 'ideogram-v3' ? 'Speed' : 'Quality', qualityModes));
    }

    return {
      id: model.id,
      kind: 'image',
      displayName: model.displayName,
      description: model.description,
      badge: model.badge,
      recommended: model.id === DEFAULT_MODEL_IDS.image,
      sortOrder: index * 10,
      minClientSchemaVersion: 1,
      controls,
      capabilities: {
        multiShot: false,
        sound: false,
        fixedLens: false,
        googleSearch: model.supportsGoogleSearch,
        outputFormat: model.supportsOutputFormat,
      },
      inputs: {
        imageReferences: model.maxImages > 0
          ? { max: model.maxImages, supportsNaming: true }
          : null,
        videoReferences: null,
        audioReferences: null,
        preparedAudioReferences: null,
        characterReferences: null,
        startFrame: false,
        endFrame: false,
        combineFramesWithReferences: false,
      },
    };
  });
}

function getVideoInputLimits(modelId: VideoModelId) {
  if (modelId === 'seedance-2' || modelId === 'seedance-2-fast' || modelId === 'seedance-2-mini') {
    return { images: 5, videos: 3, audios: 3, startFrame: true, endFrame: true };
  }
  if (modelId === 'seedance-1.5-pro') {
    return { images: 2, videos: 0, audios: 0, startFrame: true, endFrame: true };
  }
  if (modelId === 'grok-imagine-video') {
    return { images: 1, videos: 0, audios: 0, startFrame: true, endFrame: false };
  }
  if (modelId === 'kling-3.0-video') {
    return { images: 0, videos: 3, audios: 0, startFrame: true, endFrame: true };
  }
  if (modelId === 'kling-3.0-turbo') {
    return { images: 0, videos: 0, audios: 0, startFrame: true, endFrame: false };
  }
  if (modelId === 'wan-2.7') {
    return { images: 5, videos: 5, audios: 1, startFrame: true, endFrame: true };
  }
  if (modelId === 'happyhorse-1.1') {
    return { images: 9, videos: 0, audios: 0, startFrame: true, endFrame: false };
  }
  if (modelId === 'gemini-omni-video') {
    return { images: 7, videos: 1, audios: 0, startFrame: false, endFrame: false };
  }
  if (modelId === 'hailuo-2.3') {
    return { images: 0, videos: 0, audios: 0, startFrame: true, endFrame: false };
  }
  return { images: 3, videos: 0, audios: 0, startFrame: true, endFrame: true };
}

function videoDescriptors(): GenerationModelDescriptor[] {
  return Object.values(VIDEO_MODELS).map((model, index) => {
    const durationRange = getVideoDurationRange(model.id);
    const controls: CatalogControl[] = [choiceControl('aspectRatio', 'Aspect ratio', model.aspectRatios)];
    if (model.modeOptions.length > 0) {
      controls.push({
        ...choiceControl('mode', 'Mode', model.modeOptions.map((option) => option.value)),
        options: model.modeOptions.map((option) => ({ value: option.value, label: option.label })),
      });
    }
    if (model.resolutions.length > 0) {
      controls.push(choiceControl('resolution', 'Resolution', model.resolutions));
    }
    if (durationRange) {
      controls.push({
        key: 'duration',
        label: 'Duration',
        type: 'integer',
        presentation: 'stepper',
        defaultValue: durationRange.default,
        min: durationRange.min,
        max: durationRange.max,
        step: 1,
        unit: 'seconds',
      });
    } else {
      controls.push(choiceControl('duration', 'Duration', model.durations, model.durations[0]));
    }
    if (model.supportsSound) controls.push(booleanControl('sound', 'Sound'));
    if (model.supportsFixedLens) controls.push(booleanControl('fixedLens', 'Fixed lens'));
    if (model.supportsMultiShot) controls.push(booleanControl('isMultiShot', 'Multi-shot'));

    const limits = getVideoInputLimits(model.id);
    return {
      id: model.id,
      kind: 'video',
      displayName: model.displayName,
      description: model.description,
      badge: ['grok-imagine-video', 'kling-3.0-turbo', 'seedance-2-mini', 'wan-2.7', 'hailuo-2.3'].includes(model.id) ? 'New' : null,
      recommended: model.id === DEFAULT_MODEL_IDS.video,
      sortOrder: index * 10,
      minClientSchemaVersion: 1,
      controls,
      capabilities: {
        multiShot: model.supportsMultiShot,
        sound: model.supportsSound,
        fixedLens: model.supportsFixedLens,
        googleSearch: false,
        outputFormat: false,
      },
      inputs: {
        imageReferences: limits.images > 0 ? { max: limits.images, supportsNaming: true } : null,
        videoReferences: limits.videos > 0 ? { max: limits.videos } : null,
        audioReferences: limits.audios > 0 ? { max: limits.audios } : null,
        preparedAudioReferences: model.id === 'gemini-omni-video' ? { max: 3 } : null,
        characterReferences: model.id === 'gemini-omni-video' ? { max: 3 } : null,
        startFrame: limits.startFrame,
        endFrame: limits.endFrame,
        combineFramesWithReferences: model.id === 'wan-2.7',
      },
    };
  });
}

function motionDescriptors(): GenerationModelDescriptor[] {
  return Object.values(MOTION_MODELS).map((model, index) => ({
    id: model.id,
    kind: 'motion',
    displayName: model.displayName,
    description: model.description,
    badge: model.badge,
    recommended: model.id === DEFAULT_MODEL_IDS.motion,
    sortOrder: index * 10,
    minClientSchemaVersion: 1,
    controls: [
      choiceControl('resolution', 'Resolution', model.resolutions),
      choiceControl('characterOrientation', 'Character orientation', model.characterOrientations),
      {
        key: 'duration',
        label: 'Duration',
        type: 'integer',
        presentation: 'stepper',
        defaultValue: 10,
        min: 1,
        max: model.maxDuration,
        step: 1,
        unit: 'seconds',
      },
    ],
    capabilities: {
      multiShot: false,
      sound: false,
      fixedLens: false,
      googleSearch: false,
      outputFormat: false,
    },
    inputs: {
      imageReferences: { max: 1, supportsNaming: false },
      videoReferences: { max: 1 },
      audioReferences: null,
      preparedAudioReferences: null,
      characterReferences: null,
      startFrame: false,
      endFrame: false,
      combineFramesWithReferences: false,
    },
  }));
}

const ALL_PUBLIC_MODELS = [
  ...imageDescriptors(),
  ...videoDescriptors(),
  ...motionDescriptors(),
];

const PRIVATE_GENERATION_MODEL_ALIASES = [
  ...Object.values(IMAGE_MODELS),
  ...Object.values(VIDEO_MODELS),
  ...Object.values(MOTION_MODELS),
] as Array<{ id: string; displayName: string; apiModelId?: string }>;

function buildRevision(models: GenerationModelDescriptor[]): string {
  return createHash('sha256')
    .update(JSON.stringify({ schemaVersion: GENERATION_MODEL_CATALOG_SCHEMA_VERSION, models, status: MODEL_STATUS }))
    .digest('hex')
    .slice(0, 16);
}

export function buildGenerationModelCatalog({
  schemaVersion,
}: {
  platform: CatalogPlatform;
  schemaVersion: number;
}): GenerationModelCatalog {
  const models = ALL_PUBLIC_MODELS
    .filter((model) => MODEL_STATUS[model.id] === 'active' && model.minClientSchemaVersion <= schemaVersion)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.displayName.localeCompare(b.displayName));
  const modelIds = new Set(models.map((model) => model.id));

  return {
    schemaVersion: GENERATION_MODEL_CATALOG_SCHEMA_VERSION,
    revision: buildRevision(ALL_PUBLIC_MODELS),
    defaults: {
      image: modelIds.has(DEFAULT_MODEL_IDS.image) ? DEFAULT_MODEL_IDS.image : models.find((model) => model.kind === 'image')?.id ?? null,
      video: modelIds.has(DEFAULT_MODEL_IDS.video) ? DEFAULT_MODEL_IDS.video : models.find((model) => model.kind === 'video')?.id ?? null,
      motion: modelIds.has(DEFAULT_MODEL_IDS.motion) ? DEFAULT_MODEL_IDS.motion : models.find((model) => model.kind === 'motion')?.id ?? null,
    },
    models,
  };
}

function stringSetting(settings: Record<string, unknown>, key: string, fallback: string): string {
  const value = settings[key];
  return typeof value === 'string' && value ? value : fallback;
}

function booleanSetting(settings: Record<string, unknown>, key: string, fallback = false): boolean {
  return typeof settings[key] === 'boolean' ? settings[key] as boolean : fallback;
}

function numberSetting(settings: Record<string, unknown>, key: string, fallback: number): number {
  return typeof settings[key] === 'number' && Number.isFinite(settings[key]) ? settings[key] as number : fallback;
}

function validateChoice(
  fieldErrors: Record<string, string>,
  key: string,
  value: string,
  values: readonly string[],
  displayName: string
) {
  if (!values.includes(value)) {
    fieldErrors[key] = `${displayName} does not support ${key} ${value}.`;
  }
}

function assertValid(fieldErrors: Record<string, string>) {
  if (Object.keys(fieldErrors).length > 0) {
    throw new CatalogError('Some model settings are no longer available.', 'INVALID_MODEL_SETTINGS', 422, fieldErrors);
  }
}

function quoteImage(modelId: ImageModelId, settings: Record<string, unknown>, imageCount: number): GenerationModelQuote {
  const model = IMAGE_MODELS[modelId];
  const fieldErrors: Record<string, string> = {};
  const aspectRatio = stringSetting(settings, 'aspectRatio', model.aspectRatios[0]);
  validateChoice(fieldErrors, 'aspectRatio', aspectRatio, model.aspectRatios as readonly string[], model.displayName);
  const resolutionOptions = getImageResolutionOptions(modelId, aspectRatio);
  const resolution = stringSetting(settings, 'resolution', resolutionOptions[0]) as ImageResolution;
  validateChoice(fieldErrors, 'resolution', resolution, resolutionOptions as readonly string[], model.displayName);
  const outputFormat = stringSetting(settings, 'outputFormat', model.outputFormats[0]) as ImageOutputFormat;
  validateChoice(fieldErrors, 'outputFormat', outputFormat, model.outputFormats as readonly string[], model.displayName);
  if (imageCount > model.maxImages) {
    fieldErrors.references = `${model.displayName} supports up to ${model.maxImages} image references.`;
  }
  if (modelId === 'wan-2.7-image-pro' && resolution === '4K' && imageCount > 0) {
    fieldErrors.resolution = 'Wan 2.7 Image Pro supports 4K for text-to-image only.';
  }
  const qualityModes = getImageQualityModes(modelId);
  const normalizedQualityMode = stringSetting(settings, 'qualityMode', qualityModes[0] ?? 'standard') as ImageQualityMode;
  if (qualityModes.length > 0) {
    validateChoice(fieldErrors, 'qualityMode', normalizedQualityMode, qualityModes, model.displayName);
  }
  assertValid(fieldErrors);

  const normalizedSettings: Record<string, CatalogPrimitive> = {
    aspectRatio,
    resolution,
    ...(qualityModes.length > 0 ? { qualityMode: normalizedQualityMode } : {}),
    outputFormat: model.supportsOutputFormat ? outputFormat : 'jpg',
    googleSearch: model.supportsGoogleSearch ? booleanSetting(settings, 'googleSearch') : false,
  };
  const catalogRevision = buildGenerationModelCatalog({ platform: 'web', schemaVersion: 1 }).revision;
  return {
    modelId,
    catalogRevision,
    normalizedSettings,
    costCredits: getImageCost(modelId, resolution, { qualityMode: normalizedQualityMode, referenceCount: imageCount }),
  };
}

function quoteVideo(modelId: VideoModelId, settings: Record<string, unknown>, inputCounts: Required<NonNullable<GenerationModelQuoteInput['inputCounts']>>): GenerationModelQuote {
  const model = VIDEO_MODELS[modelId];
  const fieldErrors: Record<string, string> = {};
  const aspectRatio = stringSetting(settings, 'aspectRatio', model.aspectRatios[0]);
  validateChoice(fieldErrors, 'aspectRatio', aspectRatio, model.aspectRatios as readonly string[], model.displayName);
  const duration = numberSetting(settings, 'duration', getDefaultVideoDuration(modelId));
  if (!isValidVideoDuration(modelId, duration)) fieldErrors.duration = `Unsupported duration for ${model.displayName}.`;
  const mode = stringSetting(settings, 'mode', model.modeOptions[0]?.value ?? '');
  if (model.modeOptions.length > 0) validateChoice(fieldErrors, 'mode', mode, model.modeOptions.map((option) => option.value), model.displayName);
  const resolution = stringSetting(settings, 'resolution', model.resolutions[0] ?? '');
  if (model.resolutions.length > 0) validateChoice(fieldErrors, 'resolution', resolution, model.resolutions as readonly string[], model.displayName);
  if (modelId === 'hailuo-2.3' && resolution === '1080P' && duration === 10) {
    fieldErrors.duration = 'Hailuo 2.3 supports 1080P output at 6 seconds only.';
  }
  const limits = getVideoInputLimits(modelId);
  const referenceMode = stringSetting(settings, 'referenceMode', 'frames') === 'elements' ? 'elements' : 'frames';
  const elementSupport = getVideoElementSupport(modelId, { mode });
  const maxImages = referenceMode === 'elements'
    ? elementSupport.maxElements
    : Number(limits.startFrame) + Number(limits.endFrame);
  if (referenceMode === 'elements' && inputCounts.images > 0 && !elementSupport.enabled) {
    fieldErrors.images = elementSupport.reason || `${model.displayName} does not support reusable references in this mode.`;
  } else if (inputCounts.images > maxImages) {
    fieldErrors.images = `${model.displayName} supports up to ${maxImages} image ${referenceMode === 'elements' ? 'references' : 'frames'}.`;
  }
  if (inputCounts.videos > limits.videos) fieldErrors.videos = `${model.displayName} supports up to ${limits.videos} video references.`;
  if (inputCounts.audios > limits.audios) fieldErrors.audios = `${model.displayName} supports up to ${limits.audios} audio references.`;
  if (modelId === 'wan-2.7' && referenceMode === 'elements' && inputCounts.images + inputCounts.videos + inputCounts.audios > 5) {
    fieldErrors.references = 'Wan 2.7 supports up to 5 reusable references in total.';
  }
  if (modelId === 'gemini-omni-video' && inputCounts.images + (inputCounts.videos * 2) > 7) {
    fieldErrors.references = 'Gemini Omni supports seven reference slots; a video uses two slots.';
  }
  if (modelId === 'gemini-omni-video' && inputCounts.characters > 3) {
    fieldErrors.characters = 'Gemini Omni supports up to 3 prepared character references.';
  }
  if (modelId === 'gemini-omni-video' && inputCounts.preparedAudios > 3) {
    fieldErrors.preparedAudios = 'Gemini Omni supports up to 3 prepared voice references.';
  }
  if (modelId === 'gemini-omni-video' && inputCounts.images + (inputCounts.videos * 2) + inputCounts.characters > 7) {
    fieldErrors.references = 'Gemini Omni supports seven reference slots; videos use two and characters use one.';
  }
  if (modelId === 'hailuo-2.3' && referenceMode === 'frames' && inputCounts.images === 0) {
    fieldErrors.images = 'Hailuo 2.3 requires a start image.';
  }
  assertValid(fieldErrors);

  const sound = model.supportsSound ? booleanSetting(settings, 'sound') : false;
  const fixedLens = model.supportsFixedLens ? booleanSetting(settings, 'fixedLens') : false;
  const normalizedSettings: Record<string, CatalogPrimitive> = { aspectRatio, duration, mode, resolution, sound, fixedLens, referenceMode };
  const catalogRevision = buildGenerationModelCatalog({ platform: 'web', schemaVersion: 1 }).revision;
  return {
    modelId,
    catalogRevision,
    normalizedSettings,
    costCredits: getVideoCost(modelId, {
      mode,
      sound,
      durationSeconds: duration,
      resolution,
      hasReferenceVideo: inputCounts.videos > 0,
      hasReferenceImage: inputCounts.images > 0,
    }),
  };
}

function quoteMotion(modelId: MotionModelId, settings: Record<string, unknown>): GenerationModelQuote {
  const model = MOTION_MODELS[modelId];
  const fieldErrors: Record<string, string> = {};
  const resolution = stringSetting(settings, 'resolution', model.resolutions[0]) as '720p' | '1080p';
  validateChoice(fieldErrors, 'resolution', resolution, model.resolutions as readonly string[], model.displayName);
  const characterOrientation = stringSetting(settings, 'characterOrientation', model.characterOrientations[0]);
  validateChoice(fieldErrors, 'characterOrientation', characterOrientation, model.characterOrientations as readonly string[], model.displayName);
  const duration = numberSetting(settings, 'duration', 10);
  if (!Number.isInteger(duration) || duration < 1 || duration > model.maxDuration) {
    fieldErrors.duration = `Duration must be between 1 and ${model.maxDuration} seconds.`;
  }
  assertValid(fieldErrors);
  const catalogRevision = buildGenerationModelCatalog({ platform: 'web', schemaVersion: 1 }).revision;
  return {
    modelId,
    catalogRevision,
    normalizedSettings: { resolution, characterOrientation, duration },
    costCredits: getMotionCost(modelId, resolution, duration),
  };
}

export function quoteGenerationModel(input: GenerationModelQuoteInput): GenerationModelQuote {
  const catalog = buildGenerationModelCatalog({ platform: 'web', schemaVersion: 1 });
  if (input.catalogRevision && input.catalogRevision !== catalog.revision) {
    throw new CatalogError('The model catalog has changed. Refresh settings before generating.', 'CATALOG_CHANGED', 409);
  }

  const descriptor = catalog.models.find((model) => model.id === input.modelId && model.kind === input.kind);
  if (!descriptor) {
    throw new CatalogError('This model is no longer available.', 'MODEL_UNAVAILABLE', 409);
  }

  const settings = input.settings ?? {};
  const inputCounts = {
    images: Math.max(0, Math.floor(input.inputCounts?.images ?? 0)),
    videos: Math.max(0, Math.floor(input.inputCounts?.videos ?? 0)),
    audios: Math.max(0, Math.floor(input.inputCounts?.audios ?? 0)),
    preparedAudios: Math.max(0, Math.floor(input.inputCounts?.preparedAudios ?? 0)),
    characters: Math.max(0, Math.floor(input.inputCounts?.characters ?? 0)),
  };
  if (input.kind === 'image') return quoteImage(input.modelId as ImageModelId, settings, inputCounts.images);
  if (input.kind === 'video') return quoteVideo(input.modelId as VideoModelId, settings, inputCounts);
  return quoteMotion(input.modelId as MotionModelId, settings);
}

export function getGenerationModelDisplayName(modelId: string): string | null {
  return ALL_PUBLIC_MODELS.find((model) => model.id === modelId)?.displayName
    ?? PRIVATE_GENERATION_MODEL_ALIASES.find((model) => model.apiModelId === modelId)?.displayName
    ?? null;
}

export function getGenerationModelChoiceOptionLabel(
  modelId: string,
  controlKey: string,
  value: string
): string | null {
  const model = ALL_PUBLIC_MODELS.find((candidate) => candidate.id === modelId);
  const control = model?.controls.find((candidate): candidate is CatalogChoiceControl => (
    candidate.type === 'choice' && candidate.key === controlKey
  ));

  return control?.options.find((option) => option.value === value)?.label ?? null;
}
