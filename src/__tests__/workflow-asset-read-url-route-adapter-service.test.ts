import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { postWorkflowAssetReadUrlRouteResponse } from '@/lib/workflow-asset-read-url-route-adapter-service';

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

describe('workflow asset read-url route adapter service', () => {
  it('rejects unauthenticated workflow reads before parsing JSON or creating privileged clients', async () => {
    const createServiceClient = vi.fn();
    const createWorkflowAssetReadUrl = vi.fn();
    const request = new Request('http://localhost/api/uploads/workflow-asset/read-url', {
      method: 'POST',
      headers: { 'x-request-id': 'workflow-read-url-auth-1' },
      body: JSON.stringify({
        storagePath: 'generated_images/user-1/workflow-input-reference.png',
      }),
    });
    const jsonSpy = vi.spyOn(request, 'json');

    const response = await postWorkflowAssetReadUrlRouteResponse({
      request,
      dependencies: {
        createServiceClient,
        createUserClient: () => createUserClient(null),
        createWorkflowAssetReadUrl,
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('workflow-read-url-auth-1');
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(createWorkflowAssetReadUrl).not.toHaveBeenCalled();
  });

  it('delegates owned read-url work with lazy service-client creation and private headers', async () => {
    const adminSupabase = { kind: 'admin' } as unknown as SupabaseClient;
    const createServiceClient = vi.fn(() => adminSupabase);
    const createWorkflowAssetReadUrl = vi.fn(async () => ({
      ok: true as const,
      response: {
        success: true,
        signedUrl: 'https://storage.example.test/signed/workflow-input.png',
        expiresInSeconds: 3600,
      },
    }));
    const body = {
      storagePath: 'generated_images/user-1/workflow-input-reference.png',
    };

    const response = await postWorkflowAssetReadUrlRouteResponse({
      request: new Request('http://localhost/api/uploads/workflow-asset/read-url', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'workflow-read-url-success-1',
        },
        body: JSON.stringify(body),
      }),
      dependencies: {
        createServiceClient,
        createUserClient: () => createUserClient('user-1'),
        createWorkflowAssetReadUrl,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('workflow-read-url-success-1');
    await expect(response.json()).resolves.toEqual({
      success: true,
      signedUrl: 'https://storage.example.test/signed/workflow-input.png',
      expiresInSeconds: 3600,
    });
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(createWorkflowAssetReadUrl).toHaveBeenCalledWith({
      body,
      userId: 'user-1',
      client: createServiceClient,
    });
  });

  it('maps workflow read-url rate limits to stable route responses', async () => {
    const response = await postWorkflowAssetReadUrlRouteResponse({
      request: new Request('http://localhost/api/uploads/workflow-asset/read-url', {
        method: 'POST',
        headers: { 'x-request-id': 'workflow-read-url-limit-1' },
        body: JSON.stringify({
          storagePath: 'generated_videos/user-1/workflow-input-reference.mp4',
        }),
      }),
      dependencies: {
        createServiceClient: vi.fn(),
        createUserClient: () => createUserClient('user-1'),
        createWorkflowAssetReadUrl: vi.fn(async () => ({
          ok: false as const,
          status: 429,
          error: 'Too many workflow asset reads. Try again shortly.',
          code: 'RATE_LIMITED',
          retryAfterSeconds: 29,
          limit: 80,
          remaining: 0,
          resetAt: '2026-06-23T13:00:00.000Z',
        })),
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('workflow-read-url-limit-1');
    expect(response.headers.get('Retry-After')).toBe('29');
    expect(response.headers.get('X-RateLimit-Limit')).toBe('80');
    expect(response.headers.get('X-RateLimit-Remaining')).toBe('0');
    expect(response.headers.get('X-RateLimit-Reset')).toBe('2026-06-23T13:00:00.000Z');
    await expect(response.json()).resolves.toMatchObject({
      error: 'Too many workflow asset reads. Try again shortly.',
      code: 'RATE_LIMITED',
      retryAfterSeconds: 29,
      limit: 80,
      resetAt: '2026-06-23T13:00:00.000Z',
    });
  });
});
