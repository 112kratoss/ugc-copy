import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { postWorkflowAssetUploadSignRouteResponse } from '@/lib/workflow-asset-upload-sign-route-adapter-service';

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

describe('workflow asset upload-sign route adapter service', () => {
  it('rejects unauthenticated workflow uploads before parsing JSON or creating privileged clients', async () => {
    const createServiceClient = vi.fn();
    const createWorkflowAssetUploadIntent = vi.fn();
    const request = new Request('http://localhost/api/uploads/workflow-asset/sign', {
      method: 'POST',
      headers: { 'x-request-id': 'workflow-upload-sign-auth-1' },
      body: JSON.stringify({
        bucket: 'generated_images',
        fileName: 'reference.png',
        mimeType: 'image/png',
        sizeBytes: 1234,
      }),
    });
    const jsonSpy = vi.spyOn(request, 'json');

    const response = await postWorkflowAssetUploadSignRouteResponse({
      request,
      dependencies: {
        createServiceClient,
        createUserClient: () => createUserClient(null),
        createWorkflowAssetUploadIntent,
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('workflow-upload-sign-auth-1');
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(createWorkflowAssetUploadIntent).not.toHaveBeenCalled();
  });

  it('delegates validated upload-sign work with lazy service-client creation and private headers', async () => {
    const adminSupabase = { kind: 'admin' } as unknown as SupabaseClient;
    const createServiceClient = vi.fn(() => adminSupabase);
    const createUploadId = vi.fn(() => 'upload-id-1');
    const createWorkflowAssetUploadIntent = vi.fn(async () => ({
      ok: true as const,
      response: {
        success: true as const,
        bucket: 'generated_images' as const,
        path: 'user-1/workflow-input-upload-id-1-reference.png',
        storagePath: 'generated_images/user-1/workflow-input-upload-id-1-reference.png',
        token: 'workflow-upload-token',
        signedUploadUrl: 'https://storage.example.test/workflow-upload',
        expiresInSeconds: 7200,
      },
    }));
    const body = {
      bucket: 'generated_images',
      fileName: 'reference.png',
      mimeType: 'image/png',
      sizeBytes: 1234,
    };

    const response = await postWorkflowAssetUploadSignRouteResponse({
      request: new Request('http://localhost/api/uploads/workflow-asset/sign', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'workflow-upload-sign-success-1',
        },
        body: JSON.stringify(body),
      }),
      dependencies: {
        createServiceClient,
        createUploadId,
        createUserClient: () => createUserClient('user-1'),
        createWorkflowAssetUploadIntent,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('workflow-upload-sign-success-1');
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      bucket: 'generated_images',
      token: 'workflow-upload-token',
    });
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(createWorkflowAssetUploadIntent).toHaveBeenCalledWith({
      body,
      userId: 'user-1',
      client: createServiceClient,
      createUploadId,
    });
  });

  it('maps upload-sign rate limits to stable route responses', async () => {
    const response = await postWorkflowAssetUploadSignRouteResponse({
      request: new Request('http://localhost/api/uploads/workflow-asset/sign', {
        method: 'POST',
        headers: { 'x-request-id': 'workflow-upload-sign-limit-1' },
        body: JSON.stringify({
          bucket: 'generated_videos',
          fileName: 'clip.mp4',
          mimeType: 'video/mp4',
          sizeBytes: 1234,
        }),
      }),
      dependencies: {
        createServiceClient: vi.fn(),
        createUserClient: () => createUserClient('user-1'),
        createWorkflowAssetUploadIntent: vi.fn(async () => ({
          ok: false as const,
          status: 429,
          error: 'Too many workflow uploads. Try again shortly.',
          code: 'RATE_LIMITED',
          retryAfterSeconds: 37,
          limit: 40,
          remaining: 0,
          resetAt: '2026-06-23T13:00:00.000Z',
        })),
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('workflow-upload-sign-limit-1');
    expect(response.headers.get('Retry-After')).toBe('37');
    expect(response.headers.get('X-RateLimit-Limit')).toBe('40');
    expect(response.headers.get('X-RateLimit-Remaining')).toBe('0');
    expect(response.headers.get('X-RateLimit-Reset')).toBe('2026-06-23T13:00:00.000Z');
    await expect(response.json()).resolves.toMatchObject({
      error: 'Too many workflow uploads. Try again shortly.',
      code: 'RATE_LIMITED',
      retryAfterSeconds: 37,
      limit: 40,
      resetAt: '2026-06-23T13:00:00.000Z',
    });
  });
});
