import { describe, expect, it, vi } from 'vitest';

import { createApiClient } from '../lib/api-client';

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

describe('mobile api client caching', () => {
  it('deduplicates anonymous showcase feed requests inside the content cache window', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      items: [],
      pageInfo: {
        hasMore: false,
        nextOffset: null,
        offset: 0,
        limit: 12,
      },
    }));
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => null,
      fetcher: fetcher as unknown as typeof fetch,
    });

    await api.getShowcaseFeed({ limit: 12, sort: 'recent' });
    await api.getShowcaseFeed({ limit: 12, sort: 'recent' });

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not cache authenticated profile requests', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ credits: 10 }));
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      fetcher: fetcher as unknown as typeof fetch,
    });

    await api.getProfile();
    await api.getProfile();

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('posts FormData without forcing a JSON content type', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({
      success: true,
      postId: 'post-1',
      visibility: 'public',
    }));
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      fetcher: fetcher as unknown as typeof fetch,
    });
    const formData = new FormData();
    formData.append('title', 'Mobile post');

    await api.createPost(formData);

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as [RequestInfo | URL, RequestInit];
    expect(url).toBe('https://magicbooklet.test/api/posts');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(formData);
    expect((init.headers as Headers).get('Content-Type')).toBeNull();
    expect((init.headers as Headers).get('Authorization')).toBe('Bearer token-1');
  });
});
