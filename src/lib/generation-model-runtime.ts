import {
  IMAGE_MODELS,
  MOTION_MODELS,
  VIDEO_MODELS,
  type ImageModelId,
  type VideoModelId,
} from '@/lib/models';

import type {
  CatalogPrimitive,
  GenerationModelKind,
  GenerationModelQuoteInput,
} from '@/lib/generation-model-catalog';

export const GENERATION_MODEL_ADAPTER_KEYS = ['image-v1', 'video-v1', 'motion-v1'] as const;
export const GENERATION_MODEL_PRICING_STRATEGIES = ['image-v1', 'video-v1', 'motion-v1'] as const;
export const GENERATION_MODEL_VALIDATION_STRATEGIES = ['image-v1', 'video-v1', 'motion-v1'] as const;

export type GenerationModelAdapterKey = typeof GENERATION_MODEL_ADAPTER_KEYS[number];
export type GenerationModelPricingStrategy = typeof GENERATION_MODEL_PRICING_STRATEGIES[number];
export type GenerationModelValidationStrategy = typeof GENERATION_MODEL_VALIDATION_STRATEGIES[number];

export type GenerationModelOperationalConfig = {
  modelId: string;
  kind: GenerationModelKind;
  adapterKey: GenerationModelAdapterKey;
  providerModelMap: Record<string, string>;
  pricingStrategy: GenerationModelPricingStrategy;
  pricingConfig: Record<string, unknown>;
  validationStrategy: GenerationModelValidationStrategy;
  validationConfig: Record<string, unknown>;
  verificationConfig: Record<string, unknown>;
};

const IMAGE_PROVIDER_MODELS: Record<ImageModelId, Record<string, string>> = {
  'nano-banana-2-lite': { default: 'nano-banana-2-lite' },
  'nano-banana-2': { default: 'nano-banana-2' },
  'nano-banana-pro': { default: 'nano-banana-pro' },
  'gpt-image-2': {
    text: 'gpt-image-2-text-to-image',
    reference: 'gpt-image-2-image-to-image',
  },
  'seedream-5-pro': {
    text: 'seedream/5-pro-text-to-image',
    reference: 'seedream/5-pro-image-to-image',
  },
  'seedream-5-lite': {
    text: 'seedream/5-lite-text-to-image',
    reference: 'seedream/5-lite-image-to-image',
  },
  'wan-2.7-image': { default: 'wan-2.7-image' },
  'wan-2.7-image-pro': { default: 'wan-2.7-image-pro' },
  'imagen-4-fast': { default: 'google/imagen4-fast' },
  'imagen-4': { default: 'google/imagen4' },
  'imagen-4-ultra': { default: 'google/imagen4-ultra' },
  'ideogram-v3': {
    text: 'ideogram/v3-text-to-image',
    reference: 'ideogram/v3-remix',
  },
  'flux-2-pro': {
    text: 'flux-2/pro-text-to-image',
    reference: 'flux-2/pro-image-to-image',
  },
  'z-image': { default: 'z-image' },
  'grok-imagine-image': {
    text: 'grok-imagine/text-to-image',
    reference: 'grok-imagine/image-to-image',
  },
};

