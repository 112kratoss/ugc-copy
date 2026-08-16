import { describe, it, expect } from 'vitest';
import { getDefaultVideoDuration, getMotionCost, getImageCost, getImageResolutionOptions, getSoundEffectCost, getVideoCost, getVideoDurationRange, getVoiceoverCost, isAudioModel, isImageModel, isMotionModel, isVideoModel, isValidImageResolution, isValidVideoDuration, supportsImageResolutionControl } from '@/lib/models';

describe('Model Pricing', () => {
    describe('getMotionCost', () => {
        it('calculates Kling 2.6 720p cost', () => {
            expect(getMotionCost('kling-2.6', '720p', 10)).toBe(110);
        });
        it('calculates Kling 2.6 1080p cost', () => {
            expect(getMotionCost('kling-2.6', '1080p', 10)).toBe(180);
        });
        it('calculates Kling 3.0 720p cost', () => {
            expect(getMotionCost('kling-3.0', '720p', 10)).toBe(200);
        });
        it('calculates Kling 3.0 1080p cost', () => {
            expect(getMotionCost('kling-3.0', '1080p', 10)).toBe(270);
        });
        it('rounds up fractional costs', () => {
            expect(getMotionCost('kling-2.6', '720p', 3.5)).toBe(39); // 3.5 * 11 = 38.5
        });
    });

    describe('getImageCost', () => {
        it('nano-banana-2 at 1K costs 8 credits', () => {
            expect(getImageCost('nano-banana-2', '1K')).toBe(8);
        });
        it('nano-banana-2 at 2K costs 12 credits', () => {
            expect(getImageCost('nano-banana-2', '2K')).toBe(12);
        });
        it('nano-banana-2 at 4K costs 18 credits', () => {
            expect(getImageCost('nano-banana-2', '4K')).toBe(18);
        });
        it('nano-banana-pro at 1K costs 18 credits', () => {
            expect(getImageCost('nano-banana-pro', '1K')).toBe(18);
        });
        it('nano-banana-pro at 4K costs 24 credits', () => {
            expect(getImageCost('nano-banana-pro', '4K')).toBe(24);
        });
        it('gpt-image-2 has GPT Image 2 pricing tiers', () => {
            expect(getImageCost('gpt-image-2', '1K')).toBe(6);
            expect(getImageCost('gpt-image-2', '2K')).toBe(10);
            expect(getImageCost('gpt-image-2', '4K')).toBe(16);
        });
        it('prices the new Kie image models and rounds Seedream reference surcharges', () => {
            expect(getImageCost('nano-banana-2-lite', '1K')).toBe(4);
            expect(getImageCost('seedream-5-pro', '1K')).toBe(7);
            expect(getImageCost('seedream-5-pro', '1K', { referenceCount: 2 })).toBe(8);
            expect(getImageCost('seedream-5-pro', '1K', { referenceCount: 3 })).toBe(8);
            expect(getImageCost('seedream-5-pro', '2K', { referenceCount: 4 })).toBe(16);
            expect(getImageCost('flux-2-pro', '1K')).toBe(5);
            expect(getImageCost('flux-2-pro', '2K')).toBe(7);
            expect(getImageCost('z-image', '1K')).toBe(1);
        });
        it('bills every Qwen reference, unlike Seedream which bundles the first', () => {
            // Kie: "Input images are charged at 0.5 credits per image" — no free first
            // image, which is the one way Qwen diverges from the Seedream surcharge shape.
            // The surcharge path rounds to whole credits, so a 4.8-credit base bills as 5 —
            // the same value the catalog quote produces, which the parity test pins.
            expect(getImageCost('qwen3', '1K')).toBe(5);
            expect(getImageCost('qwen3', '2K')).toBe(5);
            expect(getImageCost('qwen3', '1K', { referenceCount: 1 })).toBe(6); // ceil(4.8 + 0.5)
            expect(getImageCost('qwen3', '1K', { referenceCount: 4 })).toBe(7); // ceil(4.8 + 2.0)
            // Seedream at the same reference count is cheaper because one ride free.
            expect(getImageCost('seedream-5-pro', '1K', { referenceCount: 1 })).toBe(7);
        });
        it('prices the Qwen Pro tier by resolution', () => {
            expect(getImageCost('qwen3-pro', '1K')).toBe(7); // ceil(6.4)
            expect(getImageCost('qwen3-pro', '2K')).toBe(12);
            expect(getImageCost('qwen3-pro', '2K', { referenceCount: 2 })).toBe(13); // ceil(12 + 1.0)
        });
        it('prices Ideogram Character by rendering speed', () => {
            expect(getImageCost('ideogram-character', '1K', { qualityMode: 'turbo' })).toBe(12);
            expect(getImageCost('ideogram-character', '1K', { qualityMode: 'balanced' })).toBe(18);
            expect(getImageCost('ideogram-character', '1K', { qualityMode: 'quality' })).toBe(24);
        });
        it('prices Grok Imagine 2.0 flat regardless of aspect ratio', () => {
            expect(getImageCost('grok-imagine-image-2', '1K')).toBe(4);
        });
        it('grok image pricing follows quality and reference mode', () => {
            expect(getImageCost('grok-imagine-image', '1K')).toBe(4);
            expect(getImageCost('grok-imagine-image', '1K', { qualityMode: 'quality' })).toBe(5);
            expect(getImageCost('grok-imagine-image', '1K', { qualityMode: 'quality', referenceCount: 1 })).toBe(4);
        });
        it('prices the expanded non-Runway image catalog', () => {
            expect(getImageCost('seedream-5-lite', '3K')).toBe(5.5);
            expect(getImageCost('wan-2.7-image', '2K')).toBe(4.8);
            expect(getImageCost('wan-2.7-image-pro', '4K')).toBe(12);
            expect(getImageCost('imagen-4-fast', '1K')).toBe(4);
            expect(getImageCost('imagen-4', '1K')).toBe(8);
            expect(getImageCost('imagen-4-ultra', '1K')).toBe(12);
            expect(getImageCost('ideogram-v3', '1K', { qualityMode: 'turbo' })).toBe(3.5);
            expect(getImageCost('ideogram-v3', '1K', { qualityMode: 'balanced' })).toBe(7);
            expect(getImageCost('ideogram-v3', '1K', { qualityMode: 'quality' })).toBe(10);
        });
    });

    describe('image resolution metadata', () => {
        it('limits GPT Image 2 auto and square resolution combinations', () => {
            expect(getImageResolutionOptions('gpt-image-2', 'auto')).toEqual(['1K']);
            expect(getImageResolutionOptions('gpt-image-2', '1:1')).toEqual(['1K', '2K']);
            expect(getImageResolutionOptions('gpt-image-2', '4:5')).toEqual(['1K', '2K', '4K']);
            expect(isValidImageResolution('gpt-image-2', '4K', '1:1')).toBe(false);
            expect(isValidImageResolution('gpt-image-2', '4K', '4:5')).toBe(true);
        });

        it('keeps existing image model resolution options unchanged', () => {
            expect(getImageResolutionOptions('nano-banana-2', 'auto')).toEqual(['1K', '2K', '4K']);
            expect(isValidImageResolution('nano-banana-pro', '4K', '1:1')).toBe(true);
        });

        it('hides Grok image resolution controls behind a fixed backend placeholder', () => {
            expect(getImageResolutionOptions('grok-imagine-image', '3:2')).toEqual(['1K']);
            expect(isValidImageResolution('grok-imagine-image', '2K', '3:2')).toBe(false);
            expect(supportsImageResolutionControl('grok-imagine-image')).toBe(false);
        });
    });

    describe('getVideoCost', () => {
        it('std mode without sound', () => {
            expect(getVideoCost('kling-3.0-video', { mode: 'std', sound: false, durationSeconds: 5 })).toBe(70);
        });
        it('std mode with sound', () => {
            expect(getVideoCost('kling-3.0-video', { mode: 'std', sound: true, durationSeconds: 5 })).toBe(100);
        });
        it('pro mode without sound', () => {
            expect(getVideoCost('kling-3.0-video', { mode: 'pro', sound: false, durationSeconds: 10 })).toBe(180);
        });
        it('pro mode with sound', () => {
            expect(getVideoCost('kling-3.0-video', { mode: 'pro', sound: true, durationSeconds: 10 })).toBe(270);
        });
        it('supports variable Kling durations within the allowed range', () => {
            expect(isValidVideoDuration('kling-3.0-video', 7)).toBe(true);
            expect(getVideoCost('kling-3.0-video', { mode: 'std', sound: false, durationSeconds: 7 })).toBe(98);
        });
        it('seedance 720p 8s without sound', () => {
            expect(getVideoCost('seedance-1.5-pro', { resolution: '720p', sound: false, durationSeconds: 8 })).toBe(28);
        });
        it('seedance 1080p 12s with sound', () => {
            expect(getVideoCost('seedance-1.5-pro', { resolution: '1080p', sound: true, durationSeconds: 12 })).toBe(180);
        });
        it('seedance 2 720p 12s without reference video uses the base tier', () => {
            expect(getVideoCost('seedance-2', { resolution: '720p', durationSeconds: 12 })).toBe(492);
        });
        it('seedance 2 quotes the current Kie 1080p and 4K tiers', () => {
            expect(getVideoCost('seedance-2', { resolution: '1080p', durationSeconds: 7 })).toBe(714);
            expect(getVideoCost('seedance-2', { resolution: '4k', durationSeconds: 7 })).toBe(1456);
            expect(getVideoCost('seedance-2', { resolution: '1080p', durationSeconds: 7, hasReferenceVideo: true })).toBe(434);
            expect(getVideoCost('seedance-2', { resolution: '4k', durationSeconds: 7, hasReferenceVideo: true })).toBe(896);
        });
        it('seedance 2 fast 480p 12s with reference video uses the lower tier', () => {
            expect(getVideoCost('seedance-2-fast', { resolution: '480p', durationSeconds: 12, hasReferenceVideo: true })).toBe(108);
        });
        it('prices seedance 2.5 from its own 480p/720p tiers', () => {
            // 720p noVideo 63/s, withVideo 38/s; 480p 28/s and 17/s.
            expect(getVideoCost('seedance-2-5', { resolution: '720p', durationSeconds: 10 })).toBe(630);
            expect(getVideoCost('seedance-2-5', { resolution: '720p', durationSeconds: 10, hasReferenceVideo: true })).toBe(380);
            expect(getVideoCost('seedance-2-5', { resolution: '480p', durationSeconds: 4 })).toBe(112);
            expect(getVideoCost('seedance-2-5', { resolution: '480p', durationSeconds: 4, hasReferenceVideo: true })).toBe(68);
        });
        it('prices seedance 2.5 across its full 30-second range', () => {
            // Regression guard: 2.5 generates up to 30s where the rest of the family stops at 15.
            expect(getVideoCost('seedance-2-5', { resolution: '480p', durationSeconds: 30 })).toBe(840);
        });
        it('prices kling o3 by resolution and native audio', () => {
            expect(getVideoCost('kling-o3', { resolution: '720p', durationSeconds: 3 })).toBe(42);
            expect(getVideoCost('kling-o3', { resolution: '1080p', durationSeconds: 10, sound: true })).toBe(230);
            expect(getVideoCost('kling-o3', { resolution: '1080p', durationSeconds: 10 })).toBe(180);
            // 4K bills the same with or without audio.
            expect(getVideoCost('kling-o3', { resolution: '4k', durationSeconds: 5, sound: true })).toBe(335);
            expect(getVideoCost('kling-o3', { resolution: '4k', durationSeconds: 5 })).toBe(335);
        });
        it('undercuts kling 3.0 at 1080p with sound, which is why o3 exists', () => {
            const o3 = getVideoCost('kling-o3', { resolution: '1080p', durationSeconds: 10, sound: true });
            const kling3 = getVideoCost('kling-3.0-video', { mode: 'pro', durationSeconds: 10, sound: true });
            expect(o3).toBeLessThan(kling3);
        });
        it('prices minimax h3 from its uppercase resolution enum', () => {
            expect(getVideoCost('minimax-h3', { resolution: '768P', durationSeconds: 6 })).toBe(96);
            expect(getVideoCost('minimax-h3', { resolution: '2K', durationSeconds: 6 })).toBe(156);
        });
        it('never falls through new video models to Veo pricing', () => {
            // getVideoCost has no default branch: an unmatched id silently bills at Veo
            // rates, which are an order of magnitude higher than these models.
            for (const modelId of ['seedance-2-5', 'kling-o3', 'minimax-h3'] as const) {
                const veoFallthrough = getVideoCost('veo-3.1', { resolution: '720p', durationSeconds: 1 });
                expect(getVideoCost(modelId, { durationSeconds: 1 })).not.toBe(veoFallthrough);
            }
        });
        it('prices the new Kie video models from their provider tiers', () => {
            expect(getVideoCost('seedance-2-mini', { resolution: '720p', durationSeconds: 10 })).toBe(205);
            expect(getVideoCost('seedance-2-mini', { resolution: '480p', durationSeconds: 10, hasReferenceVideo: true })).toBe(60);
            expect(getVideoCost('kling-3.0-turbo', { resolution: '1080p', durationSeconds: 5 })).toBe(113);
            expect(getVideoCost('wan-2.7', { resolution: '720p', durationSeconds: 5 })).toBe(80);
            expect(getVideoCost('hailuo-2.3', { mode: 'standard', resolution: '768P', durationSeconds: 10 })).toBe(50);
            expect(getVideoCost('hailuo-2.3', { mode: 'pro', resolution: '1080P', durationSeconds: 6 })).toBe(80);
        });
        it('prices HappyHorse per second and Gemini Omni by input mode', () => {
            expect(getVideoCost('happyhorse-1.1', { resolution: '720p', durationSeconds: 5 })).toBe(113);
            expect(getVideoCost('happyhorse-1.1', { resolution: '1080p', durationSeconds: 5 })).toBe(145);
            expect(getVideoCost('gemini-omni-video', { resolution: '1080p', durationSeconds: 8 })).toBe(105);
            expect(getVideoCost('gemini-omni-video', { resolution: '4k', durationSeconds: 10 })).toBe(210);
            expect(getVideoCost('gemini-omni-video', { resolution: '720p', durationSeconds: 4, hasReferenceVideo: true })).toBe(168);
            expect(getVideoCost('gemini-omni-video', { resolution: '4k', durationSeconds: 4, hasReferenceVideo: true })).toBe(252);
        });
        it('veo 3.1 fast has flat pricing', () => {
            expect(getVideoCost('veo-3.1', { mode: 'veo3_fast' })).toBe(60);
        });
        it('veo 3.1 quality has flat pricing', () => {
            expect(getVideoCost('veo-3.1', { mode: 'veo3' })).toBe(250);
        });
        it('prices Veo Lite and resolution-aware Veo output', () => {
            expect(getVideoCost('veo-3.1', { mode: 'veo3_lite', resolution: '1080p' })).toBe(35);
            expect(getVideoCost('veo-3.1', { mode: 'veo3_fast', resolution: '4k' })).toBe(180);
            expect(getVideoCost('veo-3.1', { mode: 'veo3', resolution: '4k' })).toBe(380);
            expect(getVideoCost('veo-3.1', { mode: 'veo3', resolution: '4k', hasReferenceImage: true })).toBe(370);
        });
        it('grok video scales by duration and resolution', () => {
            expect(getVideoCost('grok-imagine-video', { resolution: '480p', durationSeconds: 6 })).toBe(10);
            expect(getVideoCost('grok-imagine-video', { resolution: '720p', durationSeconds: 10 })).toBe(30);
        });
    });

    describe('video duration metadata', () => {
        it('exposes the Kling single-shot range and default duration', () => {
            expect(getVideoDurationRange('kling-3.0-video')).toEqual({ min: 3, max: 15, default: 5 });
            expect(getDefaultVideoDuration('kling-3.0-video')).toBe(5);
        });

        it('exposes the Seedance 2 single-shot range and default duration', () => {
            expect(getVideoDurationRange('seedance-2')).toEqual({ min: 4, max: 15, default: 15 });
            expect(getDefaultVideoDuration('seedance-2-fast')).toBe(15);
            expect(isValidVideoDuration('seedance-2', 16)).toBe(false);
        });

        it('exposes the Grok Imagine Video duration range and default duration', () => {
            expect(getVideoDurationRange('grok-imagine-video')).toEqual({ min: 6, max: 30, default: 6 });
            expect(getDefaultVideoDuration('grok-imagine-video')).toBe(6);
            expect(isValidVideoDuration('grok-imagine-video', 31)).toBe(false);
        });
    });

    describe('getVoiceoverCost', () => {
        it('turbo rounds up character-based cost', () => {
            expect(getVoiceoverCost('text-to-speech-turbo-2-5', { text: 'a'.repeat(1001) })).toBe(7);
        });

        it('multilingual uses its higher per-1k rate', () => {
            expect(getVoiceoverCost('text-to-speech-multilingual-v2', { text: 'a'.repeat(1000) })).toBe(12);
        });

        it('dialogue sums turn text only', () => {
            expect(getVoiceoverCost('text-to-dialogue-v3', {
                dialogueTurns: [
                    { text: 'Hello there' },
                    { text: 'General Kenobi' },
                ],
            })).toBe(1);
        });
    });

    describe('getSoundEffectCost', () => {
        it('rounds up per-minute SFX pricing', () => {
            expect(getSoundEffectCost('sound-effect-v2', 5)).toBe(2);
        });
    });
});

