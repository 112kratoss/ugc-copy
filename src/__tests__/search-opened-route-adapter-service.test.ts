import type { SupabaseClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST } from '@/app/api/search/opened/route';
import {
  BackendRateLimitError,
  PUBLIC_SEARCH_READ_RATE_LIMIT,
  SEARCH_OPENED_GUEST_NETWORK_RATE_LIMIT,
  SEARCH_OPENED_RATE_LIMIT,
} from '@/lib/backend-rate-limit';
import { routeIdentityPolicy, routeIdentityPolicyForRequest } from '@/lib/route-identity-policy';
import { usesRouteOwnedIdentityAdmission } from '@/lib/route-owned-identity-admission';
import { SEARCH_RESULT_OPENS_TABLE } from '@/lib/search-open-log';
import {
  SEARCH_OPENED_MAX_BODY_BYTES,
  postSearchOpenedRouteResponse,
} from '@/lib/search-opened-route-adapter-service';
import { proxy } from '@/proxy';

import mobileApiOperations from '../../contracts/mobile-api-operations-v1.json';
import mobileApiContract from '../../contracts/mobile-api-v1.json';
import {
  SEARCH_ENTRIES,
  SEARCH_ENTRY_PARAM,
  SEARCH_OPENED_PATH,
  SEARCH_OPEN_KINDS,
  SEARCH_OPEN_MAX_POSITION,
} from '../../ugc-mobile/lib/public-search-policy/search-open-log';

const contract = mobileApiContract.endpoints.recordSearchOpen;
const URL_OPENED = `https://magicbooklet.test${SEARCH_OPENED_PATH}`;
const POST_ID = contract.request.id;

type RateLimitOptions = { scope: string; limit: number; windowSeconds: number; key: string };

const allowedRateLimit = () => Promise.resolve({
  allowed: true,
  limit: 120,
  remaining: 119,
  retryAfterSeconds: 0,
  resetAt: '2026-11-15T12:00:00.000Z',
});

