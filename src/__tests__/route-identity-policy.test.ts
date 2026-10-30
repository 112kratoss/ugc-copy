import fs from 'node:fs';
import path from 'node:path';

import type { SupabaseClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

import mobileApiOperationsV1 from '../../contracts/mobile-api-operations-v1.json';
import { deleteAccountRouteResponse } from '@/lib/account-deletion-route-adapter-service';
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

// Who a deletion was started for. The deletion pipeline itself (storage sweep,
// Auth delete) has tests of its own; here only the caller it was asked for.
const accountDeletion = vi.hoisted(() => ({ startedFor: [] as string[] }));
vi.mock('@/lib/account-deletion-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/account-deletion-service')>()),
  startInitialAccountDeletion: vi.fn(async ({ userId }: { userId: string }) => {
    accountDeletion.startedFor.push(userId);
    return {
      status: 'started' as const,
      manifest: { ownerUserIds: [userId], userPrefixBuckets: [], showcaseMediaPaths: [], templateAssetPrefixes: [] },
    };
  }),
  finishInitialAccountDeletion: vi.fn(async () => ({
    alreadyCompleted: false,
    authUserAlreadyMissing: false,
    cleanupPending: false,
    storage: { bucketsScanned: 0, objectsRemoved: 0 },
  })),
  markAccountDeletionStage: vi.fn(async () => 'failed'),
}));

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

/** What the proxy's identity check reads for a guest's token (an active guest unless told). */
function guestIdentityClient(state: 'active' | 'merged' = 'active') {
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
      data: { state, created_at: '2026-10-15T00:00:00+00:00', banned: false, session_valid: true },
      error: null,
    })),
  };
}

/**
 * The service client a route's own identity check reads when no admission
 * assertion came with the request: the guest's profile row, active, anonymous
 * and linked to no account.
 */
