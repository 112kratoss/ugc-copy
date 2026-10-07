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
    description: 'Latest model — enhanced fidelity and motion accuracy',
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
    description: 'Versatile image gen with Google Search grounding',
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
    description: 'High-fidelity generation with multi-image reference',
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
    description: 'Affordable text generation and editing with up to nine references', badge: 'Value',
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
    qualityModes: ['turbo', 'balanced', 'quality'] as const,
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
    qualityModes: ['standard', 'quality'] as const,
  },
  'grok-imagine-image-2': {
    id: 'grok-imagine-image-2' as const,
    displayName: 'Grok Imagine 2.0',
    description: 'Newer xAI generation with sharper prompt adherence',
    badge: 'New',
    badgeColor: 'from-amber-500 to-orange-500',
    accentColor: 'amber',
    maxImages: 0,
    supportsGoogleSearch: false,
    supportsOutputFormat: false,
    aspectRatios: ['1:1', '2:3', '3:2', '16:9', '9:16'] as const,
    resolutions: ['1K'] as const,
    outputFormats: ['jpg'] as const,
  },
  'qwen3': {
    id: 'qwen3' as const,
    displayName: 'Qwen Image 3.0',
    description: 'Low-cost generation and editing at a flat 1K/2K rate',
    badge: 'Value',
    badgeColor: 'from-emerald-500 to-teal-500',
    accentColor: 'blue',
    maxImages: 3,
    supportsGoogleSearch: false,
    supportsOutputFormat: true,
    aspectRatios: ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9'] as const,
    resolutions: ['1K', '2K'] as const,
    outputFormats: ['jpg', 'png'] as const,
  },
  'qwen3-pro': {
    id: 'qwen3-pro' as const,
    displayName: 'Qwen Image 3.0 Pro',
    description: 'Higher-fidelity Qwen tier with 2K output',
    badge: 'Pro',
    badgeColor: 'from-teal-500 to-cyan-500',
    accentColor: 'blue',
    maxImages: 3,
    supportsGoogleSearch: false,
    supportsOutputFormat: true,
    aspectRatios: ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9'] as const,
    resolutions: ['1K', '2K'] as const,
    outputFormats: ['jpg', 'png'] as const,
  },
  'ideogram-character': {
    id: 'ideogram-character' as const,
    displayName: 'Ideogram Character',
    description: 'Keeps one character consistent across every shot',
    badge: 'Character',
    badgeColor: 'from-fuchsia-500 to-violet-500',
    accentColor: 'amber',
    maxImages: 1,
    supportsGoogleSearch: false,
    supportsOutputFormat: false,
    aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16'] as const,
    resolutions: ['1K'] as const,
    outputFormats: ['jpg'] as const,
    qualityModes: ['turbo', 'balanced', 'quality'] as const,
    requiresReference: true,
  },
  'gpt-image-2.5-flare': {
    id: 'gpt-image-2.5-flare' as const,
    displayName: 'GPT Image 2.5 Flare',
    description: 'Fast GPT Image 2.5 tier for high-volume generation and edits',
    badge: 'New',
    badgeColor: 'from-amber-500 to-orange-500',
    accentColor: 'amber',
    maxImages: 16,
    supportsGoogleSearch: false,
    supportsOutputFormat: false,
    aspectRatios: ['auto', '1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9', '27:16', '16:27', '9:8', '8:9'] as const,
    resolutions: ['1K', '2K', '4K'] as const,
    outputFormats: ['jpg'] as const,
  },
  'gpt-image-2.5-sunburst': {
    id: 'gpt-image-2.5-sunburst' as const,
    displayName: 'GPT Image 2.5 Sunburst',
    description: 'Premium GPT Image 2.5 tier for polished, campaign-ready images and edits',
    badge: 'Pro',
    badgeColor: 'from-orange-500 to-rose-500',
    accentColor: 'amber',
    maxImages: 16,
    supportsGoogleSearch: false,
    supportsOutputFormat: false,
    aspectRatios: ['auto', '1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9', '27:16', '16:27', '9:8', '8:9'] as const,
    resolutions: ['1K', '2K', '4K'] as const,
    outputFormats: ['jpg'] as const,
  },
  'seedream-5-flash': {
    id: 'seedream-5-flash' as const,
    displayName: 'Seedream 5 Flash',
    description: 'Fastest Seedream tier: generation and multi-image editing at one flat price',
    badge: 'Value',
    badgeColor: 'from-cyan-500 to-sky-500',
    accentColor: 'blue',
    maxImages: 10,
    supportsGoogleSearch: false,
    supportsOutputFormat: true,
    aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16', '2:3', '3:2', '21:9'] as const,
    resolutions: ['1K', '2K'] as const,
    outputFormats: ['jpg', 'png'] as const,
  },
  'qwen-image-2.1': {
    id: 'qwen-image-2.1' as const,
    displayName: 'Qwen Image 2.1',
    description: 'Low-cost Qwen generation and editing with 2K output',
    badge: 'Value',
    badgeColor: 'from-emerald-500 to-teal-500',
    accentColor: 'blue',
    maxImages: 10,
    supportsGoogleSearch: false,
    supportsOutputFormat: true,
    aspectRatios: ['1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16', '21:9', '9:21'] as const,
    resolutions: ['1K', '2K'] as const,
    outputFormats: ['jpg', 'png'] as const,
  },
} as const;

