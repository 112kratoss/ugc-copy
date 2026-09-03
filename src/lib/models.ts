/**
 * Centralized Model & Pricing Configuration.
 *
 * Single source of truth for all AI model definitions, pricing,
 * and constraints used across both backend API routes and frontend pages.
 */

// ─── Motion Models (Kling) ────────────────────────────────────────────────────

export const MOTION_MODELS = {
    'kling-2.6': {
        id: 'kling-2.6' as const,
        displayName: 'Kling 2.6',
        description: 'Reliable motion transfer with smooth character animation',
        badge: 'Stable',
        badgeColor: 'from-sky-500 to-blue-500',
        apiModelId: 'kling-2.6/motion-control',
        maxDuration: 30,
        characterOrientations: ['video', 'image'] as const,
        resolutions: ['720p', '1080p'] as const,
        /** Credits per second of output video */
        pricing: {
            '720p': 11,
            '1080p': 18,
        },
    },
    'kling-3.0': {
        id: 'kling-3.0' as const,
        displayName: 'Kling 3.0',
        description: 'Latest model — enhanced fidelity and motion accuracy',
        badge: 'New',
        badgeColor: 'from-[#ff7a59] to-orange-500',
        apiModelId: 'kling-3.0/motion-control',
        maxDuration: 30,
        characterOrientations: ['video', 'image'] as const,
        resolutions: ['720p', '1080p'] as const,
        pricing: {
            '720p': 20,
            '1080p': 27,
        },
    },
} as const;

export type MotionModelId = keyof typeof MOTION_MODELS;

