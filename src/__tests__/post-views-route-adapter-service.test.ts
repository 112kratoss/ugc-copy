import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { POST } from '@/app/api/showcase/views/route';
import {
  BackendRateLimitError,
  POST_VIEW_NETWORK_ADMISSION_RATE_LIMIT,
  POST_VIEW_RATE_LIMIT,
} from '@/lib/backend-rate-limit';
import {
  POST_VIEWS_REQUEST_BODY_MAX_BYTES,
  postPostViewsRouteResponse,
} from '@/lib/post-views-route-adapter-service';
import { POST_VIEWS_MAX_BATCH, POST_VIEW_SURFACES } from '@/lib/post-views-service';
import { routeIdentityPolicy, routeIdentityPolicyForRequest } from '@/lib/route-identity-policy';
import type { FeedAnonymousIdentity } from '@/lib/showcase-feed-identity';

import mobileApiOperations from '../../contracts/mobile-api-operations-v1.json';
import mobileApiContract from '../../contracts/mobile-api-v1.json';

const contract = mobileApiContract.endpoints.recordPostViews;
const URL_VIEWS = 'https://magicbooklet.test/api/showcase/views';
const NETWORK = 'a'.repeat(64);
const COOKIE_GUEST = 'c'.repeat(64);
const POST_A = '0b9e1000-0000-4000-8000-000000000011';
const POST_B = '0b9e1000-0000-4000-8000-000000000012';

type RateLimitOptions = { scope: string; limit: number; windowSeconds: number; key: string };

