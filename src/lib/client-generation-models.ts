/**
 * Browser-safe generation model metadata.
 *
 * This file intentionally contains only UI-facing labels, capabilities, and
 * control constraints. Provider IDs, adapter routing, and pricing live in the
 * server registry and are enforced by the catalog/quote APIs.
 */

export const MOTION_MODELS = {
  'kling-2.6': {
    id: 'kling-2.6' as const,
    displayName: 'Kling 2.6',
    description: 'Reliable motion transfer with smooth character animation',
    badge: 'Stable',
    badgeColor: 'from-purple-500 to-pink-500',
    maxDuration: 30,
    maxVideoDuration: 30,
    characterOrientations: ['video', 'image'] as const,
    resolutions: ['720p', '1080p'] as const,
  },
  'kling-3.0': {
    id: 'kling-3.0' as const,
    displayName: 'Kling 3.0',
    description: 'Latest model with enhanced fidelity and motion accuracy',
    badge: 'New',
    badgeColor: 'from-violet-500 to-indigo-500',
    maxDuration: 30,
    maxVideoDuration: 30,
    characterOrientations: ['video', 'image'] as const,
    resolutions: ['720p', '1080p'] as const,
  },
} as const;

export type MotionModelId = keyof typeof MOTION_MODELS;

export const IMAGE_MODELS = {
  'nano-banana-2': {
    id: 'nano-banana-2' as const,
    displayName: 'Nano Banana 2.0',
    description: 'Versatile image generation with Google Search grounding',
    badge: 'Recommended',
    badgeColor: 'from-blue-500 to-cyan-500',
    accentColor: 'blue',
    maxImages: 14,
    supportsGoogleSearch: true,
    supportsOutputFormat: true,
    aspectRatios: ['auto', '1:1', '1:4', '1:8', '2:3', '3:2', '3:4', '4:1', '4:3', '4:5', '5:4', '8:1', '9:16', '16:9', '21:9'] as const,
    resolutions: ['1K', '2K', '4K'] as const,
    outputFormats: ['jpg', 'png'] as const,
  },
  'nano-banana-pro': {
    id: 'nano-banana-pro' as const,
    displayName: 'Nano Banana Pro',
    description: 'High-fidelity generation with multi-image references',
    badge: 'Pro',
    badgeColor: 'from-violet-500 to-purple-500',
    accentColor: 'violet',
    maxImages: 8,
    supportsGoogleSearch: false,
    supportsOutputFormat: true,
    aspectRatios: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9', 'auto'] as const,
    resolutions: ['1K', '2K', '4K'] as const,
    outputFormats: ['jpg', 'png'] as const,
  },
  'gpt-image-2': {
    id: 'gpt-image-2' as const,
    displayName: 'GPT Image 2',
    description: 'ChatGPT image generation with fast, high-quality edits',
    badge: 'New',
    badgeColor: 'from-amber-500 to-orange-500',
    accentColor: 'amber',
    maxImages: 16,
    supportsGoogleSearch: false,
    supportsOutputFormat: false,
    aspectRatios: ['auto', '1:1', '5:4', '9:16', '21:9', '16:9', '4:3', '3:2', '4:5', '3:4', '2:3'] as const,
    resolutions: ['1K', '2K', '4K'] as const,
    outputFormats: ['jpg'] as const,
  },
  'grok-imagine-image': {
    id: 'grok-imagine-image' as const,
    displayName: 'Grok Imagine',
    description: 'xAI image generation and edits with multi-output results',
    badge: 'New',
    badgeColor: 'from-amber-500 to-orange-500',
    accentColor: 'amber',
    maxImages: 1,
    supportsGoogleSearch: false,
    supportsOutputFormat: false,
    aspectRatios: ['3:2', '2:3', '1:1', '9:16', '16:9'] as const,
    resolutions: ['1K'] as const,
    outputFormats: ['jpg'] as const,
  },
} as const;

export type ImageModelId = keyof typeof IMAGE_MODELS;
export type ImageResolution = '1K' | '2K' | '4K';
export type ImageOutputFormat = 'jpg' | 'png';
export type ImageQualityMode = 'standard' | 'quality';