// ─── Image Models ─────────────────────────────────────────────────────────────

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
        pricing: {
            '1K': 4,
            '2K': 4,
            '4K': 4,
        },
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
        pricing: {
            '1K': 8,
            '2K': 12,
            '4K': 18,
        },
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
        pricing: {
            '1K': 18,
            '2K': 18,
            '4K': 24,
        },
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
        pricing: {
            '1K': 6,
            '2K': 10,
            '4K': 16,
        },
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
        pricing: {
            '1K': 7,
            '2K': 14,
            '4K': 14,
        },
        additionalReferenceCredit: 0.5,
    },
    'seedream-5-lite': {
        id: 'seedream-5-lite' as const,
        displayName: 'Seedream 5 Lite',
        description: 'Fast, low-cost generation and multi-image editing up to 3K',
        badge: 'Value',
        badgeColor: 'from-cyan-500 to-blue-500',
        accentColor: 'blue',
        maxImages: 14,
        supportsGoogleSearch: false,
        supportsOutputFormat: true,
        aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16', '2:3', '3:2', '21:9'] as const,
        resolutions: ['2K', '3K'] as const,
        outputFormats: ['jpg', 'png'] as const,
        pricing: { '2K': 5.5, '3K': 5.5 },
    },
    'wan-2.7-image': {
        id: 'wan-2.7-image' as const,
        displayName: 'Wan 2.7 Image',
        description: 'Affordable text generation and editing with up to nine references',
        badge: 'Value',
        badgeColor: 'from-emerald-500 to-cyan-500',
        accentColor: 'blue',
        maxImages: 9,
        supportsGoogleSearch: false,
        supportsOutputFormat: false,
        aspectRatios: ['auto'] as const,
        resolutions: ['1K', '2K'] as const,
        outputFormats: ['jpg'] as const,
        pricing: { '1K': 4.8, '2K': 4.8 },
    },
    'wan-2.7-image-pro': {
        id: 'wan-2.7-image-pro' as const,
        displayName: 'Wan 2.7 Image Pro',
        description: 'High-fidelity Wan generation and editing with optional 4K output',
        badge: 'Pro',
        badgeColor: 'from-blue-500 to-indigo-500',
        accentColor: 'blue',
        maxImages: 9,
        supportsGoogleSearch: false,
        supportsOutputFormat: false,
        aspectRatios: ['auto'] as const,
        resolutions: ['1K', '2K', '4K'] as const,
        outputFormats: ['jpg'] as const,
        pricing: { '1K': 12, '2K': 12, '4K': 12 },
    },
    // Imagen 4 family: DISABLED in the production catalog since release
    // imagen-family-disable-20260824 — Google sunset the upstream Imagen API on
    // 2026-08-17 and live Kie probes fail with provider 500s (see the release
    // manifest's changeNote for task ids). Kept here for code-source
    // environments and a clean re-enable if Kie restores fulfillment.
    'imagen-4-fast': {
        id: 'imagen-4-fast' as const,
        displayName: 'Imagen 4 Fast',
        description: 'Fast Google image generation for polished everyday creative',
        badge: 'Fast',
        badgeColor: 'from-cyan-500 to-blue-500',
        accentColor: 'blue',
        maxImages: 0,
        supportsGoogleSearch: false,
        supportsOutputFormat: false,
        aspectRatios: ['auto', '1:1', '16:9', '9:16', '3:4', '4:3'] as const,
        resolutions: ['1K'] as const,
        outputFormats: ['jpg'] as const,
        pricing: { '1K': 4 },
    },
    'imagen-4': {
        id: 'imagen-4' as const,
        displayName: 'Imagen 4',
        description: 'Balanced Google image generation with stronger detail and typography',
        badge: 'Quality',
        badgeColor: 'from-blue-500 to-indigo-500',
        accentColor: 'blue',
        maxImages: 0,
        supportsGoogleSearch: false,
        supportsOutputFormat: false,
        aspectRatios: ['auto', '1:1', '16:9', '9:16', '3:4', '4:3'] as const,
        resolutions: ['1K'] as const,
        outputFormats: ['jpg'] as const,
        pricing: { '1K': 8 },
    },
    'imagen-4-ultra': {
        id: 'imagen-4-ultra' as const,
        displayName: 'Imagen 4 Ultra',
        description: 'Highest-quality Imagen 4 output for final production assets',
        badge: 'Ultra',
        badgeColor: 'from-violet-500 to-fuchsia-500',
        accentColor: 'blue',
        maxImages: 0,
        supportsGoogleSearch: false,
        supportsOutputFormat: false,
        aspectRatios: ['auto', '1:1', '16:9', '9:16', '3:4', '4:3'] as const,
        resolutions: ['1K'] as const,
        outputFormats: ['jpg'] as const,
        pricing: { '1K': 12 },
    },
    'ideogram-v3': {
        id: 'ideogram-v3' as const,
        displayName: 'Ideogram V3',
        description: 'Strong typography, logos, posters, and single-image remixing',
        badge: 'Design',
        badgeColor: 'from-fuchsia-500 to-violet-500',
        accentColor: 'amber',
        maxImages: 1,
        supportsGoogleSearch: false,
        supportsOutputFormat: false,
        aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16'] as const,
        resolutions: ['1K'] as const,
        outputFormats: ['jpg'] as const,
        qualityModes: ['turbo', 'balanced', 'quality'] as const,
        qualityPricing: { turbo: 3.5, balanced: 7, quality: 10 },
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
        pricing: {
            '1K': 5,
            '2K': 7,
            '4K': 7,
        },
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
        pricing: {
            '1K': 1,
            '2K': 1,
            '4K': 1,
        },
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
        pricing: {
            '1K': 4,
            '2K': 4,
            '4K': 4,
        },
        qualityPricing: {
            standard: 4,
            quality: 5,
            imageToImage: 4,
        },
        qualityModes: ['standard', 'quality'] as const,
    },
    'grok-imagine-image-2': {
        id: 'grok-imagine-image-2' as const,
        displayName: 'Grok Imagine 2.0',
        description: 'Newer xAI generation with sharper prompt adherence',
        badge: 'New',
        badgeColor: 'from-amber-500 to-orange-500',
        accentColor: 'amber',
        // Text-to-image only: the provider's image-edit variant keys off a prior Kie task id
        // rather than an uploaded image, so there is no reference mode to expose.
        maxImages: 0,
        supportsGoogleSearch: false,
        supportsOutputFormat: false,
        aspectRatios: ['1:1', '2:3', '3:2', '16:9', '9:16'] as const,
        resolutions: ['1K'] as const,
        outputFormats: ['jpg'] as const,
        pricing: {
            '1K': 4,
            '2K': 4,
            '4K': 4,
        },
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
        pricing: {
            '1K': 4.8,
            '2K': 4.8,
            '4K': 4.8,
        },
        additionalReferenceCredit: 0.5,
        // Qwen bills every input image, unlike Seedream which lets the first one through free.
        referenceCreditIncludesFirst: true,
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
        pricing: {
            '1K': 6.4,
            '2K': 12,
            '4K': 12,
        },
        additionalReferenceCredit: 0.5,
        referenceCreditIncludesFirst: true,
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
        qualityPricing: { turbo: 12, balanced: 18, quality: 24 },
        /** The provider requires at least one character reference; there is no text-only mode. */
        requiresReference: true,
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

    if (modelId === 'grok-imagine-image') {
        return IMAGE_MODELS[modelId].resolutions;
    }

    if (modelId !== 'gpt-image-2') {
        return IMAGE_MODELS[modelId].resolutions;
    }

    if (selectedAspectRatio === 'auto') {
        return GPT_IMAGE_2_AUTO_RESOLUTIONS;
    }

    if (selectedAspectRatio === '1:1') {
        return GPT_IMAGE_2_SQUARE_RESOLUTIONS;
    }

    return IMAGE_MODELS[modelId].resolutions;
}

export function isValidImageResolution(
    modelId: ImageModelId,
    resolution: string,
    aspectRatio?: string
): resolution is ImageResolution {
    return getImageResolutionOptions(modelId, aspectRatio).includes(resolution as ImageResolution);
}

export function supportsImageResolutionControl(modelId: ImageModelId): boolean {
    return !['grok-imagine-image', 'ideogram-v3', 'imagen-4-fast', 'imagen-4', 'imagen-4-ultra'].includes(modelId);
}

export function isValidImageQualityMode(value: string): value is ImageQualityMode {
    return value === 'standard' || value === 'turbo' || value === 'balanced' || value === 'quality';
}

