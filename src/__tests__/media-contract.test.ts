import { describe, expect, it } from 'vitest';

import {
  classifyVisualMedia,
  normalizeVisualCategory,
} from '@/lib/media-contract';
import { buildVisualMediaDescriptor } from '@/lib/media-descriptor';

describe('canonical visual media contract', () => {
  it('exposes only image, video, and text categories', () => {
    expect(normalizeVisualCategory({ category: 'motion', contentType: 'video/mp4' })).toBe('video');
    expect(normalizeVisualCategory({ category: 'ugc-ad', contentType: 'image/jpeg' })).toBe('image');
    expect(normalizeVisualCategory({ category: 'ugc-ad', contentType: 'video/mp4' })).toBe('video');
    expect(normalizeVisualCategory({ category: 'text', contentType: null })).toBe('text');
  });

  it('keeps motion as creation metadata while rendering it as video', () => {
    expect(classifyVisualMedia({ category: 'motion', contentType: 'video/mp4' })).toEqual({
      category: 'video',
      kind: 'video',
      creationMode: 'motion',
    });
  });

  it('never promotes audio into a visual feed item', () => {
    expect(classifyVisualMedia({ category: 'audio', contentType: 'audio/mpeg' })).toBeNull();
  });
});

describe('visual media descriptor', () => {
  it('uses storage identity as the cache key instead of an expiring URL', () => {
    const descriptor = buildVisualMediaDescriptor({
      id: 'gen-1',
      kind: 'video',
      url: 'https://signed.example.com/output.mp4?token=short-lived',
      storageKey: 'generated_videos/user-1/output.mp4',
      previewUrl: 'https://signed.example.com/output.webp?token=short-lived',
      previewStorageKey: 'generated_videos/user-1/output.preview.abc.webp',
      previewThumbhash: 'thumbhash-base64',
      previewStatus: 'ready',
      expiresAt: '2026-06-19T12:55:00.000Z',
      width: 1080,
      height: 1350,
      durationSeconds: 5,
    });

    expect(descriptor.cacheKey).toBe('generated_videos/user-1/output.preview.abc.webp');
    expect(descriptor.gridReady).toBe(true);
    expect(descriptor.expiresAt).toBe('2026-06-19T12:55:00.000Z');
  });

  it('keeps unfinished previews out of visual grids', () => {
    expect(buildVisualMediaDescriptor({
      id: 'gen-2',
      kind: 'image',
      url: 'https://signed.example.com/output.jpg',
      storageKey: 'generated_images/user-1/output.jpg',
      previewUrl: null,
      previewStorageKey: null,
      previewThumbhash: null,
      previewStatus: 'processing',
      expiresAt: null,
      width: null,
      height: null,
      durationSeconds: null,
    }).gridReady).toBe(false);
  });
});
