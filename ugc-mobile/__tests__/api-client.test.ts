import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ACCOUNT_DELETION_TIMEOUT_MS,
  AccountDeletingError,
  ApiError,
  GENERATION_START_TIMEOUT_MS,
  SessionMergedError,
  SessionRejectedError,
  UpgradeRequiredError,
  createApiClient,
  isRequestTimeoutError,
  setAccountDeletingHandler,
  setSessionMergedHandler,
  setSessionRejectedHandler,
  setUpgradeRequiredHandler,
} from '../lib/api-client';

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

function upgradeRequiredResponse() {
  return new Response(JSON.stringify({
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
  });
}

describe('mobile api client caching', () => {
  it('loads full owner details for one creation without changing summary lists', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ generations: [{
      id: 'gen-1', output_url: '/api/media/output', model: 'nano-banana-2',
      input_media: [{ id: 'ref-1', mediaType: 'image', role: 'reference_image', url: '/api/media/reference' }],
    }] }));
    const api = createApiClient({ baseUrl: 'https://magicbooklet.test', getAccessToken: async () => 'token-1', fetcher: fetcher as typeof fetch });
    const generation = await api.getGenerationDetails('gen-1');
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    const query = new URL(url).searchParams;
    expect(query.get('id')).toBe('gen-1');
    expect(query.get('limit')).toBe('1');
    expect(query.get('detail')).not.toBe('summary');
    expect((init.headers as Headers).get('Authorization')).toBe('Bearer token-1');
    expect(generation?.input_media?.[0]).toMatchObject({ mediaType: 'image', url: 'https://magicbooklet.test/api/media/reference' });
  });

  it('does not substitute a different generation when owner details are unavailable', async () => {
    const api = createApiClient({ baseUrl: 'https://magicbooklet.test', getAccessToken: async () => 'token-1',
      fetcher: vi.fn(async () => jsonResponse({ generations: [{ id: 'different-generation' }] })) as typeof fetch });
    expect(await api.getGenerationDetails('missing-generation')).toBeNull();
  });
  it('sends authenticated moderation reports and user block mutations', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ success: true, blocked: true }));
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      fetcher: fetcher as unknown as typeof fetch,
    });

    await api.reportPost('post/1', { reason: 'unsafe_content', details: 'Unsafe post' });
    await api.reportUser('creator/1', {
      reason: 'harassment',
      sourceSurface: 'creator-profile',
    });
    await api.reportGeneration('generation/1', {
      reason: 'offensive_ai_output',
      sourceSurface: 'generation-viewer',
    });
    await api.blockUser('creator/1');

    const requests = fetcher.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(requests.map(([url, init]) => [url, init.method])).toEqual([
      ['https://magicbooklet.test/api/posts/post%2F1/report', 'POST'],
      ['https://magicbooklet.test/api/moderation/reports', 'POST'],
      ['https://magicbooklet.test/api/moderation/reports', 'POST'],
      ['https://magicbooklet.test/api/moderation/blocks/creator%2F1', 'POST'],
    ]);
    expect(JSON.parse(String(requests[1][1].body))).toEqual({
      targetType: 'user',
      targetId: 'creator/1',
      reason: 'harassment',
      sourceSurface: 'creator-profile',
    });
    expect(JSON.parse(String(requests[2][1].body))).toEqual({
      targetType: 'generation',
      targetId: 'generation/1',
      reason: 'offensive_ai_output',
      sourceSurface: 'generation-viewer',
    });
    for (const [, init] of requests) {
      expect((init.headers as Headers).get('Authorization')).toBe('Bearer token-1');
    }
  });

  it('names the recipe a post report is about, and sends no bundle otherwise', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ success: true }));
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      fetcher: fetcher as unknown as typeof fetch,
    });

    await api.reportPost('post-1', { reason: 'misleading_unlock', details: 'Not what it says', bundleId: 'bundle-1' });
    await api.reportPost('post-1', { reason: 'spam' });

    const bodies = (fetcher.mock.calls as unknown as Array<[string, RequestInit]>)
      .map(([, init]) => JSON.parse(String(init.body)));
    expect(bodies[0]).toEqual({ reason: 'misleading_unlock', details: 'Not what it says', bundleId: 'bundle-1' });
    expect(bodies[1]).toEqual({ reason: 'spam' });
  });

  it('names the feed delivery a post was reported from, and sends no delivery otherwise', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ success: true }));
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      fetcher: fetcher as unknown as typeof fetch,
    });

    await api.reportPost('post-1', { reason: 'unsafe_content', details: 'From the reel', deliveryId: '812' });
    await api.reportPost('post-1', { reason: 'unsafe_content', deliveryId: '' });
    await api.reportPost('post-1', { reason: 'spam' });

    const bodies = (fetcher.mock.calls as unknown as Array<[string, RequestInit]>)
      .map(([, init]) => JSON.parse(String(init.body)));
    expect(bodies).toEqual([
      { reason: 'unsafe_content', details: 'From the reel', deliveryId: '812' },
      { reason: 'unsafe_content' },
      { reason: 'spam' },
    ]);
  });

  it('sends an explicit confirmation and transient Apple authorization when deleting an account', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ success: true, deleted: true }));
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      fetcher: fetcher as unknown as typeof fetch,
    });

    await api.deleteAccount('DELETE', { appleAuthorizationCode: 'one-time-apple-code' });

    const [url, init] = fetcher.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(String(url)).toBe('https://magicbooklet.test/api/account');
    expect(init.method).toBe('DELETE');
    expect(JSON.parse(String(init.body))).toEqual({
      confirmation: 'DELETE',
      appleAuthorizationCode: 'one-time-apple-code',
    });
  });

  it('reads the scheduled deletion the server answers once the account is locked', async () => {
    const answer = { success: true, deleted: false, deletionScheduled: true };
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      fetcher: vi.fn(async () => new Response(JSON.stringify(answer), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch,
    });

    await expect(api.deleteAccount('DELETE')).resolves.toEqual(answer);
  });

  // At 30 s a slow answer read as "Account was not deleted" while the server
  // went on erasing it (audit 04-2).
  it('waits two minutes for a deletion before calling it unanswered, and says it had been sent', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      if (init?.signal) signals.push(init.signal);
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')), { once: true });
    }));
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      fetcher: fetcher as unknown as typeof fetch,
      requestTimeoutMs: 100,
    });
    try {
      const deletion = api.deleteAccount('DELETE').catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(ACCOUNT_DELETION_TIMEOUT_MS - 1_000);
      expect(signals).toHaveLength(1);
      expect(signals[0].aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(ACCOUNT_DELETION_TIMEOUT_MS).toBe(120_000);
      expect(signals[0].aborted).toBe(true);
      const error = await deletion;
      expect(error).toMatchObject({ name: 'ApiError', status: 0 });
      expect(isRequestTimeoutError(error)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tells a request that never got out from one it stopped waiting for', async () => {
    const offline = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      fetcher: vi.fn(async () => {
        throw new TypeError('Network request failed');
      }) as unknown as typeof fetch,
    });
    const refused = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      fetcher: vi.fn(async () => new Response(JSON.stringify({ error: 'Backend unavailable' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch,
    });

    const offlineError = await offline.deleteAccount('DELETE').catch((error: unknown) => error);
    expect(offlineError).toMatchObject({ name: 'ApiError', status: 0 });
    expect(isRequestTimeoutError(offlineError)).toBe(false);
    expect(isRequestTimeoutError(await refused.deleteAccount('DELETE').catch((error: unknown) => error))).toBe(false);
    expect(isRequestTimeoutError(new Error('Request timed out after 5ms'))).toBe(false);
  });

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
    const fetcher = vi.fn(async () => upgradeRequiredResponse());
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

    const error = await api.getProfile().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UpgradeRequiredError);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      name: 'UpgradeRequiredError',
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

  it('aborts hung API requests at the configured client timeout', async () => {
    const fetcher = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason ?? new Error('aborted'));
        }, { once: true });
      })
    ));
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      fetcher: fetcher as unknown as typeof fetch,
      requestTimeoutMs: 5,
    });

    await expect(api.getProfile()).rejects.toMatchObject({
      name: 'ApiError',
      status: 0,
    });
    const [, init] = fetcher.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(init.signal?.aborted).toBe(true);
  });

  it('gives a start two minutes before calling it unconfirmed, and every other request the client timeout', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      if (init?.signal) signals.push(init.signal);
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')), { once: true });
    }));
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      fetcher: fetcher as unknown as typeof fetch,
      clientInfo: { appVersion: '0.1.8', apiVersion: 1, catalogSchemaVersion: 3 },
      requestTimeoutMs: 100,
    });
    try {
      const profile = api.getProfile().catch((error) => error);
      const unified = api.startGeneration!({
        kind: 'video',
        modelId: 'seedance-2',
        catalogRevision: 'catalog-1',
        settings: {},
        prompt: 'A reveal',
        inputs: [],
      }, 'video:attempt-1').catch((error) => error);
      const perKind = api.startVideoGeneration({ model: 'seedance-2', prompt: 'A reveal' } as never, 'video:attempt-2').catch((error) => error);
      const templateRun = api.startTemplateRun('run-1', 'template-run-start:attempt-3').catch((error) => error);

      await vi.advanceTimersByTimeAsync(150);
      expect(await profile).toMatchObject({ name: 'ApiError', status: 0 });
      expect(signals.filter((signal) => signal.aborted)).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(GENERATION_START_TIMEOUT_MS - 200);
      expect(signals.filter((signal) => signal.aborted)).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(100);
      expect(GENERATION_START_TIMEOUT_MS).toBe(120_000);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      for (const start of [unified, perKind, templateRun]) {
        expect(await start).toMatchObject({ name: 'ApiError', status: 0 });
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('times out a media-link response that sends headers but stalls while sending its body', async () => {
    vi.useFakeTimers();
    const responseState: { signal: AbortSignal | null } = { signal: null };
    let closeBody: () => void = () => undefined;
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      responseState.signal = init?.signal ?? null;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"signedUrl":'));
          closeBody = () => { try { controller.close(); } catch { /* Already aborted. */ } };
          init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true });
        },
      });
      return new Response(stream, { headers: { 'Content-Type': 'application/json' } });
    });
    const api = createApiClient({ baseUrl: 'https://magicbooklet.test', getAccessToken: async () => 'token', fetcher, requestTimeoutMs: 100 });
    const result = api.getPostResourceFileUrl('post-1', 'references/video.mp4').catch(error => error);
    try {
      await vi.advanceTimersByTimeAsync(150);
      expect(responseState.signal?.aborted).toBe(true);
      expect(await result).toMatchObject({ name: 'ApiError', status: 0 });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      closeBody();
      await result;
      vi.useRealTimers();
    }
  });

  it('keeps caller cancellation attached until the response body has finished', async () => {
    const caller = new AbortController();
    const responseState: { signal: AbortSignal | null } = { signal: null };
    let closeBody: () => void = () => undefined;
    let bodyStarted: () => void = () => undefined;
    const ready = new Promise<void>(resolve => { bodyStarted = resolve; });
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      responseState.signal = init?.signal ?? null;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          closeBody = () => { try { controller.close(); } catch { /* Already aborted. */ } };
          init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true });
          bodyStarted();
        },
      }), { headers: { 'Content-Type': 'application/json' } });
    });
    const api = createApiClient({ baseUrl: 'https://magicbooklet.test', getAccessToken: async () => 'token', fetcher });
    const result = api.quoteGenerationModel({} as never, caller.signal).catch(error => error);
    try {
      await ready;
      await new Promise(resolve => setTimeout(resolve, 0));
      caller.abort();
      expect(responseState.signal?.aborted).toBe(true);
      expect(await result).toMatchObject({ name: 'ApiError', status: 0 });
    } finally {
      closeBody();
      await result;
    }
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

  it('posts a feed-event batch with only the explicitly captured identity token', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ success: true, recorded: 1, rejected: 0 }));
    const getAccessToken = vi.fn(async () => 'current-token-that-must-not-be-read');
    const installationId = `fid_${'e'.repeat(64)}`;
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken,
      getInstallationId: async () => installationId,
      fetcher: fetcher as unknown as typeof fetch,
    });
    const events = [{
      clientEventId: 'showcase:batch-1',
      deliveryId: 'delivery-1',
      postId: 'post-1',
      eventType: 'impression' as const,
      sourceSurface: 'showcase' as const,
      occurredAt: '2026-08-12T00:00:00.000Z',
    }];

    await api.recordShowcaseFeedEvents(events, { accessToken: 'captured-token' });

    const [url, init] = fetcher.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(String(url)).toBe('https://magicbooklet.test/api/showcase/feed/events');
    expect(JSON.parse(String(init.body))).toEqual({ events });
    expect((init.headers as Headers).get('Authorization')).toBe('Bearer captured-token');
    expect((init.headers as Headers).get('x-magicbooklet-installation-id')).toBe(installationId);
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it('sends a signed-out feed-event batch without borrowing a current token', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ success: true, recorded: 1, rejected: 0 }));
    const getAccessToken = vi.fn(async () => 'must-not-be-used');
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken,
      getInstallationId: async () => `fid_${'f'.repeat(64)}`,
      fetcher: fetcher as unknown as typeof fetch,
    });

    await api.recordShowcaseFeedEvents([{
      clientEventId: 'showcase:guest-batch-1',
      deliveryId: 'delivery-guest-1',
      postId: 'post-1',
      eventType: 'open',
      sourceSurface: 'showcase',
      occurredAt: '2026-08-12T00:00:00.000Z',
    }], { accessToken: null });

    const [, init] = fetcher.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect((init.headers as Headers).get('Authorization')).toBeNull();
    expect(getAccessToken).not.toHaveBeenCalled();
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

  it('surfaces a showcase-detail 404 instead of scanning a feed page for the post', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Post not found.' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }));
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      fetcher: fetcher as unknown as typeof fetch,
    });

    await expect(api.getShowcasePost('post-1')).rejects.toMatchObject({ status: 404 });
    // The retired fallback fetched a whole feed page here. It cost a full feed
    // round trip per miss, only searched the newest page, and had to forward
    // auth by hand or it leaked posts the viewer had blocked.
    expect(fetcher).toHaveBeenCalledTimes(1);
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

    const response = await api.listGenerations(true, { limit: 12 });

    const [url] = fetcher.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(url).toBe('https://magicbooklet.test/api/generations?detail=summary&includeArchived=true&limit=12');
    expect(response.generations[0].output_url).toBe(
      'https://storage.magicbooklet.test/generated_images/user-1/gen-1.jpg?token=signed'
    );
    expect(response.generations[0].output_urls).toEqual([
      'https://storage.magicbooklet.test/generated_images/user-1/gen-1.jpg?token=signed',
    ]);
  });

  it('asks for the status projection when a caller only counts runs', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      generations: [{ id: 'gen-1', status: 'processing', created_at: '2026-10-13T10:00:00.000Z', model: 'kling-3.0-video', category: 'video' }],
    }));
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      fetcher: fetcher as unknown as typeof fetch,
    });

    const response = await api.listGenerations(false, { limit: 20, detail: 'status' });

    const [url] = fetcher.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(url).toBe('https://magicbooklet.test/api/generations?detail=status&includeArchived=false&limit=20');
    expect(response.generations.map((generation) => generation.status)).toEqual(['processing']);
  });

  it('forwards a page cursor when asking for more generations', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      generations: [],
      pagination: { limit: 24, hasMore: false, nextCursor: null },
    }));
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      fetcher: fetcher as unknown as typeof fetch,
    });

    const response = await api.listGenerations(false, { cursor: '24', limit: 24 });

    const [url] = fetcher.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(url).toBe('https://magicbooklet.test/api/generations?detail=summary&includeArchived=false&limit=24&cursor=24');
    expect(response.pagination).toEqual({ limit: 24, hasMore: false, nextCursor: null });
  });

  it('resolves every creation descriptor media URL against the API origin', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ generations: [{
      id: 'video-1', output_url: '/api/media?path=original.mp4',
      media: {
        url: '/api/media?path=original.mp4', previewUrl: '/api/media?path=poster.webp',
        renditionUrl: '/api/media?path=playback.mp4', teaserUrl: '/api/media?path=teaser.mp4',
        feedStreamUrl: null,
      },
    }] }));
    const api = createApiClient({ baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1', fetcher: fetcher as unknown as typeof fetch });
    const { generations: [item] } = await api.listGenerations(true);
    expect(item.media).toMatchObject({
      url: 'https://magicbooklet.test/api/media?path=original.mp4',
      previewUrl: 'https://magicbooklet.test/api/media?path=poster.webp',
      renditionUrl: 'https://magicbooklet.test/api/media?path=playback.mp4',
      teaserUrl: 'https://magicbooklet.test/api/media?path=teaser.mp4', feedStreamUrl: null,
    });
  });

  it('resolves an owner display rendition and keeps an explicit or absent one as it came', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ generations: [
      { id: 'image-1', output_url: '/api/media?path=original.png',
        media: { url: '/api/media?path=original.png', previewUrl: null, displayUrl: '/api/media?path=display.webp' } },
      { id: 'image-2', output_url: 'https://cdn.example.com/small.png',
        media: { url: 'https://cdn.example.com/small.png', previewUrl: null, displayUrl: null } },
      { id: 'image-3', output_url: 'https://cdn.example.com/older-server.png',
        media: { url: 'https://cdn.example.com/older-server.png', previewUrl: null } },
    ] }));
    const api = createApiClient({ baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1', fetcher: fetcher as unknown as typeof fetch });

    const { generations: [display, explicitNull, absent] } = await api.listGenerations(false);

    expect(display.media?.displayUrl).toBe('https://magicbooklet.test/api/media?path=display.webp');
    expect(explicitNull.media?.displayUrl).toBeNull();
    expect(absent.media).not.toHaveProperty('displayUrl');
  });

  it('preserves template attribution while masking private recipe metadata', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      generations: [{
        id: 'gen-template',
        status: 'succeeded',
        output_url: 'https://cdn.example.com/result.png',
        model: 'private-provider-model',
        prompt: 'private workflow prompt',
        input_media: [{ url: 'https://cdn.example.com/private-input.png', kind: 'image' }],
        origin: 'template',
        template: { runId: 'run-1', templateId: 'template-1', templateTitle: 'Ghost rider' },
      }],
    }));
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      fetcher: fetcher as unknown as typeof fetch,
    });

    const item = (await api.listGenerations(true)).generations[0];
    expect(item).toMatchObject({
      origin: 'template',
      model: 'Magicbooklet template',
      prompt: null,
      input_media: [],
      template: { runId: 'run-1', templateId: 'template-1', templateTitle: 'Ghost rider' },
    });
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

  it('requests buyer unlock details and files by purchase UUID', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      success: true,
      signedUrl: 'https://cdn.magicbooklet.test/retained.zip',
    }));
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      fetcher: fetcher as unknown as typeof fetch,
    });

    await api.getViewerUnlockFileUrl('unlock-1', 'creator/resource.zip');

    const [url, init] = fetcher.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(url).toBe('https://magicbooklet.test/api/me/unlocks/unlock-1/file-url');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ storagePath: 'creator/resource.zip' });
  });

  it("signs a purchase's files in one call per tick, inline when asked, on the buyer-library route", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { storagePath?: string; storagePaths?: string[] };
      if (body.storagePaths) {
        return jsonResponse({ files: body.storagePaths.map((path) => ({ storagePath: path, url: `https://signed.test/${path}` })) });
      }
      return jsonResponse({ success: true, signedUrl: `https://signed.test/one/${body.storagePath}` });
    });
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      fetcher: fetcher as unknown as typeof fetch,
    });

    const urls = await Promise.all([
      api.resolveViewerUnlockFileUrl('unlock-1', 'retained/a.png', { disposition: 'inline' }),
      api.resolveViewerUnlockFileUrl('unlock-1', 'retained/b.mp4', { disposition: 'inline' }),
    ]);
    // An explicit Open asks for its one file on its own.
    const opened = await api.resolveViewerUnlockFileUrl('unlock-1', 'retained/guide.pdf', { disposition: 'inline' });
    await api.getViewerUnlockFileUrls('unlock-1', ['retained/c.png']);

    const requests = (fetcher.mock.calls as unknown as Array<[string, RequestInit]>)
      .map(([url, init]) => [url, init.method, JSON.parse(String(init.body))]);
    expect(requests).toEqual([
      ['https://magicbooklet.test/api/me/unlocks/unlock-1/file-url', 'POST', { storagePaths: ['retained/a.png', 'retained/b.mp4'], disposition: 'inline' }],
      ['https://magicbooklet.test/api/me/unlocks/unlock-1/file-url', 'POST', { storagePath: 'retained/guide.pdf', disposition: 'inline' }],
      ['https://magicbooklet.test/api/me/unlocks/unlock-1/file-url', 'POST', { storagePaths: ['retained/c.png'] }],
    ]);
    expect(urls).toEqual(['https://signed.test/retained/a.png', 'https://signed.test/retained/b.mp4']);
    expect(opened).toBe('https://signed.test/one/retained/guide.pdf');
  });

  it('signs one purchase file per call on a server without the batch form', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { storagePath?: string };
      // What the buyer-library route answered before it learned `storagePaths`.
      if (!body.storagePath) {
        return new Response(JSON.stringify({ error: 'Missing resource file path.' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return jsonResponse({ success: true, signedUrl: `https://signed.test/one/${body.storagePath}` });
    });
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      fetcher: fetcher as unknown as typeof fetch,
    });

    const urls = await Promise.all([
      api.resolveViewerUnlockFileUrl('unlock-1', 'retained/a.png'),
      api.resolveViewerUnlockFileUrl('unlock-1', 'retained/b.png'),
    ]);

    expect(urls).toEqual(['https://signed.test/one/retained/a.png', 'https://signed.test/one/retained/b.png']);
    expect(fetcher).toHaveBeenCalledTimes(3);
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

  it('conditionally refreshes the generation model catalog without authentication', async () => {
    const fetcher = vi.fn(async () => new Response(null, {
      status: 304,
      headers: { ETag: '"catalog-2"' },
    }));
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      fetcher: fetcher as unknown as typeof fetch,
    });

    await expect(api.fetchGenerationModels({ etag: '"catalog-1"' })).resolves.toEqual({
      catalog: null,
      etag: '"catalog-2"',
      notModified: true,
    });

    const [url, init] = fetcher.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    const headers = init.headers as Headers;
    expect(url).toBe('https://magicbooklet.test/api/generation-models?platform=mobile&schemaVersion=1');
    expect(headers.get('If-None-Match')).toBe('"catalog-1"');
    expect(headers.get('x-magicbooklet-client')).toBe('mobile');
    expect(headers.get('Authorization')).toBeNull();
  });

  it('bypasses the catalog etag on a forced refresh', async () => {
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

    await api.fetchGenerationModels({ etag: '"catalog-1"', forceRefresh: true });

    const [url, init] = fetcher.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(url).toBe('https://magicbooklet.test/api/generation-models?platform=mobile&schemaVersion=1&refresh=1');
    expect((init.headers as Headers).get('If-None-Match')).toBeNull();
    expect(init.cache).toBe('no-store');
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

  // The multipart route these used to share is retired and answers 410, so
  // resource files take the same sign/finalize path the web composer uses.
  it('signs post resource file uploads as JSON', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      success: true,
      bucket: 'post_resource_files',
      path: 'user-1/uuid-workflow.json',
      token: 'signed-token',
      signedUploadUrl: null,
      expiresInSeconds: 7200,
      expected: { fileName: 'workflow.json', contentType: 'application/json', sizeBytes: 128 },
    }));
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      fetcher: fetcher as unknown as typeof fetch,
    });

    await api.signPostResourceFileUpload({
      fileName: 'workflow.json',
      contentType: 'application/json',
      sizeBytes: 128,
    });

    const [url, init] = fetcher.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(url).toBe('https://magicbooklet.test/api/posts/resource-files/sign');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      fileName: 'workflow.json',
      contentType: 'application/json',
      sizeBytes: 128,
    });
    expect((init.headers as Headers).get('Authorization')).toBe('Bearer token-1');
  });

  it('finalizes post resource file uploads with the signed path', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      success: true,
      attachment: {
        label: 'workflow.json',
        kind: 'file',
        storagePath: 'user-1/uuid-workflow.json',
        contentType: 'application/json',
        sizeBytes: 128,
      },
    }));
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      fetcher: fetcher as unknown as typeof fetch,
    });

    await api.finalizePostResourceFileUpload({
      path: 'user-1/uuid-workflow.json',
      fileName: 'workflow.json',
      contentType: 'application/json',
      sizeBytes: 128,
    });

    const [url, init] = fetcher.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(url).toBe('https://magicbooklet.test/api/posts/resource-files/finalize');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body)).path).toBe('user-1/uuid-workflow.json');
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

