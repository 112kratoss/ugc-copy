import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

import { getRemixSourceRouteResponse } from '@/lib/remix-source-route-adapter-service';
import { RemixSourceError } from '@/lib/remix-source-server';

function createRequest(url: string) {
  return new NextRequest(url, {
    headers: { 'x-request-id': 'remix-source-adapter-1' },
  });
}

describe('remix source route adapter service', () => {
  it('delegates source loading with generation and post ids using private no-store headers', async () => {
    const loadRemixSourceBundle = vi.fn(async () => ({
      generation: { id: 'generation-1', title: 'Remix source' },
      result: { mediaType: 'image', url: 'https://example.com/source.png' },
      inputs: {},
      inputMedia: [],
      workflowSettings: {},
      restoreIssues: [],
    }));
    const request = createRequest('http://localhost/api/remix-source?id=generation-1&postId=post-1');

    const response = await getRemixSourceRouteResponse({
      request,
      dependencies: { loadRemixSourceBundle },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('remix-source-adapter-1');
    expect(loadRemixSourceBundle).toHaveBeenCalledWith(request, 'generation-1', { postId: 'post-1' });
    await expect(response.json()).resolves.toMatchObject({
      generation: { id: 'generation-1' },
    });
  });

  it('rejects missing generation ids before loading source data', async () => {
    const loadRemixSourceBundle = vi.fn();

    const response = await getRemixSourceRouteResponse({
      request: createRequest('http://localhost/api/remix-source'),
      dependencies: { loadRemixSourceBundle },
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(loadRemixSourceBundle).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({ error: 'Missing generation ID' });
  });

  it('maps expected remix source errors without leaking internal failures', async () => {
    const response = await getRemixSourceRouteResponse({
      request: createRequest('http://localhost/api/remix-source?id=private-1'),
      dependencies: {
        loadRemixSourceBundle: vi.fn(async () => {
          throw new RemixSourceError('Remix source not found', 404);
        }),
      },
    });

    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({ error: 'Remix source not found' });
  });
});