export type ImageModelId = keyof typeof IMAGE_MODELS;
export type ImageResolution = '1K' | '2K' | '3K' | '4K';
export type ImageOutputFormat = 'jpg' | 'png';
export type ImageQualityMode = 'standard' | 'turbo' | 'balanced' | 'quality';

const GPT_IMAGE_2_AUTO_RESOLUTIONS = ['1K'] as const satisfies readonly ImageResolution[];
const GPT_IMAGE_2_SQUARE_RESOLUTIONS = ['1K', '2K'] as const satisfies readonly ImageResolution[];
// Mirrors @/lib/models: Kie renders 5:4 and 4:5 at 1K only.
const GPT_IMAGE_2_ONE_K_ONLY_ASPECT_RATIOS: readonly string[] = ['auto', '5:4', '4:5'];

const GPT_IMAGE_2_5_MODEL_IDS: readonly string[] = ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'];
const GPT_IMAGE_2_5_ONE_K_RESOLUTIONS = ['1K'] as const satisfies readonly ImageResolution[];
const GPT_IMAGE_2_5_SQUARE_RESOLUTIONS = ['1K', '2K'] as const satisfies readonly ImageResolution[];
const GPT_IMAGE_2_5_ONE_K_ONLY_ASPECT_RATIOS: readonly string[] = ['auto', '27:16', '16:27', '9:8', '8:9'];

// Mirrors getGptImage25ResolutionOptions in @/lib/models (which explains the caps);
// model-registry-parity pins the two copies to identical output.
function getGptImage25ResolutionOptions(aspectRatio: string): readonly ImageResolution[] {
  if (GPT_IMAGE_2_5_ONE_K_ONLY_ASPECT_RATIOS.includes(aspectRatio)) return GPT_IMAGE_2_5_ONE_K_RESOLUTIONS;
  if (aspectRatio === '1:1') return GPT_IMAGE_2_5_SQUARE_RESOLUTIONS;
  return IMAGE_MODELS['gpt-image-2.5-flare'].resolutions;
}

export function getImageResolutionOptions(
  modelId: ImageModelId,
  aspectRatio?: string
): readonly ImageResolution[] {
  if (!IMAGE_MODELS[modelId]) return [];
  const selectedAspectRatio = aspectRatio ?? IMAGE_MODELS[modelId].aspectRatios[0];
  if (modelId === 'grok-imagine-image') return IMAGE_MODELS[modelId].resolutions;
  if (GPT_IMAGE_2_5_MODEL_IDS.includes(modelId)) return getGptImage25ResolutionOptions(selectedAspectRatio);
  if (modelId !== 'gpt-image-2') return IMAGE_MODELS[modelId].resolutions;
  if (GPT_IMAGE_2_ONE_K_ONLY_ASPECT_RATIOS.includes(selectedAspectRatio)) return GPT_IMAGE_2_AUTO_RESOLUTIONS;
  if (selectedAspectRatio === '1:1') return GPT_IMAGE_2_SQUARE_RESOLUTIONS;
  return IMAGE_MODELS[modelId].resolutions;
}

