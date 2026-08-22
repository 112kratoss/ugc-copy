import { describe, expect, it } from 'vitest';

import {
  API_CACHE_CONTROL,
  applyPrivateNoStoreApiResponseHeaders,
  createApiResponseHeaders,
  createPrivateNoStoreApiResponseHeaders,
  normalizeApiRequestId,
} from '@/lib/api-cache';

describe('API response headers', () => {
  it('normalizes safe request ids and rejects unsafe header values', () => {
    expect(normalizeApiRequestId(' support-123:/trace=abc ')).toBe('support-123:/trace=abc');
    expect(normalizeApiRequestId('bad request id')).toBeNull();
    expect(normalizeApiRequestId('bad\nrequest')).toBeNull();
    expect(normalizeApiRequestId('x'.repeat(129))).toBeNull();
  });

  it('adds cache and trace headers without echoing authorization data', () => {
    const request = new Request('http://localhost/api/showcase/feed', {
      headers: {
        authorization: 'Bearer private-token',
        'x-request-id': 'client-trace-123',
      },
    });

    const headers = createApiResponseHeaders(request, API_CACHE_CONTROL.privateNoStore, {
      vary: ['Authorization', 'Authorization', 'x-vercel-ip-country'],
    });

    expect(headers).toEqual({
      'Cache-Control': 'private, no-store',
      Vary: 'Authorization, x-vercel-ip-country',
      'x-request-id': 'client-trace-123',
    });
    expect(Object.keys(headers).some((header) => header.toLowerCase() === 'authorization')).toBe(false);
    expect(JSON.stringify(headers)).not.toContain('private-token');
  });

  it('falls back to Vercel request ids when the client id is unsafe', () => {
    const request = new Request('http://localhost/api/showcase/feed', {
      headers: {
        'x-request-id': 'bad id',
        'x-vercel-id': 'bom1::iad1::trace-456',
      },
    });

    expect(createApiResponseHeaders(request, API_CACHE_CONTROL.publicShortEdge)['x-request-id'])
      .toBe('bom1::iad1::trace-456');
  });

  it('targets the Vercel edge explicitly for public catalogs', () => {
    const headers = createApiResponseHeaders(
      new Request('http://localhost/api/generation-models'),
      API_CACHE_CONTROL.publicCatalog,
    );

    expect(headers['Vercel-CDN-Cache-Control']).toBe(
      'public, s-maxage=300, stale-while-revalidate=3600',
    );
  });

  it('creates and applies private no-store trace headers to existing responses', () => {
    const request = new Request('http://localhost/api/uploads/media/sign', {
      headers: { 'x-request-id': 'upload-trace-1' },
    });
    const response = new Response('rate limited', {
      status: 429,
      headers: { 'Retry-After': '30' },
    });

    expect(createPrivateNoStoreApiResponseHeaders(request)).toEqual({
      'Cache-Control': 'private, no-store',
      'x-request-id': 'upload-trace-1',
    });

    const returned = applyPrivateNoStoreApiResponseHeaders(response, request);

    expect(returned).toBe(response);
    expect(response.headers.get('Retry-After')).toBe('30');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('upload-trace-1');
  });
});