describe('mobile api client forced-upgrade handling', () => {
  afterEach(() => {
    setUpgradeRequiredHandler(null);
    vi.useRealTimers();
  });

  function upgradeApi(fetcher: ReturnType<typeof vi.fn>) {
    return createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      clientInfo: {
        appVersion: '1.0.0',
        apiVersion: 1,
        catalogSchemaVersion: 1,
      },
      fetcher: fetcher as unknown as typeof fetch,
    });
  }

  it('invokes the registered handler exactly once for concurrent 426 responses', async () => {
    const handler = vi.fn();
    setUpgradeRequiredHandler(handler);
    const fetcher = vi.fn(async () => upgradeRequiredResponse());
    const api = upgradeApi(fetcher);

    const results = await Promise.allSettled([
      api.getProfile(),
      api.getOnboardingState(),
      api.getWelcomeCredits(),
    ]);

    expect(fetcher).toHaveBeenCalledTimes(3);
    for (const result of results) {
      expect(result.status).toBe('rejected');
      expect((result as PromiseRejectedResult).reason).toBeInstanceOf(UpgradeRequiredError);
    }
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({
      status: 426,
      code: 'MOBILE_UPDATE_REQUIRED',
    });
  });

  it('notifies again after the renotify window so a stranded user is re-routed', async () => {
    vi.useFakeTimers({ now: new Date('2026-07-25T10:00:00.000Z'), toFake: ['Date'] });
    const handler = vi.fn();
    setUpgradeRequiredHandler(handler);
    const fetcher = vi.fn(async () => upgradeRequiredResponse());
    const api = upgradeApi(fetcher);

    await expect(api.getProfile()).rejects.toBeInstanceOf(UpgradeRequiredError);
    await expect(api.getProfile()).rejects.toBeInstanceOf(UpgradeRequiredError);
    expect(handler).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-07-25T10:00:11.000Z'));
    await expect(api.getProfile()).rejects.toBeInstanceOf(UpgradeRequiredError);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('does not invoke the handler for other error statuses', async () => {
    const handler = vi.fn();
    setUpgradeRequiredHandler(handler);
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: 'Backend unavailable' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    }));
    const api = upgradeApi(fetcher);

    const error = await api.getProfile().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).not.toBeInstanceOf(UpgradeRequiredError);
    expect(handler).not.toHaveBeenCalled();
  });

  it('still throws the typed error when no handler is registered', async () => {
    const api = upgradeApi(vi.fn(async () => upgradeRequiredResponse()));

    await expect(api.getProfile()).rejects.toBeInstanceOf(UpgradeRequiredError);
  });

  it('surfaces the typed error even when the handler itself throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      setUpgradeRequiredHandler(() => {
        throw new Error('navigation exploded');
      });
      const api = upgradeApi(vi.fn(async () => upgradeRequiredResponse()));

      await expect(api.getProfile()).rejects.toBeInstanceOf(UpgradeRequiredError);
      expect(warn).toHaveBeenCalledWith('Upgrade-required handler failed', expect.any(Error));
    } finally {
      warn.mockRestore();
    }
  });

  it('resets deduplication when a new handler registers', async () => {
    const firstHandler = vi.fn();
    setUpgradeRequiredHandler(firstHandler);
    const api = upgradeApi(vi.fn(async () => upgradeRequiredResponse()));

    await expect(api.getProfile()).rejects.toBeInstanceOf(UpgradeRequiredError);
    expect(firstHandler).toHaveBeenCalledTimes(1);

    const secondHandler = vi.fn();
    setUpgradeRequiredHandler(secondHandler);
    await expect(api.getProfile()).rejects.toBeInstanceOf(UpgradeRequiredError);
    expect(secondHandler).toHaveBeenCalledTimes(1);
    expect(firstHandler).toHaveBeenCalledTimes(1);
  });

  it('routes 426 responses from the catalog fetch path through the same handler', async () => {
    const handler = vi.fn();
    setUpgradeRequiredHandler(handler);
    const api = upgradeApi(vi.fn(async () => upgradeRequiredResponse()));

    await expect(api.fetchGenerationModels()).rejects.toBeInstanceOf(UpgradeRequiredError);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('mobile api client merged-guest-session handling', () => {
  afterEach(() => {
    setSessionMergedHandler(null);
    vi.useRealTimers();
  });

  function sessionMergedResponse() {
    return new Response(JSON.stringify({
      code: 'SESSION_MERGED',
      error: 'This guest session has been linked to an account. Sign in to continue.',
    }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  function mergedApi(fetcher: ReturnType<typeof vi.fn>) {
    return createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      clientInfo: {
        appVersion: '1.0.0',
        apiVersion: 1,
        catalogSchemaVersion: 1,
      },
      fetcher: fetcher as unknown as typeof fetch,
    });
  }

  it('invokes the registered handler exactly once for concurrent 409 SESSION_MERGED responses', async () => {
    const handler = vi.fn();
    setSessionMergedHandler(handler);
    const fetcher = vi.fn(async () => sessionMergedResponse());
    const api = mergedApi(fetcher);

    // A merged identity fails every authenticated route at once, so a burst is
    // the normal case here rather than an edge one.
    const results = await Promise.allSettled([
      api.getProfile(),
      api.getOnboardingState(),
      api.getWelcomeCredits(),
    ]);

    expect(fetcher).toHaveBeenCalledTimes(3);
    for (const result of results) {
      expect(result.status).toBe('rejected');
      expect((result as PromiseRejectedResult).reason).toBeInstanceOf(SessionMergedError);
    }
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({
      name: 'SessionMergedError',
      status: 409,
      code: 'SESSION_MERGED',
    });
  });

  it('notifies again after the renotify window so a stranded device is re-routed', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-10T10:00:00.000Z'), toFake: ['Date'] });
    const handler = vi.fn();
    setSessionMergedHandler(handler);
    const fetcher = vi.fn(async () => sessionMergedResponse());
    const api = mergedApi(fetcher);

    await expect(api.getProfile()).rejects.toBeInstanceOf(SessionMergedError);
    await expect(api.getProfile()).rejects.toBeInstanceOf(SessionMergedError);
    expect(handler).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-09-10T10:00:11.000Z'));
    await expect(api.getProfile()).rejects.toBeInstanceOf(SessionMergedError);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('leaves a mid-deletion account alone: 409 ACCOUNT_DELETING is not a merged session', async () => {
    // Both failures are 409. The merged-guest teardown belongs to the merged
    // one only: it would refuse a registered session, which is what is being
    // deleted. ACCOUNT_DELETING has a handler of its own.
    const handler = vi.fn();
    setSessionMergedHandler(handler);
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      code: 'ACCOUNT_DELETING',
      error: 'This account is being permanently deleted.',
    }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    }));
    const api = mergedApi(fetcher);

    const error = await api.getProfile().catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).not.toBeInstanceOf(SessionMergedError);
    expect(error).toMatchObject({ status: 409, code: 'ACCOUNT_DELETING' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not invoke the handler for a 409 that carries no code', async () => {
    const handler = vi.fn();
    setSessionMergedHandler(handler);
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      error: 'Conflict',
    }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    }));
    const api = mergedApi(fetcher);

    const error = await api.getProfile().catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).not.toBeInstanceOf(SessionMergedError);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('mobile api client account-deleting handling', () => {
  afterEach(() => {
    setAccountDeletingHandler(null);
    setSessionMergedHandler(null);
    vi.useRealTimers();
  });

  function accountDeletingResponse() {
    return new Response(JSON.stringify({
      code: 'ACCOUNT_DELETING',
      error: 'This account is being permanently deleted.',
    }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  function apiWithToken(fetcher: ReturnType<typeof vi.fn>, token: string | null = 'token-1') {
    return createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => token,
      fetcher: fetcher as unknown as typeof fetch,
    });
  }

  // A deletion asked for on another device, or one whose answer this phone
  // never saw, refused every request with a plain error (audit 04-2).
  it('ends the session once for a burst of 409 ACCOUNT_DELETING answers', async () => {
    const handler = vi.fn();
    const merged = vi.fn();
    setAccountDeletingHandler(handler);
    setSessionMergedHandler(merged);
    const fetcher = vi.fn(async () => accountDeletingResponse());
    const api = apiWithToken(fetcher);

    const results = await Promise.allSettled([api.getProfile(), api.getShowcaseFeed(), api.getWelcomeCredits()]);

    expect(fetcher).toHaveBeenCalledTimes(3);
    for (const result of results) {
      expect((result as PromiseRejectedResult).reason).toBeInstanceOf(AccountDeletingError);
      expect((result as PromiseRejectedResult).reason).toBeInstanceOf(ApiError);
    }
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({ name: 'AccountDeletingError', status: 409, code: 'ACCOUNT_DELETING' });
    expect(merged).not.toHaveBeenCalled();
  });

  it('ignores a token the caller supplied itself', async () => {
    // The feed-event queue drains a previous identity's events with that
    // identity's own token: its account says nothing about who is signed in now.
    const handler = vi.fn();
    setAccountDeletingHandler(handler);
    const api = apiWithToken(vi.fn(async () => accountDeletingResponse()));

    const error = await api.recordShowcaseFeedEvents([], { accessToken: 'previous-identity-token' })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(AccountDeletingError);
    expect(handler).not.toHaveBeenCalled();
  });

  it('notifies again after the renotify window', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-14T10:00:00.000Z'), toFake: ['Date'] });
    const handler = vi.fn();
    setAccountDeletingHandler(handler);
    const api = apiWithToken(vi.fn(async () => accountDeletingResponse()));

    await expect(api.getProfile()).rejects.toBeInstanceOf(AccountDeletingError);
    await expect(api.getProfile()).rejects.toBeInstanceOf(AccountDeletingError);
    expect(handler).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-10-14T10:00:11.000Z'));
    await expect(api.getProfile()).rejects.toBeInstanceOf(AccountDeletingError);
    expect(handler).toHaveBeenCalledTimes(2);
  });
});