function harness(options: {
  user?: { id: string } | null;
  identity?: FeedAnonymousIdentity;
  enforce?: (client: unknown, options: RateLimitOptions) => Promise<unknown>;
  rpcResult?: { data: unknown; error: unknown };
  readBoundedJsonBody?: (request: Request, maxBytes: number) => Promise<unknown>;
} = {}) {
  const rpc = vi.fn<(name: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>>(
    async () => options.rpcResult ?? { data: 1, error: null },
  );
  const enforceBackendRateLimit = vi.fn<(client: unknown, options: RateLimitOptions) => Promise<unknown>>(
    options.enforce ?? (async () => ({ allowed: true })),
  );
  const getUser = vi.fn(async () => (options.user === null
    ? { data: { user: null }, error: { message: 'invalid JWT' } }
    : { data: { user: options.user ?? { id: 'viewer-1' } }, error: null }));
  const resolveFeedAnonymousIdentity = vi.fn(() => options.identity ?? {
    anonymousKeyHash: COOKIE_GUEST,
    cookieValueToSet: null,
    source: 'web-cookie' as const,
  });
  const logError = vi.fn();
  const send = (body: unknown, headers: Record<string, string> = {}) => postPostViewsRouteResponse({
    request: new Request(URL_VIEWS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    dependencies: {
      createServiceClient: vi.fn(() => ({ rpc }) as unknown as SupabaseClient) as never,
      createUserClient: vi.fn(() => ({ auth: { getUser } }) as unknown as SupabaseClient) as never,
      enforceBackendRateLimit: enforceBackendRateLimit as never,
      getFeedNetworkKeyHash: vi.fn(() => NETWORK),
      resolveFeedAnonymousIdentity,
      logError,
      ...(options.readBoundedJsonBody ? { readBoundedJsonBody: options.readBoundedJsonBody as never } : {}),
    },
  });
  return { send, rpc, enforceBackendRateLimit, getUser, resolveFeedAnonymousIdentity, logError };
}

async function expectAccepted(response: Response) {
  expect(response.status).toBe(204);
  expect(await response.text()).toBe('');
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('Set-Cookie')).toBeNull();
}

describe('POST /api/showcase/views', () => {
  it('counts a web guest by its feed cookie and the network it came from, behind a 204 with no body', async () => {
    const { send, rpc, enforceBackendRateLimit } = harness();
    await expectAccepted(await send(contract.request));
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('record_post_views', {
      p_viewer_user_id: null,
      p_anonymous_key_hash: COOKIE_GUEST,
      p_network_key_hash: NETWORK,
      p_views: [
        { postId: POST_A, surface: 'post-page' },
        { postId: POST_B, surface: 'reel' },
      ],
    });
    // A guest is held by the network's budget alone.
    expect(enforceBackendRateLimit).toHaveBeenCalledTimes(1);
    expect(enforceBackendRateLimit).toHaveBeenCalledWith(expect.anything(), {
      ...POST_VIEW_NETWORK_ADMISSION_RATE_LIMIT,
      key: NETWORK,
    });
  });

  it('counts a request with no cookie by its network, never by an id minted for it, and sets none', async () => {
    const { send, rpc } = harness({
      identity: { anonymousKeyHash: 'f'.repeat(64), cookieValueToSet: `fid_${'1'.repeat(64)}`, source: 'web-cookie' },
    });
    await expectAccepted(await send(contract.request));
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_anonymous_key_hash: NETWORK, p_network_key_hash: NETWORK });
  });

  it('counts an app guest by its installation', async () => {
    const { send, rpc } = harness({
      identity: { anonymousKeyHash: 'b'.repeat(64), cookieValueToSet: null, source: 'mobile-installation' },
    });
    await expectAccepted(await send(contract.request));
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_anonymous_key_hash: 'b'.repeat(64), p_network_key_hash: NETWORK });
  });

  it('counts a signed-in view under the account, with no guest key or network, on its own budget', async () => {
    const { send, rpc, enforceBackendRateLimit, getUser, resolveFeedAnonymousIdentity } = harness({ user: { id: 'viewer-9' } });
    await expectAccepted(await send(contract.request, { Authorization: 'Bearer session-token' }));
    expect(getUser).toHaveBeenCalledTimes(1);
    expect(resolveFeedAnonymousIdentity).not.toHaveBeenCalled();
    expect(rpc.mock.calls[0][1]).toMatchObject({
      p_viewer_user_id: 'viewer-9',
      p_anonymous_key_hash: null,
      p_network_key_hash: null,
    });
    expect(enforceBackendRateLimit).toHaveBeenLastCalledWith(expect.anything(), {
      ...POST_VIEW_RATE_LIMIT,
      key: 'viewer-9',
    });
  });

  it('refuses a token it cannot verify, and counts nothing', async () => {
    const { send, rpc } = harness({ user: null });
    const response = await send(contract.request, { Authorization: 'Bearer expired' });
    expect(response.status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('reads only JSON, so another site cannot post views from its visitors\' browsers', async () => {
    const { send, rpc, enforceBackendRateLimit } = harness();
    const response = await send(JSON.stringify(contract.request), { 'Content-Type': 'text/plain;charset=UTF-8' });
    expect(response.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
    expect(enforceBackendRateLimit).not.toHaveBeenCalled();
  });

  it('refuses a body too large, not JSON, or with no views or too many', async () => {
    const { send, rpc } = harness();
    expect((await send({ views: [], padding: 'x'.repeat(POST_VIEWS_REQUEST_BODY_MAX_BYTES) })).status).toBe(413);
    expect((await send('{"views": [')).status).toBe(400);
    expect((await send({ views: [] })).status).toBe(400);
    expect((await send({ views: 'all' })).status).toBe(400);
    expect((await send([contract.request])).status).toBe(400);
    const tooMany = Array.from({ length: POST_VIEWS_MAX_BATCH + 1 }, () => ({ postId: POST_A, surface: 'reel' }));
    expect((await send({ views: tooMany })).status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('drops an entry it cannot read and a post named twice, and keeps the rest', async () => {
    const { send, rpc } = harness();
    await expectAccepted(await send({
      views: [
        { postId: POST_A.toUpperCase(), surface: 'feed' },
        { postId: POST_A, surface: 'reel' },
        { postId: 'not-a-post', surface: 'reel' },
        { postId: POST_B, surface: 'explore' },
        'loose',
      ],
    }));
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_views: [{ postId: POST_A, surface: 'feed' }] });
  });

  it('answers a batch with nothing to count the same, without asking the database', async () => {
    const { send, rpc } = harness();
    await expectAccepted(await send({ views: [{ postId: 'nope', surface: 'reel' }] }));
    expect(rpc).not.toHaveBeenCalled();
  });

  it('says nothing about what was counted', async () => {
    const counted = harness({ rpcResult: { data: 2, error: null } });
    const nothing = harness({ rpcResult: { data: 0, error: null } });
    await expectAccepted(await counted.send(contract.request));
    await expectAccepted(await nothing.send(contract.request));
  });

  it('answers 429 past the network\'s budget, before reading the body', async () => {
    const readBoundedJsonBody = vi.fn(async () => ({ ok: true, value: contract.request }));
    const { send, rpc } = harness({
      readBoundedJsonBody,
      enforce: async () => {
        throw new BackendRateLimitError({
          allowed: false,
          limit: POST_VIEW_NETWORK_ADMISSION_RATE_LIMIT.limit,
          remaining: 0,
          retryAfterSeconds: 60,
          resetAt: '2026-11-23T08:10:00.000Z',
        });
      },
    });
    const response = await send(contract.request);
    expect(response.status).toBe(429);
    expect(readBoundedJsonBody).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('answers 500 when the database fails, and logs it', async () => {
    const { send, logError } = harness({ rpcResult: { data: null, error: { message: 'boom' } } });
    const response = await send(contract.request);
    expect(response.status).toBe(500);
    expect(logError).toHaveBeenCalledWith('Post views failed:', expect.any(Error));
  });

  it('is admitted as a public route, as the feed events are, and the route exports its POST', () => {
    expect(routeIdentityPolicy('/api/showcase/views')).toBe('public');
    expect(routeIdentityPolicyForRequest('/api/showcase/views', 'POST')).toBe('public');
    expect(typeof POST).toBe('function');
  });

  it('matches the contract the app is held to', () => {
    expect(mobileApiOperations.operations.recordPostViews).toEqual({
      method: 'POST',
      path: '/api/showcase/views',
      auth: 'optional',
    });
    expect(contract).toMatchObject({
      method: 'POST',
      path: '/api/showcase/views',
      auth: 'optional',
      maxBodyBytes: POST_VIEWS_REQUEST_BODY_MAX_BYTES,
      maxViews: POST_VIEWS_MAX_BATCH,
      surfaces: [...POST_VIEW_SURFACES],
      rateLimit: {
        scope: POST_VIEW_RATE_LIMIT.scope,
        limit: POST_VIEW_RATE_LIMIT.limit,
        windowSeconds: POST_VIEW_RATE_LIMIT.windowSeconds,
      },
      networkRateLimit: {
        scope: POST_VIEW_NETWORK_ADMISSION_RATE_LIMIT.scope,
        limit: POST_VIEW_NETWORK_ADMISSION_RATE_LIMIT.limit,
        windowSeconds: POST_VIEW_NETWORK_ADMISSION_RATE_LIMIT.windowSeconds,
      },
      status: 204,
      response: null,
    });
  });
});
