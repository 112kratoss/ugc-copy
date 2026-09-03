import type {
  CreatorToolId,
  GenerationElementDescriptor,
  ImageGenerationRequest,
  MotionGenerationRequest,
  PromptEnhancementRequest,
  PromptEnhancementWarning,
  RemixMediaAssetDescriptor,
  RemixResolvedAsset,
  RemixResolvedImageElement,
  RemixSourceBundle,
  VideoGenerationRequest,
  VideoMultiPromptInput,
} from './types';

export const IMAGE_MODELS = {
  'nano-banana-2-lite': {
    id: 'nano-banana-2-lite',
    displayName: 'Nano Banana 2 Lite',
    description: 'Fast 1K generation and edits for high-volume creative iteration.',
    badge: 'Fast',
    maxImages: 10,
    supportsGoogleSearch: false,
    supportsOutputFormat: false,
    aspectRatios: ['auto', '1:1', '1:4', '1:8', '2:3', '3:2', '3:4', '4:1', '4:3', '4:5', '5:4', '8:1', '9:16', '16:9', '21:9'],
    resolutions: ['1K'],
    outputFormats: ['jpg'],
  },
  'nano-banana-2': {
    id: 'nano-banana-2',
    displayName: 'Nano Banana 2.0',
    description: 'Versatile image generation with Google Search grounding.',
    badge: 'Recommended',
    maxImages: 14,
    supportsGoogleSearch: true,
    supportsOutputFormat: true,
    aspectRatios: ['auto', '1:1', '1:4', '1:8', '2:3', '3:2', '3:4', '4:1', '4:3', '4:5', '5:4', '8:1', '9:16', '16:9', '21:9'],
    resolutions: ['1K', '2K', '4K'],
    outputFormats: ['jpg', 'png'],
  },
  'nano-banana-pro': {
    id: 'nano-banana-pro',
    displayName: 'Nano Banana Pro',
    description: 'High-fidelity generation with multi-image references.',
    badge: 'Pro',
    maxImages: 8,
    supportsGoogleSearch: false,
    supportsOutputFormat: true,
    aspectRatios: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9', 'auto'],
    resolutions: ['1K', '2K', '4K'],
    outputFormats: ['jpg', 'png'],
  },
  'gpt-image-2': {
    id: 'gpt-image-2',
    displayName: 'GPT Image 2',
    description: 'ChatGPT image generation with fast high-quality edits.',
    badge: 'New',
    maxImages: 16,
    supportsGoogleSearch: false,
    supportsOutputFormat: false,
    aspectRatios: ['auto', '1:1', '5:4', '9:16', '21:9', '16:9', '4:3', '3:2', '4:5', '3:4', '2:3'],
    resolutions: ['1K', '2K', '4K'],
    outputFormats: ['jpg'],
  },
  'seedream-5-pro': {
    id: 'seedream-5-pro',
    displayName: 'Seedream 5 Pro',
    description: 'Production-ready portraits, products, typography, and precise edits.',
    badge: 'Creator',
    maxImages: 10,
    supportsGoogleSearch: false,
    supportsOutputFormat: true,
    aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16', '2:3', '3:2', '21:9'],
    resolutions: ['1K', '2K'],
    outputFormats: ['jpg', 'png'],
  },
  'seedream-5-lite': { id: 'seedream-5-lite', displayName: 'Seedream 5 Lite', description: 'Fast, low-cost generation and editing up to 3K.', badge: 'Value', maxImages: 14, supportsGoogleSearch: false, supportsOutputFormat: true, aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16', '2:3', '3:2', '21:9'], resolutions: ['2K', '3K'], outputFormats: ['jpg', 'png'] },
  'wan-2.7-image': { id: 'wan-2.7-image', displayName: 'Wan 2.7 Image', description: 'Affordable generation and editing with up to nine references.', badge: 'Value', maxImages: 9, supportsGoogleSearch: false, supportsOutputFormat: false, aspectRatios: ['auto'], resolutions: ['1K', '2K'], outputFormats: ['jpg'] },
  'wan-2.7-image-pro': { id: 'wan-2.7-image-pro', displayName: 'Wan 2.7 Image Pro', description: 'High-fidelity Wan generation and editing with optional 4K output.', badge: 'Pro', maxImages: 9, supportsGoogleSearch: false, supportsOutputFormat: false, aspectRatios: ['auto'], resolutions: ['1K', '2K', '4K'], outputFormats: ['jpg'] },
  'imagen-4-fast': { id: 'imagen-4-fast', displayName: 'Imagen 4 Fast', description: 'Fast Google image generation.', badge: 'Fast', maxImages: 0, supportsGoogleSearch: false, supportsOutputFormat: false, aspectRatios: ['auto', '1:1', '16:9', '9:16', '3:4', '4:3'], resolutions: ['1K'], outputFormats: ['jpg'] },
  'imagen-4': { id: 'imagen-4', displayName: 'Imagen 4', description: 'Balanced Google image generation.', badge: 'Quality', maxImages: 0, supportsGoogleSearch: false, supportsOutputFormat: false, aspectRatios: ['auto', '1:1', '16:9', '9:16', '3:4', '4:3'], resolutions: ['1K'], outputFormats: ['jpg'] },
  'imagen-4-ultra': { id: 'imagen-4-ultra', displayName: 'Imagen 4 Ultra', description: 'Highest-quality Imagen 4 output.', badge: 'Ultra', maxImages: 0, supportsGoogleSearch: false, supportsOutputFormat: false, aspectRatios: ['auto', '1:1', '16:9', '9:16', '3:4', '4:3'], resolutions: ['1K'], outputFormats: ['jpg'] },
  'ideogram-v3': { id: 'ideogram-v3', displayName: 'Ideogram V3', description: 'Typography, logos, posters, and image remixing.', badge: 'Design', maxImages: 1, supportsGoogleSearch: false, supportsOutputFormat: false, aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16'], resolutions: ['1K'], outputFormats: ['jpg'] },
  'flux-2-pro': {
    id: 'flux-2-pro',
    displayName: 'FLUX.2 Pro',
    description: 'Photoreal product work with strong multi-reference consistency.',
    badge: 'Studio',
    maxImages: 8,
    supportsGoogleSearch: false,
    supportsOutputFormat: false,
    aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3'],
    resolutions: ['1K', '2K'],
    outputFormats: ['jpg'],
  },
  'z-image': {
    id: 'z-image',
    displayName: 'Z-Image',
    description: 'Low-cost photoreal generation for drafts and rapid exploration.',
    badge: 'Economy',
    maxImages: 0,
    supportsGoogleSearch: false,
    supportsOutputFormat: false,
    aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16'],
    resolutions: ['1K'],
    outputFormats: ['jpg'],
  },
  'grok-imagine-image': {
    id: 'grok-imagine-image',
    displayName: 'Grok Imagine',
    description: 'xAI image generation and edits with multi-output results.',
    badge: 'New',
    maxImages: 1,
    supportsGoogleSearch: false,
    supportsOutputFormat: false,
    aspectRatios: ['3:2', '2:3', '1:1', '9:16', '16:9'],
    resolutions: ['1K'],
    outputFormats: ['jpg'],
  },
} as const;

export const VIDEO_MODELS = {
  'kling-3.0-video': {
    id: 'kling-3.0-video',
    displayName: 'Kling 3.0 Cinematic',
    description: 'Single-shot and multi-shot cinematic generation.',
    supportsMultiShot: true,
    supportsSound: true,
    supportsFixedLens: false,
    aspectRatios: ['16:9', '9:16', '1:1'],
    durations: [5, 10],
    singleShotDurationRange: { min: 3, max: 15, default: 5 },
    resolutions: [],
    modeOptions: [
      { value: 'std', label: 'Standard (720p)' },
      { value: 'pro', label: 'Pro (1080p)' },
    ],
  },
  'kling-3.0-turbo': {
    id: 'kling-3.0-turbo',
    displayName: 'Kling 3 Turbo',
    description: 'Fast text-to-video or single-frame animation.',
    supportsMultiShot: false,
    supportsSound: false,
    supportsFixedLens: false,
    aspectRatios: ['16:9', '9:16', '1:1'],
    durations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    singleShotDurationRange: { min: 3, max: 15, default: 5 },
    resolutions: ['720p', '1080p'],
    modeOptions: [],
  },
  'seedance-1.5-pro': {
    id: 'seedance-1.5-pro',
    displayName: 'Seedance 1.5 Pro',
    description: 'Resolution, duration, image reference, and audio controls.',
    supportsMultiShot: false,
    supportsSound: true,
    supportsFixedLens: true,
    aspectRatios: ['1:1', '21:9', '4:3', '3:4', '16:9', '9:16'],
    durations: [4, 8, 12],
    resolutions: ['480p', '720p', '1080p'],
    modeOptions: [],
  },
  'seedance-2': {
    id: 'seedance-2',
    displayName: 'Seedance 2',
    description: 'Multimodal references, generated audio, and output up to 4K.',
    supportsMultiShot: false,
    supportsSound: true,
    supportsFixedLens: false,
    aspectRatios: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'],
    durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    singleShotDurationRange: { min: 4, max: 15, default: 15 },
    resolutions: ['480p', '720p', '1080p', '4k'],
    modeOptions: [],
  },
  'seedance-2-fast': {
    id: 'seedance-2-fast',
    displayName: 'Seedance 2 Fast',
    description: 'Faster Seedance with image, video, and audio references.',
    supportsMultiShot: false,
    supportsSound: true,
    supportsFixedLens: false,
    aspectRatios: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'],
    durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    singleShotDurationRange: { min: 4, max: 15, default: 15 },
    resolutions: ['480p', '720p'],
    modeOptions: [],
  },
  'seedance-2-mini': {
    id: 'seedance-2-mini',
    displayName: 'Seedance 2 Mini',
    description: 'Lower-cost Seedance with multimodal references and generated audio.',
    supportsMultiShot: false,
    supportsSound: true,
    supportsFixedLens: false,
    aspectRatios: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'],
    durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    singleShotDurationRange: { min: 4, max: 15, default: 10 },
    resolutions: ['480p', '720p'],
    modeOptions: [],
  },
  'wan-2.7': {
    id: 'wan-2.7',
    displayName: 'Wan 2.7',
    description: 'Text, frame, and multimodal reference-to-video generation.',
    supportsMultiShot: false,
    supportsSound: false,
    supportsFixedLens: false,
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    durations: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    singleShotDurationRange: { min: 2, max: 15, default: 5 },
    resolutions: ['720p', '1080p'],
    modeOptions: [],
  },
  'happyhorse-1.1': { id: 'happyhorse-1.1', displayName: 'HappyHorse 1.1', description: 'Text, image, and multi-reference video generation.', supportsMultiShot: false, supportsSound: false, supportsFixedLens: false, aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '4:5', '5:4', '21:9', '9:21'], durations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], singleShotDurationRange: { min: 3, max: 15, default: 5 }, resolutions: ['720p', '1080p'], modeOptions: [] },
  'gemini-omni-video': { id: 'gemini-omni-video', displayName: 'Gemini Omni Video', description: 'Video creation from text, images, or one reference clip.', supportsMultiShot: false, supportsSound: false, supportsFixedLens: false, aspectRatios: ['16:9', '9:16'], durations: [4, 6, 8, 10], resolutions: ['720p', '1080p', '4k'], modeOptions: [] },
  'hailuo-2.3': {
    id: 'hailuo-2.3',
    displayName: 'Hailuo 2.3',
    description: 'Image-to-video generation in Standard and Pro modes.',
    supportsMultiShot: false,
    supportsSound: false,
    supportsFixedLens: false,
    aspectRatios: ['Auto'],
    durations: [6, 10],
    resolutions: ['768P', '1080P'],
    modeOptions: [
      { value: 'standard', label: 'Standard' },
      { value: 'pro', label: 'Pro' },
    ],
  },
  'veo-3.1': {
    id: 'veo-3.1',
    displayName: 'Veo 3.1',
    description: 'Fast and quality Google-class video generation.',
    supportsMultiShot: false,
    supportsSound: false,
    supportsFixedLens: false,
    aspectRatios: ['16:9', '9:16', 'Auto'],
    durations: [8],
    resolutions: ['720p', '1080p', '4k'],
    modeOptions: [
      { value: 'veo3_lite', label: 'Lite' },
      { value: 'veo3_fast', label: 'Fast' },
      { value: 'veo3', label: 'Quality' },
    ],
  },
  'grok-imagine-video': {
    id: 'grok-imagine-video',
    displayName: 'Grok Imagine Video',
    description: 'xAI video generation with normal and fun modes.',
    supportsMultiShot: false,
    supportsSound: false,
    supportsFixedLens: false,
    aspectRatios: ['2:3', '3:2', '1:1', '9:16', '16:9'],
    durations: [6, 10, 15, 30],
    singleShotDurationRange: { min: 6, max: 30, default: 6 },
    resolutions: ['480p', '720p'],
    modeOptions: [
      { value: 'normal', label: 'Normal' },
      { value: 'fun', label: 'Fun' },
    ],
  },
} as const;