export function getImageQualityModes(modelId: ImageModelId): readonly ImageQualityMode[] {
    // Data-driven on purpose: the previous per-id list silently dropped
    // ideogram-character's declared modes, so its Speed selector never rendered.
    const model = IMAGE_MODELS[modelId];
    return 'qualityModes' in model ? model.qualityModes : [];
}

// ─── Video Models ─────────────────────────────────────────────────────────────

export const VIDEO_MODELS = {
    'kling-3.0-video': {
        id: 'kling-3.0-video' as const,
        displayName: 'Kling 3.0 Cinematic',
        description: 'Advanced video generation engine with single-shot and multi-shot support',
        provider: 'kling' as const,
        apiModelId: 'kling-3.0/video',
        enhancerModelId: 'kling-3.0/video',
        supportsMultiShot: true,
        supportsSound: true,
        supportsFixedLens: false,
        aspectRatios: ['16:9', '9:16', '1:1'] as const,
        durations: [5, 10] as const,
        singleShotDurationRange: {
            min: 3,
            max: 15,
            default: 5,
        } as const,
        resolutions: [] as const,
        modeOptions: [
            { value: 'std', label: 'Standard (720p)' },
            { value: 'pro', label: 'Pro (1080p, High Quality)' },
        ] as const,
        /** Credits per second, keyed by mode + sound */
        pricing: {
            std: { noSound: 14, withSound: 20 },
            pro: { noSound: 18, withSound: 27 },
        },
    },
    'kling-3.0-turbo': {
        id: 'kling-3.0-turbo' as const,
        displayName: 'Kling 3 Turbo',
        description: 'Fast Kling generation for text or a single animated start frame',
        provider: 'kling' as const,
        apiModelId: 'kling/v3-turbo-text-to-video',
        enhancerModelId: 'kling-3.0-video',
        supportsMultiShot: false,
        supportsSound: false,
        supportsFixedLens: false,
        aspectRatios: ['16:9', '9:16', '1:1'] as const,
        durations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const,
        singleShotDurationRange: {
            min: 3,
            max: 15,
            default: 5,
        } as const,
        resolutions: ['720p', '1080p'] as const,
        modeOptions: [] as const,
        pricing: {
            '720p': 18,
            '1080p': 22.5,
        },
    },
    'seedance-1.5-pro': {
        id: 'seedance-1.5-pro' as const,
        displayName: 'Seedance 1.5 Pro',
        description: 'ByteDance video model with resolution, duration, and audio controls',
        provider: 'seedance' as const,
        apiModelId: 'bytedance/seedance-1.5-pro',
        enhancerModelId: 'seedance-1.5-pro',
        supportsMultiShot: false,
        supportsSound: true,
        supportsFixedLens: true,
        aspectRatios: ['1:1', '21:9', '4:3', '3:4', '16:9', '9:16'] as const,
        durations: [4, 8, 12] as const,
        modeOptions: [] as const,
        resolutions: ['480p', '720p', '1080p'] as const,
        pricing: {
            '480p': {
                noSound: { 4: 7, 8: 14, 12: 19 },
                withSound: { 4: 14, 8: 28, 12: 38 },
            },
            '720p': {
                noSound: { 4: 14, 8: 28, 12: 42 },
                withSound: { 4: 28, 8: 56, 12: 84 },
            },
            '1080p': {
                noSound: { 4: 30, 8: 60, 12: 90 },
                withSound: { 4: 60, 8: 120, 12: 180 },
            },
        },
    },
    'seedance-2': {
        id: 'seedance-2' as const,
        displayName: 'Seedance 2',
        description: 'ByteDance video model with multimodal references, generated audio, and output up to 4K',
        provider: 'seedance' as const,
        apiModelId: 'bytedance/seedance-2',
        enhancerModelId: 'seedance-2',
        supportsMultiShot: false,
        supportsSound: true,
        supportsFixedLens: false,
        aspectRatios: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'] as const,
        durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const,
        singleShotDurationRange: {
            min: 4,
            max: 15,
            default: 15,
        } as const,
        modeOptions: [] as const,
        resolutions: ['480p', '720p', '1080p', '4k'] as const,
        pricing: {
            '480p': {
                noVideo: 19,
                withVideo: 11.5,
            },
            '720p': {
                noVideo: 41,
                withVideo: 25,
            },
            '1080p': {
                noVideo: 102,
                withVideo: 62,
            },
            '4k': {
                noVideo: 208,
                withVideo: 128,
            },
        },
    },
    'seedance-2-fast': {
        id: 'seedance-2-fast' as const,
        displayName: 'Seedance 2 Fast',
        description: 'Faster ByteDance video model with image, video, and audio references',
        provider: 'seedance' as const,
        apiModelId: 'bytedance/seedance-2-fast',
        enhancerModelId: 'seedance-2-fast',
        supportsMultiShot: false,
        supportsSound: true,
        supportsFixedLens: false,
        aspectRatios: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'] as const,
        durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const,
        singleShotDurationRange: {
            min: 4,
            max: 15,
            default: 15,
        } as const,
        modeOptions: [] as const,
        resolutions: ['480p', '720p'] as const,
        pricing: {
            '480p': {
                noVideo: 15.5,
                withVideo: 9,
            },
            '720p': {
                noVideo: 33,
                withVideo: 20,
            },
        },
    },
    'seedance-2-mini': {
        id: 'seedance-2-mini' as const,
        displayName: 'Seedance 2 Mini',
        description: 'Lower-cost Seedance 2 generation with multimodal references and generated audio',
        provider: 'seedance' as const,
        apiModelId: 'bytedance/seedance-2-mini',
        enhancerModelId: 'seedance-2',
        supportsMultiShot: false,
        supportsSound: true,
        supportsFixedLens: false,
        aspectRatios: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'] as const,
        durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const,
        singleShotDurationRange: {
            min: 4,
            max: 15,
            default: 10,
        } as const,
        modeOptions: [] as const,
        resolutions: ['480p', '720p'] as const,
        pricing: {
            '480p': {
                noVideo: 9.5,
                withVideo: 6,
            },
            '720p': {
                noVideo: 20.5,
                withVideo: 12.5,
            },
        },
    },
    'wan-2.7': {
        id: 'wan-2.7' as const,
        displayName: 'Wan 2.7',
        description: 'Flexible text, frame, and multimodal reference-to-video generation',
        provider: 'wan' as const,
        apiModelId: 'wan/2-7-text-to-video',
        enhancerModelId: 'wan-2.7',
        supportsMultiShot: false,
        supportsSound: false,
        supportsFixedLens: false,
        aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'] as const,
        durations: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const,
        singleShotDurationRange: {
            min: 2,
            max: 15,
            default: 5,
        } as const,
        resolutions: ['720p', '1080p'] as const,
        modeOptions: [] as const,
        pricing: {
            '720p': 16,
            '1080p': 24,
        },
    },
    'happyhorse-1.1': {
        id: 'happyhorse-1.1' as const,
        displayName: 'HappyHorse 1.1',
        description: 'Flexible text, image, and multi-reference video generation up to 1080p',
        provider: 'happyhorse' as const,
        apiModelId: 'happyhorse-1-1/text-to-video',
        enhancerModelId: 'happyhorse-1.1',
        supportsMultiShot: false,
        supportsSound: false,
        supportsFixedLens: false,
        aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '4:5', '5:4', '21:9', '9:21'] as const,
        durations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const,
        singleShotDurationRange: { min: 3, max: 15, default: 5 } as const,
        resolutions: ['720p', '1080p'] as const,
        modeOptions: [] as const,
        pricing: { '720p': 22.5, '1080p': 29 },
    },
    'gemini-omni-video': {
        id: 'gemini-omni-video' as const,
        displayName: 'Gemini Omni Video',
        description: 'Google multimodal video creation from text, images, or one reference clip',
        provider: 'gemini-omni' as const,
        apiModelId: 'gemini-omni-video',
        enhancerModelId: 'gemini-omni-video',
        supportsMultiShot: false,
        supportsSound: false,
        supportsFixedLens: false,
        aspectRatios: ['16:9', '9:16'] as const,
        durations: [4, 6, 8, 10] as const,
        resolutions: ['720p', '1080p', '4k'] as const,
        modeOptions: [] as const,
        pricing: {
            '720p': { 4: 63, 6: 84, 8: 105, 10: 126 },
            '1080p': { 4: 63, 6: 84, 8: 105, 10: 126 },
            '4k': { 4: 147, 6: 168, 8: 189, 10: 210 },
            withVideo: { standard: 168, '4k': 252 },
        },
    },
    'hailuo-2.3': {
        id: 'hailuo-2.3' as const,
        displayName: 'Hailuo 2.3',
        description: 'Image-to-video generation with standard and high-fidelity Pro modes',
        provider: 'hailuo' as const,
        apiModelId: 'hailuo/2-3-image-to-video-standard',
        enhancerModelId: 'hailuo-2.3',
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
        pricing: {
            standard: {
                '768P': { 6: 30, 10: 50 },
                '1080P': { 6: 50 },
            },
            pro: {
                '768P': { 6: 45, 10: 90 },
                '1080P': { 6: 80 },
            },
        },
    },
    'veo-3.1': {
        id: 'veo-3.1' as const,
        displayName: 'Veo 3.1',
        description: 'Google-class video generation with fast and quality variants',
        provider: 'veo' as const,
        apiModelId: '' as const,
        enhancerModelId: 'veo-3.1',
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
        pricing: {
            veo3_lite: { '720p': 30, '1080p': 35, '4k': 150 },
            veo3_fast: { '720p': 60, '1080p': 65, '4k': 180 },
            veo3: {
                text: { '720p': 250, '1080p': 255, '4k': 380 },
                reference: { '720p': 250, '1080p': 255, '4k': 370 },
            },
        },
    },
    'grok-imagine-video': {
        id: 'grok-imagine-video' as const,
        displayName: 'Grok Imagine Video',
        description: 'xAI video generation with normal and fun modes',
        provider: 'grok' as const,
        apiModelId: 'grok-imagine/text-to-video',
        enhancerModelId: 'grok-imagine-video',
        supportsMultiShot: false,
        supportsSound: false,
        supportsFixedLens: false,
        aspectRatios: ['2:3', '3:2', '1:1', '9:16', '16:9'] as const,
        durations: [6, 10, 15, 30] as const,
        singleShotDurationRange: {
            min: 6,
            max: 30,
            default: 6,
        } as const,
        resolutions: ['480p', '720p'] as const,
        modeOptions: [
            { value: 'normal', label: 'Normal' },
            { value: 'fun', label: 'Fun' },
        ] as const,
        pricing: {
            '480p': 1.6,
            '720p': 3,
        },
    },
    'seedance-2-5': {
        id: 'seedance-2-5' as const,
        displayName: 'Seedance 2.5',
        description: 'Latest ByteDance model with 30-second output and audio references',
        provider: 'seedance' as const,
        apiModelId: 'bytedance/seedance-2-5',
        enhancerModelId: 'seedance-2-5',
        supportsMultiShot: false,
        supportsSound: true,
        supportsFixedLens: false,
        aspectRatios: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'] as const,
        durations: [4, 5, 6, 8, 10, 12, 15, 20, 25, 30] as const,
        singleShotDurationRange: {
            min: 4,
            max: 30,
            default: 5,
        } as const,
        modeOptions: [] as const,
        // 2.5 reaches 1080p but not the 4k tier of Seedance 2, and generates twice as long.
        resolutions: ['480p', '720p', '1080p'] as const,
        pricing: {
            '480p': {
                noVideo: 28,
                withVideo: 17,
            },
            '720p': {
                noVideo: 63,
                withVideo: 38,
            },
            // Every rate here is Kie's listed price, passed through. 1080p currently
            // carries a "Limited-Time 1080P Offer: 28% OFF until Sep 17, 2026 06:00 UTC"
            // — when that lapses Kie's listed price rises and this tier must be re-read
            // from the model page, because nothing here derives it.
            '1080p': {
                noVideo: 114,
                withVideo: 68.5,
            },
        },
    },
    'kling-o3': {
        id: 'kling-o3' as const,
        displayName: 'Kling O3',
        description: 'Multi-shot Kling with named subjects and 4K output',
        provider: 'kling' as const,
        apiModelId: 'kling-3.0-omni/text-to-video',
        enhancerModelId: 'kling-3.0-video',
        supportsMultiShot: true,
        supportsSound: true,
        supportsFixedLens: false,
        aspectRatios: ['16:9', '9:16', '1:1'] as const,
        durations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const,
        singleShotDurationRange: {
            min: 3,
            max: 15,
            default: 5,
        } as const,
        modeOptions: [] as const,
        resolutions: ['720p', '1080p', '4k'] as const,
        /** Credits per second, keyed by resolution + native audio. */
        pricing: {
            '720p': { noSound: 14, withSound: 18 },
            '1080p': { noSound: 18, withSound: 23 },
            '4k': { noSound: 67, withSound: 67 },
        },
    },
    'minimax-h3': {
        id: 'minimax-h3' as const,
        displayName: 'MiniMax H3',
        description: 'Hailuo H3 generation from text, a frame, or references',
        provider: 'minimax' as const,
        apiModelId: 'minimax-h3/text-to-video',
        enhancerModelId: 'minimax-h3',
        supportsMultiShot: false,
        supportsSound: false,
        supportsFixedLens: false,
        aspectRatios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'] as const,
        durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const,
        singleShotDurationRange: {
            min: 4,
            max: 15,
            default: 6,
        } as const,
        modeOptions: [] as const,
        // The provider spells these with an uppercase P; the value is sent verbatim.
        resolutions: ['768P', '2K'] as const,
        // Kie's listed rate. Their "Pricing is 50% of the official price" line is a
        // standing discount against MiniMax's own API, not a dated offer.
        pricing: {
            '768P': 8,
            '2K': 13,
        },
    },
} as const;