function activeIdentityServiceClient() {
  const row = { id: GUEST_ID, identity_state: 'active', is_anonymous: true, merged_into_user_id: null };
  const query: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'is', 'in', 'neq', 'order', 'limit']) {
    query[method] = vi.fn(() => query);
  }
  query.maybeSingle = vi.fn(async () => ({ data: row, error: null }));
  query.single = vi.fn(async () => ({ data: row, error: null }));
  return {
    from: vi.fn(() => query),
    rpc: vi.fn(async () => allowedRateLimit),
  } as unknown as SupabaseClient;
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
  /** What a guest's write is answered with, when it is not a plain 200. */
  admittedStatus?: number;
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
  'DELETE /api/account': {
    handler: 'deleteAccountRouteResponse',
    // A deletion is of someone.
    servesNoToken: false,
    // Scheduled: the identity is gone for good, and the storage sweep runs on
    // behind the answer.
    admittedStatus: 202,
    async send(caller) {
      const startedBefore = accountDeletion.startedFor.length;
      const response = await deleteAccountRouteResponse({
        // The body the app sends today (`api.deleteAccount('DELETE')`). A guest
        // has no fresh sign-in to show, and is asked for none.
        request: new Request('http://localhost/api/account', {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json',
            ...(caller ? { Authorization: 'Bearer guest-token' } : {}),
          },
          body: JSON.stringify({ confirmation: 'DELETE' }),
        }),
        dependencies: {
          createServiceClient: activeIdentityServiceClient,
          createUserClient: callerClient(caller),
          enforceBackendRateLimit: vi.fn(async () => allowedRateLimit.data),
          invalidateShowcaseFeedCache: vi.fn(),
          logError: vi.fn(),
          now: () => new Date('2026-10-15T09:00:00.000Z'),
          runAfterResponse: vi.fn(),
        },
      });
      return { status: response.status, recordedFor: accountDeletion.startedFor[startedBefore] };
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
      '/api/templates/[id]/runs',
      '/api/generations',
      // A guest's creator picks up its own run at work as it opens.
      '/api/generations/active',
      '/api/uploads/media/sign',
      '/api/showcase/preview',
    ]) {
      expect(routeIdentityPolicy(route), route).toBe('guest');
    }
  });

  it('keeps community, marketplace and payout surfaces registered-only', () => {
    // The other half of the guideline: registration may be required for
    // account-specific functionality. Letting a guest reach these would be a
    // much larger behavioural change than App Review asked for.
    for (const route of [
      '/api/posts',
      '/api/showcase/publish',
      '/api/showcase/remix',
      '/api/showcase/posts/[postId]/comments',
      '/api/profile/follow',
      '/api/marketplace/order',
      '/api/creator/payouts',
      '/api/credits/welcome/claim',
      '/api/mobile/notifications/register',
      '/api/templates/[id]/publish',
    ]) {
      expect(routeIdentityPolicy(route), route).toBe('registered');
    }
  });

  // Product decision D4 (2026-10-15). The registry's rule is that what credits
  // fund is a guest's to use. A run's steps spend the caller's own balance,
  // like every run action after its start, which were guest routes already;
  // only the start sat with the authoring routes, so a guest who had bought
  // credits was told to register to spend them on a template. Writing,
  // testing and publishing a template is authorship, and stays an account's.
  it("admits a guest's template run as the guest, and keeps authoring, testing and publishing an account's", async () => {
    const signIdentityAdmission = vi.fn(async () => 'admission-assertion');
    const dependencies = { createUserClient: () => guestIdentityClient(), signIdentityAdmission };

    expect(routeIdentityPolicy('/api/templates/[id]/runs')).toBe('guest');
    await expect(guardUserFacingRouteIdentity(bearerRequest('POST', '/api/templates/tpl-1/runs'), dependencies))
      .resolves.toBeNull();
    // The route is handed the guest it admitted, and creates the run for it.
    expect(signIdentityAdmission).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST',
      pathname: '/api/templates/tpl-1/runs',
      user: expect.objectContaining({ id: GUEST_ID, is_anonymous: true }),
    }));

    // What the run page asks after the start.
    for (const [method, pathname] of [
      ['GET', '/api/template-runs/run-1'],
      ['POST', '/api/template-runs/run-1/inputs/sign'],
      ['POST', '/api/template-runs/run-1/inputs/finalize'],
      ['POST', '/api/template-runs/run-1/start'],
      ['POST', '/api/template-runs/run-1/steps/step-1/retry'],
      ['POST', '/api/template-runs/run-1/approval-steps/step-1/approve'],
      ['POST', '/api/template-runs/run-1/cancel'],
    ] as const) {
      await expect(
        guardUserFacingRouteIdentity(bearerRequest(method, pathname), dependencies),
        `${method} ${pathname}`,
      ).resolves.toBeNull();
    }

    for (const [method, pathname] of [
      ['POST', '/api/templates'],
      ['PATCH', '/api/templates/tpl-1'],
      ['POST', '/api/templates/tpl-1/publish'],
      ['POST', '/api/templates/tpl-1/disable'],
      ['POST', '/api/templates/tpl-1/test'],
      ['POST', '/api/templates/validate'],
    ] as const) {
      const response = await guardUserFacingRouteIdentity(bearerRequest(method, pathname), dependencies);
      expect(response?.status, `${method} ${pathname}`).toBe(403);
      await expect(response?.json()).resolves.toMatchObject({ code: 'REGISTRATION_REQUIRED' });
    }
  });

  // A guest's token reaches these reads; what each serves a guest is the
  // route's own answer. remix-source-route.test.ts holds the loader to a
  // guest's own creations, and answers every other one 403
  // REGISTRATION_REQUIRED, so remixing someone else's post stays an account's.
  it("admits a guest's read of its creation's remix source and of its credit history", async () => {
    const dependencies = {
      createUserClient: () => guestIdentityClient(),
      signIdentityAdmission: vi.fn(async () => 'admission-assertion'),
    };

    expect(routeIdentityPolicy('/api/remix-source')).toBe('guest');
    expect(routeIdentityPolicy('/api/credits/history')).toBe('guest');
    for (const pathname of ['/api/remix-source?id=gen-1', '/api/credits/history?limit=30']) {
      await expect(guardUserFacingRouteIdentity(bearerRequest('GET', pathname), dependencies), pathname)
        .resolves.toBeNull();
    }

    const remix = await guardUserFacingRouteIdentity(bearerRequest('POST', '/api/showcase/remix'), dependencies);
    expect(remix?.status).toBe(403);
    await expect(remix?.json()).resolves.toMatchObject({ code: 'REGISTRATION_REQUIRED' });
  });

  // Product decision D5 (2026-10-15): a guest may delete its own data. The
  // path keeps its registered answer for every other method, and the merge
  // under it stays an account's.
  it("admits a guest's deletion of itself, and refuses it to a guest already linked to an account", async () => {
    expect(routeIdentityPolicy('/api/account')).toBe('registered');
    expect(routeIdentityPolicyForRequest('/api/account', 'DELETE')).toBe('guest');
    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH']) {
      expect(routeIdentityPolicyForRequest('/api/account', method), method).toBe('registered');
    }
    expect(routeIdentityPolicyForRequest('/api/account/merge', 'POST')).toBe('registered');
    expect(routeIdentityPolicyForRequest('/api/account/merge', 'DELETE')).toBe('registered');

    const active = { createUserClient: () => guestIdentityClient(), signIdentityAdmission: vi.fn(async () => 'admission-assertion') };
    await expect(guardUserFacingRouteIdentity(bearerRequest('DELETE', '/api/account'), active)).resolves.toBeNull();
    const merge = await guardUserFacingRouteIdentity(bearerRequest('POST', '/api/account/merge'), active);
    expect(merge?.status).toBe(403);
    await expect(merge?.json()).resolves.toMatchObject({ code: 'REGISTRATION_REQUIRED' });

    // A linked guest's data now belongs to the account it was merged into.
    const merged = { createUserClient: () => guestIdentityClient('merged'), signIdentityAdmission: vi.fn(async () => 'admission-assertion') };
    const linked = await guardUserFacingRouteIdentity(bearerRequest('DELETE', '/api/account'), merged);
    expect(linked?.status).toBe(409);
    await expect(linked?.json()).resolves.toMatchObject({ code: 'SESSION_MERGED' });
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
      'DELETE /api/account',
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

    for (const [write, { send, servesNoToken, admittedStatus = 200 }] of Object.entries(GUEST_WRITES)) {
      await expect(send({ id: GUEST_ID, is_anonymous: true }), write)
        .resolves.toEqual({ status: admittedStatus, recordedFor: GUEST_ID });
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
