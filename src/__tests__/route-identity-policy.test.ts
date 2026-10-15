import fs from 'node:fs';
import path from 'node:path';

import type { SupabaseClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

import mobileApiOperationsV1 from '../../contracts/mobile-api-operations-v1.json';
import { postModerationReportRouteResponse } from '@/lib/moderation-route-adapter-service';
import { postOnboardingEventRouteResponse } from '@/lib/onboarding-route-adapter-service';
import { getPostResourceBundleRouteResponse } from '@/lib/post-resource-bundle-route-adapter-service';
import type { PostResourceBundleDetail } from '@/lib/post-resource-bundles-server';
import { postProfileShareRouteResponse } from '@/lib/profile-share-route-adapter-service';
import { guardUserFacingRouteIdentity } from '@/lib/route-identity-admission';
import {
  GUEST_READABLE_REGISTERED_ROUTES,
  GUEST_WRITABLE_REGISTERED_ROUTES,
  ROUTE_IDENTITY_POLICY,
  routeIdentityPolicy,
  routeIdentityPolicyForRequest,
} from '@/lib/route-identity-policy';
import { postShowcaseShareRouteResponse } from '@/lib/showcase-share-route-adapter-service';

function listApiRoutes(dir: string, base = ''): string[] {
  const routes: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const next = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      routes.push(...listApiRoutes(next, `${base}/${entry.name}`));
    } else if (entry.name === 'route.ts') {
      routes.push(`/api${base}`);
    }
  }
  return routes;
}

const routes = listApiRoutes(path.resolve(process.cwd(), 'src/app/api')).sort();

const GUEST_ID = '0a0a0a0a-0000-4000-8000-00000000000a';

type Caller = { id: string; is_anonymous: true } | null;

function callerClient(caller: Caller) {
  return () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: caller }, error: null })) },
  }) as unknown as SupabaseClient;
}

function postJson(route: string, body: Record<string, unknown>) {
  return new Request(`http://localhost${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const allowedRateLimit = {
  data: { allowed: true, limit: 300, remaining: 299, retryAfterSeconds: 0, resetAt: '2026-10-15T06:10:00.000Z' },
  error: null,
};

function rateLimitedServiceClient() {
  return { rpc: vi.fn(async () => allowedRateLimit) } as unknown as SupabaseClient;
}

/** What the proxy's identity check reads for an active guest's token. */
function guestIdentityClient() {
  return {
    auth: {
      getClaims: vi.fn(async () => ({
        data: {
          claims: { sub: GUEST_ID, aud: 'authenticated', role: 'authenticated', is_anonymous: true },
        },
        error: null,
      })),
    },
    rpc: vi.fn(async () => ({
      data: { state: 'active', created_at: '2026-10-15T00:00:00+00:00', banned: false, session_valid: true },
      error: null,
    })),
  };
}

function bearerRequest(method: string, pathname: string) {
  return new NextRequest(`https://magicbooklet.test${pathname}`, {
    method,
    headers: { Authorization: 'Bearer guest-token' },
  });
}

/**
 * Each write in GUEST_WRITABLE_REGISTERED_ROUTES, sent through the handler its
 * route hands the request to. `recordedFor` is the identity the write was
 * recorded under (undefined when nothing was recorded).
 */