export type VideoModelId = keyof typeof VIDEO_MODELS;

export function getVideoElementSupport(
    modelId: VideoModelId,
    options: { mode?: string; isMultiShot?: boolean } = {}
): { enabled: boolean; maxElements: number; maxNamed: number; reason: string | null } {
    // Kling O3 is the one model that carries named subjects across a multi-shot run, so
    // multi-shot no longer disables references for everything indiscriminately.
    if (options.isMultiShot && modelId !== 'kling-o3') {
        return {
            enabled: false,
            maxElements: 0,
            maxNamed: 0,
            reason: 'Reusable references are available in single-shot only.',
        };
    }

    if (modelId === 'seedance-1.5-pro') {
        return {
            enabled: true,
            maxElements: 2,
            maxNamed: 2,
            reason: null,
        };
    }

    if (modelId === 'seedance-2' || modelId === 'seedance-2-fast' || modelId === 'seedance-2-mini' || modelId === 'wan-2.7') {
        return {
            enabled: true,
            maxElements: 5,
            maxNamed: 5,
            reason: null,
        };
    }

    // 2.5's reference_image_urls takes 30 where the rest of the family stops at 5.
    if (modelId === 'seedance-2-5') {
        return { enabled: true, maxElements: 30, maxNamed: 30, reason: null };
    }

    // Kling O3 accepts 7 reference images and names at most 3 of them as subjects the
    // provider resolves natively from @mentions.
    if (modelId === 'kling-o3') {
        return { enabled: true, maxElements: 7, maxNamed: 3, reason: null };
    }

    if (modelId === 'minimax-h3') {
        return { enabled: true, maxElements: 9, maxNamed: 9, reason: null };
    }

    if (modelId === 'happyhorse-1.1') {
        return { enabled: true, maxElements: 9, maxNamed: 9, reason: null };
    }

    if (modelId === 'gemini-omni-video') {
        return { enabled: true, maxElements: 7, maxNamed: 7, reason: null };
    }

    if (modelId === 'veo-3.1') {
        if (options.mode === 'veo3_fast' || options.mode === 'veo3_lite') {
            return {
                enabled: true,
                maxElements: 3,
                maxNamed: 3,
                reason: null,
            };
        }

        return {
            enabled: false,
            maxElements: 0,
            maxNamed: 0,
            reason: 'Reusable references require Veo Lite or Fast.',
        };
    }

    if (modelId === 'grok-imagine-video') {
        return {
            enabled: true,
            maxElements: 1,
            maxNamed: 1,
            reason: null,
        };
    }

    if (modelId === 'kling-3.0-video') {
        return {
            enabled: false,
            maxElements: 0,
            maxNamed: 0,
            reason: 'Reusable image references are not available for Kling yet.',
        };
    }

    return {
        enabled: false,
        maxElements: 0,
        maxNamed: 0,
        reason: 'Reusable references are not available for this model yet.',
    };
}

