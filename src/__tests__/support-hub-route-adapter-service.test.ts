import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const authUser = vi.hoisted(() => ({
  value: { id: 'account-1', is_anonymous: false } as { id: string; is_anonymous: boolean } | null,
}));

vi.mock('@/lib/server-auth-user', () => ({
  getVerifiedAuthUserResult: vi.fn(async () => ({ data: { user: authUser.value }, error: null })),
}));

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import {
  createSupportRoadmapReactionRouteHandlers,
  createSupportRoadmapRouteHandlers,
  createSupportUpdateReactionRouteHandlers,
  createSupportUpdatesRouteHandlers,
} from '@/lib/support-hub-route-adapter-service';

import {
  readSupportHubReactionResponse,
  readSupportRoadmapResponse,
  readSupportUpdatesPage,
} from '../../ugc-mobile/lib/support-hub-policy/support-hub-policy';
import mobileApiContract from '../../contracts/mobile-api-v1.json';

const endpoints = mobileApiContract.endpoints;
const BASE = 'https://magicbooklet.test';
const POST_ID = '7d8e9f0a-1b2c-4d3e-8f4a-5b6c7d8e9f0a';
const ITEM_ID = '8e9f0a1b-2c3d-4e4f-9a5b-6c7d8e9f0a1b';

function dependencies({ rateLimit = vi.fn(async () => undefined as never) } = {}) {
  return {
    createUserClient: vi.fn(() => ({}) as unknown as SupabaseClient),
    createServiceClient: vi.fn(() => ({}) as unknown as SupabaseClient),
    enforceBackendRateLimit: rateLimit,
    getFeedNetworkKeyHash: vi.fn(() => 'network-hash'),
    listSupportUpdates: vi.fn(async () => endpoints.getSupportUpdates.response as never),
    listSupportRoadmap: vi.fn(async () => endpoints.getSupportRoadmap.response as never),
    setSupportUpdateReaction: vi.fn(async () => ({ ok: true as const, value: endpoints.reactToSupportUpdate.response as never })),
    setSupportRoadmapReaction: vi.fn(async () => ({ ok: true as const, value: endpoints.reactToSupportRoadmapItem.response as never })),
    logError: vi.fn(),
  };
}