export function supportsImageResolutionControl(modelId: ImageModelId): boolean {
  return !['grok-imagine-image', 'ideogram-v3', 'imagen-4-fast', 'imagen-4', 'imagen-4-ultra'].includes(modelId);
}

export function getImageQualityModes(modelId: ImageModelId): readonly ImageQualityMode[] {
  // Mirrors the server implementation: driven by the entry's declared modes so
  // the two copies cannot disagree about which models expose a quality picker.
  const model = IMAGE_MODELS[modelId];
  return model && 'qualityModes' in model ? model.qualityModes as readonly ImageQualityMode[] : [];
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
  'seedance-2-5': {
    id: 'seedance-2-5' as const,
    displayName: 'Seedance 2.5',
    description: 'Latest ByteDance model with 30-second output and audio references',
    supportsMultiShot: false,
    supportsSound: true,
    supportsFixedLens: false,
    aspectRatios: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'] as const,
    durations: [4, 5, 6, 8, 10, 12, 15, 20, 25, 30] as const,
    singleShotDurationRange: { min: 4, max: 30, default: 5 } as const,
    resolutions: ['480p', '720p', '1080p'] as const,
    modeOptions: [] as const,
  },
  'kling-o3': {
    id: 'kling-o3' as const,
    displayName: 'Kling O3',
    description: 'Multi-shot Kling with named subjects and 4K output',
    supportsMultiShot: true,
    supportsSound: true,
    supportsFixedLens: false,
    aspectRatios: ['16:9', '9:16', '1:1'] as const,
    durations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const,
    singleShotDurationRange: { min: 3, max: 15, default: 5 } as const,
    resolutions: ['720p', '1080p', '4k'] as const,
    modeOptions: [] as const,
  },
  'minimax-h3': {
    id: 'minimax-h3' as const,
    displayName: 'MiniMax H3',
    description: 'Hailuo H3 generation from text, a frame, or references',
    supportsMultiShot: false,
    supportsSound: false,
    supportsFixedLens: false,
    aspectRatios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'] as const,
    durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const,
    singleShotDurationRange: { min: 4, max: 15, default: 6 } as const,
    resolutions: ['768P', '2K'] as const,
    modeOptions: [] as const,
  },
  'gemini-omni-1.1-flash': {
    id: 'gemini-omni-1.1-flash' as const,
    displayName: 'Gemini Omni 1.1 Flash',
    description: 'Faster Gemini Omni with start and end frames, references, and 360p to 4K output',
    supportsMultiShot: false,
    supportsSound: false,
    supportsFixedLens: false,
    aspectRatios: ['16:9', '9:16'] as const,
    durations: [4, 6, 8, 10] as const,
    resolutions: ['360p', '720p', '1080p', '4k'] as const,
    modeOptions: [] as const,
  },
  'wan-3.0': {
    id: 'wan-3.0' as const,
    displayName: 'Wan 3.0',
    description: 'Wan 3.0 with frames, up to ten references, generated audio, and clips up to 30 seconds',
    supportsMultiShot: false,
    supportsSound: true,
    supportsFixedLens: false,
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'] as const,
    durations: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30] as const,
    singleShotDurationRange: { min: 2, max: 30, default: 5 } as const,
    resolutions: ['480P', '720P', '1080P'] as const,
    modeOptions: [] as const,
  },
  'wan-3.0-prime': {
    id: 'wan-3.0-prime' as const,
    displayName: 'Wan 3.0 Prime',
    description: 'High-speed Wan 3.0 tier with the same frames, references, audio, and 30-second clips',
    supportsMultiShot: false,
    supportsSound: true,
    supportsFixedLens: false,
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'] as const,
    durations: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30] as const,
    singleShotDurationRange: { min: 2, max: 30, default: 5 } as const,
    resolutions: ['480P', '720P', '1080P'] as const,
    modeOptions: [] as const,
  },
  'grok-imagine-video-1.5': {
    id: 'grok-imagine-video-1.5' as const,
    displayName: 'Grok Imagine Video 1.5',
    description: 'xAI preview tier with up to seven reference images and 1 to 15 second clips',
    supportsMultiShot: false,
    supportsSound: false,
    supportsFixedLens: false,
    aspectRatios: ['16:9', '9:16', '1:1', '3:2', '2:3'] as const,
    durations: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const,
    singleShotDurationRange: { min: 1, max: 15, default: 8 } as const,
    resolutions: ['480p', '720p'] as const,
    modeOptions: [] as const,
  },
  'pixverse-v6': {
    id: 'pixverse-v6' as const,
    displayName: 'PixVerse V6',
    description: 'PixVerse video from text, a start frame, a frame pair, or named references, with optional audio',
    supportsMultiShot: false,
    supportsSound: true,
    supportsFixedLens: false,
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '21:9'] as const,
    durations: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const,
    singleShotDurationRange: { min: 1, max: 15, default: 5 } as const,
    resolutions: ['360p', '540p', '720p', '1080p'] as const,
    modeOptions: [] as const,
  },
} as const;