const GUEST_WRITES: Record<string, {
  handler: string;
  /** Whether the handler also serves a request that carries no token at all. */
  servesNoToken: boolean;
  send: (caller: Caller) => Promise<{ status: number; recordedFor: string | null | undefined }>;
}> = {
  'POST /api/onboarding/events': {
    handler: 'postOnboardingEventRouteResponse',
    servesNoToken: true,
    async send(caller) {
      const rows: Array<Record<string, unknown>> = [];
      const admin = {
        rpc: vi.fn(async () => allowedRateLimit),
        from: vi.fn(() => ({
          upsert: vi.fn(async (row: Record<string, unknown>) => {
            rows.push(row);
            return { error: null };
          }),
        })),
      } as unknown as SupabaseClient;
      const response = await postOnboardingEventRouteResponse({
        request: postJson('/api/onboarding/events', {
          clientEventId: '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b',
          installationId: `fid_${'a'.repeat(64)}`,
          eventName: 'started',
          platform: 'android',
        }),
        dependencies: { createServiceClient: () => admin, createUserClient: callerClient(caller) },
      });
      return { status: response.status, recordedFor: rows[0]?.user_id as string | null | undefined };
    },
  },
  'POST /api/showcase/share': {
    handler: 'postShowcaseShareRouteResponse',
    servesNoToken: true,
    async send(caller) {
      let recordedFor: string | null | undefined;
      const response = await postShowcaseShareRouteResponse({
        request: postJson('/api/showcase/share', { postId: 'post-1', sourceSurface: 'showcase', channel: 'copy-link' }),
        dependencies: {
          createServiceClient: rateLimitedServiceClient,
          createUserClient: callerClient(caller),
          runAfterResponse: vi.fn(),
          shareShowcasePostForRoute: vi.fn(async ({ actorUserId }: { actorUserId: string | null }) => {
            recordedFor = actorUserId;
            return { ok: true as const, body: { success: true as const } };
          }),
        },
      });
      return { status: response.status, recordedFor };
    },
  },
  'POST /api/profile/share': {
    handler: 'postProfileShareRouteResponse',
    servesNoToken: true,
    async send(caller) {
      let recordedFor: string | null | undefined;
      const response = await postProfileShareRouteResponse({
        request: postJson('/api/profile/share', { username: 'nova', sourceSurface: 'creator-profile', channel: 'copy-link' }),
        dependencies: {
          createServiceClient: rateLimitedServiceClient,
          createUserClient: callerClient(caller),
          shareCreatorProfileForRoute: vi.fn(async ({ actorUserId }: { actorUserId: string | null }) => {
            recordedFor = actorUserId;
            return { ok: true as const, body: { success: true as const } };
          }),
        },
      });
      return { status: response.status, recordedFor };
    },
  },
  'POST /api/moderation/reports': {
    handler: 'postModerationReportRouteResponse',
    // A report is filed by someone who owns the generation it flags.
    servesNoToken: false,
    async send(caller) {
      let recordedFor: string | null | undefined;
      const response = await postModerationReportRouteResponse({
        request: postJson('/api/moderation/reports', {
          targetType: 'generation',
          targetId: '3c3c3c3c-0000-4000-8000-00000000000c',
          reason: 'offensive_ai_output',
          sourceSurface: 'generation-viewer',
        }),
        dependencies: {
          createServiceClient: vi.fn(),
          createUserClient: callerClient(caller),
          submitModerationReportForRoute: vi.fn(async ({ reporterUserId }: { reporterUserId: string }) => {
            recordedFor = reporterUserId;
            return { ok: true as const, body: { success: true as const } };
          }),
        },
      });
      return { status: response.status, recordedFor };
    },
  },
};

