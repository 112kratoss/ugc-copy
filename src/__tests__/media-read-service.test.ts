import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import {
  createMediaReadSignedUrlForRoute,
  parseMediaReadRoutePayload,
} from '@/lib/media-read-service';

function createClients({
  allowed = true,
  signedUrl = 'https://project.supabase.co/storage/v1/object/sign/generated_images/user/file.jpg?token=abc',
  storageError = null as Error | null,
} = {}) {
  const rpc = vi.fn(async () => ({
    data: {
      allowed,
      limit: 300,
      remaining: allowed ? 299 : 0,
      retryAfterSeconds: allowed ? 0 : 25,
      resetAt: '2026-06-22T06:30:00.000Z',
    },
    error: null,
  }));
  const createSignedUrl = vi.fn(async () => ({
    data: storageError ? null : { signedUrl },
    error: storageError,
  }));
  const storageFrom = vi.fn(() => ({ createSignedUrl }));

  return {
    rateLimitClient: { rpc } as unknown as SupabaseClient,
    userClient: { storage: { from: storageFrom } } as unknown as SupabaseClient,
    createSignedUrl,
    rpc,
    storageFrom,
  };
}

describe('parseMediaReadRoutePayload', () => {
  it('rejects unsupported buckets or missing paths before client creation', () => {
    expect(parseMediaReadRoutePayload({
      bucket: 'avatars',
      filePath: 'user/file.jpg',
      requestedFilename: null,
      shouldDownload: false,
    })).toEqual({
      ok: false,
      status: 400,
      body: { error: 'Invalid media path' },
    });

    expect(parseMediaReadRoutePayload({
      bucket: 'generated_images',
      filePath: null,
      requestedFilename: null,
      shouldDownload: false,
    })).toEqual({
      ok: false,
      status: 400,
      body: { error: 'Invalid media path' },
    });
  });

  it('normalizes valid media read parameters', () => {
    expect(parseMediaReadRoutePayload({
      bucket: 'generated_videos',
      filePath: 'user/clip.mp4',
      requestedFilename: 'my/bad"clip.mp4',
      shouldDownload: true,
    })).toEqual({
      ok: true,
      payload: {
        bucket: 'generated_videos',
        filePath: 'user/clip.mp4',
        downloadFilename: 'my-bad-clip.mp4',
      },
    });
  });
});

describe('createMediaReadSignedUrlForRoute', () => {
  it('rate limits authenticated media reads before user-scoped Storage signing', async () => {
    const clients = createClients();

    const result = await createMediaReadSignedUrlForRoute({
      payload: {
        bucket: 'generated_images',
        filePath: 'user/file.jpg',
        downloadFilename: null,
      },
      rateLimitClient: clients.rateLimitClient,
      userClient: clients.userClient,
      userId: 'user-1',
    });

    expect(clients.rpc).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'media-read:sign',
      p_subject_key: 'user-1',
      p_limit: 300,
      p_window_seconds: 600,
    });
    expect(clients.storageFrom).toHaveBeenCalledWith('generated_images');
    expect(clients.createSignedUrl).toHaveBeenCalledWith('user/file.jpg', 600, undefined);
    expect(result).toEqual({
      ok: true,
      signedUrl: 'https://project.supabase.co/storage/v1/object/sign/generated_images/user/file.jpg?token=abc',
    });
  });

  it('passes sanitized download names into Storage signing', async () => {
    const clients = createClients();

    await createMediaReadSignedUrlForRoute({
      payload: {
        bucket: 'generated_videos',
        filePath: 'user/clip.mp4',
        downloadFilename: 'my-bad-clip.mp4',
      },
      rateLimitClient: clients.rateLimitClient,
      userClient: clients.userClient,
      userId: 'user-1',
    });

    expect(clients.createSignedUrl).toHaveBeenCalledWith(
      'user/clip.mp4',
      600,
      { download: 'my-bad-clip.mp4' },
    );
  });

  it('returns rate-limit and missing-media failures without signing after denial', async () => {
    const denied = createClients({ allowed: false });

    const deniedResult = await createMediaReadSignedUrlForRoute({
      payload: {
        bucket: 'generated_images',
        filePath: 'user/file.jpg',
        downloadFilename: null,
      },
      rateLimitClient: denied.rateLimitClient,
      userClient: denied.userClient,
      userId: 'user-1',
    });

    expect(deniedResult.ok).toBe(false);
    expect(deniedResult).toHaveProperty('rateLimitError');
    expect(denied.createSignedUrl).not.toHaveBeenCalled();

    const missing = createClients({ storageError: new Error('not found') });
    await expect(createMediaReadSignedUrlForRoute({
      payload: {
        bucket: 'generation_inputs',
        filePath: 'user/missing.png',
        downloadFilename: null,
      },
      rateLimitClient: missing.rateLimitClient,
      userClient: missing.userClient,
      userId: 'user-1',
    })).resolves.toEqual({
      ok: false,
      status: 404,
      body: { error: 'Failed to load media' },
    });
  });
});