function request(path: string, method = 'GET', { body, headers = {} }: { body?: unknown; headers?: Record<string, string> } = {}) {
  return new Request(`${BASE}${path}`, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const rateLimited = () => vi.fn(async () => {
  throw new BackendRateLimitError({ scope: 'support-hub:read', limit: 300, remaining: 0, resetAt: '2026-11-26T10:00:00.000Z', retryAfterSeconds: 60 } as never);
});

beforeEach(() => {
  authUser.value = { id: 'account-1', is_anonymous: false };
});

describe('GET /api/support/updates', () => {
  it('answers the contract\'s page, read for the reader a token names, never cached', async () => {
    const deps = dependencies();
    const response = await createSupportUpdatesRouteHandlers({ dependencies: deps })
      .GET(request('/api/support/updates?cursor=abc&limit=5', 'GET', { headers: { authorization: 'Bearer token' } }));

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe(endpoints.getSupportUpdates.cacheControl);
    expect(response.headers.get('vary')).toContain('Authorization');
    const body = await response.json();
    expect(body).toEqual(endpoints.getSupportUpdates.response);
    expect(readSupportUpdatesPage(body)?.updates).toHaveLength(1);
    expect(deps.listSupportUpdates).toHaveBeenCalledWith(expect.objectContaining({ viewerUserId: 'account-1', cursor: 'abc', limit: 5 }));
    expect(deps.enforceBackendRateLimit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ scope: 'support-hub:read', key: 'account-1' }));
  });

  it('reads a visitor without a token for no one, keyed on the network', async () => {
    const deps = dependencies();
    await createSupportUpdatesRouteHandlers({ dependencies: deps }).GET(request('/api/support/updates'));

    expect(deps.listSupportUpdates).toHaveBeenCalledWith(expect.objectContaining({ viewerUserId: null, limit: 20 }));
    expect(deps.enforceBackendRateLimit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ key: 'network-hash' }));
  });

  it('lets the CDN keep the public read of a visitor with no session at all', async () => {
    const deps = dependencies();
    const response = await createSupportUpdatesRouteHandlers({ dependencies: deps }).GET(request('/api/support/updates?scope=public'));

    expect(response.headers.get('cache-control')).toBe(endpoints.getSupportUpdates.publicScope.cacheControl);
    expect(deps.listSupportUpdates).toHaveBeenCalledWith(expect.objectContaining({ viewerUserId: null }));
  });

  it('keeps a request with a session cookie out of shared caches, scope or not', async () => {
    const response = await createSupportUpdatesRouteHandlers({ dependencies: dependencies() })
      .GET(request('/api/support/updates?scope=public', 'GET', { headers: { cookie: 'sb-project-auth-token=abc' } }));

    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('answers a rate limit and never caches it', async () => {
    const response = await createSupportUpdatesRouteHandlers({ dependencies: dependencies({ rateLimit: rateLimited() }) })
      .GET(request('/api/support/updates?scope=public'));

    expect(response.status).toBe(429);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('answers a failed read with words, not the error', async () => {
    const deps = dependencies();
    deps.listSupportUpdates.mockRejectedValueOnce(new Error('database down'));
    const response = await createSupportUpdatesRouteHandlers({ dependencies: deps }).GET(request('/api/support/updates'));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Updates could not be loaded.' });
  });
});

describe('GET /api/support/roadmap', () => {
  it('answers the contract\'s roadmap with the reader\'s reactions', async () => {
    const deps = dependencies();
    const response = await createSupportRoadmapRouteHandlers({ dependencies: deps })
      .GET(request('/api/support/roadmap', 'GET', { headers: { authorization: 'Bearer token' } }));

    const body = await response.json();
    expect(body).toEqual(endpoints.getSupportRoadmap.response);
    expect(readSupportRoadmapResponse(body)?.items).toHaveLength(2);
    expect(deps.listSupportRoadmap).toHaveBeenCalledWith(expect.objectContaining({ viewerUserId: 'account-1' }));
  });
});

describe('POST reactions', () => {
  const updateContext = (postId = POST_ID) => ({ params: Promise.resolve({ postId }) });
  const itemContext = (itemId = ITEM_ID) => ({ params: Promise.resolve({ itemId }) });

  it('sets the account\'s reaction on an update and answers the counts', async () => {
    const deps = dependencies();
    const response = await createSupportUpdateReactionRouteHandlers({ dependencies: deps })
      .POST(request(`/api/support/updates/${POST_ID}/reaction`, 'POST', { body: endpoints.reactToSupportUpdate.request }), updateContext());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual(endpoints.reactToSupportUpdate.response);
    expect(readSupportHubReactionResponse(body)?.myReaction).toBe('👍');
    expect(deps.setSupportUpdateReaction).toHaveBeenCalledWith(expect.objectContaining({ userId: 'account-1', postId: POST_ID, emoji: '👍' }));
    expect(deps.enforceBackendRateLimit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ scope: 'support-hub:reaction', key: 'account-1' }));
  });

  it('clears a reaction with null', async () => {
    const deps = dependencies();
    await createSupportRoadmapReactionRouteHandlers({ dependencies: deps })
      .POST(request(`/api/support/roadmap/${ITEM_ID}/reaction`, 'POST', { body: endpoints.reactToSupportRoadmapItem.requestVariants.remove }), itemContext());

    expect(deps.setSupportRoadmapReaction).toHaveBeenCalledWith(expect.objectContaining({ itemId: ITEM_ID, emoji: null }));
  });

  it('asks a guest, or no one, to sign in', async () => {
    authUser.value = { id: 'guest-1', is_anonymous: true };
    const guest = await createSupportUpdateReactionRouteHandlers({ dependencies: dependencies() })
      .POST(request(`/api/support/updates/${POST_ID}/reaction`, 'POST', { body: { emoji: '👍' } }), updateContext());
    expect(guest.status).toBe(401);
    expect(await guest.json()).toEqual(endpoints.reactToSupportUpdate.errors.registrationRequired.response);

    authUser.value = null;
    const none = await createSupportUpdateReactionRouteHandlers({ dependencies: dependencies() })
      .POST(request(`/api/support/updates/${POST_ID}/reaction`, 'POST', { body: { emoji: '👍' } }), updateContext());
    expect(none.status).toBe(401);
  });

  it('refuses a reaction that is not a quick reaction, and an id that is not one', async () => {
    const invalid = await createSupportUpdateReactionRouteHandlers({ dependencies: dependencies() })
      .POST(request(`/api/support/updates/${POST_ID}/reaction`, 'POST', { body: { emoji: '🎃' } }), updateContext());
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual(endpoints.reactToSupportUpdate.errors.invalidReaction.response);

    const badId = await createSupportUpdateReactionRouteHandlers({ dependencies: dependencies() })
      .POST(request('/api/support/updates/nope/reaction', 'POST', { body: { emoji: '👍' } }), updateContext('nope'));
    expect(badId.status).toBe(404);
  });

  it('passes on the service\'s refusal of an update no longer there', async () => {
    const deps = dependencies();
    deps.setSupportUpdateReaction.mockResolvedValueOnce({
      ok: false,
      status: 404,
      code: 'NOT_FOUND',
      error: endpoints.reactToSupportUpdate.errors.notFound.response.error,
    } as never);
    const response = await createSupportUpdateReactionRouteHandlers({ dependencies: deps })
      .POST(request(`/api/support/updates/${POST_ID}/reaction`, 'POST', { body: { emoji: '👍' } }), updateContext());

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(endpoints.reactToSupportUpdate.errors.notFound.response);
  });
});