const GPT_IMAGE_2_AUTO_RESOLUTIONS = ['1K'] as const satisfies readonly ImageResolution[];
const GPT_IMAGE_2_SQUARE_RESOLUTIONS = ['1K', '2K'] as const satisfies readonly ImageResolution[];

export function getImageResolutionOptions(
  modelId: ImageModelId,
  aspectRatio?: string
): readonly ImageResolution[] {
  const selectedAspectRatio = aspectRatio ?? IMAGE_MODELS[modelId].aspectRatios[0];
  if (modelId === 'grok-imagine-image') return IMAGE_MODELS[modelId].resolutions;
  if (modelId !== 'gpt-image-2') return IMAGE_MODELS[modelId].resolutions;
  if (selectedAspectRatio === 'auto') return GPT_IMAGE_2_AUTO_RESOLUTIONS;
  if (selectedAspectRatio === '1:1') return GPT_IMAGE_2_SQUARE_RESOLUTIONS;
  return IMAGE_MODELS[modelId].resolutions;
}

export function supportsImageResolutionControl(modelId: ImageModelId): boolean {
  return modelId !== 'grok-imagine-image';
}

export const VIDEO_MODELS = {
  'kling-3.0-video': {
    id: 'kling-3.0-video' as const,
    displayName: 'Kling 3.0 Cinematic',
    description: 'Advanced video generation engine with single-shot and multi-shot support',
    supportsMultiShot: true,
    supportsSound: true,
    supportsFixedLens: false,
    aspectRatios: ['16:9', '9:16', '1:1'] as const,
    durations: [5, 10] as const,
    singleShotDurationRange: { min: 3, max: 15, default: 5 } as const,
    resolutions: [] as const,
    modeOptions: [
      { value: 'std', label: 'Standard (720p)' },
      { value: 'pro', label: 'Pro (1080p, High Quality)' },
    ] as const,
  },
  'seedance-1.5-pro': {
    id: 'seedance-1.5-pro' as const,
    displayName: 'Seedance 1.5 Pro',
    description: 'ByteDance video model with resolution, duration, and audio controls',
    supportsMultiShot: false,
    supportsSound: true,
    supportsFixedLens: true,
    aspectRatios: ['1:1', '21:9', '4:3', '3:4', '16:9', '9:16'] as const,
    durations: [4, 8, 12] as const,
    modeOptions: [] as const,
    resolutions: ['480p', '720p', '1080p'] as const,
  },
  'seedance-2': {
    id: 'seedance-2' as const,
    displayName: 'Seedance 2',
    description: 'ByteDance video model with image, video, audio, and audio generation controls',
    supportsMultiShot: false,
    supportsSound: true,
    supportsFixedLens: false,
    aspectRatios: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'] as const,
    durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const,
    singleShotDurationRange: { min: 4, max: 15, default: 15 } as const,
    modeOptions: [] as const,
    resolutions: ['480p', '720p'] as const,
  },
  'seedance-2-fast': {
    id: 'seedance-2-fast' as const,
    displayName: 'Seedance 2 Fast',
    description: 'Faster ByteDance video model with image, video, and audio references',
    supportsMultiShot: false,
    supportsSound: true,
    supportsFixedLens: false,
    aspectRatios: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'] as const,
    durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const,
    singleShotDurationRange: { min: 4, max: 15, default: 15 } as const,
    modeOptions: [] as const,
    resolutions: ['480p', '720p'] as const,
  },
  'veo-3.1': {
    id: 'veo-3.1' as const,
    displayName: 'Veo 3.1',
    description: 'Google-class video generation with fast and quality variants',
    supportsMultiShot: false,
    supportsSound: false,
    supportsFixedLens: false,
    aspectRatios: ['16:9', '9:16', 'Auto'] as const,
    durations: [8] as const,
    resolutions: [] as const,
    modeOptions: [
      { value: 'veo3_fast', label: 'Fast' },
      { value: 'veo3', label: 'Quality' },
    ] as const,
  },
  'grok-imagine-video': {
    id: 'grok-imagine-video' as const,
    displayName: 'Grok Imagine Video',
    description: 'xAI video generation with playful, normal, and spicy modes',
    supportsMultiShot: false,
    supportsSound: false,
    supportsFixedLens: false,
    aspectRatios: ['2:3', '3:2', '1:1', '9:16', '16:9'] as const,
    durations: [6, 10, 15, 30] as const,
    singleShotDurationRange: { min: 6, max: 30, default: 6 } as const,
    resolutions: ['480p', '720p'] as const,
    modeOptions: [
      { value: 'normal', label: 'Normal' },
      { value: 'fun', label: 'Fun' },
      { value: 'spicy', label: 'Spicy' },
    ] as const,
  },
} as const;