export function getVideoDurationRange(modelId: VideoModelId): { min: number; max: number; default: number } | null {
    const model = VIDEO_MODELS[modelId];

    if ('singleShotDurationRange' in model) {
        return model.singleShotDurationRange;
    }

    return null;
}

export function getDefaultVideoDuration(modelId: VideoModelId): number {
    return getVideoDurationRange(modelId)?.default ?? VIDEO_MODELS[modelId].durations[0];
}

export function isValidVideoDuration(modelId: VideoModelId, durationSeconds: number): boolean {
    const range = getVideoDurationRange(modelId);

    if (range) {
        return durationSeconds >= range.min && durationSeconds <= range.max;
    }

    return (VIDEO_MODELS[modelId].durations as readonly number[]).includes(durationSeconds);
}

export function clampVideoDuration(modelId: VideoModelId, durationSeconds: number): number {
    const range = getVideoDurationRange(modelId);

    if (range) {
        return Math.min(range.max, Math.max(range.min, durationSeconds));
    }

    return isValidVideoDuration(modelId, durationSeconds)
        ? durationSeconds
        : VIDEO_MODELS[modelId].durations[0];
}

// ─── Audio Models (ElevenLabs via KIE) ───────────────────────────────────────

export const VOICEOVER_MODELS = {
    'text-to-speech-turbo-2-5': {
        id: 'text-to-speech-turbo-2-5' as const,
        displayName: 'ElevenLabs TTS Turbo 2.5',
        description: 'Fast single-speaker text-to-speech',
        apiModelId: 'elevenlabs/text-to-speech-turbo-2-5',
        pricingPerThousandCharacters: 6,
        supportsDialogue: false,
    },
    'text-to-speech-multilingual-v2': {
        id: 'text-to-speech-multilingual-v2' as const,
        displayName: 'ElevenLabs TTS Multilingual V2',
        description: 'Higher-quality multilingual text-to-speech',
        apiModelId: 'elevenlabs/text-to-speech-multilingual-v2',
        pricingPerThousandCharacters: 12,
        supportsDialogue: false,
    },
    'text-to-dialogue-v3': {
        id: 'text-to-dialogue-v3' as const,
        displayName: 'ElevenLabs Text-to-Dialogue V3',
        description: 'Multi-speaker dialogue synthesis',
        apiModelId: 'elevenlabs/text-to-dialogue-v3',
        pricingPerThousandCharacters: 14,
        supportsDialogue: true,
    },
} as const;

