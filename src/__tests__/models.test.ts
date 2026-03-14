import { describe, it, expect } from 'vitest';
import { getMotionCost, getImageCost, getVideoCost, isImageModel, isMotionModel } from '@/lib/models';

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
            expect(getVideoCost('std', false, 5)).toBe(100); // 5 * 20
        });
        it('std mode with sound', () => {
            expect(getVideoCost('std', true, 5)).toBe(150); // 5 * 30
        });
        it('pro mode without sound', () => {
            expect(getVideoCost('pro', false, 10)).toBe(270); // 10 * 27
        });
        it('pro mode with sound', () => {
            expect(getVideoCost('pro', true, 10)).toBe(400); // 10 * 40
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
});
