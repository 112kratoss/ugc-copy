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
    badgeColor: 'from-sky-500 to-blue-500',
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
    badgeColor: 'from-[#ff7a59] to-orange-500',
    maxDuration: 30,
    maxVideoDuration: 30,
    characterOrientations: ['video', 'image'] as const,
    resolutions: ['720p', '1080p'] as const,
  },
} as const;

export type MotionModelId = keyof typeof MOTION_MODELS;

export const IMAGE_MODELS = {
  'nano-banana-2-lite': {
    id: 'nano-banana-2-lite' as const,
    displayName: 'Nano Banana 2 Lite',
    description: 'Fast 1K generation and edits for high-volume creative iteration',
    badge: 'Fast',
    badgeColor: 'from-cyan-500 to-blue-500',
    accentColor: 'blue',
    maxImages: 10,
    supportsGoogleSearch: false,
    supportsOutputFormat: false,
    aspectRatios: ['auto', '1:1', '1:4', '1:8', '2:3', '3:2', '3:4', '4:1', '4:3', '4:5', '5:4', '8:1', '9:16', '16:9', '21:9'] as const,
    resolutions: ['1K'] as const,
    outputFormats: ['jpg'] as const,
  },
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
    badgeColor: 'from-sky-500 to-blue-500',
    accentColor: 'blue',
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
  'seedream-5-pro': {
    id: 'seedream-5-pro' as const,
    displayName: 'Seedream 5 Pro',
    description: 'Production-ready portraits, products, typography, and precise edits',
    badge: 'Creator',
    badgeColor: 'from-blue-500 to-indigo-500',
    accentColor: 'blue',
    maxImages: 10,
    supportsGoogleSearch: false,
    supportsOutputFormat: true,
    aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16', '2:3', '3:2', '21:9'] as const,
    resolutions: ['1K', '2K'] as const,
    outputFormats: ['jpg', 'png'] as const,
  },
  'seedream-5-lite': {
    id: 'seedream-5-lite' as const, displayName: 'Seedream 5 Lite',
    description: 'Fast, low-cost generation and multi-image editing up to 3K', badge: 'Value',
    badgeColor: 'from-cyan-500 to-blue-500', accentColor: 'blue', maxImages: 14,
    supportsGoogleSearch: false, supportsOutputFormat: true,
    aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16', '2:3', '3:2', '21:9'] as const,
    resolutions: ['2K', '3K'] as const, outputFormats: ['jpg', 'png'] as const,
  },
  'wan-2.7-image': {
    id: 'wan-2.7-image' as const, displayName: 'Wan 2.7 Image',
    description: 'Affordable generation and editing with up to nine references', badge: 'Value',
    badgeColor: 'from-emerald-500 to-cyan-500', accentColor: 'blue', maxImages: 9,
    supportsGoogleSearch: false, supportsOutputFormat: false, aspectRatios: ['auto'] as const,
    resolutions: ['1K', '2K'] as const, outputFormats: ['jpg'] as const,
  },
  'wan-2.7-image-pro': {
    id: 'wan-2.7-image-pro' as const, displayName: 'Wan 2.7 Image Pro',
    description: 'High-fidelity Wan generation and editing with optional 4K output', badge: 'Pro',
    badgeColor: 'from-blue-500 to-indigo-500', accentColor: 'blue', maxImages: 9,
    supportsGoogleSearch: false, supportsOutputFormat: false, aspectRatios: ['auto'] as const,
    resolutions: ['1K', '2K', '4K'] as const, outputFormats: ['jpg'] as const,
  },
  'imagen-4-fast': {
    id: 'imagen-4-fast' as const, displayName: 'Imagen 4 Fast', description: 'Fast Google image generation for polished everyday creative', badge: 'Fast', badgeColor: 'from-cyan-500 to-blue-500', accentColor: 'blue', maxImages: 0, supportsGoogleSearch: false, supportsOutputFormat: false, aspectRatios: ['auto', '1:1', '16:9', '9:16', '3:4', '4:3'] as const, resolutions: ['1K'] as const, outputFormats: ['jpg'] as const,
  },
  'imagen-4': {
    id: 'imagen-4' as const, displayName: 'Imagen 4', description: 'Balanced Google image generation with stronger detail and typography', badge: 'Quality', badgeColor: 'from-blue-500 to-indigo-500', accentColor: 'blue', maxImages: 0, supportsGoogleSearch: false, supportsOutputFormat: false, aspectRatios: ['auto', '1:1', '16:9', '9:16', '3:4', '4:3'] as const, resolutions: ['1K'] as const, outputFormats: ['jpg'] as const,
  },
  'imagen-4-ultra': {
    id: 'imagen-4-ultra' as const, displayName: 'Imagen 4 Ultra', description: 'Highest-quality Imagen 4 output for final production assets', badge: 'Ultra', badgeColor: 'from-violet-500 to-fuchsia-500', accentColor: 'blue', maxImages: 0, supportsGoogleSearch: false, supportsOutputFormat: false, aspectRatios: ['auto', '1:1', '16:9', '9:16', '3:4', '4:3'] as const, resolutions: ['1K'] as const, outputFormats: ['jpg'] as const,
  },
  'ideogram-v3': {
    id: 'ideogram-v3' as const, displayName: 'Ideogram V3', description: 'Strong typography, logos, posters, and single-image remixing', badge: 'Design', badgeColor: 'from-fuchsia-500 to-violet-500', accentColor: 'amber', maxImages: 1, supportsGoogleSearch: false, supportsOutputFormat: false, aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16'] as const, resolutions: ['1K'] as const, outputFormats: ['jpg'] as const,
  },
  'flux-2-pro': {
    id: 'flux-2-pro' as const,
    displayName: 'FLUX.2 Pro',
    description: 'Photoreal product work with strong multi-reference consistency',
    badge: 'Studio',
    badgeColor: 'from-sky-500 to-cyan-500',
    accentColor: 'blue',
    maxImages: 8,
    supportsGoogleSearch: false,
    supportsOutputFormat: false,
    aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3'] as const,
    resolutions: ['1K', '2K'] as const,
    outputFormats: ['jpg'] as const,
  },
  'z-image': {
    id: 'z-image' as const,
    displayName: 'Z-Image',
    description: 'Low-cost photoreal generation for drafts and rapid exploration',
    badge: 'Economy',
    badgeColor: 'from-emerald-500 to-cyan-500',
    accentColor: 'blue',
    maxImages: 0,
    supportsGoogleSearch: false,
    supportsOutputFormat: false,
    aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16'] as const,
    resolutions: ['1K'] as const,
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
export type ImageResolution = '1K' | '2K' | '3K' | '4K';
export type ImageOutputFormat = 'jpg' | 'png';
export type ImageQualityMode = 'standard' | 'turbo' | 'balanced' | 'quality';

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
  return !['grok-imagine-image', 'ideogram-v3', 'imagen-4-fast', 'imagen-4', 'imagen-4-ultra'].includes(modelId);
}

export function getImageQualityModes(modelId: ImageModelId): readonly ImageQualityMode[] {
  if (modelId === 'ideogram-v3') return ['turbo', 'balanced', 'quality'];
  if (modelId === 'grok-imagine-image') return ['standard', 'quality'];
  return [];
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
  'kling-3.0-turbo': {
    id: 'kling-3.0-turbo' as const,
    displayName: 'Kling 3 Turbo',
    description: 'Fast Kling generation for text or a single animated start frame',
    supportsMultiShot: false,
    supportsSound: false,
    supportsFixedLens: false,
    aspectRatios: ['16:9', '9:16', '1:1'] as const,
    durations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const,
    singleShotDurationRange: { min: 3, max: 15, default: 5 } as const,
    resolutions: ['720p', '1080p'] as const,
    modeOptions: [] as const,
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
    description: 'ByteDance video model with multimodal references, generated audio, and output up to 4K',
    supportsMultiShot: false,
    supportsSound: true,
    supportsFixedLens: false,
    aspectRatios: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'] as const,
    durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const,
    singleShotDurationRange: { min: 4, max: 15, default: 15 } as const,
    modeOptions: [] as const,
    resolutions: ['480p', '720p', '1080p', '4k'] as const,
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
  'seedance-2-mini': {
    id: 'seedance-2-mini' as const,
    displayName: 'Seedance 2 Mini',
    description: 'Lower-cost Seedance 2 generation with multimodal references and generated audio',
    supportsMultiShot: false,
    supportsSound: true,
    supportsFixedLens: false,
    aspectRatios: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'] as const,
    durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const,
    singleShotDurationRange: { min: 4, max: 15, default: 10 } as const,
    modeOptions: [] as const,
    resolutions: ['480p', '720p'] as const,
  },
  'wan-2.7': {
    id: 'wan-2.7' as const,
    displayName: 'Wan 2.7',
    description: 'Flexible text, frame, and multimodal reference-to-video generation',
    supportsMultiShot: false,
    supportsSound: false,
    supportsFixedLens: false,
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'] as const,
    durations: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const,
    singleShotDurationRange: { min: 2, max: 15, default: 5 } as const,
    resolutions: ['720p', '1080p'] as const,
    modeOptions: [] as const,
  },
  'happyhorse-1.1': {
    id: 'happyhorse-1.1' as const, displayName: 'HappyHorse 1.1',
    description: 'Flexible text, image, and multi-reference video generation up to 1080p',
    supportsMultiShot: false, supportsSound: false, supportsFixedLens: false,
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '4:5', '5:4', '21:9', '9:21'] as const,
    durations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const,
    singleShotDurationRange: { min: 3, max: 15, default: 5 } as const,
    resolutions: ['720p', '1080p'] as const, modeOptions: [] as const,
  },
  'gemini-omni-video': {
    id: 'gemini-omni-video' as const, displayName: 'Gemini Omni Video',
    description: 'Google multimodal video creation from text, images, or one reference clip',
    supportsMultiShot: false, supportsSound: false, supportsFixedLens: false,
    aspectRatios: ['16:9', '9:16'] as const, durations: [4, 6, 8, 10] as const,
    resolutions: ['720p', '1080p', '4k'] as const, modeOptions: [] as const,
  },
  'hailuo-2.3': {
    id: 'hailuo-2.3' as const,
    displayName: 'Hailuo 2.3',
    description: 'Image-to-video generation with standard and high-fidelity Pro modes',
    supportsMultiShot: false,
    supportsSound: false,
    supportsFixedLens: false,
    aspectRatios: ['Auto'] as const,
    durations: [6, 10] as const,
    resolutions: ['768P', '1080P'] as const,
    modeOptions: [
      { value: 'standard', label: 'Standard' },
      { value: 'pro', label: 'Pro' },
    ] as const,
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
    resolutions: ['720p', '1080p', '4k'] as const,
    modeOptions: [
      { value: 'veo3_lite', label: 'Lite' },
      { value: 'veo3_fast', label: 'Fast' },
      { value: 'veo3', label: 'Quality' },
    ] as const,
  },
  'grok-imagine-video': {
    id: 'grok-imagine-video' as const,
    displayName: 'Grok Imagine Video',
    description: 'xAI video generation with normal and fun modes',
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
    ] as const,
  },
} as const;

