import { describe, expect, it, vi } from 'vitest';

import { ApiError, createApiClient } from '../lib/api-client';

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

describe('mobile api client caching', () => {
  it('sends a request id with backend calls', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ credits: 10 }));
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      fetcher: fetcher as unknown as typeof fetch,
    });

    await api.getProfile();

    const [, init] = fetcher.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect((init.headers as Headers).get('x-request-id')).toMatch(/^mobile:/);
    expect((init.headers as Headers).get('Authorization')).toBe('Bearer token-1');
  });

  it('advertises the mobile app, API, and catalog contract versions', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ credits: 10 }));
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      clientInfo: {
        appVersion: '1.2.3',
        apiVersion: 1,
        catalogSchemaVersion: 1,
      },
      fetcher: fetcher as unknown as typeof fetch,
    });

    await api.getProfile();

    const [, init] = fetcher.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    const headers = init.headers as Headers;
    expect(headers.get('x-magicbooklet-client')).toBe('mobile');
    expect(headers.get('x-magicbooklet-app-version')).toBe('1.2.3');
    expect(headers.get('x-magicbooklet-api-version')).toBe('1');
    expect(headers.get('x-magicbooklet-catalog-schema-version')).toBe('1');
  });

  it('exposes stable compatibility error codes to update handling', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      code: 'MOBILE_UPDATE_REQUIRED',
      error: 'Update Magicbooklet to continue.',
      compatibility: {
        currentApiVersion: 1,
        minimumApiVersion: 1,
        minimumAppVersion: '1.1.0',
        supportedCatalogSchemaVersions: [1],
      },
    }), {
      status: 426,
      headers: { 'Content-Type': 'application/json' },
    }));
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      clientInfo: {
        appVersion: '1.0.0',
        apiVersion: 1,
        catalogSchemaVersion: 1,
      },
      fetcher: fetcher as unknown as typeof fetch,
    });

    await expect(api.getProfile()).rejects.toMatchObject({
      name: 'ApiError',
      status: 426,
      code: 'MOBILE_UPDATE_REQUIRED',
      message: 'Update Magicbooklet to continue.',
    });
  });

  it('preserves explicit request ids for advanced callers', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ ok: true }));
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      fetcher: fetcher as unknown as typeof fetch,
    });

    await api.request('/api/profile', {
      headers: {
        'x-request-id': 'mobile-custom-trace-1',
      },
    });

    const [, init] = fetcher.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect((init.headers as Headers).get('x-request-id')).toBe('mobile-custom-trace-1');
  });

  it('attaches the server request id to HTTP API errors without leaking auth headers', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: 'Backend unavailable' }), {
      status: 503,
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': 'server-trace-1',
      },
    }));
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-secret',
      fetcher: fetcher as unknown as typeof fetch,
    });

    let capturedError: unknown;
    try {
      await api.getProfile();
    } catch (error) {
      capturedError = error;
    }

    expect(capturedError).toBeInstanceOf(ApiError);
    expect(capturedError).toMatchObject({
      status: 503,
      message: 'Backend unavailable',
      requestId: 'server-trace-1',
      details: { error: 'Backend unavailable' },
    });
    expect(JSON.stringify((capturedError as ApiError).details)).not.toContain('token-secret');
  });

  it('attaches the outgoing request id to network errors', async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError('Network request failed');
    });
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      fetcher: fetcher as unknown as typeof fetch,
    });

    let capturedError: unknown;
    try {
      await api.getProfile();
    } catch (error) {
      capturedError = error;
    }

    const [, init] = fetcher.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    const outgoingRequestId = (init.headers as Headers).get('x-request-id');
    expect(outgoingRequestId).toMatch(/^mobile:/);
    expect(capturedError).toBeInstanceOf(ApiError);
    expect((capturedError as ApiError).requestId).toBe(outgoingRequestId);
    expect(JSON.stringify((capturedError as ApiError).details)).not.toContain('token-1');
  });

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

  it('requests fresh authenticated showcase feed data by default', async () => {
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
      getAccessToken: async () => 'token-1',
      fetcher: fetcher as unknown as typeof fetch,
    });

    await api.getShowcaseFeed({ limit: 12, sort: 'recent' });
    await api.getShowcaseFeed({ limit: 12, sort: 'recent' });

    expect(fetcher).toHaveBeenCalledTimes(2);
    const [, firstInit] = fetcher.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    const [, secondInit] = fetcher.mock.calls[1] as unknown as [RequestInfo | URL, RequestInit];
    expect((firstInit.headers as Headers).get('Authorization')).toBe('Bearer token-1');
    expect((secondInit.headers as Headers).get('Authorization')).toBe('Bearer token-1');
  });

  it('posts idempotent ranked-feed events with recommendation context', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ success: true, accepted: true }));
    const installationId = `fid_${'c'.repeat(64)}`;
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      getInstallationId: async () => installationId,
      fetcher: fetcher as unknown as typeof fetch,
    });

    const body = {
      clientEventId: 'showcase:event-1',
      feedSessionId: 'session-1',
      deliveryId: 'delivery-1',
      postId: 'post-1',
      eventType: 'impression' as const,
      position: 4,
      durationMs: 1000,
      sourceSurface: 'showcase' as const,
    };
    await expect(api.recordShowcaseFeedEvent(body)).resolves.toEqual({ success: true, accepted: true });

    const [url, init] = fetcher.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(String(url)).toBe('https://magicbooklet.test/api/showcase/feed/events');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual(body);
    expect((init.headers as Headers).get('Authorization')).toBe('Bearer token-1');
    expect((init.headers as Headers).get('x-magicbooklet-installation-id')).toBe(installationId);
  });

  it('adds the same persistent installation identity to ranked feed pages but not unrelated APIs', async () => {
    const installationId = `fid_${'d'.repeat(64)}`;
    const getInstallationId = vi.fn(async () => installationId);
    const fetcher = vi.fn(async () => jsonResponse({ items: [], pageInfo: { hasMore: false } }));
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => null,
      getInstallationId,
      fetcher: fetcher as unknown as typeof fetch,
    });

    await api.getShowcaseFeed({ sort: 'for-you' });
    await api.getProfile();

    const [, feedInit] = fetcher.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    const [, profileInit] = fetcher.mock.calls[1] as unknown as [RequestInfo | URL, RequestInit];
    expect((feedInit.headers as Headers).get('x-magicbooklet-installation-id')).toBe(installationId);
    expect((profileInit.headers as Headers).has('x-magicbooklet-installation-id')).toBe(false);
    expect(getInstallationId).toHaveBeenCalledTimes(1);
  });

  it('loads authenticated remix source bundles with post context', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      generation: {
        id: 'gen-1',
        title: 'Original',
        prompt: 'Use the same recipe.',
        category: 'image',
        model: 'nano-banana-2',
      },
      result: null,
      inputs: {
        image: {
          elements: [],
        },
      },
      workflowSettings: {},
      restoreIssues: [],
    }));
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      fetcher: fetcher as unknown as typeof fetch,
    });

    const bundle = await api.getRemixSourceBundle('gen-1', { postId: 'post-1' });

    expect(bundle.generation.id).toBe('gen-1');
    const [url, init] = fetcher.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(String(url)).toBe('https://magicbooklet.test/api/remix-source?id=gen-1&postId=post-1');
    expect((init.headers as Headers).get('Authorization')).toBe('Bearer token-1');
  });

  it('loads creator profiles by encoded username with optional query params', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      profile: {
        id: 'creator-1',
        username: 'luna studio',
        displayName: 'Luna Studio',
        bio: 'Creator portfolio',
        avatarUrl: null,
        coverUrl: null,
        websiteUrl: null,
        twitterHandle: null,
        instagramHandle: null,
        tiktokHandle: null,
        location: null,
      },
      stats: {
        publicCreations: 0,
        totalSaves: 0,
        totalRemixes: 0,
        unlocks: 0,
        totalUnlockSales: 0,
        toolsUsed: [],
      },
      items: [],
      pageInfo: {
        hasMore: false,
        nextLimit: null,
        nextOffset: null,
        limit: 48,
        offset: 0,
      },
      viewer: {
        isOwner: false,
        isFollowing: false,
      },
    }));
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      fetcher: fetcher as unknown as typeof fetch,
    });

    const response = await api.getCreatorProfile('luna studio', { limit: 48 });

    expect(response.profile.displayName).toBe('Luna Studio');
    const [url, init] = fetcher.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(url).toBe('https://magicbooklet.test/api/creators/luna%20studio?limit=48');
    expect((init.headers as Headers).get('Authorization')).toBe('Bearer token-1');
  });

  it('loads and updates creator follow state through the profile follow API', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ following: false }))
      .mockResolvedValueOnce(jsonResponse({ following: true }));
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      fetcher: fetcher as unknown as typeof fetch,
    });

    await expect(api.getCreatorFollowState('creator-1')).resolves.toEqual({ following: false });
    await expect(api.setCreatorFollowing('creator-1', true)).resolves.toEqual({ following: true });

    const [getUrl, getInit] = fetcher.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(getUrl).toBe('https://magicbooklet.test/api/profile/follow?followingId=creator-1');
    expect((getInit.headers as Headers).get('Authorization')).toBe('Bearer token-1');

    const [postUrl, postInit] = fetcher.mock.calls[1] as unknown as [RequestInfo | URL, RequestInit];
    expect(postUrl).toBe('https://magicbooklet.test/api/profile/follow');
    expect(postInit.method).toBe('POST');
    expect(JSON.parse(String(postInit.body))).toEqual({ followingId: 'creator-1', following: true });
    expect((postInit.headers as Headers).get('Authorization')).toBe('Bearer token-1');
  });

  it('deduplicates explicitly anonymous showcase feed requests inside the content cache window', async () => {
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

    await api.getShowcaseFeed({ limit: 12, sort: 'recent' }, { auth: false });
    await api.getShowcaseFeed({ limit: 12, sort: 'recent' }, { auth: false });

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
    const fetcher = vi.fn(async () => jsonResponse({
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

  it('requests server-issued temporary media upload intents with JSON metadata', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      success: true,
      bucket: 'uploads',
      path: 'user-1/reference.png',
      storagePath: 'uploads/user-1/reference.png',
      token: 'upload-token',
      signedUploadUrl: 'https://storage.magicbooklet.test/upload-token',
      expiresInSeconds: 7200,
    }));
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      fetcher: fetcher as unknown as typeof fetch,
    });

    await api.createMediaUpload({
      fileName: 'reference.png',
      mimeType: 'image/png',
      kind: 'image',
      sizeBytes: 1234,
    });

    const [url, init] = fetcher.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(url).toBe('https://magicbooklet.test/api/uploads/media/sign');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      fileName: 'reference.png',
      mimeType: 'image/png',
      kind: 'image',
      sizeBytes: 1234,
    });
    expect((init.headers as Headers).get('Content-Type')).toBe('application/json');
    expect((init.headers as Headers).get('Authorization')).toBe('Bearer token-1');
  });

  it('requests server-issued temporary media read URLs with JSON metadata', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      success: true,
      signedUrl: 'https://storage.magicbooklet.test/signed/reference.png',
      expiresInSeconds: 3600,
    }));
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      fetcher: fetcher as unknown as typeof fetch,
    });

    await api.createMediaReadUrl({
      storagePath: 'uploads/user-1/reference.png',
    });

    const [url, init] = fetcher.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(url).toBe('https://magicbooklet.test/api/uploads/media/read-url');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      storagePath: 'uploads/user-1/reference.png',
    });
    expect((init.headers as Headers).get('Content-Type')).toBe('application/json');
    expect((init.headers as Headers).get('Authorization')).toBe('Bearer token-1');
  });

  it('requests server-issued profile media upload intents with JSON metadata', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      success: true,
      bucket: 'profiles',
      path: 'user-1/avatar.png',
      token: 'profile-upload-token',
      signedUploadUrl: 'https://storage.magicbooklet.test/profile-upload-token',
      publicUrl: 'https://storage.magicbooklet.test/profiles/user-1/avatar.png',
      expiresInSeconds: 7200,
    }));
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      fetcher: fetcher as unknown as typeof fetch,
    });

    await api.createProfileMediaUpload({
      role: 'avatar',
      fileName: 'avatar.png',
      mimeType: 'image/png',
      sizeBytes: 1234,
    });

    const [url, init] = fetcher.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(url).toBe('https://magicbooklet.test/api/profile/media/sign');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      role: 'avatar',
      fileName: 'avatar.png',
      mimeType: 'image/png',
      sizeBytes: 1234,
    });
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

  it('loads and caches the public generation model catalog', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      schemaVersion: 1,
      revision: '0123456789abcdef',
      defaults: { image: null, video: null, motion: null },
      models: [],
    }));
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      fetcher: fetcher as unknown as typeof fetch,
    });

    await api.listGenerationModels();
    await api.listGenerationModels();

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(url).toBe('https://magicbooklet.test/api/generation-models?platform=mobile&schemaVersion=1');
    expect((init.headers as Headers).get('Authorization')).toBeNull();
  });

  it('requests an authenticated authoritative generation quote', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      modelId: 'nano-banana-2',
      catalogRevision: '0123456789abcdef',
      normalizedSettings: { aspectRatio: '1:1', resolution: '1K' },
      costCredits: 8,
    }));
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      fetcher: fetcher as unknown as typeof fetch,
    });

    await api.quoteGenerationModel({
      kind: 'image',
      modelId: 'nano-banana-2',
      settings: { aspectRatio: '1:1', resolution: '1K' },
      inputCounts: { images: 0, videos: 0, audios: 0 },
      catalogRevision: '0123456789abcdef',
    });

    const [url, init] = fetcher.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(url).toBe('https://magicbooklet.test/api/generation-models/quote');
    expect(init.method).toBe('POST');
    expect((init.headers as Headers).get('Authorization')).toBe('Bearer token-1');
  });

  it('sends idempotency keys on generation starts', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      success: true,
      predictionId: 'prediction-1',
      generationId: 'gen-1',
      status: 'processing',
      remainingCredits: 92,
      cost: 8,
    }));
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      fetcher: fetcher as unknown as typeof fetch,
    });

    await api.startImageGeneration({
      model: 'nano-banana-2',
      prompt: 'A product hero shot.',
      catalogRevision: 'catalog-1',
    }, 'image:stable-request-1');

    const [url, init] = fetcher.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(url).toBe('https://magicbooklet.test/api/generate-image');
    expect(init.method).toBe('POST');
    expect((init.headers as Headers).get('Authorization')).toBe('Bearer token-1');
    expect((init.headers as Headers).get('Idempotency-Key')).toBe('image:stable-request-1');
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
    const fetcher = vi.fn(async () => jsonResponse({
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

  it('deletes owner posts without a JSON body by default', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      success: true,
      deleted: true,
    }));
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      fetcher: fetcher as unknown as typeof fetch,
    });

    await api.deletePost('post-123');

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(url).toBe('https://magicbooklet.test/api/posts/post-123');
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
    expect((init.headers as Headers).get('Content-Type')).toBeNull();
  });

  it('sends force delete for owner posts when requested', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      success: true,
      deleted: true,
    }));
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      fetcher: fetcher as unknown as typeof fetch,
    });

    await api.deletePost('post-123', { force: true });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(url).toBe('https://magicbooklet.test/api/posts/post-123');
    expect(init.method).toBe('DELETE');
    expect(JSON.parse(String(init.body))).toEqual({ force: true });
    expect((init.headers as Headers).get('Content-Type')).toBe('application/json');
  });
});