function harness(options: {
  insert?: () => Promise<{ error: unknown }>;
  env?: Record<string, string | undefined>;
  enforce?: (client: unknown, options: RateLimitOptions) => Promise<unknown>;
  user?: { id: string; is_anonymous?: boolean } | null;
  runAfterResponse?: (task: () => Promise<unknown>) => void;
} = {}) {
  const write = options.insert ?? (async () => ({ error: null }));
  const insert = vi.fn<(row: Record<string, unknown>) => Promise<{ error: unknown }>>(() => write());
  const from = vi.fn<(table: string) => { insert: typeof insert }>(() => ({ insert }));
  const rpc = vi.fn<(name: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>>(
    async () => ({ data: 'e'.repeat(64), error: null }),
  );
  const tasks: Array<() => Promise<unknown>> = [];
  const logEvent = vi.fn();
  const logError = vi.fn();
  const enforceBackendRateLimit = vi.fn<(client: unknown, options: RateLimitOptions) => Promise<unknown>>(
    options.enforce ?? (() => allowedRateLimit()),
  );
  const createServiceClient = vi.fn(() => ({ from, rpc }) as unknown as SupabaseClient);
  const getUser = vi.fn(async () => (options.user === null
    ? { data: { user: null }, error: { message: 'invalid JWT' } }
    : { data: { user: options.user ?? { id: 'viewer-1' } }, error: null }));
  // `Content-Type: null` sends the body as a browser's no-cors fetch does: text/plain.
  const send = (body: unknown, headers: Record<string, string | null> = {}) => postSearchOpenedRouteResponse({
    request: new Request(URL_OPENED, {
      method: 'POST',
      headers: Object.fromEntries(
        Object.entries({ 'Content-Type': 'application/json', ...headers })
          .map(([name, value]) => [name, value ?? 'text/plain;charset=UTF-8']),
      ),
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    dependencies: {
      createServiceClient: createServiceClient as never,
      createUserClient: vi.fn(() => ({ auth: { getUser } }) as unknown as SupabaseClient),
      enforceBackendRateLimit: enforceBackendRateLimit as never,
      getFeedNetworkKeyHash: vi.fn(() => 'network-key'),
      logEvent,
      logError,
      runAfterResponse: options.runAfterResponse ?? ((task) => { tasks.push(task); }),
      env: options.env ?? {},
    },
  });
  return { send, insert, from, rpc, tasks, logEvent, logError, enforceBackendRateLimit, createServiceClient, getUser };
}

async function expectAccepted(response: Response) {
  expect(response.status).toBe(204);
  expect(await response.text()).toBe('');
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
}

describe('POST /api/search/opened', () => {
  it('writes one anonymous row behind a 204 with no body, for a visitor', async () => {
    const { send, insert, from, tasks, enforceBackendRateLimit } = harness();
    const response = await send(contract.request);
    await expectAccepted(response);
    // Nothing is written in front of the answer.
    expect(insert).not.toHaveBeenCalled();
    expect(tasks).toHaveLength(1);
    await tasks[0]();
    expect(from).toHaveBeenCalledWith(SEARCH_RESULT_OPENS_TABLE);
    const row = insert.mock.calls[0][0];
    expect(row).toEqual({
      created_at: expect.any(String),
      query: 'neon product',
      search_type: 'posts',
      sort: 'latest',
      entry: 'suggestion',
      visitor_day: expect.stringMatching(/^[0-9a-f]{64}$/u),
      result_kind: 'post',
      result_id: POST_ID,
      result_position: 3,
    });
    expect(JSON.stringify(row)).not.toContain('network-key');
    // Counted on its own scope, on the visitor's hashed network, as /api/search counts a visitor.
    expect(enforceBackendRateLimit).toHaveBeenCalledWith(expect.anything(), {
      ...SEARCH_OPENED_RATE_LIMIT,
      key: 'network-key',
    });
  });

  it('keys a signed-in report on the user, as /api/search does, and stores no id', async () => {
    const { send, insert, tasks, enforceBackendRateLimit, getUser } = harness({ user: { id: 'viewer-1' } });
    await expectAccepted(await send(contract.request, { Authorization: 'Bearer session-token' }));
    expect(getUser).toHaveBeenCalledTimes(1);
    expect(enforceBackendRateLimit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      scope: 'public-search:opened',
      key: 'viewer-1',
    }));
    await tasks[0]();
    expect(JSON.stringify(insert.mock.calls[0][0])).not.toContain('viewer-1');
  });

  it('takes a guest session as its caller: keyed on the guest, never refused', async () => {
    const { send, tasks, enforceBackendRateLimit } = harness({ user: { id: 'guest-1', is_anonymous: true } });
    await expectAccepted(await send(contract.request, { Authorization: 'Bearer guest-token' }));
    expect(enforceBackendRateLimit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ key: 'guest-1' }));
    expect(tasks).toHaveLength(1);
  });

  // A guest's id is new with every anonymous sign-in, so its own key alone is no limit
  // (review of #826, finding 9): the write is counted against its network too, as the
  // search's embedding and the feed's events are.
  describe('a guest session is counted against its network as well', () => {
    it('counts a guest twice, on its id and on its network; an account and a visitor once', async () => {
      const guest = harness({ user: { id: 'guest-1', is_anonymous: true } });
      await expectAccepted(await guest.send(contract.request, { Authorization: 'Bearer guest-token' }));
      expect(guest.enforceBackendRateLimit.mock.calls.map(([, options]) => options)).toEqual([
        { ...SEARCH_OPENED_RATE_LIMIT, key: 'guest-1' },
        { ...SEARCH_OPENED_GUEST_NETWORK_RATE_LIMIT, key: 'network-key' },
      ]);

      const account = harness({ user: { id: 'viewer-1' } });
      await expectAccepted(await account.send(contract.request, { Authorization: 'Bearer session-token' }));
      expect(account.enforceBackendRateLimit.mock.calls.map(([, options]) => options)).toEqual([
        { ...SEARCH_OPENED_RATE_LIMIT, key: 'viewer-1' },
      ]);

      const visitor = harness();
      await expectAccepted(await visitor.send(contract.request));
      expect(visitor.enforceBackendRateLimit.mock.calls.map(([, options]) => options)).toEqual([
        { ...SEARCH_OPENED_RATE_LIMIT, key: 'network-key' },
      ]);
    });

    it('answers 429 and writes nothing once the network has had its share, whatever fresh guest id asks', async () => {
      const { send, tasks } = harness({
        user: { id: 'guest-2', is_anonymous: true },
        enforce: async (_client, options) => {
          if (options.scope !== SEARCH_OPENED_GUEST_NETWORK_RATE_LIMIT.scope) return allowedRateLimit();
          throw new BackendRateLimitError({
            allowed: false, limit: 360, remaining: 0, retryAfterSeconds: 30, resetAt: '2026-11-15T12:00:00.000Z',
          });
        },
      });
      const response = await send(contract.request, { Authorization: 'Bearer guest-token' });
      expect(response.status).toBe(429);
      expect(response.headers.get('Retry-After')).toBe('30');
      expect(tasks).toHaveLength(0);
    });

    it('has a scope of its own, a few guests’ worth, pinned in the contract', () => {
      expect(SEARCH_OPENED_GUEST_NETWORK_RATE_LIMIT).toEqual({
        scope: contract.guestNetworkRateLimit.scope,
        limit: contract.guestNetworkRateLimit.limit,
        windowSeconds: contract.guestNetworkRateLimit.windowSeconds,
      });
      expect(SEARCH_OPENED_GUEST_NETWORK_RATE_LIMIT.scope).not.toBe(SEARCH_OPENED_RATE_LIMIT.scope);
      expect(SEARCH_OPENED_GUEST_NETWORK_RATE_LIMIT.limit).toBe(3 * SEARCH_OPENED_RATE_LIMIT.limit);
      expect(SEARCH_OPENED_GUEST_NETWORK_RATE_LIMIT.windowSeconds).toBe(SEARCH_OPENED_RATE_LIMIT.windowSeconds);
    });
  });

  // A page of another site can post to this route from a visitor's browser. With a JSON
  // content type the browser asks first (a preflight this site does not grant); a "simple"
  // request, text/plain or a form, is sent without asking, so it is refused here
  // (review of #826, finding 9).
  describe('only a JSON request reaches the write', () => {
    it.each([
      ['text/plain, as a no-cors fetch sends a string', 'text/plain;charset=UTF-8'],
      ['a form', 'application/x-www-form-urlencoded'],
      ['multipart', 'multipart/form-data; boundary=x'],
      ['a type that only starts like JSON', 'application/jsonp'],
      ['an empty type', ''],
    ])('answers 400 to %s, with a well-formed report in it, before a token is read or anything counted', async (_name, contentType) => {
      const { send, tasks, enforceBackendRateLimit, getUser } = harness();
      const response = await send(contract.request, { 'Content-Type': contentType, Authorization: 'Bearer session-token' });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: 'Content-Type must be application/json.' });
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
      expect(getUser).not.toHaveBeenCalled();
      expect(enforceBackendRateLimit).not.toHaveBeenCalled();
      expect(tasks).toHaveLength(0);
    });

    it('answers 400 to a request with no content type at all', async () => {
      const { tasks } = harness();
      const response = await postSearchOpenedRouteResponse({
        request: new Request(URL_OPENED, { method: 'POST', body: new Blob([JSON.stringify(contract.request)]) }),
        dependencies: { env: {} },
      });
      expect(response.status).toBe(400);
      expect(tasks).toHaveLength(0);
    });

    it.each(['application/json', 'application/json; charset=utf-8', 'Application/JSON'])('takes %s', async (contentType) => {
      const { send, tasks } = harness();
      await expectAccepted(await send(contract.request, { 'Content-Type': contentType }));
      expect(tasks).toHaveLength(1);
      expect(contract.contentType).toBe('application/json');
    });
  });

  // Opening one's own profile would store one's own account id beside the day's visitor
  // code, which names the account behind every search of that code (review of #826,
  // finding 13). Such a report is dropped, with no lookup: the id is the token's own.
  describe('a report of the viewer’s own profile is dropped', () => {
    const OWN_ID = '0b9e0000-0000-4000-8000-000000000002';
    const ownProfile = { ...contract.request, kind: 'creator', id: OWN_ID };

    it('answers 204, counts the request and writes nothing, for an account and for a guest', async () => {
      for (const user of [{ id: OWN_ID }, { id: OWN_ID, is_anonymous: true }]) {
        const { send, tasks, enforceBackendRateLimit, rpc, from } = harness({ user });
        await expectAccepted(await send(ownProfile, { Authorization: 'Bearer session-token' }));
        expect(enforceBackendRateLimit).toHaveBeenCalled();
        expect(tasks).toHaveLength(0);
        // Nothing was looked up to decide it.
        expect(rpc).not.toHaveBeenCalled();
        expect(from).not.toHaveBeenCalled();
      }
    });

    it('is the same for an id sent in capitals', async () => {
      const { send, tasks } = harness({ user: { id: OWN_ID } });
      await expectAccepted(await send({ ...ownProfile, id: OWN_ID.toUpperCase() }, { Authorization: 'Bearer session-token' }));
      expect(tasks).toHaveLength(0);
    });

    it('still writes another creator’s profile, the viewer’s own post, and a visitor’s report of that id', async () => {
      const other = harness({ user: { id: OWN_ID } });
      await expectAccepted(await other.send({ ...ownProfile, id: POST_ID }, { Authorization: 'Bearer session-token' }));
      expect(other.tasks).toHaveLength(1);

      // A post's id is not an account's: kept, whoever made the post.
      const post = harness({ user: { id: OWN_ID } });
      await expectAccepted(await post.send({ ...ownProfile, kind: 'post' }, { Authorization: 'Bearer session-token' }));
      expect(post.tasks).toHaveLength(1);

      // No token, no viewer to compare with: stored as sent, as every id is.
      const visitor = harness();
      await expectAccepted(await visitor.send(ownProfile));
      expect(visitor.tasks).toHaveLength(1);
    });
  });

  it('has a limit of its own, apart from the search read limit', () => {
    expect(SEARCH_OPENED_RATE_LIMIT.scope).toBe('public-search:opened');
    expect(SEARCH_OPENED_RATE_LIMIT.scope).not.toBe(PUBLIC_SEARCH_READ_RATE_LIMIT.scope);
    expect(SEARCH_OPENED_RATE_LIMIT).toEqual({
      scope: contract.rateLimit.scope,
      limit: contract.rateLimit.limit,
      windowSeconds: contract.rateLimit.windowSeconds,
    });
  });

  describe('is no existence oracle', () => {
    it('answers every well-formed report the same and does the same work, whatever the id names', async () => {
      const ids = [
        POST_ID,
        '00000000-0000-4000-8000-000000000000',
        'ffffffff-ffff-4fff-bfff-ffffffffffff',
      ];
      const seen: Array<{ status: number; body: string; headers: string; inserts: number }> = [];
      for (const id of ids) {
        const { send, tasks, insert, rpc, from, createServiceClient } = harness();
        const response = await send({ ...contract.request, id });
        await tasks[0]();
        seen.push({
          status: response.status,
          body: await response.text(),
          headers: JSON.stringify([...response.headers.entries()].filter(([name]) => name !== 'x-request-id').sort()),
          inserts: insert.mock.calls.length,
        });
        // The only database calls: the day's key (read once an instance a day) and the insert.
        // Nothing looks the id up.
        expect(rpc.mock.calls.every(([name]) => name === 'search_visitor_day_key')).toBe(true);
        expect(from.mock.calls.map(([table]) => table)).toEqual([SEARCH_RESULT_OPENS_TABLE]);
        expect(createServiceClient).toHaveBeenCalled();
      }
      expect(new Set(seen.map((entry) => JSON.stringify(entry))).size).toBe(1);
      expect(seen[0]).toMatchObject({ status: 204, body: '', inserts: 1 });
    });

    it('answers 204 for each kind, an entity named as a filter names one', async () => {
      for (const kind of SEARCH_OPEN_KINDS) {
        const { send, tasks, insert } = harness();
        await expectAccepted(await send(kind === 'entity' ? contract.entityRequest : { ...contract.request, kind }));
        await tasks[0]();
        expect(insert.mock.calls[0][0]).toMatchObject({
          result_kind: kind,
          result_id: kind === 'entity' ? 'model:kling-2.6' : POST_ID,
        });
      }
    });

    it('answers 204 when the insert fails, throws, or the scheduler throws', async () => {
      const failing = harness({ insert: async () => ({ error: { message: 'insert refused' } }) });
      await expectAccepted(await failing.send(contract.request));
      await failing.tasks[0]();
      expect(failing.logEvent).toHaveBeenCalledWith('warn', 'search_open_log_failed', expect.anything());

      const throwing = harness({ insert: async () => { throw new Error('network'); } });
      await expectAccepted(await throwing.send(contract.request));
      await expect(throwing.tasks[0]()).resolves.toBeUndefined();

      const noScheduler = harness({ runAfterResponse: () => { throw new Error('outside a request'); } });
      await expectAccepted(await noScheduler.send(contract.request));
    });

    it('answers 204 and writes nothing when the limit cannot be counted', async () => {
      const { send, tasks, logError } = harness({ enforce: async () => { throw new Error('database down'); } });
      await expectAccepted(await send(contract.request));
      expect(tasks).toHaveLength(0);
      expect(logError).toHaveBeenCalledTimes(1);
    });
  });

  describe('the kill switch', () => {
    it.each(['1', 'true'])('SEARCH_QUERY_LOG_DISABLED=%s answers 204 with no token read, no count and no row', async (value) => {
      const { send, tasks, enforceBackendRateLimit, createServiceClient, getUser } = harness({
        env: { SEARCH_QUERY_LOG_DISABLED: value },
      });
      await expectAccepted(await send(contract.request, { Authorization: 'Bearer session-token' }));
      expect(getUser).not.toHaveBeenCalled();
      expect(enforceBackendRateLimit).not.toHaveBeenCalled();
      expect(createServiceClient).not.toHaveBeenCalled();
      expect(tasks).toHaveLength(0);
    });

    it('still refuses a malformed body while off, so a client fault shows either way', async () => {
      const { send } = harness({ env: { SEARCH_QUERY_LOG_DISABLED: '1' } });
      expect((await send({ ...contract.request, kind: 'comment' })).status).toBe(400);
    });
  });

  describe('the rate limit', () => {
    it('answers 429 with Retry-After, privately, and writes nothing', async () => {
      const { send, tasks } = harness({
        enforce: async () => {
          throw new BackendRateLimitError({
            allowed: false,
            limit: 120,
            remaining: 0,
            retryAfterSeconds: 9,
            resetAt: '2026-11-15T12:00:00.000Z',
          });
        },
      });
      const response = await send(contract.request);
      expect(response.status).toBe(contract.refusals.rateLimited);
      expect(response.headers.get('Retry-After')).toBe('9');
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
      expect(tasks).toHaveLength(0);
    });
  });

  describe('refusals say the request was malformed, and nothing else', () => {
    it.each([
      ['a body that is not JSON', '{nope'],
      ['a JSON string', '"port"'],
      ['an unknown kind', { ...contract.request, kind: 'comment' }],
      ['an unknown entry', { ...contract.request, entry: 'voice' }],
      ['an unknown tab', { ...contract.request, type: 'everything' }],
      ['an unknown order', { ...contract.request, sort: 'oldest' }],
      ['an id that is not a uuid', { ...contract.request, id: 'luna-studio' }],
      ['an entity id on a post', { ...contract.request, id: 'model:kling-2.6' }],
      ['place zero', { ...contract.request, position: 0 }],
      ['a place sent as text', { ...contract.request, position: '3' }],
      ['no query', { ...contract.request, q: undefined }],
      ['a query of one character', { ...contract.request, q: 'n' }],
      ['a handle of one character', { ...contract.request, q: '@n' }],
      ['a query of 101 characters', { ...contract.request, q: 'x'.repeat(101) }],
    ])('answers 400 to %s, before a token is read or anything counted', async (_name, body) => {
      const { send, tasks, enforceBackendRateLimit, getUser } = harness();
      const response = await send(body, { Authorization: 'Bearer session-token' });
      expect(response.status).toBe(contract.refusals.malformed);
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
      await expect(response.json()).resolves.toEqual({ error: expect.any(String) });
      expect(getUser).not.toHaveBeenCalled();
      expect(enforceBackendRateLimit).not.toHaveBeenCalled();
      expect(tasks).toHaveLength(0);
    });

    it('answers 413 to a body past the limit, whatever its Content-Length says', async () => {
      const { send, tasks } = harness();
      const response = await send({ ...contract.request, padding: 'x'.repeat(SEARCH_OPENED_MAX_BODY_BYTES) });
      expect(response.status).toBe(contract.refusals.tooLarge);
      expect(tasks).toHaveLength(0);
      expect(SEARCH_OPENED_MAX_BODY_BYTES).toBe(contract.maxBodyBytes);
    });

    it('answers 401 to a token that does not verify, never a quiet fall back to the network key', async () => {
      const { send, tasks, enforceBackendRateLimit } = harness({ user: null });
      const response = await send(contract.request, { Authorization: 'Bearer bad-token' });
      expect(response.status).toBe(contract.refusals.invalidToken);
      expect(enforceBackendRateLimit).not.toHaveBeenCalled();
      expect(tasks).toHaveLength(0);
    });

    it('clamps a place past the last one kept, and stores it', async () => {
      const { send, tasks, insert } = harness();
      await expectAccepted(await send({ ...contract.request, position: 9_000 }));
      await tasks[0]();
      expect(insert.mock.calls[0][0]).toMatchObject({ result_position: SEARCH_OPEN_MAX_POSITION });
    });
  });

  describe('the contract', () => {
    it('is the operation both clients call', () => {
      expect(contract.method).toBe('POST');
      expect(contract.path).toBe(SEARCH_OPENED_PATH);
      expect(mobileApiOperations.operations.recordSearchOpen).toEqual({
        method: 'POST', path: SEARCH_OPENED_PATH, auth: 'optional',
      });
      expect(contract.kinds).toEqual([...SEARCH_OPEN_KINDS]);
      expect(contract.maxPosition).toBe(SEARCH_OPEN_MAX_POSITION);
      expect(contract.status).toBe(204);
    });

    it('names the search request’s entry parameter and its values', () => {
      const search = mobileApiContract.endpoints.searchPublicContent;
      expect(search.entryParameter).toBe(SEARCH_ENTRY_PARAM);
      expect(search.entries).toEqual([...SEARCH_ENTRIES]);
      expect(contract.request.entry).toBe('suggestion');
    });

    it('is served by the route file', async () => {
      // No service role in a test: the write fails behind the answer, which is still 204.
      const response = await POST(new Request(URL_OPENED, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...contract.request, kind: 'comment' }),
      }));
      expect(response.status).toBe(400);
    });
  });
});