export type VoiceoverModelId = keyof typeof VOICEOVER_MODELS;

export const SOUND_EFFECT_MODELS = {
    'sound-effect-v2': {
        id: 'sound-effect-v2' as const,
        displayName: 'ElevenLabs Sound Effect V2',
        description: 'Prompt-driven sound effect generation',
        apiModelId: 'elevenlabs/sound-effect-v2',
        pricingPerMinute: 14,
        outputFormats: ['mp3', 'wav'] as const,
    },
} as const;

export type SoundEffectModelId = keyof typeof SOUND_EFFECT_MODELS;

const AUDIO_MODELS = {
    ...VOICEOVER_MODELS,
    ...SOUND_EFFECT_MODELS,
} as const;

export interface DialogueTurnPricingInput {
    text: string;
}

// ─── Pricing Helpers ──────────────────────────────────────────────────────────

/** Calculate credits for a motion generation. */
export function getMotionCost(
    modelId: MotionModelId,
    resolution: '720p' | '1080p',
    durationSeconds: number
): number {
    const model = MOTION_MODELS[modelId];
    const perSecond = model.pricing[resolution];
    return Math.ceil(durationSeconds * perSecond);
}

/** Calculate credits for an image generation. */
export function getImageCost(
    modelId: ImageModelId,
    resolution: ImageResolution,
    options: {
        qualityMode?: ImageQualityMode;
        referenceCount?: number;
    } = {}
): number {
    if (modelId === 'grok-imagine-image') {
        const pricing = IMAGE_MODELS['grok-imagine-image'].qualityPricing;
        if ((options.referenceCount ?? 0) > 0) {
            return pricing.imageToImage;
        }

        return options.qualityMode === 'quality' ? pricing.quality : pricing.standard;
    }

    if (modelId === 'ideogram-v3' || modelId === 'ideogram-character') {
        const pricing = IMAGE_MODELS[modelId].qualityPricing;
        const qualityMode = options.qualityMode === 'quality'
            ? 'quality'
            : options.qualityMode === 'balanced'
                ? 'balanced'
                : 'turbo';
        return pricing[qualityMode];
    }

    if (modelId === 'seedream-5-pro' || modelId === 'qwen3' || modelId === 'qwen3-pro') {
        const model = IMAGE_MODELS[modelId];
        const baseCost = (model.pricing as Partial<Record<ImageResolution, number>>)[resolution] ?? model.pricing['1K'];
        // Seedream bundles the first reference into the base price; Qwen bills every one.
        const freeReferences = 'referenceCreditIncludesFirst' in model && model.referenceCreditIncludesFirst ? 0 : 1;
        const chargeableReferences = Math.max(0, (options.referenceCount ?? 0) - freeReferences);
        return Math.ceil(baseCost + (chargeableReferences * model.additionalReferenceCredit));
    }

    const pricing = IMAGE_MODELS[modelId].pricing as Partial<Record<ImageResolution, number>>;
    return pricing[resolution] ?? pricing[IMAGE_MODELS[modelId].resolutions[0] as ImageResolution] ?? 0;
}