describe('mobile api client refused-token handling', () => {
  afterEach(() => {
    setSessionRejectedHandler(null);
    vi.useRealTimers();
  });

  // What src/proxy.ts answers when the bearer token names a session Supabase no
  // longer has — for example one ended by "Sign out" on another device.
  function refusedTokenResponse(body: Record<string, unknown> = { error: 'Unauthorized', code: 'UNAUTHORIZED' }) {
    return new Response(JSON.stringify(body), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  function apiWithToken(fetcher: ReturnType<typeof vi.fn>, token: string | null = 'token-1') {
    return createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => token,
      clientInfo: {
        appVersion: '1.0.0',
        apiVersion: 1,
        catalogSchemaVersion: 1,
      },
      fetcher: fetcher as unknown as typeof fetch,
    });
  }

  it('invokes the registered handler exactly once for a burst of refused tokens', async () => {
    const handler = vi.fn();
    setSessionRejectedHandler(handler);
    const fetcher = vi.fn(async () => refusedTokenResponse());
    const api = apiWithToken(fetcher);

    // A session ended elsewhere fails every request at once — the feed, the
    // profile, notifications — so a burst is the normal case.
    const results = await Promise.allSettled([
      api.getProfile(),
      api.getShowcaseFeed(),
      api.getWelcomeCredits(),
    ]);

    expect(fetcher).toHaveBeenCalledTimes(3);
    for (const result of results) {
      expect(result.status).toBe('rejected');
      expect((result as PromiseRejectedResult).reason).toBeInstanceOf(SessionRejectedError);
    }
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({
      name: 'SessionRejectedError',
      status: 401,
      code: 'UNAUTHORIZED',
    });
  });

  it('leaves a request that carried no token alone: a signed-out 401 has no session to recover', async () => {
    const handler = vi.fn();
    setSessionRejectedHandler(handler);
    const fetcher = vi.fn(async () => refusedTokenResponse());
    const api = apiWithToken(fetcher, null);

    const error = await api.getProfile().catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).not.toBeInstanceOf(SessionRejectedError);
    expect(error).toMatchObject({ status: 401 });
    expect(handler).not.toHaveBeenCalled();
  });

  it('treats a 401 without a code as a refused token too', async () => {
    // Route adapters that check the token themselves answer 401 with no code.
    const handler = vi.fn();
    setSessionRejectedHandler(handler);
    const fetcher = vi.fn(async () => refusedTokenResponse({ error: 'Authentication required.' }));
    const api = apiWithToken(fetcher);

    await expect(api.getShowcaseFeed()).rejects.toBeInstanceOf(SessionRejectedError);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('ignores a token the caller supplied itself', async () => {
    // The feed-event queue drains a previous identity's events with that
    // identity's own token. Its refusal says nothing about the current session.
    const handler = vi.fn();
    setSessionRejectedHandler(handler);
    const fetcher = vi.fn(async () => refusedTokenResponse());
    const api = apiWithToken(fetcher);

    const error = await api.recordShowcaseFeedEvents([], { accessToken: 'previous-identity-token' })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).not.toBeInstanceOf(SessionRejectedError);
    expect(handler).not.toHaveBeenCalled();
  });

  it('notifies again after the renotify window so a still-refused device retries its recovery', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-11T10:00:00.000Z'), toFake: ['Date'] });
    const handler = vi.fn();
    setSessionRejectedHandler(handler);
    const fetcher = vi.fn(async () => refusedTokenResponse());
    const api = apiWithToken(fetcher);

    await expect(api.getProfile()).rejects.toBeInstanceOf(SessionRejectedError);
    await expect(api.getProfile()).rejects.toBeInstanceOf(SessionRejectedError);
    expect(handler).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-09-11T10:00:11.000Z'));
    await expect(api.getProfile()).rejects.toBeInstanceOf(SessionRejectedError);
    expect(handler).toHaveBeenCalledTimes(2);
  });
});