export const MOTION_MODELS = {
  'kling-2.6': {
    id: 'kling-2.6',
    displayName: 'Kling 2.6',
    description: 'Reliable motion transfer with smooth animation.',
    badge: 'Stable',
    maxDuration: 30,
    characterOrientations: ['video', 'image'],
    resolutions: ['720p', '1080p'],
  },
  'kling-3.0': {
    id: 'kling-3.0',
    displayName: 'Kling 3.0',
    description: 'Enhanced fidelity and motion accuracy.',
    badge: 'New',
    maxDuration: 30,
    characterOrientations: ['video', 'image'],
    resolutions: ['720p', '1080p'],
  },
} as const;

/**
 * Model ids are supplied by the published generation catalog. Keep the
 * bundled registries below only as a compatibility fallback for creation
 * surfaces that have not moved to catalog descriptors yet.
 */
export type ImageModelId = string;
export type VideoModelId = string;
export type MotionModelId = string;
export type ImageResolution = '1K' | '2K' | '3K' | '4K';
export type ImageOutputFormat = 'jpg' | 'png';
export type ImageQualityMode = 'standard' | 'turbo' | 'balanced' | 'quality';
export type MotionResolution = '720p' | '1080p';
export type ReferenceMode = 'frames' | 'elements';
export type MediaKind = 'image' | 'video' | 'audio';
export type CatalogDraftPrimitive = string | number | boolean;

export interface CatalogDraftInputAsset {
  id: string;
  kind: MediaKind | 'character' | 'prepared-voice';
  url?: string | null;
  storagePath?: string | null;
  fileName?: string | null;
  displayName?: string | null;
  handle?: string | null;
  durationSeconds?: number | null;
  sourceGenerationId?: string | null;
}

export type CatalogDraftInputSlots = Record<string, CatalogDraftInputAsset[]>;

export interface CatalogBackedDraftFields {
  catalogRevision?: string | null;
  catalogSettings?: Record<string, CatalogDraftPrimitive>;
  catalogInputSlots?: CatalogDraftInputSlots;
}

export interface UploadedMediaInput {
  signedUrl: string;
  storagePath: string;
  mimeType: string;
  fileName: string;
  kind?: MediaKind;
  durationSeconds?: number | null;
  sizeBytes?: number | null;
}

export interface MediaDraft {
  id: string;
  kind: MediaKind;
  url: string;
  storagePath?: string | null;
  mimeType?: string | null;
  fileName: string;
  displayName: string;
  handle?: string;
  durationSeconds?: number | null;
  sizeBytes?: number | null;
  sourceGenerationId?: string | null;
}

export interface ImageCreationDraft extends CatalogBackedDraftFields {
  tool: 'image';
  model: ImageModelId;
  prompt: string;
  aspectRatio: string;
  resolution: ImageResolution;
  qualityMode: ImageQualityMode;
  outputFormat: ImageOutputFormat;
  googleSearch: boolean;
  references: MediaDraft[];
  sourceGenerationId?: string | null;
}

export interface VideoShotDraft {
  id: string;
  prompt: string;
  duration: number;
}

export interface VideoCreationDraft extends CatalogBackedDraftFields {
  tool: 'video';
  model: VideoModelId;
  prompt: string;
  isMultiShot: boolean;
  multiPrompts: VideoShotDraft[];
  references: MediaDraft[];
  referenceVideos: MediaDraft[];
  referenceAudios: MediaDraft[];
  preparedAudioIds: string[];
  characterIds: string[];
  startFrame: MediaDraft | null;
  endFrame: MediaDraft | null;
  mode: string;
  aspectRatio: string;
  sound: boolean;
  duration: number;
  resolution: string;
  fixedLens: boolean;
  referenceMode: ReferenceMode;
  sourceGenerationId?: string | null;
}

export interface MotionCreationDraft extends CatalogBackedDraftFields {
  tool: 'motion';
  model: MotionModelId;
  prompt: string;
  characterImage: MediaDraft | null;
  referenceVideo: MediaDraft | null;
  characterOrientation: 'video' | 'image';
  mode: MotionResolution;
  duration: number;
  sourceGenerationId?: string | null;
}

export type CreationDraft = ImageCreationDraft | VideoCreationDraft | MotionCreationDraft;

export interface CreationValidationResult {
  errors: string[];
  warnings: PromptEnhancementWarning[];
  cost: number;
  canGenerate: boolean;
}

export type CreationReadinessState = 'ready' | 'warning' | 'neutral';

export interface CreationReadinessItem {
  id: 'prompt' | 'media' | 'settings' | 'cost';
  label: string;
  body: string;
  state: CreationReadinessState;
}

export type CreationReadinessCostStatus = 'ready' | 'pending' | 'unavailable';

export interface CreationSectionSummary {
  essentials: string;
  references: string;
  advanced: string;
}

export type CreationSectionId = 'prompt' | 'essentials' | 'references' | 'advanced' | 'generate';

export interface VisibleGenerationCheckMessages {
  message: string | null;
  errors: string[];
  warnings: PromptEnhancementWarning[];
}

export const REMIX_RESTORE_WARNING_MESSAGE = 'Some source media could not be restored automatically, so you may need to re-add a few references.';

const HANDLE_PATTERN = /(^|[^\w])(@[a-z0-9_]+)(?=$|[^\w])/g;

function createDraftId(prefix: string, seed: string) {
  const normalized = seed.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return `${prefix}-${normalized || Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`;
}

function toHandleBase(value: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized.length > 0 ? normalized : 'element';
}