describe('Model Type Checks', () => {
    it('identifies image models correctly', () => {
        expect(isImageModel('nano-banana-2-lite')).toBe(true);
        expect(isImageModel('nano-banana-2')).toBe(true);
        expect(isImageModel('nano-banana-pro')).toBe(true);
        expect(isImageModel('gpt-image-2')).toBe(true);
        expect(isImageModel('seedream-5-pro')).toBe(true);
        expect(isImageModel('flux-2-pro')).toBe(true);
        expect(isImageModel('z-image')).toBe(true);
        expect(isImageModel('grok-imagine-image')).toBe(true);
        expect(isImageModel('kling-2.6')).toBe(false);
    });

    it('identifies motion models correctly', () => {
        expect(isMotionModel('kling-2.6')).toBe(true);
        expect(isMotionModel('kling-3.0')).toBe(true);
        expect(isMotionModel('nano-banana-2')).toBe(false);
    });

    it('identifies audio models correctly', () => {
        expect(isAudioModel('text-to-speech-turbo-2-5')).toBe(true);
        expect(isAudioModel('elevenlabs/text-to-dialogue-v3')).toBe(true);
        expect(isAudioModel('kling-3.0/video')).toBe(false);
    });

    it('identifies video models correctly', () => {
        expect(isVideoModel('grok-imagine-video')).toBe(true);
        expect(isVideoModel('seedance-2-mini')).toBe(true);
        expect(isVideoModel('kling-3.0-turbo')).toBe(true);
        expect(isVideoModel('wan-2.7')).toBe(true);
        expect(isVideoModel('hailuo-2.3')).toBe(true);
        expect(isVideoModel('grok-imagine-image')).toBe(false);
    });
});