describe('signing bundle files', () => {
  type Fetcher = ReturnType<typeof vi.fn>;

  function errorResponse(status: number, error: string) {
    return new Response(JSON.stringify({ error }), { status, headers: { 'Content-Type': 'application/json' } });
  }

  function clientWith(fetcher: Fetcher) {
    return createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      fetcher: fetcher as unknown as typeof fetch,
    });
  }

  function bodies(fetcher: Fetcher) {
    return fetcher.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)));
  }

  /** A server with the batch form: signs every path it is sent. */
  function batchServer() {
    return vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { storagePath?: string; storagePaths?: string[] };
      if (body.storagePaths) {
        return jsonResponse({ files: body.storagePaths.map((path) => ({ storagePath: path, url: `https://signed.test/${path}` })) });
      }
      return jsonResponse({ success: true, signedUrl: `https://signed.test/one/${body.storagePath}` });
    });
  }

  it('asks for an inline file only when told to, and keeps the plain body otherwise', async () => {
    const fetcher = batchServer();
    const api = clientWith(fetcher);

    await api.getPostResourceFileUrl('post-1', 'refs/a.jpg', { disposition: 'inline' });
    await api.getPostResourceFileUrl('post-1', 'refs/a.jpg');

    expect(bodies(fetcher)).toEqual([
      { storagePath: 'refs/a.jpg', disposition: 'inline' },
      { storagePath: 'refs/a.jpg' },
    ]);
  });

  it('signs every path asked for in the same tick with one call', async () => {
    const fetcher = batchServer();
    const api = clientWith(fetcher);

    const urls = await Promise.all([
      api.resolvePostResourceFileUrl('post-1', 'refs/a.jpg', { disposition: 'inline' }),
      api.resolvePostResourceFileUrl('post-1', 'refs/b.mp4', { disposition: 'inline' }),
      api.resolvePostResourceFileUrl('post-1', 'refs/a.jpg', { disposition: 'inline' }),
    ]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe('https://magicbooklet.test/api/posts/post-1/resource-bundle/file-url');
    expect(bodies(fetcher)).toEqual([{ storagePaths: ['refs/a.jpg', 'refs/b.mp4'], disposition: 'inline' }]);
    expect(urls).toEqual(['https://signed.test/refs/a.jpg', 'https://signed.test/refs/b.mp4', 'https://signed.test/refs/a.jpg']);
  });

  it('signs a path asked for on its own with the single form every server knows', async () => {
    const fetcher = batchServer();
    const api = clientWith(fetcher);

    await expect(api.resolvePostResourceFileUrl('post-1', 'files/guide.pdf', { disposition: 'inline' }))
      .resolves.toBe('https://signed.test/one/files/guide.pdf');
    expect(bodies(fetcher)).toEqual([{ storagePath: 'files/guide.pdf', disposition: 'inline' }]);
  });

  it('keeps separate posts in separate requests', async () => {
    const fetcher = batchServer();
    const api = clientWith(fetcher);

    await Promise.all([
      api.resolvePostResourceFileUrl('post-1', 'refs/a.jpg'),
      api.resolvePostResourceFileUrl('post-2', 'refs/b.jpg'),
    ]);

    expect(fetcher.mock.calls.map((call) => String(call[0]))).toEqual([
      'https://magicbooklet.test/api/posts/post-1/resource-bundle/file-url',
      'https://magicbooklet.test/api/posts/post-2/resource-bundle/file-url',
    ]);
  });

  it('signs one path per call on a server without the batch form', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { storagePath?: string };
      // What the route answered before it learned `storagePaths`.
      if (!body.storagePath) return errorResponse(400, 'Missing resource file path.');
      return jsonResponse({ success: true, signedUrl: `https://signed.test/one/${body.storagePath}` });
    });
    const api = clientWith(fetcher);

    const urls = await Promise.all([
      api.resolvePostResourceFileUrl('post-1', 'refs/a.jpg'),
      api.resolvePostResourceFileUrl('post-1', 'refs/b.jpg'),
    ]);

    expect(urls).toEqual(['https://signed.test/one/refs/a.jpg', 'https://signed.test/one/refs/b.jpg']);
    expect(bodies(fetcher)).toEqual([
      { storagePaths: ['refs/a.jpg', 'refs/b.jpg'] },
      { storagePath: 'refs/a.jpg' },
      { storagePath: 'refs/b.jpg' },
    ]);
  });

  it('takes a whole-batch 404 as the answer for every path, without asking for each again', async () => {
    // The route answers 404 only when nothing asked for is on the unlock.
    const fetcher = vi.fn(async () => errorResponse(404, 'Resource file not found on this unlock.'));
    const api = clientWith(fetcher);

    const results = await Promise.allSettled([
      api.resolvePostResourceFileUrl('post-1', 'refs/gone-a.jpg'),
      api.resolvePostResourceFileUrl('post-1', 'refs/gone-b.jpg'),
    ]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(((results[1] as PromiseRejectedResult).reason as ApiError).status).toBe(404);
  });

  it('gives every path the answer when access or the signing limit stops the batch', async () => {
    const fetcher = vi.fn(async () => errorResponse(403, 'Unlock this resource before downloading files.'));
    const api = clientWith(fetcher);

    const results = await Promise.allSettled([
      api.resolvePostResourceFileUrl('post-1', 'refs/a.jpg'),
      api.resolvePostResourceFileUrl('post-1', 'refs/b.jpg'),
    ]);

    // No retry per path: it would be refused the same way, and spend the limit.
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(((results[0] as PromiseRejectedResult).reason as Error).message).toBe('Unlock this resource before downloading files.');
  });

  it('refuses a path the batch answer left out, without a second request', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ files: [{ storagePath: 'refs/a.jpg', url: 'https://signed.test/refs/a.jpg' }] }));
    const api = clientWith(fetcher);

    const [kept, missing] = await Promise.allSettled([
      api.resolvePostResourceFileUrl('post-1', 'refs/a.jpg'),
      api.resolvePostResourceFileUrl('post-1', 'refs/b.jpg'),
    ]);

    expect(kept).toEqual({ status: 'fulfilled', value: 'https://signed.test/refs/a.jpg' });
    expect(missing.status).toBe('rejected');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('signs more than the batch limit in calls of 25', async () => {
    const fetcher = batchServer();
    const api = clientWith(fetcher);
    const paths = Array.from({ length: 30 }, (_, index) => `refs/${index}.jpg`);

    const urls = await Promise.all(paths.map((path) => api.resolvePostResourceFileUrl('post-1', path)));

    expect(bodies(fetcher).map((body: { storagePaths: string[] }) => body.storagePaths.length)).toEqual([25, 5]);
    expect(urls[29]).toBe('https://signed.test/refs/29.jpg');
  });
});