/** Calculate credits for a video generation. */
export function getVideoCost(
    modelId: VideoModelId,
    options: {
        mode?: string;
        sound?: boolean;
        durationSeconds?: number;
        resolution?: string;
        hasReferenceVideo?: boolean;
        hasReferenceImage?: boolean;
    }
): number {
    if (modelId === 'kling-3.0-video') {
        const mode = options.mode === 'pro' ? 'pro' : 'std';
        const durationSeconds = options.durationSeconds ?? 0;
        const pricing = VIDEO_MODELS['kling-3.0-video'].pricing[mode];
        const perSecond = options.sound ? pricing.withSound : pricing.noSound;
        return Math.ceil(durationSeconds * perSecond);
    }

    if (modelId === 'seedance-1.5-pro') {
        const pricingTable = VIDEO_MODELS['seedance-1.5-pro'].pricing;
        const resolution = options.resolution && options.resolution in pricingTable
            ? options.resolution as keyof typeof pricingTable
            : '720p';
        const durationSeconds = Math.round(options.durationSeconds ?? 8) as 4 | 8 | 12;
        const pricing = VIDEO_MODELS['seedance-1.5-pro'].pricing[resolution];
        const durationKey = durationSeconds in pricing.noSound ? durationSeconds : 8;
        return options.sound ? pricing.withSound[durationKey] : pricing.noSound[durationKey];
    }

    if (modelId === 'seedance-2' || modelId === 'seedance-2-fast' || modelId === 'seedance-2-mini' || modelId === 'seedance-2-5') {
        const pricingTable = VIDEO_MODELS[modelId].pricing;
        const resolution = options.resolution && options.resolution in pricingTable
            ? options.resolution as keyof typeof pricingTable
            : '720p';
        const durationSeconds = options.durationSeconds ?? getDefaultVideoDuration(modelId);
        const pricing = pricingTable[resolution];
        const perSecond = options.hasReferenceVideo ? pricing.withVideo : pricing.noVideo;
        return Math.ceil(durationSeconds * perSecond);
    }

    if (modelId === 'kling-o3') {
        const pricingTable = VIDEO_MODELS['kling-o3'].pricing;
        const resolution = options.resolution && options.resolution in pricingTable
            ? options.resolution as keyof typeof pricingTable
            : '720p';
        const durationSeconds = options.durationSeconds ?? getDefaultVideoDuration(modelId);
        const pricing = pricingTable[resolution];
        return Math.ceil(durationSeconds * (options.sound ? pricing.withSound : pricing.noSound));
    }

    if (modelId === 'minimax-h3') {
        const pricingTable = VIDEO_MODELS['minimax-h3'].pricing;
        const resolution = options.resolution && options.resolution in pricingTable
            ? options.resolution as keyof typeof pricingTable
            : '768P';
        const durationSeconds = options.durationSeconds ?? getDefaultVideoDuration(modelId);
        return Math.ceil(durationSeconds * pricingTable[resolution]);
    }

    if (modelId === 'kling-3.0-turbo' || modelId === 'wan-2.7') {
        const pricingTable = VIDEO_MODELS[modelId].pricing;
        const resolution = options.resolution && options.resolution in pricingTable
            ? options.resolution as keyof typeof pricingTable
            : '720p';
        const durationSeconds = options.durationSeconds ?? getDefaultVideoDuration(modelId);
        return Math.ceil(durationSeconds * pricingTable[resolution]);
    }

    if (modelId === 'happyhorse-1.1') {
        const pricing = VIDEO_MODELS['happyhorse-1.1'].pricing;
        const resolution = options.resolution === '1080p' ? '1080p' : '720p';
        return Math.ceil((options.durationSeconds ?? 5) * pricing[resolution]);
    }

    if (modelId === 'gemini-omni-video') {
        const pricing = VIDEO_MODELS['gemini-omni-video'].pricing;
        const resolution = options.resolution === '4k' ? '4k' : options.resolution === '1080p' ? '1080p' : '720p';
        if (options.hasReferenceVideo) {
            return pricing.withVideo[resolution === '4k' ? '4k' : 'standard'];
        }
        const duration = ([4, 6, 8, 10] as const).includes(options.durationSeconds as 4 | 6 | 8 | 10)
            ? options.durationSeconds as 4 | 6 | 8 | 10
            : 4;
        return pricing[resolution][duration];
    }

    if (modelId === 'hailuo-2.3') {
        const mode = options.mode === 'pro' ? 'pro' : 'standard';
        const resolution = options.resolution === '1080P' ? '1080P' : '768P';
        const duration = options.durationSeconds === 10 ? 10 : 6;
        const table = VIDEO_MODELS['hailuo-2.3'].pricing[mode][resolution];
        return duration in table ? table[duration as keyof typeof table] : table[6];
    }

    if (modelId === 'grok-imagine-video') {
        const pricingTable = VIDEO_MODELS['grok-imagine-video'].pricing;
        const resolution = options.resolution && options.resolution in pricingTable
            ? options.resolution as keyof typeof pricingTable
            : '480p';
        const durationSeconds = options.durationSeconds ?? getDefaultVideoDuration(modelId);
        return Math.ceil(durationSeconds * pricingTable[resolution]);
    }

    if (modelId === 'veo-3.1') {
        const resolution = options.resolution === '1080p' || options.resolution === '4k'
            ? options.resolution
            : '720p';
        if (options.mode === 'veo3') {
            const variant = options.hasReferenceImage ? 'reference' : 'text';
            return VIDEO_MODELS['veo-3.1'].pricing.veo3[variant][resolution];
        }
        const mode = options.mode === 'veo3_lite' ? 'veo3_lite' : 'veo3_fast';
        return VIDEO_MODELS['veo-3.1'].pricing[mode][resolution];
    }

    // Every model must be matched explicitly. This used to fall through to Veo
    // pricing, which silently billed unmatched models at 30-250 credits/gen.
    throw new Error(`getVideoCost has no pricing branch for video model: ${modelId satisfies never}`);
}