const VIDEO_PROVIDER_MODELS: Record<VideoModelId, Record<string, string>> = {
  'kling-3.0-video': { default: 'kling-3.0/video' },
  'kling-3.0-turbo': {
    default: 'kling/v3-turbo-text-to-video',
    text: 'kling/v3-turbo-text-to-video',
    image: 'kling/v3-turbo-image-to-video',
  },
  'seedance-1.5-pro': { default: 'bytedance/seedance-1.5-pro' },
  'seedance-2': { default: 'bytedance/seedance-2' },
  'seedance-2-fast': { default: 'bytedance/seedance-2-fast' },
  'seedance-2-mini': { default: 'bytedance/seedance-2-mini' },
  'wan-2.7': {
    default: 'wan/2-7-text-to-video',
    text: 'wan/2-7-text-to-video',
    image: 'wan/2-7-image-to-video',
    reference: 'wan/2-7-r2v',
  },
  'happyhorse-1.1': {
    default: 'happyhorse-1-1/text-to-video',
    text: 'happyhorse-1-1/text-to-video',
    image: 'happyhorse-1-1/image-to-video',
    reference: 'happyhorse-1-1/reference-to-video',
  },
  'gemini-omni-video': { default: 'gemini-omni-video' },
  'hailuo-2.3': {
    default: 'hailuo/2-3-image-to-video-standard',
    standard: 'hailuo/2-3-image-to-video-standard',
    pro: 'hailuo/2-3-image-to-video-pro',
  },
  'veo-3.1': {
    default: 'veo3_fast',
    veo3_lite: 'veo3_lite',
    veo3_fast: 'veo3_fast',
    veo3: 'veo3',
  },
  'grok-imagine-video': {
    default: 'grok-imagine/text-to-video',
    text: 'grok-imagine/text-to-video',
    image: 'grok-imagine/image-to-video',
  },
};

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function buildCodeGenerationModelOperations(): GenerationModelOperationalConfig[] {
  const imageEntries = Object.values(IMAGE_MODELS).map((model) => ({
    modelId: model.id,
    kind: 'image' as const,
    adapterKey: 'image-v1' as const,
    providerModelMap: IMAGE_PROVIDER_MODELS[model.id],
    pricingStrategy: 'image-v1' as const,
    pricingConfig: cloneJson(model),
    validationStrategy: 'image-v1' as const,
    validationConfig: {},
    verificationConfig: { mode: 'manual', provider: 'kie' },
  }));
  const videoEntries = Object.values(VIDEO_MODELS).map((model) => ({
    modelId: model.id,
    kind: 'video' as const,
    adapterKey: 'video-v1' as const,
    providerModelMap: VIDEO_PROVIDER_MODELS[model.id],
    pricingStrategy: 'video-v1' as const,
    pricingConfig: cloneJson(model),
    validationStrategy: 'video-v1' as const,
    validationConfig: {},
    verificationConfig: { mode: 'manual', provider: 'kie' },
  }));
  const motionEntries = Object.values(MOTION_MODELS).map((model) => ({
    modelId: model.id,
    kind: 'motion' as const,
    adapterKey: 'motion-v1' as const,
    providerModelMap: { default: model.apiModelId },
    pricingStrategy: 'motion-v1' as const,
    pricingConfig: cloneJson(model),
    validationStrategy: 'motion-v1' as const,
    validationConfig: {},
    verificationConfig: { mode: 'manual', provider: 'kie' },
  }));

  return [...imageEntries, ...videoEntries, ...motionEntries];
}

