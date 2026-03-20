import { describe, it, expect } from 'vitest';
import { getDefaultVideoDuration, getMotionCost, getImageCost, getSoundEffectCost, getVideoCost, getVideoDurationRange, getVoiceoverCost, isAudioModel, isImageModel, isMotionModel, isValidVideoDuration } from '@/lib/models';

describe('Model Pricing', () => {
    describe('getMotionCost', () => {
        it('calculates Kling 2.6 720p cost', () => {
            expect(getMotionCost('kling-2.6', '720p', 10)).toBe(60);
        });
        it('calculates Kling 2.6 1080p cost', () => {
            expect(getMotionCost('kling-2.6', '1080p', 10)).toBe(90);
        });
        it('calculates Kling 3.0 720p cost', () => {
            expect(getMotionCost('kling-3.0', '720p', 10)).toBe(120);
        });
        it('calculates Kling 3.0 1080p cost', () => {
            expect(getMotionCost('kling-3.0', '1080p', 10)).toBe(200);
        });
        it('rounds up fractional costs', () => {
            expect(getMotionCost('kling-2.6', '720p', 3.5)).toBe(21); // 3.5 * 6 = 21
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
    });

    describe('getVideoCost', () => {
        it('std mode without sound', () => {
            expect(getVideoCost('kling-3.0-video', { mode: 'std', sound: false, durationSeconds: 5 })).toBe(100);
        });
        it('std mode with sound', () => {
            expect(getVideoCost('kling-3.0-video', { mode: 'std', sound: true, durationSeconds: 5 })).toBe(150);
        });
        it('pro mode without sound', () => {
            expect(getVideoCost('kling-3.0-video', { mode: 'pro', sound: false, durationSeconds: 10 })).toBe(270);
        });
        it('pro mode with sound', () => {
            expect(getVideoCost('kling-3.0-video', { mode: 'pro', sound: true, durationSeconds: 10 })).toBe(400);
        });
        it('supports variable Kling durations within the allowed range', () => {
            expect(isValidVideoDuration('kling-3.0-video', 7)).toBe(true);
            expect(getVideoCost('kling-3.0-video', { mode: 'std', sound: false, durationSeconds: 7 })).toBe(140);
        });
        it('seedance 720p 8s without sound', () => {
            expect(getVideoCost('seedance-1.5-pro', { resolution: '720p', sound: false, durationSeconds: 8 })).toBe(28);
        });
        it('seedance 1080p 12s with sound', () => {
            expect(getVideoCost('seedance-1.5-pro', { resolution: '1080p', sound: true, durationSeconds: 12 })).toBe(180);
        });
        it('veo 3.1 fast has flat pricing', () => {
            expect(getVideoCost('veo-3.1', { mode: 'veo3_fast' })).toBe(60);
        });
        it('veo 3.1 quality has flat pricing', () => {
            expect(getVideoCost('veo-3.1', { mode: 'veo3' })).toBe(250);
        });
    });

    describe('video duration metadata', () => {
        it('exposes the Kling single-shot range and default duration', () => {
            expect(getVideoDurationRange('kling-3.0-video')).toEqual({ min: 3, max: 15, default: 5 });
            expect(getDefaultVideoDuration('kling-3.0-video')).toBe(5);
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
        expect(isImageModel('nano-banana-2')).toBe(true);
        expect(isImageModel('nano-banana-pro')).toBe(true);
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
});