function normalizeDisplayName(value: string | undefined, fallback: string) {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

function buildElementHandle(displayName: string, usedHandles: Set<string>, fallbackIndex: number) {
  const base = toHandleBase(displayName);
  let handle = `@${base}`;
  if (!usedHandles.has(handle)) {
    usedHandles.add(handle);
    return handle;
  }

  let suffix = Math.max(2, fallbackIndex);
  while (usedHandles.has(`@${base}_${suffix}`)) {
    suffix += 1;
  }
  handle = `@${base}_${suffix}`;
  usedHandles.add(handle);
  return handle;
}

function normalizeExistingHandle(value: string | undefined, usedHandles: Set<string>) {
  const handle = value?.trim();
  if (!handle || !/^@[a-z0-9_]+$/.test(handle) || usedHandles.has(handle)) {
    return null;
  }
  usedHandles.add(handle);
  return handle;
}

export function extractPromptHandles(prompt: string): string[] {
  const handles = new Set<string>();
  prompt.replace(HANDLE_PATTERN, (_match, _prefix, handle: string) => {
    handles.add(handle);
    return _match;
  });
  return Array.from(handles);
}

function unknownPromptHandles(prompt: string, validHandles: string[]) {
  const valid = new Set(validHandles);
  return extractPromptHandles(prompt).filter((handle) => !valid.has(handle));
}

function formatList(values: readonly string[]) {
  return values.join(', ');
}

function asStringList(values: readonly unknown[]) {
  return values as readonly string[];
}

function asNumberList(values: readonly unknown[]) {
  return values as readonly number[];
}

function isImageModelId(value: string): value is ImageModelId {
  return value in IMAGE_MODELS;
}

function isVideoModelId(value: string): value is VideoModelId {
  return value in VIDEO_MODELS;
}

function isMotionModelId(value: string): value is MotionModelId {
  return value in MOTION_MODELS;
}

type BundledImageModel = (typeof IMAGE_MODELS)[keyof typeof IMAGE_MODELS];
type BundledVideoModel = (typeof VIDEO_MODELS)[keyof typeof VIDEO_MODELS];
type BundledMotionModel = (typeof MOTION_MODELS)[keyof typeof MOTION_MODELS];

function bundledImageModel(model: string): BundledImageModel {
  return IMAGE_MODELS[model as keyof typeof IMAGE_MODELS] ?? IMAGE_MODELS['nano-banana-2'];
}

function bundledVideoModel(model: string): BundledVideoModel {
  return VIDEO_MODELS[model as keyof typeof VIDEO_MODELS] ?? VIDEO_MODELS['kling-3.0-video'];
}

function bundledMotionModel(model: string): BundledMotionModel {
  return MOTION_MODELS[model as keyof typeof MOTION_MODELS] ?? MOTION_MODELS['kling-3.0'];
}

export function isSeedance2Family(model: VideoModelId) {
  return model === 'seedance-2' || model === 'seedance-2-fast' || model === 'seedance-2-mini';
}

export function supportsMultimodalVideoReferences(model: VideoModelId) {
  return isSeedance2Family(model) || model === 'wan-2.7' || model === 'gemini-omni-video';
}

export function defaultVideoMode(model: VideoModelId) {
  const modes = bundledVideoModel(model).modeOptions;
  return modes[0]?.value ?? (model === 'seedance-1.5-pro' ? 'standard' : 'std');
}

function getVideoDurationRange(model: VideoModelId) {
  const config = bundledVideoModel(model);
  return 'singleShotDurationRange' in config ? config.singleShotDurationRange : null;
}

export function getDefaultVideoDuration(model: VideoModelId) {
  return getVideoDurationRange(model)?.default ?? bundledVideoModel(model).durations[0];
}

export function isValidVideoDuration(model: VideoModelId, duration: number) {
  const range = getVideoDurationRange(model);
  if (range) {
    return duration >= range.min && duration <= range.max;
  }
  return asNumberList(bundledVideoModel(model).durations).includes(duration);
}

export function getImageResolutionOptions(model: ImageModelId, aspectRatio: string): readonly ImageResolution[] {
  if (model === 'grok-imagine-image') return ['1K'];
  if (model !== 'gpt-image-2') return bundledImageModel(model).resolutions;
  if (aspectRatio === 'auto') return ['1K'];
  if (aspectRatio === '1:1') return ['1K', '2K'];
  return bundledImageModel(model).resolutions;
}

function namedReferences(references: MediaDraft[]): MediaDraft[] {
  const used = new Set<string>();
  return references.map((reference, index) => {
    const displayName = normalizeDisplayName(reference.displayName, `Element ${index + 1}`);
    const existingHandle = normalizeExistingHandle(reference.handle, used);
    return {
      ...reference,
      displayName,
      handle: existingHandle ?? buildElementHandle(displayName, used, index + 1),
    };
  });
}

function preparedVideoAudioIds(draft: VideoCreationDraft): string[] {
  return Array.isArray(draft.preparedAudioIds) ? draft.preparedAudioIds : [];
}

function preparedVideoCharacterIds(draft: VideoCreationDraft): string[] {
  return Array.isArray(draft.characterIds) ? draft.characterIds : [];
}

function mediaAssetDescriptor(media: MediaDraft | null): RemixMediaAssetDescriptor | null {
  if (!media) return null;
  return {
    url: media.url,
    kind: media.kind,
    label: media.displayName,
    storagePath: media.storagePath ?? null,
    sourceGenerationId: media.sourceGenerationId ?? null,
    mediaType: media.kind,
    fileName: media.fileName,
  };
}

function elementDescriptors(references: MediaDraft[]): GenerationElementDescriptor[] {
  return namedReferences(references).map((reference) => ({
    id: reference.id,
    displayName: reference.displayName,
    handle: reference.handle ?? buildElementHandle(reference.displayName, new Set(), 1),
    storagePath: reference.storagePath ?? null,
    sourceGenerationId: reference.sourceGenerationId ?? null,
  }));
}

export function createMediaDraftFromUpload(
  upload: UploadedMediaInput,
  options: {
    displayName?: string;
    kind?: MediaKind;
    sourceGenerationId?: string | null;
  } = {}
): MediaDraft {
  const kind = options.kind ?? upload.kind ?? (upload.mimeType.startsWith('video/') ? 'video' : upload.mimeType.startsWith('audio/') ? 'audio' : 'image');
  const displayName = normalizeDisplayName(
    options.displayName,
    upload.fileName.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ') || `${kind} reference`
  );

  return {
    id: createDraftId(kind, upload.storagePath || upload.fileName),
    kind,
    url: upload.signedUrl,
    storagePath: upload.storagePath,
    mimeType: upload.mimeType,
    fileName: upload.fileName,
    displayName,
    handle: kind === 'image' ? `@${toHandleBase(displayName)}` : undefined,
    durationSeconds: upload.durationSeconds ?? null,
    sizeBytes: upload.sizeBytes ?? null,
    sourceGenerationId: options.sourceGenerationId ?? null,
  };
}

function stringSetting(settings: Record<string, unknown>, key: string) {
  const value = settings[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function booleanSetting(settings: Record<string, unknown>, key: string) {
  const value = settings[key];
  return typeof value === 'boolean' ? value : null;
}

function numberSetting(settings: Record<string, unknown>, key: string) {
  const value = settings[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isImageResolution(value: string | null): value is ImageResolution {
  return value === '1K' || value === '2K' || value === '3K' || value === '4K';
}

function isImageOutputFormat(value: string | null): value is ImageOutputFormat {
  return value === 'jpg' || value === 'png';
}

function isImageQualityMode(value: string | null): value is ImageQualityMode {
  return value === 'standard' || value === 'turbo' || value === 'balanced' || value === 'quality';
}

function isReferenceMode(value: string | null): value is ReferenceMode {
  return value === 'frames' || value === 'elements';
}

function isMotionResolution(value: string | null): value is MotionResolution {
  return value === '720p' || value === '1080p';
}

function isMotionCharacterOrientation(value: string | null): value is MotionCreationDraft['characterOrientation'] {
  return value === 'video' || value === 'image';
}

function extensionForKind(kind: MediaKind) {
  if (kind === 'video') return 'mp4';
  if (kind === 'audio') return 'mp3';
  return 'png';
}

function mimeTypeForKind(kind: MediaKind) {
  if (kind === 'video') return 'video/mp4';
  if (kind === 'audio') return 'audio/mpeg';
  return 'image/png';
}

function fileNameFromPath(storagePath?: string | null) {
  const fileName = storagePath?.split('/').filter(Boolean).at(-1);
  return fileName && fileName.length > 0 ? fileName : null;
}

function fileNameFromLabel(label: string, kind: MediaKind) {
  const base = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || `${kind}-reference`;
  return `${base}.${extensionForKind(kind)}`;
}

function remixAssetFileName(
  asset: Pick<RemixResolvedAsset, 'storagePath' | 'label' | 'kind'>,
  fallbackDisplayName: string
) {
  return fileNameFromPath(asset.storagePath) ?? fileNameFromLabel(asset.label ?? fallbackDisplayName, asset.kind);
}

function remixImageElementFileName(element: RemixResolvedImageElement, fallbackDisplayName: string) {
  return fileNameFromPath(element.storagePath) ?? fileNameFromLabel(fallbackDisplayName, 'image');
}

function createMediaDraftFromRemixAsset(
  asset: RemixResolvedAsset | null | undefined,
  fallbackDisplayName: string
): MediaDraft | null {
  if (!asset?.url) return null;
  const displayName = normalizeDisplayName(asset.label ?? undefined, fallbackDisplayName);
  const draft = createMediaDraftFromUpload(
    {
      signedUrl: asset.url,
      storagePath: asset.storagePath ?? '',
      mimeType: mimeTypeForKind(asset.kind),
      fileName: remixAssetFileName(asset, displayName),
      kind: asset.kind,
    },
    {
      displayName,
      kind: asset.kind,
      sourceGenerationId: asset.sourceGenerationId ?? null,
    }
  );

  return {
    ...draft,
    storagePath: asset.storagePath ?? null,
    sourceGenerationId: asset.sourceGenerationId ?? null,
  };
}

function createMediaDraftFromRemixImageElement(
  element: RemixResolvedImageElement,
  index: number
): MediaDraft | null {
  if (!element.url) return null;
  const displayName = normalizeDisplayName(element.displayName, `Image reference ${index + 1}`);
  const draft = createMediaDraftFromUpload(
    {
      signedUrl: element.url,
      storagePath: element.storagePath ?? '',
      mimeType: 'image/png',
      fileName: remixImageElementFileName(element, displayName),
      kind: 'image',
    },
    {
      displayName,
      kind: 'image',
      sourceGenerationId: element.sourceGenerationId ?? null,
    }
  );

  return {
    ...draft,
    id: element.id || draft.id,
    displayName,
    handle: element.handle || draft.handle,
    storagePath: element.storagePath ?? null,
    sourceGenerationId: element.sourceGenerationId ?? null,
  };
}

function hydrateRemixImageElements(elements: RemixResolvedImageElement[] | undefined) {
  let skipped = 0;
  const drafts = (elements ?? []).flatMap((element, index) => {
    const draft = createMediaDraftFromRemixImageElement(element, index);
    if (!draft) skipped += 1;
    return draft ? [draft] : [];
  });
  return { drafts, skipped };
}

function hydrateRemixAssets(
  assets: RemixResolvedAsset[] | undefined,
  labelPrefix: string
) {
  let skipped = 0;
  const drafts = (assets ?? []).flatMap((asset, index) => {
    const draft = createMediaDraftFromRemixAsset(asset, `${labelPrefix} ${index + 1}`);
    if (!draft) skipped += 1;
    return draft ? [draft] : [];
  });
  return { drafts, skipped };
}

function hydrateOptionalRemixAsset(
  asset: RemixResolvedAsset | null | undefined,
  fallbackDisplayName: string
) {
  if (!asset) return { draft: null, skipped: 0 };
  const draft = createMediaDraftFromRemixAsset(asset, fallbackDisplayName);
  return { draft, skipped: draft ? 0 : 1 };
}

function hydrateVideoMultiPrompts(value: unknown): VideoShotDraft[] | null {
  if (!Array.isArray(value)) return null;
  const shots = value.flatMap((item, index) => {
    if (!item || typeof item !== 'object') return [];
    const shot = item as Partial<VideoShotDraft>;
    if (typeof shot.prompt !== 'string') return [];
    return [{
      id: typeof shot.id === 'string' && shot.id.trim() ? shot.id : `shot-${index + 1}`,
      prompt: shot.prompt,
      duration: typeof shot.duration === 'number' && Number.isFinite(shot.duration) ? shot.duration : 5,
    }];
  });
  return shots.length > 0 ? shots : null;
}

export function renameMediaDraft(media: MediaDraft, displayName: string): MediaDraft {
  const nextDisplayName = displayName.trim();
  return {
    ...media,
    displayName: nextDisplayName,
    handle: (media.kind === 'image' || Boolean(media.handle)) && nextDisplayName ? `@${toHandleBase(nextDisplayName)}` : undefined,
  };
}

/**
 * Swaps a reference's media in place while keeping its identity: the draft id
 * (list keys and the open details sheet stay on the same entry), the display
 * name, and the handle — an @mention already written into the prompt keeps
 * pointing at the same slot, now backed by the new file.
 */
export function replaceMediaDraftMedia(media: MediaDraft, upload: UploadedMediaInput): MediaDraft {
  return {
    ...media,
    url: upload.signedUrl,
    storagePath: upload.storagePath,
    mimeType: upload.mimeType,
    fileName: upload.fileName,
    durationSeconds: upload.durationSeconds ?? null,
    sizeBytes: upload.sizeBytes ?? null,
    // The swapped-in file is a fresh upload, not a copy of a generation.
    sourceGenerationId: null,
  };
}

export function createDefaultCreationDraft(tool: 'image'): ImageCreationDraft;
export function createDefaultCreationDraft(tool: 'video'): VideoCreationDraft;
export function createDefaultCreationDraft(tool: 'motion'): MotionCreationDraft;
export function createDefaultCreationDraft(tool: CreatorToolId): CreationDraft {
  if (tool === 'image') {
    return {
      tool,
      model: 'nano-banana-2',
      prompt: '',
      aspectRatio: '4:5',
      resolution: '1K',
      qualityMode: 'standard',
      outputFormat: 'jpg',
      googleSearch: false,
      references: [],
      sourceGenerationId: null,
      catalogRevision: null,
      catalogSettings: {},
    };
  }

  if (tool === 'video') {
    return {
      tool,
      model: 'kling-3.0-video',
      prompt: '',
      isMultiShot: false,
      multiPrompts: [
        { id: 'shot-1', prompt: '', duration: 5 },
        { id: 'shot-2', prompt: '', duration: 5 },
      ],
      references: [],
      referenceVideos: [],
      referenceAudios: [],
      preparedAudioIds: [],
      characterIds: [],
      startFrame: null,
      endFrame: null,
      mode: 'std',
      aspectRatio: '9:16',
      sound: false,
      duration: 5,
      resolution: '720p',
      fixedLens: false,
      referenceMode: 'frames',
      sourceGenerationId: null,
      catalogRevision: null,
      catalogSettings: {},
    };
  }

  return {
    tool,
    model: 'kling-3.0',
    prompt: '',
    characterImage: null,
    referenceVideo: null,
    characterOrientation: 'video',
    mode: '720p',
    duration: 10,
    sourceGenerationId: null,
    catalogRevision: null,
    catalogSettings: {},
  };
}

type RemixHydrationResult<T extends CreationDraft> = {
  draft: T;
  warning: string | null;
};

function remixRestoreWarning(restoreIssues: readonly string[] | undefined, skippedCount: number) {
  return (restoreIssues?.length ?? 0) > 0 || skippedCount > 0 ? REMIX_RESTORE_WARNING_MESSAGE : null;
}

function hydrateImageDraftFromRemixSource(
  baseDraft: ImageCreationDraft,
  bundle: RemixSourceBundle
): RemixHydrationResult<ImageCreationDraft> {
  const settings = bundle.workflowSettings ?? {};
  const modelSetting = stringSetting(settings, 'model');
  const model = modelSetting && isImageModelId(modelSetting) ? modelSetting : baseDraft.model;
  const config = bundledImageModel(model);
  const restoredReferences = hydrateRemixImageElements(bundle.inputs.image?.elements);

  let nextDraft: ImageCreationDraft = {
    ...baseDraft,
    model,
    prompt: bundle.generation.prompt,
    references: restoredReferences.drafts,
    sourceGenerationId: bundle.generation.id,
  };

  const aspectRatio = stringSetting(settings, 'aspectRatio');
  if (aspectRatio && asStringList(config.aspectRatios).includes(aspectRatio)) {
    nextDraft = { ...nextDraft, aspectRatio };
  }

  const resolution = stringSetting(settings, 'resolution');
  if (isImageResolution(resolution) && getImageResolutionOptions(model, nextDraft.aspectRatio).includes(resolution)) {
    nextDraft = { ...nextDraft, resolution };
  }

  const qualityMode = stringSetting(settings, 'qualityMode');
  if (isImageQualityMode(qualityMode)) {
    nextDraft = { ...nextDraft, qualityMode };
  }

  const outputFormat = stringSetting(settings, 'outputFormat');
  if (isImageOutputFormat(outputFormat) && config.supportsOutputFormat && asStringList(config.outputFormats).includes(outputFormat)) {
    nextDraft = { ...nextDraft, outputFormat };
  }

  const googleSearch = booleanSetting(settings, 'googleSearch');
  if (typeof googleSearch === 'boolean' && config.supportsGoogleSearch) {
    nextDraft = { ...nextDraft, googleSearch };
  }

  const normalizedDraft = applyModelDefaults(nextDraft) as ImageCreationDraft;
  const droppedReferences = Math.max(0, nextDraft.references.length - normalizedDraft.references.length);

  return {
    draft: normalizedDraft,
    warning: remixRestoreWarning(bundle.restoreIssues, restoredReferences.skipped + droppedReferences),
  };
}

function hydrateVideoDraftFromRemixSource(
  baseDraft: VideoCreationDraft,
  bundle: RemixSourceBundle
): RemixHydrationResult<VideoCreationDraft> {
  const settings = bundle.workflowSettings ?? {};
  const modelSetting = stringSetting(settings, 'model');
  const model = modelSetting && isVideoModelId(modelSetting) ? modelSetting : baseDraft.model;
  const config = bundledVideoModel(model);
  const videoInputs = bundle.inputs.video;
  const restoredElements = hydrateRemixImageElements(videoInputs?.elements);
  const restoredStartFrame = hydrateOptionalRemixAsset(videoInputs?.startFrame, 'Start Frame');
  const restoredEndFrame = hydrateOptionalRemixAsset(videoInputs?.endFrame, 'End Frame');
  const restoredReferenceVideos = hydrateRemixAssets(videoInputs?.referenceVideos, 'Video reference');
  const restoredReferenceAudios = hydrateRemixAssets(videoInputs?.referenceAudios, 'Audio reference');
  const mode = stringSetting(settings, 'mode');
  const isMultiShot = booleanSetting(settings, 'isMultiShot');
  const multiPrompts = hydrateVideoMultiPrompts(settings.multiPrompts);
  const referenceModeSetting = isReferenceMode(stringSetting(settings, 'referenceMode'))
    ? stringSetting(settings, 'referenceMode') as ReferenceMode
    : null;
  const referenceMode = videoInputs?.referenceMode ?? referenceModeSetting ?? (
    restoredElements.drafts.length > 0 ? 'elements' : baseDraft.referenceMode
  );

  let nextDraft: VideoCreationDraft = {
    ...baseDraft,
    model,
    prompt: bundle.generation.prompt,
    references: restoredElements.drafts,
    referenceVideos: restoredReferenceVideos.drafts,
    referenceAudios: restoredReferenceAudios.drafts,
    preparedAudioIds: Array.isArray(settings.preparedAudioIds) ? settings.preparedAudioIds.filter((value): value is string => typeof value === 'string' && Boolean(value.trim())).slice(0, 3) : [],
    characterIds: Array.isArray(settings.characterIds) ? settings.characterIds.filter((value): value is string => typeof value === 'string' && Boolean(value.trim())).slice(0, 3) : [],
    startFrame: restoredStartFrame.draft,
    endFrame: restoredEndFrame.draft,
    referenceMode,
    sourceGenerationId: bundle.generation.id,
  };

  if (typeof isMultiShot === 'boolean') {
    nextDraft = { ...nextDraft, isMultiShot };
  }
  if (multiPrompts) {
    nextDraft = { ...nextDraft, isMultiShot: true, multiPrompts };
  }

  if (mode) {
    nextDraft = {
      ...nextDraft,
      mode: config.modeOptions.length === 0 || config.modeOptions.some((option) => option.value === mode)
        ? mode
        : nextDraft.mode,
    };
  }

  const aspectRatio = stringSetting(settings, 'aspectRatio');
  if (aspectRatio && asStringList(config.aspectRatios).includes(aspectRatio)) {
    nextDraft = { ...nextDraft, aspectRatio };
  }

  const duration = numberSetting(settings, 'duration');
  if (typeof duration === 'number' && (model === 'veo-3.1' || isValidVideoDuration(model, duration))) {
    nextDraft = { ...nextDraft, duration };
  }

  const resolution = stringSetting(settings, 'resolution');
  if (resolution && (config.resolutions.length === 0 || asStringList(config.resolutions).includes(resolution))) {
    nextDraft = { ...nextDraft, resolution };
  }

  const sound = booleanSetting(settings, 'sound');
  if (typeof sound === 'boolean' && config.supportsSound) {
    nextDraft = { ...nextDraft, sound };
  }

  const fixedLens = booleanSetting(settings, 'fixedLens');
  if (typeof fixedLens === 'boolean' && config.supportsFixedLens) {
    nextDraft = { ...nextDraft, fixedLens };
  }

  const normalizedDraft = applyModelDefaults(nextDraft) as VideoCreationDraft;
  const droppedReferences = Math.max(0, nextDraft.references.length - normalizedDraft.references.length)
    + Math.max(0, nextDraft.referenceVideos.length - normalizedDraft.referenceVideos.length)
    + Math.max(0, nextDraft.referenceAudios.length - normalizedDraft.referenceAudios.length);
  const skipped = restoredElements.skipped
    + restoredStartFrame.skipped
    + restoredEndFrame.skipped
    + restoredReferenceVideos.skipped
    + restoredReferenceAudios.skipped
    + droppedReferences;

  return {
    draft: normalizedDraft,
    warning: remixRestoreWarning(bundle.restoreIssues, skipped),
  };
}

function hydrateMotionDraftFromRemixSource(
  baseDraft: MotionCreationDraft,
  bundle: RemixSourceBundle
): RemixHydrationResult<MotionCreationDraft> {
  const settings = bundle.workflowSettings ?? {};
  const modelSetting = stringSetting(settings, 'model');
  const model = modelSetting && isMotionModelId(modelSetting) ? modelSetting : baseDraft.model;
  const motionInputs = bundle.inputs.motion;
  const restoredCharacterImage = hydrateOptionalRemixAsset(motionInputs?.characterImage, 'Character Image');
  const restoredReferenceVideo = hydrateOptionalRemixAsset(motionInputs?.referenceVideo, 'Reference Motion');

  let nextDraft: MotionCreationDraft = {
    ...baseDraft,
    model,
    prompt: bundle.generation.prompt,
    characterImage: restoredCharacterImage.draft,
    referenceVideo: restoredReferenceVideo.draft,
    sourceGenerationId: bundle.generation.id,
  };

  const mode = stringSetting(settings, 'mode');
  if (isMotionResolution(mode)) {
    nextDraft = { ...nextDraft, mode };
  }

  const characterOrientation = stringSetting(settings, 'characterOrientation');
  if (isMotionCharacterOrientation(characterOrientation)) {
    nextDraft = { ...nextDraft, characterOrientation };
  }

  const duration = numberSetting(settings, 'duration');
  if (typeof duration === 'number' && duration > 0 && duration <= bundledMotionModel(model).maxDuration) {
    nextDraft = { ...nextDraft, duration: Math.ceil(duration) };
  }

  const normalizedDraft = applyModelDefaults(nextDraft) as MotionCreationDraft;
  const skipped = restoredCharacterImage.skipped + restoredReferenceVideo.skipped;

  return {
    draft: normalizedDraft,
    warning: remixRestoreWarning(bundle.restoreIssues, skipped),
  };
}

export function hydrateCreationDraftFromRemixSource(
  baseDraft: ImageCreationDraft,
  bundle: RemixSourceBundle
): RemixHydrationResult<ImageCreationDraft>;
export function hydrateCreationDraftFromRemixSource(
  baseDraft: VideoCreationDraft,
  bundle: RemixSourceBundle
): RemixHydrationResult<VideoCreationDraft>;
export function hydrateCreationDraftFromRemixSource(
  baseDraft: MotionCreationDraft,
  bundle: RemixSourceBundle
): RemixHydrationResult<MotionCreationDraft>;
export function hydrateCreationDraftFromRemixSource(
  baseDraft: CreationDraft,
  bundle: RemixSourceBundle
): RemixHydrationResult<CreationDraft> {
  if (baseDraft.tool === 'image') return hydrateImageDraftFromRemixSource(baseDraft, bundle);
  if (baseDraft.tool === 'video') return hydrateVideoDraftFromRemixSource(baseDraft, bundle);
  return hydrateMotionDraftFromRemixSource(baseDraft, bundle);
}

/**
 * Which reference shape a run uses, read off what is attached rather than a stored mode.
 *
 * The create screen shows every slot a model declares at once, so nothing selects a mode
 * any more. Deriving it here keeps the answer from drifting away from the attachments the
 * way a separately persisted `draft.referenceMode` could — and Gemini Omni has no frame
 * slots at all, so it is always in the reference shape.
 */
export function videoDraftReferenceMode(draft: VideoCreationDraft): ReferenceMode {
  if (draft.model === 'gemini-omni-video') return 'elements';
  const hasReferences = draft.references.length > 0
    || draft.referenceVideos.length > 0
    || draft.referenceAudios.length > 0
    || draft.preparedAudioIds.length > 0
    || draft.characterIds.length > 0;
  return hasReferences ? 'elements' : 'frames';
}

export function getVideoElementSupport(model: VideoModelId, options: { mode?: string; isMultiShot?: boolean } = {}) {
  if (options.isMultiShot) {
    return { enabled: false, maxElements: 0, reason: 'Reusable references are available in single-shot only.' };
  }
  if (model === 'seedance-1.5-pro') return { enabled: true, maxElements: 2, reason: null };
  if (model === 'seedance-2' || model === 'seedance-2-fast' || model === 'seedance-2-mini' || model === 'wan-2.7') return { enabled: true, maxElements: 5, reason: null };
  // seedance-2-5, kling-o3 and minimax-h3 shipped publishing reference capacity with no
  // branch here, so validateVideoDraft rejected every reference they advertised. The web
  // catalog is the source of these numbers; kling-o3's 7 covers 3 named subjects plus
  // plain references.
  if (model === 'seedance-2-5') return { enabled: true, maxElements: 30, reason: null };
  if (model === 'minimax-h3') return { enabled: true, maxElements: 9, reason: null };
  if (model === 'kling-o3') return { enabled: true, maxElements: 7, reason: null };
  if (model === 'happyhorse-1.1') return { enabled: true, maxElements: 9, reason: null };
  if (model === 'gemini-omni-video') return { enabled: true, maxElements: 7, reason: null };
  if (model === 'veo-3.1') {
    return options.mode === 'veo3_fast' || options.mode === 'veo3_lite'
      ? { enabled: true, maxElements: 3, reason: null }
      : { enabled: false, maxElements: 0, reason: 'Reusable references require Veo Lite or Fast.' };
  }
  if (model === 'grok-imagine-video') return { enabled: true, maxElements: 1, reason: null };
  if (model === 'kling-3.0-video') return { enabled: false, maxElements: 0, reason: 'Reusable image references are not available for Kling yet.' };
  return { enabled: false, maxElements: 0, reason: 'Reusable references are not available for this model yet.' };
}

export function getMotionDuration(draft: MotionCreationDraft) {
  const sourceDuration = draft.referenceVideo?.durationSeconds ?? draft.duration;
  return Math.max(0, Math.ceil(sourceDuration || 0));
}

function inspectVideoPromptQuality(draft: VideoCreationDraft): PromptEnhancementWarning[] {
  if (draft.model === 'kling-3.0-video' && draft.isMultiShot && draft.multiPrompts.length > 6) {
    return [{
      code: 'kling_too_many_shots',
      severity: 'blocking',
      message: 'Kling multi-shot should stay at 6 shots or fewer.',
      fixHint: 'Merge adjacent beats or split the concept into separate generations.',
    }];
  }
  return [];
}

function buildLocalValidationResult(
  errors: string[],
  warnings: PromptEnhancementWarning[] = []
): CreationValidationResult {
  return { errors, warnings, cost: 0, canGenerate: false };
}

function validateImageDraft(draft: ImageCreationDraft): CreationValidationResult {
  const errors: string[] = [];
  if (!draft.prompt.trim()) errors.push('Prompt is required.');
  if (!isImageModelId(draft.model)) errors.push(`Unsupported image model: ${draft.model}`);

  const model = bundledImageModel(draft.model);
  const aspectRatios = asStringList(model.aspectRatios);
  if (!aspectRatios.includes(draft.aspectRatio)) {
    errors.push(`${model.displayName} does not support aspect ratio ${draft.aspectRatio}.`);
  }

  const resolutionOptions = getImageResolutionOptions(draft.model, draft.aspectRatio);
  if (!resolutionOptions.includes(draft.resolution)) {
    errors.push(`${model.displayName} supports ${formatList(resolutionOptions)} at aspect ratio ${draft.aspectRatio}.`);
  }

  if (draft.references.length > model.maxImages) {
    errors.push(`${model.displayName} supports up to ${model.maxImages} total reference image${model.maxImages === 1 ? '' : 's'}.`);
  }
  if (draft.model === 'wan-2.7-image-pro' && draft.resolution === '4K' && draft.references.length > 0) {
    errors.push('Wan 2.7 Image Pro supports 4K for text-to-image only.');
  }

  const handles = namedReferences(draft.references).map((reference) => reference.handle).filter((handle): handle is string => Boolean(handle));
  const unknown = unknownPromptHandles(draft.prompt, handles);
  if (unknown.length > 0) {
    errors.push(`Unknown element mention${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`);
  }

  return buildLocalValidationResult(errors);
}

function validateVideoDraft(draft: VideoCreationDraft): CreationValidationResult {
  const errors: string[] = [];
  const model = bundledVideoModel(draft.model);
  const usesReusableReferences = videoDraftReferenceMode(draft) === 'elements';
  const activeReferences = usesReusableReferences ? draft.references : [];
  const activeReferenceVideos = usesReusableReferences ? draft.referenceVideos : [];
  const activeReferenceAudios = usesReusableReferences ? draft.referenceAudios : [];
  const activeStartFrame = usesReusableReferences ? null : draft.startFrame;
  const activeEndFrame = usesReusableReferences ? null : draft.endFrame;

  if (!isVideoModelId(draft.model)) {
    errors.push(`Unsupported video model: ${draft.model}`);
  }

  if (draft.isMultiShot) {
    if (!model.supportsMultiShot) {
      errors.push(`${model.displayName} does not support multi-shot video generation.`);
    }
    if (draft.multiPrompts.length === 0) {
      errors.push('At least one shot is required for multi-shot mode.');
    }
    if (!draft.multiPrompts.every((shot) => shot.prompt.trim().length > 0)) {
      errors.push('All multi-shot entries need a text prompt.');
    }
  } else if (!draft.prompt.trim()) {
    errors.push('Prompt is required.');
  }

  const elementSupport = getVideoElementSupport(draft.model, { mode: draft.mode, isMultiShot: draft.isMultiShot });
  if (activeReferences.length > 0 && !elementSupport.enabled) {
    errors.push(elementSupport.reason ?? 'Image references are not available in this video mode.');
  }
  if (activeReferences.length > elementSupport.maxElements) {
    errors.push(`This video mode supports up to ${elementSupport.maxElements} image reference${elementSupport.maxElements === 1 ? '' : 's'}.`);
  }

  const handles = namedReferences(activeReferences).map((reference) => reference.handle).filter((handle): handle is string => Boolean(handle));
  const mentioned = extractPromptHandles(draft.prompt);
  const knownMentions = mentioned.filter((handle) => handles.includes(handle));
  const unknown = draft.isMultiShot ? [] : unknownPromptHandles(draft.prompt, handles);
  if (unknown.length > 0) {
    errors.push(`Unknown element mention${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`);
  }
  if (knownMentions.length > 0 && !usesReusableReferences) {
    errors.push('Attach the reference images your @handles name before generating.');
  }

  if (draft.isMultiShot && activeEndFrame) {
    errors.push('End frames are not available in multi-shot mode.');
  }
  if (draft.model === 'grok-imagine-video' && activeReferences.length + (activeStartFrame ? 1 : 0) + (activeEndFrame ? 1 : 0) > 1) {
    errors.push('Grok Imagine Video supports up to 1 image reference per run.');
  }

  if (!supportsMultimodalVideoReferences(draft.model) && activeReferenceVideos.length > 0) {
    errors.push('Reference videos are not available for this model.');
  }
  if (!supportsMultimodalVideoReferences(draft.model) && activeReferenceAudios.length > 0) {
    errors.push('Reference audio is not available for this model.');
  }
  if (isSeedance2Family(draft.model) && activeReferenceVideos.length > 3) {
    errors.push('Seedance 2 supports up to 3 reference videos per run.');
  }
  if (isSeedance2Family(draft.model) && activeReferenceAudios.length > 3) {
    errors.push('Seedance 2 supports up to 3 reference audio files per run.');
  }
  if (draft.model === 'wan-2.7' && activeReferenceAudios.length > 1) {
    errors.push('Wan 2.7 supports one reference voice per run.');
  }
  if (draft.model === 'wan-2.7' && activeReferences.length + activeReferenceVideos.length + activeReferenceAudios.length > 5) {
    errors.push('Wan 2.7 supports up to 5 reusable references in total.');
  }
  if (draft.model === 'gemini-omni-video' && activeReferenceVideos.length > 1) {
    errors.push('Gemini Omni supports one reference video per run.');
  }
  if (draft.model === 'gemini-omni-video' && activeReferenceAudios.length > 0) {
    errors.push('Gemini Omni audio IDs are not supported by this upload flow.');
  }
  if (draft.model === 'gemini-omni-video' && activeReferences.length + (activeReferenceVideos.length * 2) > 7) {
    errors.push('Gemini Omni supports seven reference slots; a video uses two slots.');
  }
  if (draft.model === 'gemini-omni-video' && preparedVideoAudioIds(draft).length > 3) {
    errors.push('Gemini Omni supports up to 3 prepared voice references.');
  }
  if (draft.model === 'gemini-omni-video' && preparedVideoCharacterIds(draft).length > 3) {
    errors.push('Gemini Omni supports up to 3 prepared character references.');
  }
  if (draft.model === 'gemini-omni-video' && activeReferences.length + (activeReferenceVideos.length * 2) + preparedVideoCharacterIds(draft).length > 7) {
    errors.push('Gemini Omni supports seven reference slots; videos use two and characters use one.');
  }
  const knownReferenceDuration = activeReferenceVideos.reduce((total, media) => total + (media.durationSeconds ?? 0), 0);
  if (isSeedance2Family(draft.model) && knownReferenceDuration > 15) {
    errors.push('Seedance 2 reference videos must be 15 seconds or less combined.');
  }
  if (draft.model === 'hailuo-2.3' && !activeStartFrame) {
    errors.push('Hailuo 2.3 requires a start image.');
  }
  if ((draft.model === 'kling-3.0-turbo' || draft.model === 'hailuo-2.3' || draft.model === 'happyhorse-1.1' || draft.model === 'gemini-omni-video') && activeEndFrame) {
    errors.push(`${model.displayName} supports a start frame only.`);
  }

  const aspectRatios = asStringList(model.aspectRatios);
  if (!aspectRatios.includes(draft.aspectRatio)) {
    errors.push(`Unsupported aspect ratio for ${model.displayName}.`);
  }
  if (model.modeOptions.length > 0 && !model.modeOptions.some((option) => option.value === draft.mode)) {
    errors.push(`Unsupported mode for ${model.displayName}.`);
  }
  const resolutions = asStringList(model.resolutions);
  if (resolutions.length > 0 && !resolutions.includes(draft.resolution)) {
    errors.push(`Unsupported resolution for ${model.displayName}.`);
  }
  if (draft.model === 'hailuo-2.3' && draft.resolution === '1080P' && draft.duration === 10) {
    errors.push('Hailuo 2.3 supports 1080P output at 6 seconds only.');
  }
  if (!draft.isMultiShot && draft.model !== 'veo-3.1' && !isValidVideoDuration(draft.model, draft.duration)) {
    errors.push(`Unsupported duration for ${model.displayName}.`);
  }

  const warnings = inspectVideoPromptQuality(draft);
  warnings.filter((warning) => warning.severity === 'blocking').forEach((warning) => errors.push(warning.message));

  return buildLocalValidationResult(errors, warnings);
}

function validateMotionDraft(draft: MotionCreationDraft): CreationValidationResult {
  const errors: string[] = [];
  if (!isMotionModelId(draft.model)) errors.push(`Unsupported motion model: ${draft.model}`);
  if (!draft.characterImage) errors.push('Character image is required.');
  if (!draft.referenceVideo) errors.push('Reference video is required.');

  const duration = getMotionDuration(draft);
  const maxDuration = bundledMotionModel(draft.model).maxDuration;
  if (draft.referenceVideo && (duration < 1 || duration > maxDuration)) {
    errors.push(`Reference video must be between 1 and ${maxDuration} seconds.`);
  }
  if (!asStringList(bundledMotionModel(draft.model).resolutions).includes(draft.mode)) {
    errors.push(`Unsupported motion resolution: ${draft.mode}.`);
  }
  if (!asStringList(bundledMotionModel(draft.model).characterOrientations).includes(draft.characterOrientation)) {
    errors.push(`Unsupported character orientation: ${draft.characterOrientation}.`);
  }

  return buildLocalValidationResult(errors);
}

export function validateCreationDraft(draft: CreationDraft, options: { credits?: number | null } = {}): CreationValidationResult {
  void options;
  if (draft.tool === 'image') return validateImageDraft(draft);
  if (draft.tool === 'video') return validateVideoDraft(draft);
  return validateMotionDraft(draft);
}

export function getCreationSectionOrder(draft: CreationDraft): CreationSectionId[] {
  if (draft.tool === 'motion') {
    return ['essentials', 'references', 'prompt', 'advanced', 'generate'];
  }
  return ['prompt', 'references', 'essentials', 'advanced', 'generate'];
}

function isReadinessCoveredError(error: string) {
  return (
    error === 'Prompt is required.' ||
    error === 'All multi-shot entries need a text prompt.' ||
    error === 'Character image is required.' ||
    error === 'Reference video is required.' ||
    error.startsWith('Insufficient credits.')
  );
}

export function getVisibleGenerationCheckMessages(
  validation: CreationValidationResult,
  message: string | null
): VisibleGenerationCheckMessages {
  return {
    message,
    errors: validation.errors.filter((error) => !isReadinessCoveredError(error)),
    warnings: validation.warnings,
  };
}

export function getCreationSectionSummary(draft: CreationDraft): CreationSectionSummary {
  if (draft.tool === 'image') {
    return {
      essentials: `${bundledImageModel(draft.model).displayName} · ${draft.aspectRatio} · ${draft.resolution}`,
      references: imageReferenceSummary(draft.references.length),
      advanced: `${draft.outputFormat.toUpperCase()} · Search ${draft.googleSearch ? 'on' : 'off'}`,
    };
  }

  if (draft.tool === 'video') {
    const model = bundledVideoModel(draft.model);
    const duration = draft.isMultiShot
      ? draft.multiPrompts.reduce((total, shot) => total + Math.max(1, Math.round(shot.duration || 0)), 0)
      : draft.duration;

    return {
      essentials: `${model.displayName} · ${draft.aspectRatio} · ${duration}s`,
      references: videoReferenceSummary(draft),
      advanced: videoAdvancedSummary(draft),
    };
  }

  return {
    essentials: `${bundledMotionModel(draft.model).displayName} · ${draft.mode} · ${getMotionDuration(draft)}s`,
    references: `${draft.characterImage ? 'Character ready' : 'Character missing'} · ${draft.referenceVideo ? 'motion ready' : 'motion missing'}`,
    advanced: `${draft.characterOrientation === 'video' ? 'Video' : 'Image'} orientation`,
  };
}

export function getCreationReadiness(
  draft: CreationDraft,
  validation: CreationValidationResult,
  summaryOverride?: CreationSectionSummary,
  options: {
    costStatus?: CreationReadinessCostStatus;
    costUnavailableMessage?: string;
  } = {}
): CreationReadinessItem[] {
  const summary = summaryOverride ?? getCreationSectionSummary(draft);
  const insufficientCreditsError = validation.errors.find((error) => error.startsWith('Insufficient credits.'));
  const costStatus = options.costStatus ?? (validation.canGenerate ? 'ready' : 'unavailable');
  const costReadiness: CreationReadinessItem = insufficientCreditsError
    ? {
        id: 'cost',
        label: 'Credits needed',
        body: insufficientCreditsError,
        state: 'warning',
      }
    : costStatus === 'pending'
      ? {
          id: 'cost',
          label: 'Cost pending',
          body: 'Calculating the server quote before generation.',
          state: 'neutral',
        }
      : costStatus === 'unavailable'
        ? {
            id: 'cost',
            label: 'Model settings unavailable',
            body: options.costUnavailableMessage ?? 'Retry model settings before generating.',
            state: 'warning',
          }
        : {
            id: 'cost',
            label: 'Cost ready',
            body: `${validation.cost} credits available for this generation.`,
            state: 'ready',
          };

  return [
    promptReadiness(draft),
    mediaReadiness(draft),
    {
      id: 'settings',
      label: settingsHasBlockingError(draft, validation) ? 'Settings need review' : 'Settings ready',
      body: settingsHasBlockingError(draft, validation)
        ? 'Fix the highlighted issue before generating.'
        : summary.essentials,
      state: settingsHasBlockingError(draft, validation) ? 'warning' : 'ready',
    },
    costReadiness,
  ];
}

function imageReferenceSummary(count: number) {
  if (count === 0) return 'No references';
  return `${count} reference image${count === 1 ? '' : 's'}`;
}

function videoReferenceSummary(draft: VideoCreationDraft) {
  if (videoDraftReferenceMode(draft) === 'elements') {
    return `Reusable refs · ${draft.references.length === 0 ? 'no image references' : `${draft.references.length} image reference${draft.references.length === 1 ? '' : 's'}`}`;
  }

  const frameCount = [draft.startFrame, draft.endFrame].filter(Boolean).length;
  return `Frames mode · ${frameCount === 0 ? 'no frames' : `${frameCount} frame${frameCount === 1 ? '' : 's'}`}`;
}

function videoAdvancedSummary(draft: VideoCreationDraft) {
  const model = bundledVideoModel(draft.model);
  const modeLabel = model.modeOptions.find((option) => option.value === draft.mode)?.label;
  const parts = [
    modeLabel,
    model.resolutions.length > 0 ? draft.resolution : null,
    model.supportsSound ? `sound ${draft.sound ? 'on' : 'off'}` : null,
    model.supportsFixedLens ? `fixed lens ${draft.fixedLens ? 'on' : 'off'}` : null,
  ].filter((part): part is string => Boolean(part));
  return parts.join(' · ') || 'Default model settings';
}

function promptReadiness(draft: CreationDraft): CreationReadinessItem {
  if (draft.tool === 'motion') {
    return {
      id: 'prompt',
      label: draft.prompt.trim() ? 'Prompt ready' : 'Prompt optional',
      body: draft.prompt.trim()
        ? 'Motion direction will be sent with the required media.'
        : 'Motion transfer can run from the character image and reference video.',
      state: draft.prompt.trim() ? 'ready' : 'neutral',
    };
  }

  if (draft.tool === 'video' && draft.isMultiShot) {
    const ready = draft.multiPrompts.length > 0 && draft.multiPrompts.every((shot) => shot.prompt.trim());
    return {
      id: 'prompt',
      label: ready ? 'Shots ready' : 'Shot prompts needed',
      body: ready ? `${draft.multiPrompts.length} shot prompt${draft.multiPrompts.length === 1 ? '' : 's'} ready.` : 'Add text to every shot before generating.',
      state: ready ? 'ready' : 'warning',
    };
  }

  return {
    id: 'prompt',
    label: draft.prompt.trim() ? 'Prompt ready' : 'Prompt needed',
    body: draft.prompt.trim() ? 'The main generation prompt is ready.' : 'Add a prompt before generating.',
    state: draft.prompt.trim() ? 'ready' : 'warning',
  };
}

function mediaReadiness(draft: CreationDraft): CreationReadinessItem {
  if (draft.tool === 'motion') {
    const hasCharacter = Boolean(draft.characterImage);
    const hasReference = Boolean(draft.referenceVideo);
    return {
      id: 'media',
      label: hasCharacter && hasReference ? 'Motion media ready' : 'Motion media needed',
      body: hasCharacter && hasReference
        ? 'Character image and reference motion video are attached.'
        : 'Add a character image and reference motion video.',
      state: hasCharacter && hasReference ? 'ready' : 'warning',
    };
  }

  if (draft.tool === 'video') {
    const attachedCount = videoDraftReferenceMode(draft) === 'elements'
      ? draft.references.length
      : [draft.startFrame, draft.endFrame].filter(Boolean).length;
    return {
      id: 'media',
      label: 'References optional',
      body: attachedCount > 0 ? `${attachedCount} video reference item${attachedCount === 1 ? '' : 's'} attached.` : 'Generate from text, or attach frames/elements for more control.',
      state: attachedCount > 0 ? 'ready' : 'neutral',
    };
  }

  const imageModel = bundledImageModel(draft.model);
  if (imageModel?.maxImages === 0) {
    return {
      id: 'media',
      label: 'Prompt-only model',
      body: `${imageModel.displayName} generates without reference images.`,
      state: 'neutral',
    };
  }

  return {
    id: 'media',
    label: 'References optional',
    body: draft.references.length > 0 ? `${draft.references.length} reference image${draft.references.length === 1 ? '' : 's'} attached.` : 'Generate from text, or add reference images for more control.',
    state: draft.references.length > 0 ? 'ready' : 'neutral',
  };
}

function settingsHasBlockingError(draft: CreationDraft, validation: CreationValidationResult) {
  return validation.errors.some((error) => isSettingsError(draft, error));
}

function isSettingsError(draft: CreationDraft, error: string) {
  if (error.startsWith('Insufficient credits.')) return false;
  if (error === 'Prompt is required.' || error === 'All multi-shot entries need a text prompt.') return false;
  if (draft.tool === 'motion' && (error === 'Character image is required.' || error === 'Reference video is required.')) return false;
  return true;
}

function sanitizeVideoMultiPrompts(draft: VideoCreationDraft): VideoMultiPromptInput[] {
  return draft.multiPrompts.map((shot, index) => ({
    id: shot.id || `shot-${index + 1}`,
    prompt: shot.prompt.trim(),
    duration: Math.max(1, Math.round(shot.duration || 5)),
  }));
}

export function buildGenerationPayload(draft: ImageCreationDraft): ImageGenerationRequest;
export function buildGenerationPayload(draft: VideoCreationDraft): VideoGenerationRequest;
export function buildGenerationPayload(draft: MotionCreationDraft): MotionGenerationRequest;
export function buildGenerationPayload(draft: CreationDraft): ImageGenerationRequest | VideoGenerationRequest | MotionGenerationRequest {
  if (draft.tool === 'image') {
    const config = bundledImageModel(draft.model);
    const references = namedReferences(draft.references);
    return {
      model: draft.model,
      prompt: draft.prompt.trim(),
      imageUrls: references.map((reference) => reference.url),
      elements: elementDescriptors(references),
      aspectRatio: draft.aspectRatio,
      resolution: draft.resolution,
      outputFormat: config.supportsOutputFormat && asStringList(config.outputFormats).includes(draft.outputFormat) ? draft.outputFormat : 'jpg',
      googleSearch: config.supportsGoogleSearch ? draft.googleSearch : false,
      qualityMode: draft.model === 'ideogram-v3'
        ? (draft.qualityMode === 'turbo' || draft.qualityMode === 'balanced' || draft.qualityMode === 'quality' ? draft.qualityMode : 'turbo')
        : draft.model === 'grok-imagine-image'
          ? (draft.qualityMode === 'quality' ? 'quality' : 'standard')
          : 'standard',
      sourceGenerationId: draft.sourceGenerationId ?? null,
    };
  }

  if (draft.tool === 'video') {
    const usesReusableReferences = videoDraftReferenceMode(draft) === 'elements';
    const references = namedReferences(usesReusableReferences ? draft.references : []);
    const imageUrls = references.map((reference) => reference.url);
    return {
      model: draft.model,
      isMultiShot: draft.isMultiShot,
      prompt: draft.prompt.trim(),
      multiPrompts: draft.isMultiShot ? sanitizeVideoMultiPrompts(draft) : undefined,
      elements: elementDescriptors(references),
      elementImageUrls: imageUrls,
      imageUrls,
      referenceVideoUrls: usesReusableReferences ? draft.referenceVideos.map((media) => media.url) : [],
      referenceAudioUrls: usesReusableReferences ? draft.referenceAudios.map((media) => media.url) : [],
      preparedAudioIds: usesReusableReferences ? preparedVideoAudioIds(draft) : [],
      characterIds: usesReusableReferences ? preparedVideoCharacterIds(draft) : [],
      startImageUrl: usesReusableReferences && draft.model !== 'wan-2.7' ? null : draft.startFrame?.url ?? null,
      endImageUrl: usesReusableReferences ? null : draft.endFrame?.url ?? null,
      startFrame: usesReusableReferences && draft.model !== 'wan-2.7' ? null : mediaAssetDescriptor(draft.startFrame),
      endFrame: usesReusableReferences ? null : mediaAssetDescriptor(draft.endFrame),
      mode: draft.mode,
      aspectRatio: draft.aspectRatio,
      sound: bundledVideoModel(draft.model).supportsSound ? draft.sound : false,
      duration: draft.duration,
      resolution: draft.resolution,
      fixedLens: bundledVideoModel(draft.model).supportsFixedLens ? draft.fixedLens : false,
      referenceMode: videoDraftReferenceMode(draft),
      seedanceAssets: null,
      sourceGenerationId: draft.sourceGenerationId ?? null,
    };
  }

  return {
    model: draft.model,
    prompt: draft.prompt.trim(),
    characterImageUrl: draft.characterImage?.url ?? '',
    referenceVideoUrl: draft.referenceVideo?.url ?? '',
    characterOrientation: draft.characterOrientation,
    duration: getMotionDuration(draft),
    mode: draft.mode,
    characterImage: mediaAssetDescriptor(draft.characterImage),
    referenceVideo: mediaAssetDescriptor(draft.referenceVideo),
    sourceGenerationId: draft.sourceGenerationId ?? null,
  };
}

export interface PromptEnhancementRequestOptions {
  level?: 'faithful' | 'cinematic';
}

/** Uploaded https frame URLs the enhancer LLM may be pointed at as vision input. */
function enhancerFrameImageUrls(draft: VideoCreationDraft, usesReusableReferences: boolean): string[] {
  if (usesReusableReferences) return [];
  return [draft.startFrame?.url, draft.endFrame?.url]
    .filter((url): url is string => typeof url === 'string' && url.startsWith('https://'));
}

export function buildPromptEnhancementRequest(
  draft: CreationDraft,
  options: PromptEnhancementRequestOptions = {},
): PromptEnhancementRequest {
  const level = options.level && options.level !== 'cinematic' ? options.level : undefined;
  if (draft.tool === 'image') {
    const references = namedReferences(draft.references);
    return {
      medium: 'image',
      selectedModel: draft.model,
      prompt: draft.prompt,
      context: {
        referenceImageCount: references.length,
        elementReferences: references.map((reference) => ({
          handle: reference.handle ?? '',
          displayName: reference.displayName,
        })),
        ...(level ? { enhancementLevel: level } : {}),
      },
    };
  }

  if (draft.tool === 'video') {
    const usesReusableReferences = videoDraftReferenceMode(draft) === 'elements';
    const references = namedReferences(usesReusableReferences ? draft.references : []);
    const frameImageUrls = enhancerFrameImageUrls(draft, usesReusableReferences);
    return {
      medium: 'video',
      selectedModel: draft.model,
      prompt: draft.prompt,
      context: {
        duration: draft.duration,
        sound: draft.sound,
        hasStartImage: !usesReusableReferences && Boolean(draft.startFrame),
        hasEndImage: !usesReusableReferences && Boolean(draft.endFrame),
        hasReferenceVideo: usesReusableReferences && draft.referenceVideos.length > 0,
        referenceImageCount: references.length,
        isMultiShot: draft.isMultiShot,
        shotCount: draft.multiPrompts.length,
        elementReferences: references.map((reference) => ({
          handle: reference.handle ?? '',
          displayName: reference.displayName,
        })),
        ...(frameImageUrls.length > 0 ? { frameImageUrls } : {}),
        ...(level ? { enhancementLevel: level } : {}),
      },
    };
  }

  return {
    medium: 'motion',
    selectedModel: draft.model,
    prompt: draft.prompt,
    context: {
      duration: getMotionDuration(draft),
      hasReferenceVideo: Boolean(draft.referenceVideo),
      referenceImageCount: draft.characterImage ? 1 : 0,
      ...(level ? { enhancementLevel: level } : {}),
    },
  };
}

export function applyModelDefaults(draft: CreationDraft): CreationDraft {
  if (draft.tool === 'image') {
    const config = bundledImageModel(draft.model);
    const aspectRatio = asStringList(config.aspectRatios).includes(draft.aspectRatio) ? draft.aspectRatio : config.aspectRatios[0];
    const resolutions = getImageResolutionOptions(draft.model, aspectRatio);
    return {
      ...draft,
      aspectRatio,
      resolution: resolutions.includes(draft.resolution) ? draft.resolution : resolutions[0],
      outputFormat: config.supportsOutputFormat && asStringList(config.outputFormats).includes(draft.outputFormat) ? draft.outputFormat : 'jpg',
      googleSearch: config.supportsGoogleSearch ? draft.googleSearch : false,
      qualityMode: draft.model === 'ideogram-v3'
        ? (draft.qualityMode === 'turbo' || draft.qualityMode === 'balanced' || draft.qualityMode === 'quality' ? draft.qualityMode : 'turbo')
        : draft.model === 'grok-imagine-image'
          ? (draft.qualityMode === 'quality' ? 'quality' : 'standard')
          : draft.qualityMode,
      references: draft.references.slice(0, config.maxImages),
    };
  }

  if (draft.tool === 'video') {
    const config = bundledVideoModel(draft.model);
    const duration = isValidVideoDuration(draft.model, draft.duration) ? draft.duration : getDefaultVideoDuration(draft.model);
    return {
      ...draft,
      aspectRatio: asStringList(config.aspectRatios).includes(draft.aspectRatio) ? draft.aspectRatio : config.aspectRatios[0],
      mode: config.modeOptions.length === 0 || config.modeOptions.some((option) => option.value === draft.mode) ? draft.mode : defaultVideoMode(draft.model),
      duration,
      resolution: config.resolutions.length === 0 || asStringList(config.resolutions).includes(draft.resolution) ? draft.resolution : config.resolutions[0],
      sound: config.supportsSound ? draft.sound : false,
      fixedLens: config.supportsFixedLens ? draft.fixedLens : false,
      isMultiShot: config.supportsMultiShot ? draft.isMultiShot : false,
      referenceAudios: supportsMultimodalVideoReferences(draft.model) && draft.model !== 'gemini-omni-video' ? draft.referenceAudios.slice(0, draft.model === 'wan-2.7' ? 1 : 3) : [],
      referenceVideos: supportsMultimodalVideoReferences(draft.model) ? draft.referenceVideos.slice(0, draft.model === 'gemini-omni-video' ? 1 : draft.model === 'wan-2.7' ? 5 : 3) : [],
      preparedAudioIds: draft.model === 'gemini-omni-video' ? preparedVideoAudioIds(draft).slice(0, 3) : [],
      characterIds: draft.model === 'gemini-omni-video' ? preparedVideoCharacterIds(draft).slice(0, 3) : [],
      referenceMode: videoDraftReferenceMode(draft),
      references: draft.references.slice(0, getVideoElementSupport(draft.model, { mode: draft.mode, isMultiShot: draft.isMultiShot }).maxElements),
    };
  }

  const config = bundledMotionModel(draft.model);
  return {
    ...draft,
    mode: asStringList(config.resolutions).includes(draft.mode) ? draft.mode : '720p',
    characterOrientation: asStringList(config.characterOrientations).includes(draft.characterOrientation) ? draft.characterOrientation : 'video',
  };
}

/**
 * Video models whose provider generates an audio track unconditionally. There
 * is no sound toggle for these; the prompt (or the enhancer) must script the
 * soundscape or explicitly ask for "no music".
 */
export const ALWAYS_ON_AUDIO_VIDEO_MODELS: ReadonlySet<string> = new Set([
  'wan-2.7',
  'grok-imagine-video',
  'minimax-h3',
  'happyhorse-1.1',
]);
