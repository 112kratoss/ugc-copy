import { describe, expect, it, vi } from 'vitest';

import { getSourceToolsRouteResponse } from '@/lib/source-tools-route-adapter-service';

describe('source tools route adapter service', () => {
  it('returns a public cached catalog response with deterministic ETag and trace headers', async () => {
    const listSourceToolsCatalog = vi.fn(async () => [
      {
        slug: 'higgsfield',
        label: 'Higgsfield',
        supportedMediaKinds: ['image', 'video'],
        models: [{ slug: 'soul', label: 'Soul' }],
      },
    ]);

    const response = await getSourceToolsRouteResponse({
      request: new Request('http://localhost/api/source-tools', {
        headers: { 'x-request-id': 'source-tools-adapter-1' },
      }),
      dependencies: { listSourceToolsCatalog },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300, stale-while-revalidate=3600');
    expect(response.headers.get('ETag')).toMatch(/^"[a-f0-9]{16}"$/);
    expect(response.headers.get('x-request-id')).toBe('source-tools-adapter-1');
    await expect(response.json()).resolves.toEqual({
      tools: [
        {
          slug: 'higgsfield',
          label: 'Higgsfield',
          supportedMediaKinds: ['image', 'video'],
          models: [{ slug: 'soul', label: 'Soul' }],
        },
      ],
    });
    expect(listSourceToolsCatalog).toHaveBeenCalledTimes(1);
  });

  it('returns a public 304 response when the request ETag matches', async () => {
    const tools = [
      {
        slug: 'magicbooklet',
        label: 'MagicBooklet',
        supportedMediaKinds: ['image'],
        models: [{ slug: 'nano-banana-2', label: 'Nano Banana 2.0' }],
      },
    ];
    const listSourceToolsCatalog = vi.fn(async () => tools);
    const firstResponse = await getSourceToolsRouteResponse({
      request: new Request('http://localhost/api/source-tools'),
      dependencies: { listSourceToolsCatalog },
    });
    const etag = firstResponse.headers.get('ETag');

    const response = await getSourceToolsRouteResponse({
      request: new Request('http://localhost/api/source-tools', {
        headers: {
          'If-None-Match': etag ?? '',
          'x-request-id': 'source-tools-adapter-304',
        },
      }),
      dependencies: { listSourceToolsCatalog },
    });

    expect(response.status).toBe(304);
    expect(response.headers.get('ETag')).toBe(etag);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300, stale-while-revalidate=3600');
    expect(response.headers.get('x-request-id')).toBe('source-tools-adapter-304');
    await expect(response.text()).resolves.toBe('');
  });

  it('creates stable cache headers when called without a Next route request', async () => {
    const response = await getSourceToolsRouteResponse({
      dependencies: {
        listSourceToolsCatalog: vi.fn(async () => []),
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300, stale-while-revalidate=3600');
    expect(response.headers.get('ETag')).toMatch(/^"[a-f0-9]{16}"$/);
    await expect(response.json()).resolves.toEqual({ tools: [] });
  });
});
