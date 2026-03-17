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
        badgeColor: 'from-purple-500 to-pink-500',
        apiModelId: 'kling-2.6/motion-control',
        maxDuration: 30,
        characterOrientations: ['video', 'image'] as const,
        resolutions: ['720p', '1080p'] as const,
        /** Credits per second of output video */
        pricing: {
            '720p': 6,
            '1080p': 9,
        },
    },
    'kling-3.0': {
        id: 'kling-3.0' as const,
        displayName: 'Kling 3.0',
        description: 'Latest model — enhanced fidelity and motion accuracy',
        badge: 'New',
        badgeColor: 'from-violet-500 to-indigo-500',
        apiModelId: 'kling-3.0/motion-control',
        maxDuration: 30,
        characterOrientations: ['video', 'image'] as const,
        resolutions: ['720p', '1080p'] as const,
        pricing: {
            '720p': 12,
            '1080p': 20,
        },
    },
} as const;

export type MotionModelId = keyof typeof MOTION_MODELS;

// ─── Image Models (Nano Banana) ───────────────────────────────────────────────

export const IMAGE_MODELS = {
    'nano-banana-2': {
        id: 'nano-banana-2' as const,
        displayName: 'Nano Banana 2.0',
        description: 'Versatile image gen with Google Search grounding',
        badge: 'Recommended',
        badgeColor: 'from-blue-500 to-cyan-500',
        accentColor: 'blue',
        maxImages: 14,
        supportsGoogleSearch: true,
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
        badgeColor: 'from-violet-500 to-purple-500',
        accentColor: 'violet',
        maxImages: 8,
        supportsGoogleSearch: false,
        aspectRatios: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9', 'auto'] as const,
        resolutions: ['1K', '2K', '4K'] as const,
        outputFormats: ['jpg', 'png'] as const,
        pricing: {
            '1K': 18,
            '2K': 18,
            '4K': 24,
        },
    },
} as const;

export type ImageModelId = keyof typeof IMAGE_MODELS;

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
        resolutions: [] as const,
        modeOptions: [
            { value: 'std', label: 'Standard (720p)' },
            { value: 'pro', label: 'Pro (1080p, High Quality)' },
        ] as const,
        /** Credits per second, keyed by mode + sound */
        pricing: {
            std: { noSound: 20, withSound: 30 },
            pro: { noSound: 27, withSound: 40 },
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
        resolutions: [] as const,
        modeOptions: [
            { value: 'veo3_fast', label: 'Fast' },
            { value: 'veo3', label: 'Quality' },
        ] as const,
        pricing: {
            veo3_fast: 60,
            veo3: 250,
        },
    },
} as const;

export type VideoModelId = keyof typeof VIDEO_MODELS;

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
    resolution: '1K' | '2K' | '4K'
): number {
    return IMAGE_MODELS[modelId].pricing[resolution];
}

/** Calculate credits for a video generation. */
export function getVideoCost(
    modelId: VideoModelId,
    options: {
        mode?: string;
        sound?: boolean;
        durationSeconds?: number;
        resolution?: string;
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

    const mode = options.mode === 'veo3' ? 'veo3' : 'veo3_fast';
    return VIDEO_MODELS['veo-3.1'].pricing[mode];
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