/** Calculate credits for a voiceover generation. */
export function getVoiceoverCost(
    modelId: VoiceoverModelId,
    options: {
        text?: string;
        dialogueTurns?: DialogueTurnPricingInput[];
    }
): number {
    const model = VOICEOVER_MODELS[modelId];
    const characterCount = model.supportsDialogue
        ? (options.dialogueTurns || []).reduce((total, turn) => total + turn.text.trim().length, 0)
        : (options.text || '').trim().length;

    return Math.ceil((characterCount * model.pricingPerThousandCharacters) / 1000);
}

/** Calculate credits for a sound-effect generation. */
export function getSoundEffectCost(
    modelId: SoundEffectModelId,
    durationSeconds: number
): number {
    const model = SOUND_EFFECT_MODELS[modelId];
    return Math.ceil((durationSeconds * model.pricingPerMinute) / 60);
}

// ─── Helpers to check model type ──────────────────────────────────────────────

/** Returns true if the model ID is an image model. */
export function isImageModel(modelId: string): boolean {
    return modelId in IMAGE_MODELS;
}

/** Returns true if the model ID is a motion model. */
export function isMotionModel(modelId: string): boolean {
    return modelId in MOTION_MODELS;
}

/** Returns true if the model ID is a video model. */
export function isVideoModel(modelId: string): boolean {
    return modelId in VIDEO_MODELS;
}

/** Returns true if the model ID is an audio model or audio provider ID. */
export function isAudioModel(modelId: string): boolean {
    if (modelId in AUDIO_MODELS) {
        return true;
    }

    return Object.values(AUDIO_MODELS).some((model) => model.apiModelId === modelId);
}
