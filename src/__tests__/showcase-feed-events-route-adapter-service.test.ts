import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { postShowcaseFeedEventRouteResponse } from '@/lib/showcase-feed-events-route-adapter-service';
import { parseShowcaseFeedEventPayload } from '@/lib/showcase-feed-events-service';

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
        postId: 'post-1',
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
    expect(enforceBackendRateLimit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      scope: 'showcase-feed:event',
      key: 'viewer-1',
    }));
    expect(recordShowcaseFeedEvent).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 'viewer-1',
      anonymousKeyHash: 'anon-hash',
      payload: expect.objectContaining({ eventType: 'impression', postId: 'post-1', position: 0 }),
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
          postId: 'post-1',
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
    expect(enforceBackendRateLimit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ key: 'network-hash' }));
    expect(recordShowcaseFeedEvent).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: null,
      anonymousKeyHash: 'anon-hash',
    }));
  });

  it('rejects an invalid supplied authorization header instead of treating it as anonymous', async () => {
    const recordShowcaseFeedEvent = vi.fn();
    const enforceBackendRateLimit = vi.fn();
    const response = await postShowcaseFeedEventRouteResponse({
      request: new Request('http://localhost/api/showcase/feed/events', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer expired-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          clientEventId: 'event-expired-1',
          postId: 'post-1',
          eventType: 'not_interested',
          sourceSurface: 'showcase',
        }),
      }),
      dependencies: {
        createUserClient: vi.fn(() => createUserClient(null)),
        createServiceClient: vi.fn(() => ({}) as SupabaseClient),
        enforceBackendRateLimit,
        getFeedAnonymousKeyHash: vi.fn(() => 'anon-hash'),
        recordShowcaseFeedEvent,
      },
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Authentication required.' });
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(enforceBackendRateLimit).not.toHaveBeenCalled();
    expect(recordShowcaseFeedEvent).not.toHaveBeenCalled();
  });

  it('rejects unsupported event types and oversized or malformed optional values', () => {
    expect(parseShowcaseFeedEventPayload({
      clientEventId: 'event-1',
      postId: 'post-1',
      eventType: 'like',
      sourceSurface: 'showcase',
    })).toMatchObject({ ok: false, status: 400 });

    expect(parseShowcaseFeedEventPayload({
      clientEventId: 'event-2',
      postId: 'post-1',
      eventType: 'dwell',
      sourceSurface: 'showcase',
      durationMs: -1,
    })).toMatchObject({ ok: false, status: 400 });
  });
});
