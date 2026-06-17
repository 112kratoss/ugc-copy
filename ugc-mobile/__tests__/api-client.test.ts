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
  it('turns local network failures into actionable API errors', async () => {
    const api = createApiClient({
      baseUrl: 'http://10.0.2.2:3000',
      getAccessToken: async () => 'token-1',
      fetcher: vi.fn(async () => {
        throw new TypeError('Network request failed');
      }) as unknown as typeof fetch,
    });

    await expect(api.getProfile()).rejects.toMatchObject({
      name: 'ApiError',
      status: 0,
      message: 'Could not reach local API at http://10.0.2.2:3000. Start the web app and check EXPO_PUBLIC_API_BASE_URL.',
    });
  });

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

  it('requests fresh signed generation media URLs that native media components can load', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      generations: [
        {
          id: 'gen-1',
          output_url: 'https://storage.magicbooklet.test/generated_images/user-1/gen-1.jpg?token=signed',
          output_urls: [
            'https://storage.magicbooklet.test/generated_images/user-1/gen-1.jpg?token=signed',
          ],
        },
      ],
    }));
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      fetcher: fetcher as unknown as typeof fetch,
    });

    const response = await api.listGenerations(true);

    const [url] = fetcher.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(url).toBe('https://magicbooklet.test/api/generations?includeArchived=true');
    expect(response.generations[0].output_url).toBe(
      'https://storage.magicbooklet.test/generated_images/user-1/gen-1.jpg?token=signed'
    );
    expect(response.generations[0].output_urls).toEqual([
      'https://storage.magicbooklet.test/generated_images/user-1/gen-1.jpg?token=signed',
    ]);
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
    const [url, init] = fetcher.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(url).toBe('https://magicbooklet.test/api/posts');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(formData);
    expect((init.headers as Headers).get('Content-Type')).toBeNull();
    expect((init.headers as Headers).get('Authorization')).toBe('Bearer token-1');
  });

  it('requests signed resource file URLs with JSON metadata', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      success: true,
      signedUrl: 'https://cdn.magicbooklet.test/resource.zip',
    }));
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      fetcher: fetcher as unknown as typeof fetch,
    });

    await api.getPostResourceFileUrl('post-1', 'bundles/resource.zip');

    const [url, init] = fetcher.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(url).toBe('https://magicbooklet.test/api/posts/post-1/resource-bundle/file-url');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ storagePath: 'bundles/resource.zip' });
    expect((init.headers as Headers).get('Content-Type')).toBe('application/json');
    expect((init.headers as Headers).get('Authorization')).toBe('Bearer token-1');
  });

  it('lists source tools for the mobile Made With picker', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      tools: [{
        slug: 'runway',
        label: 'Runway',
        models: [{ slug: 'gen-4', label: 'Gen-4' }],
        supportedMediaKinds: ['image', 'video'],
      }],
    }));
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      fetcher: fetcher as unknown as typeof fetch,
    });

    const response = await api.listSourceTools();

    const [url, init] = fetcher.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(url).toBe('https://magicbooklet.test/api/source-tools');
    expect(init.method ?? 'GET').toBe('GET');
    expect(response.tools[0].models[0].label).toBe('Gen-4');
  });

  it('saves showcase posts with an idempotent target state and source surface', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      success: true,
      isSaved: false,
      saveCount: 4,
      changed: true,
      message: 'Removed from bookmarks',
    }));
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      fetcher: fetcher as unknown as typeof fetch,
    });

    const response = await api.saveShowcasePost('post-1', {
      shouldSave: false,
      sourceSurface: 'mobile-viewer',
    });

    const [url, init] = fetcher.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(url).toBe('https://magicbooklet.test/api/showcase/save');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      postId: 'post-1',
      shouldSave: false,
      sourceSurface: 'mobile-viewer',
    });
    expect((init.headers as Headers).get('Content-Type')).toBe('application/json');
    expect((init.headers as Headers).get('Authorization')).toBe('Bearer token-1');
    expect(response).toMatchObject({
      success: true,
      isSaved: false,
      saveCount: 4,
      changed: true,
    });
  });

  it('uploads post resource files as FormData without forcing a JSON content type', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({
      success: true,
      attachment: {
        label: 'workflow.json',
        kind: 'file',
        storagePath: 'user-1/workflow.json',
        contentType: 'application/json',
        sizeBytes: 128,
      },
    }));
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      fetcher: fetcher as unknown as typeof fetch,
    });
    const formData = new FormData();
    formData.append('file', new Blob(['{}'], { type: 'application/json' }), 'workflow.json');

    await api.uploadPostResourceFile(formData);

    const [url, init] = fetcher.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(url).toBe('https://magicbooklet.test/api/posts/resource-files');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(formData);
    expect((init.headers as Headers).get('Content-Type')).toBeNull();
    expect((init.headers as Headers).get('Authorization')).toBe('Bearer token-1');
  });

  it('requests owner post detail', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      success: true,
      post: { id: 'post-123', title: 'Post title' },
    }));
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      fetcher: fetcher as unknown as typeof fetch,
    });

    const response = await api.getOwnerPost('post-123');

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(url).toBe('https://magicbooklet.test/api/posts/post-123');
    expect(init.method ?? 'GET').toBe('GET');
    expect(response.post.title).toBe('Post title');
  });

  it('sends PATCH request to update posts with JSON body', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      success: true,
      postId: 'post-123',
    }));
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      fetcher: fetcher as unknown as typeof fetch,
    });

    await api.updatePost('post-123', { title: 'Updated title' });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(url).toBe('https://magicbooklet.test/api/posts/post-123');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({ title: 'Updated title' });
  });

  it('posts to archive post endpoint', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      success: true,
      archived: true,
    }));
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      fetcher: fetcher as unknown as typeof fetch,
    });

    await api.archivePost('post-123');

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(url).toBe('https://magicbooklet.test/api/posts/post-123/archive');
    expect(init.method).toBe('POST');
  });

  it('posts to restore post endpoint', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      success: true,
      restored: true,
    }));
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      fetcher: fetcher as unknown as typeof fetch,
    });

    await api.restorePost('post-123');

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(url).toBe('https://magicbooklet.test/api/posts/post-123/restore');
    expect(init.method).toBe('POST');
  });
});