export type VideoModelId = keyof typeof VIDEO_MODELS;

/**
 * Mirrors the server implementation in @/lib/models. This is the fallback used before
 * the catalog descriptor is available; descriptor-derived affordances are authoritative
 * once it loads. Keep the two in step — the registry parity suite compares behaviour.
 */
export function getVideoElementSupport(
  modelId: VideoModelId,
  options: { mode?: string; isMultiShot?: boolean } = {}
): { enabled: boolean; maxElements: number; maxNamed: number; reason: string | null } {
  // Kling O3 carries named subjects across a multi-shot run; every other model loses
  // reference support in multi-shot.
  if (options.isMultiShot && modelId !== 'kling-o3') {
    return { enabled: false, maxElements: 0, maxNamed: 0, reason: 'Reusable references are available in single-shot only.' };
  }
  if (modelId === 'seedance-1.5-pro') return { enabled: true, maxElements: 2, maxNamed: 2, reason: null };
  if (modelId === 'seedance-2' || modelId === 'seedance-2-fast' || modelId === 'seedance-2-mini' || modelId === 'wan-2.7') return { enabled: true, maxElements: 5, maxNamed: 5, reason: null };
  // 2.5 takes 30 reference images where the rest of the family stops at 5.
  if (modelId === 'seedance-2-5') return { enabled: true, maxElements: 30, maxNamed: 30, reason: null };
  // 7 reference images, at most 3 of them named as provider-resolved subjects.
  if (modelId === 'kling-o3') return { enabled: true, maxElements: 7, maxNamed: 3, reason: null };
  if (modelId === 'minimax-h3') return { enabled: true, maxElements: 9, maxNamed: 9, reason: null };
  if (modelId === 'happyhorse-1.1') return { enabled: true, maxElements: 9, maxNamed: 9, reason: null };
  if (modelId === 'gemini-omni-video') return { enabled: true, maxElements: 7, maxNamed: 7, reason: null };
  if (modelId === 'veo-3.1') {
    return options.mode === 'veo3_fast' || options.mode === 'veo3_lite'
      ? { enabled: true, maxElements: 3, maxNamed: 3, reason: null }
      : { enabled: false, maxElements: 0, maxNamed: 0, reason: 'Reusable references require Veo Lite or Fast.' };
  }
  if (modelId === 'grok-imagine-video') return { enabled: true, maxElements: 1, maxNamed: 1, reason: null };
  // 7 image_urls (Gemini Omni 1.1 Flash, Grok 1.5 Preview) and 7 image_references (PixVerse V6).
  if (modelId === 'gemini-omni-1.1-flash' || modelId === 'grok-imagine-video-1.5' || modelId === 'pixverse-v6') {
    return { enabled: true, maxElements: 7, maxNamed: 7, reason: null };
  }
  // Wan 3.0's reference_image_urls takes 10 where Wan 2.7's reference mode stops at 5.
  if (modelId === 'wan-3.0' || modelId === 'wan-3.0-prime') return { enabled: true, maxElements: 10, maxNamed: 10, reason: null };
  if (modelId === 'kling-3.0-video') return { enabled: false, maxElements: 0, maxNamed: 0, reason: 'Reusable image references are not available for Kling yet.' };
  return { enabled: false, maxElements: 0, maxNamed: 0, reason: 'Reusable references are not available for this model yet.' };
}

