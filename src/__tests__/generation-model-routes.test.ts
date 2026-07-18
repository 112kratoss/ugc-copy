import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const rpc = vi.fn(async () => ({
    data: {
      allowed: true,
      limit: 240,
      remaining: 239,
      retryAfterSeconds: 0,
      resetAt: '2026-06-22T06:30:00.000Z',
    },
    error: null,
  }));
  const createServiceClient = vi.fn(() => ({ rpc }));

  return {
    createServiceClient,
    rpc,
  };
});

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => mocks.createServiceClient(),
}));

import { GET } from '@/app/api/generation-models/route';
import { POST } from '@/app/api/generation-models/quote/route';

describe('GET /api/generation-models', () => {
  it('returns a cacheable compatible catalog with an ETag', async () => {
    const response = await GET(new NextRequest(
      'http://localhost/api/generation-models?platform=mobile&schemaVersion=1',
      { headers: { 'x-request-id': 'catalog-req-1' } }
    ));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300, stale-while-revalidate=3600');
    expect(response.headers.get('ETag')).toBe(`"${body.revision}"`);
    expect(response.headers.get('x-request-id')).toBe('catalog-req-1');
    expect(body.models.some((model: { id: string }) => model.id === 'nano-banana-2')).toBe(true);
  });

  it('returns 304 when the client already has the current revision', async () => {
    const initial = await GET(new NextRequest(
      'http://localhost/api/generation-models?platform=web&schemaVersion=1'
    ));
    const etag = initial.headers.get('ETag')!;
    const response = await GET(new NextRequest(
      'http://localhost/api/generation-models?platform=web&schemaVersion=1',
      { headers: { 'If-None-Match': etag, 'x-vercel-id': 'iad1::catalog-304' } }
    ));

    expect(response.status).toBe(304);
    expect(response.headers.get('ETag')).toBe(etag);
    expect(response.headers.get('x-request-id')).toBe('iad1::catalog-304');
  });
});

describe('POST /api/generation-models/quote', () => {
  beforeEach(() => {
    mocks.createServiceClient.mockClear();
    mocks.rpc.mockClear();
    mocks.rpc.mockResolvedValue({
      data: {
        allowed: true,
        limit: 240,
        remaining: 239,
        retryAfterSeconds: 0,
        resetAt: '2026-06-22T06:30:00.000Z',
      },
      error: null,
    });
  });

  it('returns a no-store authoritative quote', async () => {
    const response = await POST(new NextRequest(
      'http://localhost/api/generation-models/quote',
      {
        method: 'POST',
        headers: {
          'x-forwarded-for': '203.0.113.10, 10.0.0.5',
          'x-request-id': 'quote-success-1',
        },
        body: JSON.stringify({
          kind: 'motion',
          modelId: 'kling-2.6',
          settings: { resolution: '1080p', duration: 10, characterOrientation: 'video' },
          inputCounts: { images: 1, videos: 1, audios: 0 },
        }),
      }
    ));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('quote-success-1');
    expect(mocks.createServiceClient).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'generation-model:quote',
      p_subject_key: '203.0.113.10',
      p_limit: 240,
      p_window_seconds: 600,
    });
    expect(body.costCredits).toBe(180);
  });

  it('returns structured validation errors', async () => {
    const response = await POST(new NextRequest(
      'http://localhost/api/generation-models/quote',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer private-token',
          'x-request-id': 'quote-validation-1',
        },
        body: JSON.stringify({
          kind: 'image',
          modelId: 'grok-imagine-image',
          settings: { aspectRatio: '21:9', resolution: '1K' },
        }),
      }
    ));
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('quote-validation-1');
    expect(response.headers.has('authorization')).toBe(false);
    expect(Array.from(response.headers.entries()).join('\n')).not.toContain('private-token');
    expect(body).toMatchObject({
      code: 'INVALID_MODEL_SETTINGS',
      fieldErrors: { aspectRatio: expect.any(String) },
    });
    expect(mocks.createServiceClient).toHaveBeenCalledTimes(1);
  });

  it('rate limits quote requests before returning catalog pricing', async () => {
    mocks.rpc.mockResolvedValue({
      data: {
        allowed: false,
        limit: 240,
        remaining: 0,
        retryAfterSeconds: 25,
        resetAt: '2026-06-22T06:30:00.000Z',
      },
      error: null,
    });

    const response = await POST(new NextRequest(
      'http://localhost/api/generation-models/quote',
      {
        method: 'POST',
        headers: {
          'x-real-ip': '198.51.100.24',
          'x-request-id': 'quote-rate-limit-1',
        },
        body: JSON.stringify({
          kind: 'motion',
          modelId: 'kling-2.6',
          settings: { resolution: '1080p', duration: 10, characterOrientation: 'video' },
          inputCounts: { images: 1, videos: 1, audios: 0 },
        }),
      }
    ));
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('25');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('quote-rate-limit-1');
    expect(body).toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 25,
    });
    expect(mocks.rpc).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'generation-model:quote',
      p_subject_key: '198.51.100.24',
      p_limit: 240,
      p_window_seconds: 600,
    });
  });
});
