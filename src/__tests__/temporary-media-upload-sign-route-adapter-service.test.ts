import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { postTemporaryMediaUploadSignRouteResponse } from '@/lib/temporary-media-upload-sign-route-adapter-service';

function createUserClient(userId: string | null = 'user-1') {
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: userId ? { id: userId } : null },
        error: userId ? null : new Error('missing session'),
      })),
    },
  } as unknown as SupabaseClient;
}

describe('temporary media upload-sign route adapter service', () => {
  it('rejects unauthenticated upload-sign requests before parsing JSON or creating privileged clients', async () => {
    const createServiceClient = vi.fn();
    const createTemporaryMediaUploadIntent = vi.fn();
    const request = new Request('http://localhost/api/uploads/media/sign', {
      method: 'POST',
      headers: { 'x-request-id': 'media-upload-sign-auth-1' },
      body: JSON.stringify({
        fileName: 'reference.png',
        kind: 'image',
        mimeType: 'image/png',
        sizeBytes: 1234,
      }),
    });
    const jsonSpy = vi.spyOn(request, 'json');

    const response = await postTemporaryMediaUploadSignRouteResponse({
      request,
      dependencies: {
        createServiceClient,
        createTemporaryMediaUploadIntent,
        createUserClient: () => createUserClient(null),
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('media-upload-sign-auth-1');
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(createTemporaryMediaUploadIntent).not.toHaveBeenCalled();
  });

  it('delegates upload-sign work with lazy service-client creation and private headers', async () => {
    const adminSupabase = { kind: 'admin' } as unknown as SupabaseClient;
    const createServiceClient = vi.fn(() => adminSupabase);
    const createUploadId = vi.fn(() => 'upload-id-1');
    const createTemporaryMediaUploadIntent = vi.fn(async () => ({
      ok: true as const,
      response: {
        success: true,
        bucket: 'uploads' as const,
        path: 'user-1/upload-id-1-reference.png',
        storagePath: 'uploads/user-1/upload-id-1-reference.png',
        token: 'upload-token',
        signedUploadUrl: 'https://storage.example.test/signed-upload',
        expiresInSeconds: 7200,
      },
    }));
    const body = {
      fileName: 'reference.png',
      kind: 'image',
      mimeType: 'image/png',
      sizeBytes: 1234,
    };

    const response = await postTemporaryMediaUploadSignRouteResponse({
      request: new Request('http://localhost/api/uploads/media/sign', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'media-upload-sign-success-1',
        },
        body: JSON.stringify(body),
      }),
      dependencies: {
        createServiceClient,
        createTemporaryMediaUploadIntent,
        createUploadId,
        createUserClient: () => createUserClient('user-1'),
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('media-upload-sign-success-1');
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      bucket: 'uploads',
      token: 'upload-token',
    });
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(createTemporaryMediaUploadIntent).toHaveBeenCalledWith({
      body,
      userId: 'user-1',
      client: createServiceClient,
      createUploadId,
    });
  });

  it('maps upload-sign rate limits to stable route responses', async () => {
    const response = await postTemporaryMediaUploadSignRouteResponse({
      request: new Request('http://localhost/api/uploads/media/sign', {
        method: 'POST',
        headers: { 'x-request-id': 'media-upload-sign-limit-1' },
        body: JSON.stringify({
          fileName: 'clip.mp4',
          kind: 'video',
          mimeType: 'video/mp4',
          sizeBytes: 1234,
        }),
      }),
      dependencies: {
        createServiceClient: vi.fn(),
        createTemporaryMediaUploadIntent: vi.fn(async () => ({
          ok: false as const,
          status: 429,
          error: 'Too many media uploads. Try again shortly.',
          code: 'RATE_LIMITED',
          retryAfterSeconds: 44,
          limit: 60,
          remaining: 0,
          resetAt: '2026-06-23T13:00:00.000Z',
        })),
        createUserClient: () => createUserClient('user-1'),
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('media-upload-sign-limit-1');
    expect(response.headers.get('Retry-After')).toBe('44');
    expect(response.headers.get('X-RateLimit-Limit')).toBe('60');
    expect(response.headers.get('X-RateLimit-Remaining')).toBe('0');
    expect(response.headers.get('X-RateLimit-Reset')).toBe('2026-06-23T13:00:00.000Z');
    await expect(response.json()).resolves.toMatchObject({
      error: 'Too many media uploads. Try again shortly.',
      code: 'RATE_LIMITED',
      retryAfterSeconds: 44,
      limit: 60,
      resetAt: '2026-06-23T13:00:00.000Z',
    });
  });
});
