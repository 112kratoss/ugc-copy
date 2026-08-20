import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import {
  SHOWCASE_FEED_EVENT_REQUEST_BODY_MAX_BYTES,
  postShowcaseFeedEventRouteResponse,
} from '@/lib/showcase-feed-events-route-adapter-service';
import {
  parseShowcaseFeedEventPayload,
  type ShowcaseFeedEventBatchRecordResult,
  type ShowcaseFeedEventPayload,
} from '@/lib/showcase-feed-events-service';

const POST_ID = '72000000-0000-4000-8000-000000000001';

function createUserClient(userId: string | null, error: Error | null = null) {
  return {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: userId ? { id: userId } : null }, error })),
    },
  } as unknown as SupabaseClient;
}

describe('showcase feed events route adapter', () => {
  it('records a valid authenticated qualified impression with private cache headers', async () => {
    const recordShowcaseFeedEvent = vi.fn(async () => ({ ok: true as const, body: { success: true as const } }));
    const enforceBackendRateLimit = vi.fn(async () => ({
      allowed: true,
      limit: 300,
      remaining: 299,
      retryAfterSeconds: 0,
      resetAt: new Date().toISOString(),
    }));
    const request = new Request('http://localhost/api/showcase/feed/events', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token',
        'Content-Type': 'application/json',
        'x-request-id': 'feed-event-1',
      },
      body: JSON.stringify({
        clientEventId: 'event-1',
        postId: POST_ID,
        eventType: 'impression',
        sourceSurface: 'showcase',
        position: 0,
      }),
    });

    const response = await postShowcaseFeedEventRouteResponse({
      request,
      dependencies: {
        createUserClient: vi.fn(() => createUserClient('viewer-1')),
        createServiceClient: vi.fn(() => ({}) as SupabaseClient),
        enforceBackendRateLimit,
        getFeedAnonymousKeyHash: vi.fn(() => 'anon-hash'),
        getFeedNetworkKeyHash: vi.fn(() => 'network-hash'),
        recordShowcaseFeedEvent,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('feed-event-1');
    expect(enforceBackendRateLimit).toHaveBeenNthCalledWith(1, expect.anything(), expect.objectContaining({
      scope: 'showcase-feed:event-network-admission',
      key: 'network-hash',
    }));
    expect(enforceBackendRateLimit).toHaveBeenNthCalledWith(2, expect.anything(), expect.objectContaining({
      scope: 'showcase-feed:event',
      key: 'viewer-1',
    }));
    expect(recordShowcaseFeedEvent).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 'viewer-1',
      anonymousKeyHash: 'anon-hash',
      payload: expect.objectContaining({ eventType: 'impression', postId: POST_ID, position: 0 }),
    }));
  });

  it('allows anonymous events while using a privacy-preserving rate-limit key', async () => {
    const recordShowcaseFeedEvent = vi.fn(async () => ({ ok: true as const, body: { success: true as const } }));
    const enforceBackendRateLimit = vi.fn(async () => ({
      allowed: true,
      limit: 300,
      remaining: 299,
      retryAfterSeconds: 0,
      resetAt: new Date().toISOString(),
    }));
    const response = await postShowcaseFeedEventRouteResponse({
      request: new Request('http://localhost/api/showcase/feed/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientEventId: 'event-anon-1',
          postId: POST_ID,
          eventType: 'open',
          sourceSurface: 'showcase-reel',
        }),
      }),
      dependencies: {
        createUserClient: vi.fn(() => createUserClient(null)),
        createServiceClient: vi.fn(() => ({}) as SupabaseClient),
        enforceBackendRateLimit,
        getFeedAnonymousKeyHash: vi.fn(() => 'anon-hash'),
        getFeedNetworkKeyHash: vi.fn(() => 'network-hash'),
        resolveFeedAnonymousIdentity: vi.fn(() => ({
          anonymousKeyHash: 'anon-hash',
          cookieValueToSet: `fid_${'e'.repeat(64)}`,
          source: 'web-cookie' as const,
        })),
        recordShowcaseFeedEvent,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('__Host-magicbooklet-feed-id=fid_');
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(enforceBackendRateLimit).toHaveBeenCalledTimes(1);
    expect(enforceBackendRateLimit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      scope: 'showcase-feed:event-network-admission',
      key: 'network-hash',
    }));
    expect(recordShowcaseFeedEvent).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: null,
      anonymousKeyHash: 'anon-hash',
    }));
  });

  it('rejects an invalid supplied authorization header instead of treating it as anonymous', async () => {
    const recordShowcaseFeedEvent = vi.fn();
    const enforceBackendRateLimit = vi.fn(async () => ({
      allowed: true,
      limit: 300,
      remaining: 299,
      retryAfterSeconds: 0,
      resetAt: new Date().toISOString(),
    }));
    const response = await postShowcaseFeedEventRouteResponse({
      request: new Request('http://localhost/api/showcase/feed/events', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer expired-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          clientEventId: 'event-expired-1',
          postId: POST_ID,
          eventType: 'not_interested',
          sourceSurface: 'showcase',
        }),
      }),
      dependencies: {
        createUserClient: vi.fn(() => createUserClient(null)),
        createServiceClient: vi.fn(() => ({}) as SupabaseClient),
        enforceBackendRateLimit,
        getFeedAnonymousKeyHash: vi.fn(() => 'anon-hash'),
        getFeedNetworkKeyHash: vi.fn(() => 'network-hash'),
        recordShowcaseFeedEvent,
      },
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Authentication required.' });
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(enforceBackendRateLimit).toHaveBeenCalledTimes(1);
    expect(recordShowcaseFeedEvent).not.toHaveBeenCalled();
  });

  it('rejects unsupported event types and oversized or malformed optional values', () => {
    expect(parseShowcaseFeedEventPayload({
      clientEventId: 'event-1',
      postId: POST_ID,
      eventType: 'like',
      sourceSurface: 'showcase',
    })).toMatchObject({ ok: false, status: 400 });

    expect(parseShowcaseFeedEventPayload({
      clientEventId: 'event-2',
      postId: POST_ID,
      eventType: 'dwell',
      sourceSurface: 'showcase',
      durationMs: -1,
    })).toMatchObject({ ok: false, status: 400 });
  });

  it('keeps authenticated actor budgets separate for viewers sharing one network', async () => {
    const recordShowcaseFeedEvent = vi.fn(async () => ({
      ok: true as const,
      body: { success: true as const },
    }));
    const limitedActor = new BackendRateLimitError({
      allowed: false,
      limit: 300,
      remaining: 0,
      retryAfterSeconds: 30,
      resetAt: '2026-08-19T12:00:00.000Z',
    });
    const enforceBackendRateLimit = vi.fn(async (
      _client: unknown,
      options: { scope: string; key: string },
    ) => {
      if (options.scope === 'showcase-feed:event' && options.key === 'viewer-1') {
        throw limitedActor;
      }
      return {
        allowed: true,
        limit: options.scope === 'showcase-feed:event' ? 300 : 3_000,
        remaining: 299,
        retryAfterSeconds: 0,
        resetAt: '2026-08-19T12:00:00.000Z',
      };
    });

    const requestFor = (clientEventId: string) => new Request(
      'http://localhost/api/showcase/feed/events',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientEventId,
          postId: POST_ID,
          eventType: 'open',
          sourceSurface: 'showcase',
        }),
      },
    );
    const dependenciesFor = (userId: string) => ({
      createUserClient: vi.fn(() => createUserClient(userId)),
      createServiceClient: vi.fn(() => ({}) as SupabaseClient),
      enforceBackendRateLimit,
      getFeedAnonymousKeyHash: vi.fn(() => 'anon-hash'),
      getFeedNetworkKeyHash: vi.fn(() => 'shared-network-hash'),
      recordShowcaseFeedEvent,
    });

    const limited = await postShowcaseFeedEventRouteResponse({
      request: requestFor('event-shared-network-1'),
      dependencies: dependenciesFor('viewer-1'),
    });
    const allowed = await postShowcaseFeedEventRouteResponse({
      request: requestFor('event-shared-network-2'),
      dependencies: dependenciesFor('viewer-2'),
    });

    expect(limited.status).toBe(429);
    expect(allowed.status).toBe(200);
    expect(enforceBackendRateLimit.mock.calls.map(([, options]) => options)).toEqual([
      expect.objectContaining({
        scope: 'showcase-feed:event-network-admission',
        key: 'shared-network-hash',
      }),
      expect.objectContaining({ scope: 'showcase-feed:event', key: 'viewer-1' }),
      expect.objectContaining({
        scope: 'showcase-feed:event-network-admission',
        key: 'shared-network-hash',
      }),
      expect.objectContaining({ scope: 'showcase-feed:event', key: 'viewer-2' }),
    ]);
    expect(recordShowcaseFeedEvent).toHaveBeenCalledTimes(1);
  });

  it('accepts only database-safe UUID and bigint identifier shapes', () => {
    expect(parseShowcaseFeedEventPayload({
      clientEventId: 'event-valid-identifiers',
      feedSessionId: '73000000-0000-4000-8000-000000000001',
      deliveryId: '9223372036854775807',
      postId: POST_ID,
      eventType: 'impression',
      sourceSurface: 'showcase',
    })).toMatchObject({ ok: true });

    for (const identifiers of [
      { postId: 'post-not-a-uuid' },
      { feedSessionId: 'session-not-a-uuid' },
      { deliveryId: 'delivery-not-a-bigint' },
      { deliveryId: '9223372036854775808' },
    ]) {
      expect(parseShowcaseFeedEventPayload({
        clientEventId: 'event-invalid-identifiers',
        postId: POST_ID,
        eventType: 'impression',
        sourceSurface: 'showcase',
        ...identifiers,
      })).toMatchObject({ ok: false, status: 400 });
    }
  });

  function batchEvent(index: number) {
    return {
      clientEventId: `event-${index}`,
      postId: POST_ID,
      eventType: 'impression',
      sourceSurface: 'showcase',
      position: index,
    };
  }

  // Generic so each mock's precise call signature survives into the dependency
  // object; a widened vi.fn type stops matching the adapter's contract.
  function batchDependencies<TRecord, TLimit>(recordShowcaseFeedEvent: TRecord, enforceBackendRateLimit: TLimit) {
    const recordShowcaseFeedEvents = vi.fn(async ({ payloads }: { payloads: ShowcaseFeedEventPayload[] }) => ({
      ok: true as const,
      body: { success: true as const, recorded: payloads.length, rejected: 0 },
      results: payloads.map(() => ({ ok: true as const, body: { success: true as const } })),
    }));
    return {
      createUserClient: vi.fn(() => createUserClient('viewer-1')),
      createServiceClient: vi.fn(() => ({}) as SupabaseClient),
      enforceBackendRateLimit,
      getFeedAnonymousKeyHash: vi.fn(() => 'anon-hash'),
      getFeedNetworkKeyHash: vi.fn(() => 'network-hash'),
      recordShowcaseFeedEvent,
      recordShowcaseFeedEvents,
    };
  }

  function batchRequest(body: unknown) {
    return new Request('http://localhost/api/showcase/feed/events', {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('charges one auth plus one network and actor admission for a whole batch', async () => {
    // A fully-watched reel produced ~7 requests, each re-running auth and a
    // rate-limit write transaction. That per-request overhead, not the inserts,
    // is what batching removes.
    const recordShowcaseFeedEvent = vi.fn(async () => ({ ok: true as const, body: { success: true as const } }));
    const enforceBackendRateLimit = vi.fn(async () => ({
      allowed: true, limit: 300, remaining: 299, retryAfterSeconds: 0, resetAt: new Date().toISOString(),
    }));
    const dependencies = batchDependencies(recordShowcaseFeedEvent, enforceBackendRateLimit);

    const response = await postShowcaseFeedEventRouteResponse({
      request: batchRequest({ events: [0, 1, 2, 3, 4, 5, 6].map(batchEvent) }),
      dependencies,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true, recorded: 7, rejected: 0 });
    expect(recordShowcaseFeedEvent).not.toHaveBeenCalled();
    expect(dependencies.recordShowcaseFeedEvents).toHaveBeenCalledTimes(1);
    expect(dependencies.recordShowcaseFeedEvents).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 'viewer-1',
      anonymousKeyHash: 'anon-hash',
      payloads: expect.arrayContaining([
        expect.objectContaining({ clientEventId: 'event-0' }),
        expect.objectContaining({ clientEventId: 'event-6' }),
      ]),
    }));
    expect(enforceBackendRateLimit).toHaveBeenCalledTimes(2);
    expect(dependencies.createUserClient).toHaveBeenCalledTimes(1);
  });

  it('answers a single event in the original shape, for clients that cannot be updated yet', async () => {
    // Mobile ships on its own store train, so builds sending one event per
    // request stay in the wild long after the server learns to batch.
    const recordShowcaseFeedEvent = vi.fn(async () => ({ ok: true as const, body: { success: true as const } }));
    const enforceBackendRateLimit = vi.fn(async () => ({
      allowed: true, limit: 300, remaining: 299, retryAfterSeconds: 0, resetAt: new Date().toISOString(),
    }));

    const response = await postShowcaseFeedEventRouteResponse({
      request: batchRequest(batchEvent(0)),
      dependencies: batchDependencies(recordShowcaseFeedEvent, enforceBackendRateLimit),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(recordShowcaseFeedEvent).toHaveBeenCalledTimes(1);
  });

  it('records the valid events in a batch that also contains a malformed one', async () => {
    // The client has already dropped these from its queue, so discarding the
    // whole flush over one bad entry loses telemetry that cannot be re-sent.
    const recordShowcaseFeedEvent = vi.fn(async () => ({ ok: true as const, body: { success: true as const } }));
    const enforceBackendRateLimit = vi.fn(async () => ({
      allowed: true, limit: 300, remaining: 299, retryAfterSeconds: 0, resetAt: new Date().toISOString(),
    }));

    const response = await postShowcaseFeedEventRouteResponse({
      request: batchRequest({ events: [batchEvent(0), { eventType: 'nonsense' }, batchEvent(2)] }),
      dependencies: batchDependencies(recordShowcaseFeedEvent, enforceBackendRateLimit),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true, recorded: 2, rejected: 0 });
    expect(recordShowcaseFeedEvent).not.toHaveBeenCalled();
  });

  it('rejects an oversized batch instead of accepting unbounded work per request', async () => {
    const recordShowcaseFeedEvent = vi.fn(async () => ({ ok: true as const, body: { success: true as const } }));
    const enforceBackendRateLimit = vi.fn(async () => ({
      allowed: true, limit: 300, remaining: 299, retryAfterSeconds: 0, resetAt: new Date().toISOString(),
    }));

    const response = await postShowcaseFeedEventRouteResponse({
      request: batchRequest({ events: Array.from({ length: 26 }, (_, index) => batchEvent(index)) }),
      dependencies: batchDependencies(recordShowcaseFeedEvent, enforceBackendRateLimit),
    });

    expect(response.status).toBe(400);
    // Invalid requests still consume network admission before parsing.
    expect(enforceBackendRateLimit).toHaveBeenCalledTimes(1);
    expect(recordShowcaseFeedEvent).not.toHaveBeenCalled();
  });

  it('returns 413 for an undeclared oversized stream after network admission', async () => {
    const recordShowcaseFeedEvent = vi.fn();
    const enforceBackendRateLimit = vi.fn(async () => ({
      allowed: true, limit: 300, remaining: 299, retryAfterSeconds: 0, resetAt: new Date().toISOString(),
    }));
    const request = new Request('http://localhost/api/showcase/feed/events', {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(SHOWCASE_FEED_EVENT_REQUEST_BODY_MAX_BYTES) }),
    });
    expect(request.headers.has('content-length')).toBe(false);

    const response = await postShowcaseFeedEventRouteResponse({
      request,
      dependencies: batchDependencies(recordShowcaseFeedEvent, enforceBackendRateLimit),
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: 'Feed event payload is too large.' });
    expect(enforceBackendRateLimit).toHaveBeenCalledTimes(1);
    expect(recordShowcaseFeedEvent).not.toHaveBeenCalled();
  });

  it('charges malformed JSON to the network limit before returning 400', async () => {
    const recordShowcaseFeedEvent = vi.fn();
    const enforceBackendRateLimit = vi.fn(async () => ({
      allowed: true, limit: 300, remaining: 299, retryAfterSeconds: 0, resetAt: new Date().toISOString(),
    }));

    const response = await postShowcaseFeedEventRouteResponse({
      request: new Request('http://localhost/api/showcase/feed/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{invalid',
      }),
      dependencies: batchDependencies(recordShowcaseFeedEvent, enforceBackendRateLimit),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid JSON payload.' });
    expect(enforceBackendRateLimit).toHaveBeenCalledTimes(1);
    expect(recordShowcaseFeedEvent).not.toHaveBeenCalled();
  });

  it('returns mixed RPC outcomes as a successful batch flush', async () => {
    const recordShowcaseFeedEvent = vi.fn();
    const enforceBackendRateLimit = vi.fn(async () => ({
      allowed: true, limit: 300, remaining: 299, retryAfterSeconds: 0, resetAt: new Date().toISOString(),
    }));
    const dependencies = batchDependencies(recordShowcaseFeedEvent, enforceBackendRateLimit);
    const recordShowcaseFeedEvents = vi.fn(async (): Promise<ShowcaseFeedEventBatchRecordResult> => ({
      ok: true,
      body: { success: true, recorded: 1, rejected: 1 },
      results: [
        { ok: true, body: { success: true } },
        { ok: false, status: 409, body: { error: 'Feed event ID is already used by a different event.' } },
      ],
    }));

    const response = await postShowcaseFeedEventRouteResponse({
      request: batchRequest({ events: [batchEvent(0), batchEvent(1)] }),
      dependencies: { ...dependencies, recordShowcaseFeedEvents },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true, recorded: 1, rejected: 1 });
  });

  it('returns 500 without a serial fallback when the batch RPC fails', async () => {
    const recordShowcaseFeedEvent = vi.fn();
    const enforceBackendRateLimit = vi.fn(async () => ({
      allowed: true, limit: 300, remaining: 299, retryAfterSeconds: 0, resetAt: new Date().toISOString(),
    }));
    const dependencies = batchDependencies(recordShowcaseFeedEvent, enforceBackendRateLimit);
    const recordShowcaseFeedEvents = vi.fn(async (): Promise<ShowcaseFeedEventBatchRecordResult> => ({
      ok: false,
      status: 500,
      body: { error: 'Failed to record feed event batch.' },
    }));

    const response = await postShowcaseFeedEventRouteResponse({
      request: batchRequest({ events: [batchEvent(0), batchEvent(1)] }),
      dependencies: { ...dependencies, recordShowcaseFeedEvents },
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'Failed to record feed event batch.' });
    expect(recordShowcaseFeedEvent).not.toHaveBeenCalled();
  });
});