export type VideoModelId = keyof typeof VIDEO_MODELS;

export function getVideoElementSupport(
  modelId: VideoModelId,
  options: { mode?: string; isMultiShot?: boolean } = {}
): { enabled: boolean; maxElements: number; reason: string | null } {
  if (options.isMultiShot) return { enabled: false, maxElements: 0, reason: 'Named elements are available in single-shot only.' };
  if (modelId === 'seedance-1.5-pro') return { enabled: true, maxElements: 2, reason: null };
  if (modelId === 'seedance-2' || modelId === 'seedance-2-fast') return { enabled: true, maxElements: 5, reason: null };
  if (modelId === 'veo-3.1') {
    return options.mode === 'veo3_fast'
      ? { enabled: true, maxElements: 3, reason: null }
      : { enabled: false, maxElements: 0, reason: 'Named elements require Veo Fast.' };
  }
  if (modelId === 'grok-imagine-video') return { enabled: true, maxElements: 1, reason: null };
  if (modelId === 'kling-3.0-video') return { enabled: false, maxElements: 0, reason: 'Named elements are not available for Kling yet.' };
  return { enabled: false, maxElements: 0, reason: 'Named elements are not available for this model yet.' };
}

export function getVideoDurationRange(modelId: VideoModelId): { min: number; max: number; default: number } | null {
  const model = VIDEO_MODELS[modelId];
  return 'singleShotDurationRange' in model ? model.singleShotDurationRange : null;
}

export function getDefaultVideoDuration(modelId: VideoModelId): number {
  return getVideoDurationRange(modelId)?.default ?? VIDEO_MODELS[modelId].durations[0];
}

export function isValidVideoDuration(modelId: VideoModelId, durationSeconds: number): boolean {
  const range = getVideoDurationRange(modelId);
  if (range) return durationSeconds >= range.min && durationSeconds <= range.max;
  return (VIDEO_MODELS[modelId].durations as readonly number[]).includes(durationSeconds);
}

export function clampVideoDuration(modelId: VideoModelId, durationSeconds: number): number {
  const range = getVideoDurationRange(modelId);
  if (range) return Math.min(range.max, Math.max(range.min, durationSeconds));
  return isValidVideoDuration(modelId, durationSeconds)
    ? durationSeconds
    : VIDEO_MODELS[modelId].durations[0];
}

const AUDIO_MODEL_IDS = [
  'text-to-speech-turbo-2-5',
  'text-to-speech-multilingual-v2',
  'text-to-dialogue-v3',
  'sound-effect-v2',
] as const;

const AUDIO_PROVIDER_MODEL_IDS = [
  'elevenlabs/text-to-speech-turbo-2-5',
  'elevenlabs/text-to-speech-multilingual-v2',
  'elevenlabs/text-to-dialogue-v3',
  'elevenlabs/sound-effect-v2',
] as const;

export function isImageModel(modelId: string): boolean {
  return modelId in IMAGE_MODELS;
}

export function isMotionModel(modelId: string): boolean {
  return modelId in MOTION_MODELS;
}

export function isVideoModel(modelId: string): boolean {
  return modelId in VIDEO_MODELS;
}

export function isAudioModel(modelId: string): boolean {
  return (AUDIO_MODEL_IDS as readonly string[]).includes(modelId)
    || (AUDIO_PROVIDER_MODEL_IDS as readonly string[]).includes(modelId);
}