export function resolveProviderModelId(
  config: GenerationModelOperationalConfig | null | undefined,
  variant: string,
  fallback: string,
): string {
  const configured = config?.providerModelMap[variant] ?? config?.providerModelMap.default;
  return typeof configured === 'string' && configured.trim() ? configured : fallback;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function nestedNumber(root: unknown, path: Array<string | number>, fallback = 0): number {
  let value: unknown = root;
  for (const segment of path) {
    value = recordValue(value)[String(segment)];
  }
  return numberValue(value, fallback);
}

function settingString(settings: Record<string, CatalogPrimitive>, key: string, fallback: string): string {
  return typeof settings[key] === 'string' ? settings[key] as string : fallback;
}

function settingNumber(settings: Record<string, CatalogPrimitive>, key: string, fallback: number): number {
  return typeof settings[key] === 'number' ? settings[key] as number : fallback;
}

function settingBoolean(settings: Record<string, CatalogPrimitive>, key: string): boolean {
  return settings[key] === true;
}

function imageRuntimeCost(
  config: GenerationModelOperationalConfig,
  settings: Record<string, CatalogPrimitive>,
  inputCounts: Required<NonNullable<GenerationModelQuoteInput['inputCounts']>>,
): number {
  const model = config.pricingConfig;
  const modelId = config.modelId;
  const resolution = settingString(settings, 'resolution', '1K');
  const qualityMode = settingString(settings, 'qualityMode', 'standard');
  if (modelId === 'grok-imagine-image') {
    if (inputCounts.images > 0) return nestedNumber(model, ['qualityPricing', 'imageToImage']);
    return nestedNumber(model, ['qualityPricing', qualityMode === 'quality' ? 'quality' : 'standard']);
  }
  if (modelId === 'ideogram-v3') {
    const key = qualityMode === 'quality' ? 'quality' : qualityMode === 'balanced' ? 'balanced' : 'turbo';
    return nestedNumber(model, ['qualityPricing', key]);
  }
  const resolutions = Array.isArray(model.resolutions) ? model.resolutions : [];
  const fallbackResolution = typeof resolutions[0] === 'string' ? resolutions[0] : '1K';
  const baseCost = nestedNumber(model, ['pricing', resolution], nestedNumber(model, ['pricing', fallbackResolution]));
  if (modelId === 'seedream-5-pro') {
    const additionalReferences = Math.max(0, inputCounts.images - 1);
    return Math.ceil(baseCost + additionalReferences * numberValue(model.additionalReferenceCredit));
  }
  return baseCost;
}

function videoRuntimeCost(
  config: GenerationModelOperationalConfig,
  settings: Record<string, CatalogPrimitive>,
  inputCounts: Required<NonNullable<GenerationModelQuoteInput['inputCounts']>>,
): number {
  const model = config.pricingConfig;
  const modelId = config.modelId;
  const duration = settingNumber(settings, 'duration', 5);
  const resolution = settingString(settings, 'resolution', '720p');
  const mode = settingString(settings, 'mode', 'std');
  const sound = settingBoolean(settings, 'sound');
  if (modelId === 'kling-3.0-video') {
    return Math.ceil(duration * nestedNumber(model, ['pricing', mode === 'pro' ? 'pro' : 'std', sound ? 'withSound' : 'noSound']));
  }
  if (modelId === 'seedance-1.5-pro') {
    const selectedResolution = ['480p', '720p', '1080p'].includes(resolution) ? resolution : '720p';
    const selectedDuration = [4, 8, 12].includes(Math.round(duration)) ? Math.round(duration) : 8;
    return nestedNumber(model, ['pricing', selectedResolution, sound ? 'withSound' : 'noSound', selectedDuration]);
  }
  if (modelId === 'seedance-2' || modelId === 'seedance-2-fast' || modelId === 'seedance-2-mini') {
    const selectedResolution = resolution in recordValue(model.pricing) ? resolution : '720p';
    const rate = nestedNumber(model, ['pricing', selectedResolution, inputCounts.videos > 0 ? 'withVideo' : 'noVideo']);
    return Math.ceil(duration * rate);
  }
  if (modelId === 'kling-3.0-turbo' || modelId === 'wan-2.7' || modelId === 'happyhorse-1.1' || modelId === 'grok-imagine-video') {
    const selectedResolution = resolution in recordValue(model.pricing) ? resolution : '720p';
    return Math.ceil(duration * nestedNumber(model, ['pricing', selectedResolution]));
  }
  if (modelId === 'gemini-omni-video') {
    const selectedResolution = resolution === '4k' ? '4k' : resolution === '1080p' ? '1080p' : '720p';
    if (inputCounts.videos > 0) {
      return nestedNumber(model, ['pricing', 'withVideo', selectedResolution === '4k' ? '4k' : 'standard']);
    }
    const selectedDuration = [4, 6, 8, 10].includes(duration) ? duration : 4;
    return nestedNumber(model, ['pricing', selectedResolution, selectedDuration]);
  }
  if (modelId === 'hailuo-2.3') {
    const selectedMode = mode === 'pro' ? 'pro' : 'standard';
    const selectedResolution = resolution === '1080P' ? '1080P' : '768P';
    const selectedDuration = duration === 10 ? 10 : 6;
    return nestedNumber(
      model,
      ['pricing', selectedMode, selectedResolution, selectedDuration],
      nestedNumber(model, ['pricing', selectedMode, selectedResolution, 6]),
    );
  }
  const selectedResolution = resolution === '1080p' || resolution === '4k' ? resolution : '720p';
  if (mode === 'veo3') {
    return nestedNumber(model, ['pricing', 'veo3', inputCounts.images > 0 ? 'reference' : 'text', selectedResolution]);
  }
  return nestedNumber(model, ['pricing', mode === 'veo3_lite' ? 'veo3_lite' : 'veo3_fast', selectedResolution]);
}

export function calculateGenerationModelRuntimeCost(
  config: GenerationModelOperationalConfig,
  settings: Record<string, CatalogPrimitive>,
  inputCounts: Required<NonNullable<GenerationModelQuoteInput['inputCounts']>>,
): number {
  let cost: number;
  if (config.pricingStrategy === 'image-v1') {
    cost = imageRuntimeCost(config, settings, inputCounts);
  } else if (config.pricingStrategy === 'video-v1') {
    cost = videoRuntimeCost(config, settings, inputCounts);
  } else {
    const resolution = settingString(settings, 'resolution', '720p');
    const duration = settingNumber(settings, 'duration', 1);
    cost = Math.ceil(duration * nestedNumber(config.pricingConfig, ['pricing', resolution]));
  }

  if (!Number.isFinite(cost) || cost < 0) {
    throw new Error(`Invalid pricing configuration for ${config.modelId}.`);
  }
  return cost;
}
