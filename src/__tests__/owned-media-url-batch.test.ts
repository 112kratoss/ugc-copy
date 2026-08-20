import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveOwnedStoredMediaUrlMap } from '@/lib/owned-media-url-batch';

describe('owned media URL batching', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('deduplicates paths and signs once per bucket while preserving safe remote URLs', async () => {
    const signers = new Map<string, ReturnType<typeof vi.fn>>();
    const storageFrom = vi.fn((bucket: string) => {
      const createSignedUrls = vi.fn(async (paths: string[], expiresIn: number) => ({
        data: paths.map((path) => ({
          error: null,
          path,
          signedUrl: `https://signed.example.com/${bucket}/${path}?expires=${expiresIn}`,
        })),
        error: null,
      }));
      signers.set(bucket, createSignedUrls);
      return { createSignedUrls };
    });

    const result = await resolveOwnedStoredMediaUrlMap({
      supabase: { storage: { from: storageFrom } } as never,
      outputUrls: [
        'generated_images/user-1/image.png',
        'generated_images/user-1/image.png',
        'generated_videos/user-1/video.mp4',
        'https://provider.example.com/result.jpg',
      ],
      ownerUserIds: ['user-1'],
    });

    expect(storageFrom).toHaveBeenCalledTimes(2);
    expect(signers.get('generated_images')).toHaveBeenCalledWith(['user-1/image.png'], 3600);
    expect(signers.get('generated_videos')).toHaveBeenCalledWith(['user-1/video.mp4'], 3600);
    expect(result.get('generated_images/user-1/image.png')).toBe(
      'https://signed.example.com/generated_images/user-1/image.png?expires=3600',
    );
    expect(result.get('https://provider.example.com/result.jpg')).toBe(
      'https://provider.example.com/result.jpg',
    );
  });

  it('rejects cross-owner paths and keeps the media proxy fallback on signing failure', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const createSignedUrls = vi.fn(async () => ({
      data: [{
        error: 'Object not found',
        path: 'user-1/missing.png',
        signedUrl: null,
      }],
      error: null,
    }));

    const result = await resolveOwnedStoredMediaUrlMap({
      supabase: {
        storage: { from: vi.fn(() => ({ createSignedUrls })) },
      } as never,
      outputUrls: [
        'generated_images/user-1/missing.png',
        'generated_images/user-2/private.png',
        'http://provider.example.com/insecure.jpg',
        'https://user:password@provider.example.com/credentialed.jpg',
      ],
      ownerUserIds: ['user-1'],
    });

    expect(createSignedUrls).toHaveBeenCalledWith(['user-1/missing.png'], 3600);
    expect(result.get('generated_images/user-1/missing.png')).toBe(
      '/api/media?bucket=generated_images&path=user-1%2Fmissing.png',
    );
    expect(result.get('generated_images/user-2/private.png')).toBeNull();
    expect(result.get('http://provider.example.com/insecure.jpg')).toBeNull();
    expect(result.get('https://user:password@provider.example.com/credentialed.jpg')).toBeNull();
    const refusalLog = JSON.parse(consoleError.mock.calls[0][0] as string);
    expect(refusalLog.msg).toBe('refused_to_sign_media_outside_owner_prefix');
    expect(refusalLog.message).toBe(
      'Refused to sign media outside owner prefix: generated_images/user-2/private.png',
    );
  });

  it('signs canonical media owned by a linked guest and rejects encoded owner changes', async () => {
    const createSignedUrls = vi.fn(async (paths: string[]) => ({
      data: paths.map((path) => ({ path, signedUrl: `https://signed.example/${path}`, error: null })),
      error: null,
    }));
    const result = await resolveOwnedStoredMediaUrlMap({
      supabase: {
        storage: { from: vi.fn(() => ({ createSignedUrls })) },
      } as never,
      outputUrls: [
        'generated_images/guest-1/linked.png',
        'generated_images/guest-1%252fother/private.png',
      ],
      ownerUserIds: ['user-1', 'guest-1'],
    });

    expect(createSignedUrls).toHaveBeenCalledWith(['guest-1/linked.png'], 3600);
    expect(result.get('generated_images/guest-1/linked.png')).toBe(
      'https://signed.example/guest-1/linked.png',
    );
    expect(result.get('generated_images/guest-1%252fother/private.png')).toBeNull();
  });
});