export type VideoModelId = keyof typeof VIDEO_MODELS;

export function getVideoElementSupport(
  modelId: VideoModelId,
  options: { mode?: string; isMultiShot?: boolean } = {}
): { enabled: boolean; maxElements: number; reason: string | null } {
  if (options.isMultiShot) return { enabled: false, maxElements: 0, reason: 'Reusable references are available in single-shot only.' };
  if (modelId === 'seedance-1.5-pro') return { enabled: true, maxElements: 2, reason: null };
  if (modelId === 'seedance-2' || modelId === 'seedance-2-fast' || modelId === 'seedance-2-mini' || modelId === 'wan-2.7') return { enabled: true, maxElements: 5, reason: null };
  if (modelId === 'happyhorse-1.1') return { enabled: true, maxElements: 9, reason: null };
  if (modelId === 'gemini-omni-video') return { enabled: true, maxElements: 7, reason: null };
  if (modelId === 'veo-3.1') {
    return options.mode === 'veo3_fast' || options.mode === 'veo3_lite'
      ? { enabled: true, maxElements: 3, reason: null }
      : { enabled: false, maxElements: 0, reason: 'Reusable references require Veo Lite or Fast.' };
  }
  if (modelId === 'grok-imagine-video') return { enabled: true, maxElements: 1, reason: null };
  if (modelId === 'kling-3.0-video') return { enabled: false, maxElements: 0, reason: 'Reusable image references are not available for Kling yet.' };
  return { enabled: false, maxElements: 0, reason: 'Reusable references are not available for this model yet.' };
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
