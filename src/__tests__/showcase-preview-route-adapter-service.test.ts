import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import {
  createShowcasePreviewRouteHandlers,
  getShowcasePreviewRouteResponse,
} from '@/lib/showcase-preview-route-adapter-service';

function createUserClient(userId: string | null = 'viewer-1') {
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: userId ? { id: userId } : null },
        error: userId ? null : new Error('missing session'),
      })),
    },
  } as unknown as SupabaseClient;
}

describe('showcase preview route adapter service', () => {
  it('rejects missing generation ids before auth, service clients, or preview work', async () => {
    const createUserClientMock = vi.fn(() => createUserClient('viewer-1'));
    const createServiceClient = vi.fn();
    const createShowcasePreviewForRoute = vi.fn();

    const response = await getShowcasePreviewRouteResponse({
      request: new Request('https://app.example/api/showcase/preview', {
        headers: { 'x-request-id': 'showcase-preview-missing-1' },
      }),
      dependencies: {
        createServiceClient,
        createShowcasePreviewForRoute,
        createUserClient: createUserClientMock,
      },
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('showcase-preview-missing-1');
    await expect(response.json()).resolves.toEqual({ error: 'Missing generation ID' });
    expect(createUserClientMock).not.toHaveBeenCalled();
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(createShowcasePreviewForRoute).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated preview requests before service clients or preview work', async () => {
    const createServiceClient = vi.fn();
    const createShowcasePreviewForRoute = vi.fn();

    const response = await getShowcasePreviewRouteResponse({
      request: new Request('https://app.example/api/showcase/preview?id=generation-1', {
        headers: {
          authorization: 'Bearer private-token',
          'x-request-id': 'showcase-preview-auth-1',
        },
      }),
      dependencies: {
        createServiceClient,
        createShowcasePreviewForRoute,
        createUserClient: () => createUserClient(null),
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('showcase-preview-auth-1');
    expect(Array.from(response.headers.entries()).join('\n')).not.toContain('private-token');
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(createShowcasePreviewForRoute).not.toHaveBeenCalled();
  });

  it('delegates authenticated previews with the viewer id and service client', async () => {
    const serviceClient = { service: 'admin' } as unknown as SupabaseClient;
    const createServiceClient = vi.fn(() => serviceClient);
    const createShowcasePreviewForRoute = vi.fn(async () => ({
      ok: true as const,
      body: { url: 'https://signed.example.com/preview.png' },
    }));

    const response = await getShowcasePreviewRouteResponse({
      request: new Request('https://app.example/api/showcase/preview?id=generation-1', {
        headers: { 'x-request-id': 'showcase-preview-success-1' },
      }),
      dependencies: {
        createServiceClient,
        createShowcasePreviewForRoute,
        createUserClient: () => createUserClient('viewer-1'),
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('showcase-preview-success-1');
    await expect(response.json()).resolves.toEqual({ url: 'https://signed.example.com/preview.png' });
    expect(createServiceClient).toHaveBeenCalledTimes(1);
    expect(createShowcasePreviewForRoute).toHaveBeenCalledWith({
      generationId: 'generation-1',
      serviceClient,
      viewerUserId: 'viewer-1',
    });
  });

  it('maps preview rate limits into standard private no-store responses', async () => {
    const rateLimitError = new BackendRateLimitError({
      allowed: false,
      limit: 240,
      remaining: 0,
      retryAfterSeconds: 12,
      resetAt: '2026-06-23T03:00:00.000Z',
    });
    const createShowcasePreviewForRoute = vi.fn(async () => ({
      ok: false as const,
      rateLimitError,
    }));

    const response = await getShowcasePreviewRouteResponse({
      request: new Request('https://app.example/api/showcase/preview?id=generation-1', {
        headers: { 'x-request-id': 'showcase-preview-rate-limit-1' },
      }),
      dependencies: {
        createServiceClient: vi.fn(() => ({ service: 'admin' }) as unknown as SupabaseClient),
        createShowcasePreviewForRoute,
        createUserClient: () => createUserClient('viewer-1'),
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('12');
    expect(response.headers.get('X-RateLimit-Limit')).toBe('240');
    expect(response.headers.get('X-RateLimit-Remaining')).toBe('0');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 12,
      limit: 240,
    });
  });

  it('preserves preview validation failure bodies and statuses', async () => {
    const response = await getShowcasePreviewRouteResponse({
      request: new Request('https://app.example/api/showcase/preview?id=generation-1'),
      dependencies: {
        createServiceClient: vi.fn(() => ({ service: 'admin' }) as unknown as SupabaseClient),
        createShowcasePreviewForRoute: vi.fn(async () => ({
          ok: false as const,
          status: 403 as const,
          body: { error: 'Generation is private' },
        })),
        createUserClient: () => createUserClient('viewer-1'),
      },
    });

    expect(response.status).toBe(403);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({ error: 'Generation is private' });
  });

  it('creates route handlers that forward preview GET requests through the adapter', async () => {
    const serviceClient = { service: 'admin' } as unknown as SupabaseClient;
    const createShowcasePreviewForRoute = vi.fn(async () => ({
      ok: true as const,
      body: { url: 'https://signed.example.com/factory-preview.png' },
    }));
    const { GET } = createShowcasePreviewRouteHandlers({
      dependencies: {
        createServiceClient: vi.fn(() => serviceClient),
        createShowcasePreviewForRoute,
        createUserClient: () => createUserClient('viewer-1'),
      },
    });

    const response = await GET(new Request('https://app.example/api/showcase/preview?id=generation-1', {
      headers: { 'x-request-id': 'showcase-preview-factory-1' },
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('showcase-preview-factory-1');
    await expect(response.json()).resolves.toEqual({
      url: 'https://signed.example.com/factory-preview.png',
    });
    expect(createShowcasePreviewForRoute).toHaveBeenCalledWith({
      generationId: 'generation-1',
      serviceClient,
      viewerUserId: 'viewer-1',
    });
  });
});