/**
 * Reference clip/track capacity per video model, mirroring VIDEO_INPUT_LIMITS on the
 * server. This is the pre-catalog fallback: once a descriptor is available its
 * `inputs.videoReferences` / `inputs.audioReferences` are authoritative.
 *
 * It exists because the workflow canvas used to hardcode "Seedance and Kling only",
 * which silently contradicted the descriptors — and the create-video surface — for
 * wan-2.7 (5 clips + 1 track), gemini-omni-video (1 clip) and minimax-h3 (1 + 1).
 */
export function getVideoReferenceSupport(modelId: VideoModelId): { videos: number; audios: number } {
  switch (modelId) {
    case 'seedance-2':
    case 'seedance-2-fast':
    case 'seedance-2-mini':
      return { videos: 3, audios: 3 };
    // 2.5's arrays are far wider than the rest of the family's, though the 30s combined
    // ceiling on reference videos is unchanged.
    case 'seedance-2-5':
      return { videos: 10, audios: 10 };
    case 'wan-2.7':
      return { videos: 5, audios: 1 };
    case 'minimax-h3':
      return { videos: 3, audios: 3 };
    case 'gemini-omni-video':
    case 'gemini-omni-1.1-flash':
      return { videos: 1, audios: 0 };
    // wan/3-0-video: 5 reference clips and 5 audio files, 15 s each kind in total.
    case 'wan-3.0':
    case 'wan-3.0-prime':
      return { videos: 5, audios: 5 };
    // Kling's slot carries named video elements rather than plain reference clips, but
    // the canvas routes both through the reference-video handle.
    case 'kling-3.0-video':
      return { videos: 3, audios: 0 };
    default:
      return { videos: 0, audios: 0 };
  }
}

export function getVideoDurationRange(modelId: VideoModelId): { min: number; max: number; default: number } | null {
  const model = VIDEO_MODELS[modelId];
  return model && 'singleShotDurationRange' in model ? model.singleShotDurationRange : null;
}

export function getDefaultVideoDuration(modelId: VideoModelId): number {
  return getVideoDurationRange(modelId)?.default ?? (VIDEO_MODELS[modelId]?.durations[0] ?? 5);
}

export function isValidVideoDuration(modelId: VideoModelId, durationSeconds: number): boolean {
  const range = getVideoDurationRange(modelId);
  if (range) return durationSeconds >= range.min && durationSeconds <= range.max;
  return ((VIDEO_MODELS[modelId]?.durations ?? []) as readonly number[]).includes(durationSeconds);
}

export function clampVideoDuration(modelId: VideoModelId, durationSeconds: number): number {
  const range = getVideoDurationRange(modelId);
  if (range) return Math.min(range.max, Math.max(range.min, durationSeconds));
  return isValidVideoDuration(modelId, durationSeconds)
    ? durationSeconds
    : (VIDEO_MODELS[modelId]?.durations[0] ?? 5);
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

/**
 * Video models whose provider generates an audio track unconditionally — there
 * is no sound toggle to offer, but the UI should say audio is coming and the
 * prompt enhancer scripts the soundscape (or "no music") for them.
 */
export const ALWAYS_ON_AUDIO_VIDEO_MODELS: ReadonlySet<string> = new Set([
  'wan-2.7',
  'grok-imagine-video',
  'minimax-h3',
  'happyhorse-1.1',
]);