describe('route identity policy', () => {
  it('finds the API surface it is meant to be covering', () => {
    // A guard on the guard: if the traversal ever silently returns nothing, the
    // exhaustiveness test below would pass vacuously.
    expect(routes.length).toBeGreaterThan(100);
    expect(routes).toContain('/api/mobile/commerce/sync');
  });

  it('requires every route to declare who may call it', () => {
    // The whole point. Before anonymous sessions existed, "has a JWT" and "is
    // registered" were the same thing, so no route ever had to choose. They are
    // now different, and a route that does not choose defaults to admitting
    // guests — silently, with no test failure. This makes that impossible to
    // merge: a new endpoint fails here until someone answers the question.
    const undeclared = routes.filter((route) => routeIdentityPolicy(route) === null);

    expect(undeclared).toEqual([]);
  });

  it('does not declare policies for routes that no longer exist', () => {
    // Stale entries are worse than missing ones: they make the registry look
    // like it covers something it does not.
    const known = new Set(routes);
    const orphaned = Object.keys(ROUTE_IDENTITY_POLICY).filter((route) => !known.has(route));

    expect(orphaned).toEqual([]);
  });

  it('keeps commerce and every creation tool reachable by guests', () => {
    // These are the routes App Review 5.1.1(v) is about. If any of them ever
    // becomes registered-only, the rejection comes straight back.
    for (const route of [
      '/api/mobile/commerce/sync',
      '/api/mobile/commerce/restore',
      '/api/account/merge/prepare',
      '/api/generate',
      '/api/generate-image',
      '/api/generate-video',
      '/api/enhance-prompt',
      '/api/generations',
      '/api/uploads/media/sign',
      '/api/showcase/preview',
    ]) {
      expect(routeIdentityPolicy(route)).toBe('guest');
    }
  });

  it('keeps community, marketplace and payout surfaces registered-only', () => {
    // The other half of the guideline: registration may be required for
    // account-specific functionality. Letting a guest reach these would be a
    // much larger behavioural change than App Review asked for.
    for (const route of [
      '/api/posts',
      '/api/showcase/publish',
      '/api/showcase/posts/[postId]/comments',
      '/api/profile/follow',
      '/api/marketplace/order',
      '/api/creator/payouts',
      '/api/credits/welcome/claim',
      '/api/mobile/notifications/register',
    ]) {
      expect(routeIdentityPolicy(route)).toBe('registered');
    }
  });

  // A read listed there is admitted for a guest's token. That is only right for
  // a registered path whose GET needs no one: its writes, today's or one added
  // later, keep the path's answer.
  it('lists as guest-readable only registered paths with a read, whose writes stay an account\'s', () => {
    expect([...GUEST_READABLE_REGISTERED_ROUTES]).toEqual([
      '/api/showcase/posts/[postId]/comments',
      '/api/posts/[postId]/resource-bundle',
    ]);

    for (const route of GUEST_READABLE_REGISTERED_ROUTES) {
      expect(routeIdentityPolicy(route), route).toBe('registered');
      const source = fs.readFileSync(path.resolve(process.cwd(), `src/app${route}/route.ts`), 'utf8');
      expect(source, route).toMatch(/export (?:async function GET\b|const GET\b|const \{[^}]*\bGET\b[^}]*\})/);
      const concrete = route.replace(/\[[A-Za-z0-9_]+\]/g, 'id-1');
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        expect(routeIdentityPolicyForRequest(concrete, method), `${method} ${route}`).toBe('registered');
      }
    }
    // The comments path is registered for a write it has today.
    const comments = fs.readFileSync(
      path.resolve(process.cwd(), 'src/app/api/showcase/posts/[postId]/comments/route.ts'),
      'utf8',
    );
    expect(comments).toMatch(/export (?:async function|const) (?:POST|PUT|PATCH|DELETE)\b/);
  });

  // The app's unlock screen falls back to this read when the marketplace detail
  // answers 404, and a guest's app sends its token with it. Asking the path's
  // question turned "Unlock unavailable" into a 403 the screen read as a lost
  // connection (2026-10-15 marketplace comparison, finding 02-9).
  it("admits a guest's read of a post's recipe, and still refuses a guest every buy under it", async () => {
    const dependencies = {
      createUserClient: () => guestIdentityClient(),
      signIdentityAdmission: vi.fn(async () => 'admission-assertion'),
    };

    await expect(guardUserFacingRouteIdentity(bearerRequest('GET', '/api/posts/post-1/resource-bundle'), dependencies))
      .resolves.toBeNull();
    await expect(guardUserFacingRouteIdentity(bearerRequest('HEAD', '/api/posts/post-1/resource-bundle'), dependencies))
      .resolves.toBeNull();

    for (const pathname of [
      '/api/posts/post-1/resource-bundle/unlock-free',
      '/api/posts/post-1/resource-bundle/unlock-with-credits',
      '/api/posts/post-1/resource-bundle/order',
      '/api/posts/post-1/resource-bundle/verify',
      '/api/posts/post-1/resource-bundle/file-url',
    ]) {
      const response = await guardUserFacingRouteIdentity(bearerRequest('POST', pathname), dependencies);
      expect(response?.status, pathname).toBe(403);
      await expect(response?.json()).resolves.toMatchObject({ code: 'REGISTRATION_REQUIRED' });
    }
  });

  // The proxy admits that read on the route's word that it asks for no one.
  it('keeps the recipe read open to a request with no token', async () => {
    const getPostResourceBundleDetailByPostId = vi.fn(async () => ({
      id: 'bundle-1',
      postId: 'post-1',
      seller: { id: 'creator-1' },
      viewerIsOwner: false,
      resources: null,
    } as unknown as PostResourceBundleDetail));
    const noSession = {
      auth: { getUser: vi.fn(async () => ({ data: { user: null }, error: new Error('Auth session missing!') })) },
    } as unknown as SupabaseClient;

    const response = await getPostResourceBundleRouteResponse({
      request: new Request('http://localhost/api/posts/post-1/resource-bundle'),
      context: { params: Promise.resolve({ postId: 'post-1' }) },
      dependencies: {
        createUserClient: () => noSession,
        getPostResourceBundleDetailByPostId,
        isMarketplaceCreatorBlockedForViewer: vi.fn(),
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true, bundle: { id: 'bundle-1', resources: null } });
    expect(getPostResourceBundleDetailByPostId).toHaveBeenCalledWith('post-1', { viewerUserId: null, countryCode: null });
  });

  // The proxy admits that read on the route's word that it asks for no one.
  it("keeps the comments read open to a request with no token, and its writes an account's", () => {
    const adapter = fs.readFileSync(path.resolve(process.cwd(), 'src/lib/post-comments-route-adapter-service.ts'), 'utf8');
    const read = adapter.slice(adapter.indexOf('async function handlePostCommentsGET'), adapter.indexOf('async function handlePostCommentsPOST'));
    const write = adapter.slice(adapter.indexOf('async function handlePostCommentsPOST'), adapter.indexOf('async function handlePostCommentDELETE'));
    const remove = adapter.slice(adapter.indexOf('async function handlePostCommentDELETE'));

    expect(read).toContain('await getViewerUserId(request, dependencies)');
    expect(read).not.toContain('requireViewerUserId');
    expect(write).toContain('await requireViewerUserId(request, dependencies)');
    expect(remove).toContain('await requireViewerUserId(request, dependencies)');
  });

  // A write listed there reaches its route with a guest's token. That is only
  // right for a registered path whose route takes that method.
  it('lists as guest-writable, by method, registered paths whose route takes that method', () => {
    expect(GUEST_WRITABLE_REGISTERED_ROUTES.map(({ method, route }) => `${method} ${route}`)).toEqual([
      'POST /api/onboarding/events',
      'POST /api/showcase/share',
      'POST /api/profile/share',
      'POST /api/moderation/reports',
    ]);

    for (const { method, route } of GUEST_WRITABLE_REGISTERED_ROUTES) {
      expect(routeIdentityPolicy(route), route).toBe('registered');
      const source = fs.readFileSync(path.resolve(process.cwd(), `src/app${route}/route.ts`), 'utf8');
      expect(source, route).toMatch(new RegExp(`export (?:async )?function ${method}\\b`));
      expect(source, route).toContain(GUEST_WRITES[`${method} ${route}`]?.handler ?? 'no handler listed');
    }
  });

  // The proxy admits these writes on the handler's word that it takes a
  // guest. A handler that answered one 401 would read in the app as a session
  // that has ended, and the guest would be signed out over a share.
  it('has every guest-writable handler take a guest as its caller', async () => {
    expect(Object.keys(GUEST_WRITES).sort()).toEqual(
      GUEST_WRITABLE_REGISTERED_ROUTES.map(({ method, route }) => `${method} ${route}`).sort(),
    );

    for (const [write, { send, servesNoToken }] of Object.entries(GUEST_WRITES)) {
      await expect(send({ id: GUEST_ID, is_anonymous: true }), write)
        .resolves.toEqual({ status: 200, recordedFor: GUEST_ID });
      await expect(send(null), write).resolves.toEqual(servesNoToken
        ? { status: 200, recordedFor: null }
        : { status: 401, recordedFor: undefined });
    }
  });

  // What the registry admits with no token, or with a guest's, the operations
  // contract (the proxy's mobile route list) calls optional (finding 02-9).
  it('marks the recipe reads the app makes as optional in the operations contract', () => {
    expect(mobileApiOperationsV1.operations.getMarketplaceResourceDetail.auth).toBe('optional');
    expect(mobileApiOperationsV1.fallbackRoutes).toContainEqual({
      method: 'GET',
      path: '/api/posts/:postId/resource-bundle',
      auth: 'optional',
    });
    expect(routeIdentityPolicyForRequest('/api/marketplace/resources/bundle-1', 'GET')).toBe('public');
    expect(routeIdentityPolicyForRequest('/api/posts/post-1/resource-bundle', 'GET')).toBe('public');
  });

  it('covers every route the mobile app actually calls', () => {
    // The contract drives CORS and version gating at runtime; this registry
    // drives admission. They are different questions — the contract's `required`
    // means "the client sends a token", which is true even for routes that read
    // fine signed out — so this does not compare the two verdicts. What it does
    // catch is drift: a mobile-facing route this registry has never heard of.
    //
    // Params are compared structurally because the two files name them
    // differently: the contract says `:runId` where the filesystem says `[id]`.
    const shape = (route: string) =>
      route.replace(/:([A-Za-z0-9_]+)/g, '[]').replace(/\[[A-Za-z0-9_]+\]/g, '[]');

    const declared = new Set(Object.keys(ROUTE_IDENTITY_POLICY).map(shape));
    const operations = Object.values(mobileApiOperationsV1.operations) as Array<{
      path: string;
      auth: string;
    }>;

    const unknown = operations
      .map((operation) => operation.path)
      .filter((route) => !declared.has(shape(route)));

    expect(unknown).toEqual([]);
  });
});
