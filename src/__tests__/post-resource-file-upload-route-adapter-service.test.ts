import { describe, expect, it, vi } from 'vitest';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import { postPostResourceFileUploadRouteResponse } from '@/lib/post-resource-file-upload-route-adapter-service';

function createRequest(headers: Record<string, string> = {}) {
  const formData = new FormData();
  formData.set('file', new File(['hello'], 'guide.pdf', { type: 'application/pdf' }));

  return new Request('http://localhost/api/posts/resource-files', {
    method: 'POST',
    headers,
    body: formData,
  });
}

describe('post resource file upload route adapter service', () => {
  it('authenticates before creating privileged clients and maps upload success with private headers', async () => {
    const adminClient = { storage: { from: vi.fn() }, rpc: vi.fn() };
    const createServiceClient = vi.fn(() => adminClient);
    const uploadPostResourceFileForRoute = vi.fn(async () => ({
      ok: true as const,
      body: {
        success: true as const,
        attachment: {
          label: 'guide.pdf',
          kind: 'file' as const,
          storagePath: 'user-1/upload-1-guide.pdf',
          contentType: 'application/pdf',
          sizeBytes: 5,
        },
      },
    }));

    const response = await postPostResourceFileUploadRouteResponse({
      request: createRequest({ 'x-request-id': 'resource-upload-adapter-1' }),
      dependencies: {
        createServiceClient,
        createUserClient: vi.fn(() => ({
          auth: {
            getUser: vi.fn(async () => ({
              data: { user: { id: 'user-1' } },
              error: null,
            })),
          },
        }) as never),
        uploadPostResourceFileForRoute,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('resource-upload-adapter-1');
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      attachment: { storagePath: 'user-1/upload-1-guide.pdf' },
    });
    expect(createServiceClient).toHaveBeenCalledTimes(1);
    expect(uploadPostResourceFileForRoute).toHaveBeenCalledWith({
      client: adminClient,
      userId: 'user-1',
      readFormData: expect.any(Function),
    });
  });

  it('does not create an admin client when authentication fails', async () => {
    const createServiceClient = vi.fn();
    const response = await postPostResourceFileUploadRouteResponse({
      request: createRequest({ 'x-request-id': 'resource-upload-auth-1' }),
      dependencies: {
        createServiceClient,
        createUserClient: vi.fn(() => ({
          auth: {
            getUser: vi.fn(async () => ({
              data: { user: null },
              error: new Error('missing session'),
            })),
          },
        }) as never),
        uploadPostResourceFileForRoute: vi.fn(),
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('resource-upload-auth-1');
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(createServiceClient).not.toHaveBeenCalled();
  });

  it('maps upload rate-limit results into standard private no-store responses', async () => {
    const rateLimitError = new BackendRateLimitError({
      allowed: false,
      limit: 30,
      remaining: 0,
      retryAfterSeconds: 47,
      resetAt: '2026-06-23T03:00:00.000Z',
    });

    const response = await postPostResourceFileUploadRouteResponse({
      request: createRequest({ 'x-request-id': 'resource-upload-rate-limit-1' }),
      dependencies: {
        createServiceClient: vi.fn(() => ({ storage: { from: vi.fn() }, rpc: vi.fn() }) as never),
        createUserClient: vi.fn(() => ({
          auth: {
            getUser: vi.fn(async () => ({
              data: { user: { id: 'user-1' } },
              error: null,
            })),
          },
        }) as never),
        uploadPostResourceFileForRoute: vi.fn(async () => ({
          ok: false as const,
          status: 429 as const,
          body: { error: 'Too many uploads.' },
          rateLimitError,
        })),
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('47');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('resource-upload-rate-limit-1');
    await expect(response.json()).resolves.toMatchObject({ code: 'RATE_LIMITED' });
  });
});