describe('POST /api/search/opened admission', () => {
  const SUBJECT = '11111111-1111-4111-8111-111111111111';

  beforeEach(() => {
    vi.stubEnv('IDENTITY_ADMISSION_SECRET', 'identity-admission-test-secret-at-least-32-characters');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function identityClient(options: {
    anonymous?: boolean;
    agent?: boolean;
    invalid?: boolean;
    state?: string;
    banned?: boolean;
    sessionValid?: boolean;
  } = {}) {
    const claims = {
      sub: SUBJECT,
      aud: 'authenticated',
      role: 'authenticated',
      session_id: '22222222-2222-4222-8222-222222222222',
      is_anonymous: options.anonymous ?? false,
      ...(options.agent ? { client_id: 'client-claude' } : {}),
      exp: Math.floor(Date.now() / 1000) + 3_600,
    };
    return {
      auth: {
        getClaims: vi.fn(async () => (options.invalid
          ? { data: null, error: Object.assign(new Error('invalid JWT'), { status: 401, code: 'bad_jwt', __isAuthError: true }) }
          : { data: { claims }, error: null })),
      },
      rpc: vi.fn(async () => ({
        data: {
          state: options.state ?? 'active',
          created_at: '2026-08-22T00:00:00+00:00',
          banned: options.banned ?? false,
          session_valid: options.sessionValid ?? true,
        },
        error: null,
      })),
    };
  }

  async function throughProxy(
    pathname: string,
    method: 'GET' | 'POST',
    options: Parameters<typeof identityClient>[0] | 'no-token',
  ) {
    const request = new NextRequest(`https://magicbooklet.test${pathname}`, {
      method,
      headers: options === 'no-token' ? {} : { Authorization: 'Bearer some-token' },
    });
    const response = await proxy(request, {
      createUserClient: () => identityClient(options === 'no-token' ? {} : options) as never,
    });
    const body = response.headers.get('content-type')?.includes('application/json')
      ? await response.json() as { code?: string }
      : null;
    return { status: response.status, code: body?.code ?? null };
  }

  it('is a public route, admitted by the proxy and not by the route itself', () => {
    expect(routeIdentityPolicy(SEARCH_OPENED_PATH)).toBe('public');
    expect(routeIdentityPolicyForRequest(SEARCH_OPENED_PATH, 'POST')).toBe('public');
    expect(usesRouteOwnedIdentityAdmission(
      new NextRequest(`https://magicbooklet.test${SEARCH_OPENED_PATH}`, { method: 'POST' }),
    )).toBe(false);
  });

  it.each([
    ['no token', 'no-token' as const],
    ['an account’s token', {}],
    ['a guest’s token', { anonymous: true }],
    ['an agent’s token', { agent: true }],
    ['a token that does not verify', { invalid: true }],
    ['a suspended account’s token', { banned: true }],
    ['a revoked session’s token', { sessionValid: false }],
    ['a deleting account’s token', { state: 'deleting' }],
    ['a merged guest’s token', { anonymous: true, state: 'merged' }],
  ])('is admitted exactly as /api/search is, for %s', async (_name, options) => {
    const opened = await throughProxy(SEARCH_OPENED_PATH, 'POST', options);
    const search = await throughProxy('/api/search?q=lu', 'GET', options);
    expect(opened).toEqual(search);
  });

  it('admits a visitor and a guest, and refuses an agent’s token as every route but the MCP server’s does', async () => {
    expect((await throughProxy(SEARCH_OPENED_PATH, 'POST', 'no-token')).status).toBe(200);
    expect((await throughProxy(SEARCH_OPENED_PATH, 'POST', { anonymous: true })).status).toBe(200);
    expect(await throughProxy(SEARCH_OPENED_PATH, 'POST', { agent: true }))
      .toEqual({ status: 403, code: 'AGENT_TOKEN_NOT_ALLOWED' });
    expect((await throughProxy(SEARCH_OPENED_PATH, 'POST', { banned: true })).status).not.toBe(200);
    expect((await throughProxy(SEARCH_OPENED_PATH, 'POST', { invalid: true })).status).toBe(401);
  });
});
