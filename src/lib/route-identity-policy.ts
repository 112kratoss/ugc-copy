/**
 * What kind of caller each API route accepts.
 *
 * Before guest checkout there was one answer everywhere — "anyone with a valid
 * JWT" — and it was correct, because the only way to hold a JWT was to register.
 * Anonymous sessions broke that equivalence silently: a guest holds a perfectly
 * ordinary token, so every route still asking the old question started admitting
 * them the moment guests existed, with no code change and no test failure.
 *
 * This registry exists so that admission is a decision rather than an accident.
 * `route-identity-policy.test.ts` fails on any route that is not listed, so a new
 * endpoint cannot be merged without someone answering the question for it.
 *
 *   guest       accepts an active guest or a registered user
 *   registered  rejects anonymous and linked-guest sessions
 *   public      no authentication, or optional auth (what a guest's token means
 *               there is the route's own: see PUBLIC_ROUTES)
 *   service     not user-facing: cron, webhooks, ops, admin console
 */
export type RouteIdentityPolicy = 'guest' | 'registered' | 'public' | 'service';

/**
 * Guest-allowed routes.
 *
 * The rule: anything funded by credits, or owned by the identity itself.
 * Registration buys cross-device access and a public presence — not the right to
 * spend credits you paid for. That is the distinction guideline 5.1.1(v) turns
 * on, and reading it any wider re-creates the rejection.
 */
const GUEST_ROUTES = [
  // Commerce: the whole point of the change.
  '/api/mobile/commerce/sync',
  '/api/mobile/commerce/restore',
  '/api/account/merge/prepare',

  // Identity's own state. Reads only — mutation is registered-only below.
  '/api/profile',
  // Where the identity's balance came from and went: purchases, grants,
  // spends and refunds. A guest buys and spends, so it reads its own record.
  '/api/credits/history',

  // Every credit-funded creation tool.
  '/api/generate',
  '/api/generate-image',
  '/api/generate-video',
  '/api/enhance-prompt',
  '/api/generation-models/quote',
  // Starting a run of a published template: the run is the caller's own and
  // its steps spend the caller's credits, like every run action after it.
  // Authoring, testing and publishing a template stay registered below.
  '/api/templates/[id]/runs',
  '/api/template-runs/[id]',
  '/api/template-runs/[id]/start',
  '/api/template-runs/[id]/cancel',
  '/api/template-runs/[id]/inputs/sign',
  '/api/template-runs/[id]/inputs/finalize',
  '/api/template-runs/[id]/steps/[stepId]/retry',
  '/api/template-runs/[id]/approval-steps/[stepId]/approve',
  '/api/workflow-canvases',
  '/api/workflow-canvases/[id]',
  '/api/workflow-canvases/[id]/run',
  '/api/workflow-canvases/[id]/runs/[runId]',
  '/api/workflow-canvases/[id]/runs/[runId]/approval-steps/[stepId]/approve',

  // The output of those tools, and the media they need.
  '/api/generations',
  '/api/generations/[id]',
  '/api/generations/[id]/archive',
  '/api/generations/[id]/restore',
  '/api/generations/[id]/restore-media',
  // A creation's recipe, restored into the editor to make it again. A guest is
  // served only a generation of its own (or of an identity linked to it); the
  // loader answers a guest's every other request 403 REGISTRATION_REQUIRED
  // itself, so restoring someone else's post stays an account's, as remixing
  // one is (POST /api/showcase/remix below).
  '/api/remix-source',
  '/api/uploads/media/sign',
  '/api/uploads/finalize',
  '/api/uploads/media/read-url',
  '/api/uploads/workflow-asset/sign',
  '/api/uploads/workflow-asset/read-url',
  '/api/media',
  '/api/showcase/preview',

  // The identity's own feed preferences. An app guest's Not interested or
  // Hide is kept under the guest uid (see PUBLIC_ROUTES), so taking one back
  // is the guest's to do as much as a registered user's.
  '/api/showcase/feed/feedback/undo',
] as const;

/**
 * Registered-only routes.
 *
 * Anything with a public presence, an identity of record, or money moving out.
 * These are the "account-specific functionality" the guideline explicitly allows
 * gating, and the reason guest checkout does not turn Magicbooklet into an
 * anonymous posting surface.
 */
const REGISTERED_ROUTES = [
  '/api/content-preferences',
  '/api/posts/[postId]/reveal',
  // Identity of record. Profile mutation shares a path with the read above and
  // is gated inside the adapter by method.
  '/api/profile/validate',
  '/api/profile/media/sign',
  '/api/profile/media/cleanup',
  '/api/profile/share',
  // A guest's DELETE (deleting its own data) is listed in
  // GUEST_WRITABLE_REGISTERED_ROUTES below.
  '/api/account',
  '/api/account/merge',

  // Registration rewards. A guest claiming these is the faucet 20260811120000
  // closes at the database.
  '/api/credits/welcome',
  '/api/credits/welcome/claim',
  '/api/onboarding/state',
  '/api/onboarding/events',
  '/api/referrals/me',
  '/api/referrals/link',
  '/api/referrals/claim',
  '/api/referrals/visit',

  // Community: publishing, conversation, and everything attributable.
  '/api/posts',
  '/api/posts/[postId]',
  '/api/posts/[postId]/archive',
  '/api/posts/[postId]/restore',
  '/api/posts/[postId]/report',
  '/api/posts/resource-files',
  '/api/posts/resource-files/sign',
  '/api/posts/resource-files/finalize',
  '/api/showcase/publish',
  '/api/showcase/remix',
  '/api/showcase/save',
  // Whether the account has been told that creators can see who saved: a
  // guest saves nothing.
  '/api/profile/saver-notice',
  '/api/showcase/saved-media',
  '/api/showcase/saved-state',
  '/api/showcase/viewer-exclusions',
  '/api/showcase/share',
  '/api/showcase/posts/[postId]/comments',
  '/api/showcase/posts/[postId]/comments/[commentId]',
  '/api/profile/follow',
  '/api/moderation/reports',
  '/api/moderation/blocks',
  '/api/moderation/blocks/[userId]',

  // Marketplace, unlocks and payouts: an identified payee is a legal
  // requirement, not a product preference.
  '/api/marketplace/assets',
  '/api/marketplace/assets/[assetId]/import',
  '/api/marketplace/assets/[assetId]/unlock-with-credits',
  '/api/marketplace/order',
  '/api/marketplace/verify',
  '/api/marketplace/sales/export',
  '/api/me/unlocks',
  '/api/me/unlocks/[unlockId]',
  '/api/me/unlocks/[unlockId]/file-url',
  '/api/posts/[postId]/resource-bundle',
  '/api/posts/[postId]/resource-bundle/order',
  '/api/posts/[postId]/resource-bundle/verify',
  '/api/posts/[postId]/resource-bundle/file-url',
  '/api/posts/[postId]/resource-bundle/unlock-free',
  '/api/posts/[postId]/resource-bundle/unlock-with-credits',
  '/api/creator/payouts',

  // Notifications need somewhere durable to deliver to.
  '/api/mobile/notifications',
  '/api/mobile/notifications/read',
  '/api/mobile/notifications/read-all',
  '/api/mobile/notifications/preferences',
  '/api/mobile/notifications/register',
  '/api/mobile/notifications/unregister',

  // Authoring and sharing templates is a published artifact with an author.
  // (Running someone's published template is a creation tool, listed with
  // the guest routes above.)
  '/api/templates',
  '/api/templates/[id]',
  '/api/templates/[id]/publish',
  '/api/templates/[id]/disable',
  '/api/templates/[id]/test',
  '/api/templates/validate',
  '/api/workflow-canvases/[id]/publish',
  '/api/workflow-canvases/[id]/share',
  '/api/workflow-canvases/[id]/history',
  '/api/workflow-canvases/[id]/history/[entryId]/restore',
  '/api/workflow-canvases/[id]/assistant',
  '/api/workflow-canvases/[id]/assistant/messages',
  '/api/workflow-canvases/[id]/assistant/proposals/[proposalId]/apply',
  '/api/workflow-canvases/[id]/assistant/proposals/[proposalId]/discard',
  '/api/workflow-shares/[shareId]',
  '/api/workflow-shares/[shareId]/import',
  '/api/workflow-blueprint',

  // Web payments.
  '/api/razorpay/order',
  '/api/razorpay/verify',
] as const;

/**
 * Public routes.
 *
 * No token is needed. One that is sent must still be a live identity (the
 * proxy checks it), and each route decides what a guest's identity means to
 * it. The feed and its events rank and log a verified guest session as the
 * user it is: the app's guest holds an anonymous Supabase session, so its
 * interest weights build up, and its Not interested and Hide are kept under
 * the guest uid, which the device holds until sign-out (product decision D1,
 * 2026-10-14). The unsigned viewer is the web's guest, who sends no token and
 * is known only by a hashed cookie: no weights, and feedback that lasts the
 * visit.
 */
const PUBLIC_ROUTES = [
  '/api/app-version',
  '/api/contact',
  '/api/fx',
  '/api/generation-models',
  '/api/model-catalog/v1/current',
  '/api/model-catalog/v1/models',
  '/api/model-catalog/v1/models/[id]',
  '/api/model-catalog/v1/details',
  '/api/source-tools',
  '/api/seedance-assets',
  '/api/creators/[username]',
  '/api/search',
  '/api/showcase/feed',
  '/api/showcase/feed/events',
  // Whether a lane has a post newer than the one a client holds: no identity
  // is read, and every caller gets the same cacheable answer.
  '/api/showcase/feed/newest',
  '/api/showcase/posts/[postId]',
  // Which live post an id names (an old link's generation id included), for
  // the app when the read above answers 404. A token only keys the by-id
  // read's rate limit on its caller; every caller gets the same answer.
  '/api/showcase/posts/[postId]/resolve',
  '/api/marketplace/resources',
  '/api/marketplace/resources/[resourceId]',
  '/api/security/csp-report',
  // Sampled media-failure reports: no identity is read or recorded.
  '/api/mobile/media-diagnostics',
  // Per-session playback start-up and stall aggregates: no identity is read or recorded.
  '/api/mobile/playback-metrics',
] as const;

/** Cron, webhooks, ops and the admin console: no end-user identity involved. */
const SERVICE_ROUTES = [
  '/api/admin/session',
  '/api/admin/users/credits',
  '/api/admin/payouts',
  '/api/admin/moderation/post-reports',
  '/api/admin/moderation/posts',
  '/api/admin/moderation/subject-reports',
  '/api/admin/users/sanctions',
  '/api/admin/moderation/generations',
  '/api/admin/contact',
  '/api/cron/account-deletion-resweeps',
  '/api/cron/backend-alert-delivery',
  '/api/cron/backend-jobs',
  '/api/cron/feed-embeddings',
  '/api/cron/feed-maintenance',
  '/api/cron/generation-completions',
  '/api/cron/generation-model-verification',
  '/api/cron/media-preview-repair',
  '/api/cron/media-upload-reclaim',
  '/api/cron/mobile-push-receipts',
  '/api/cron/operational-data-retention',
  '/api/cron/referral-rewards',
  '/api/cron/showcase-media-revocations',
  '/api/cron/workflow-run-steps',
  '/api/ops/backend-alerts',
  '/api/ops/backend-costs',
  '/api/ops/backend-dashboard',
  '/api/ops/backend-health',
  '/api/razorpay/webhook',
  '/api/webhooks/kie',
  '/api/mobile/commerce/revenuecat-webhook',
] as const;

/**
 * Registered-only paths whose read any visitor may make.
 *
 * The registry answers per path, and a path's methods can differ. Writing a
 * comment takes an account; reading the thread under a public post takes no
 * one, not even a token. A guest's app sends its token with every request, so
 * asking the path's question of that read refused a guest what a signed-out
 * visitor is served: every guest saw "Comments are unavailable" on every post.
 *
 * A post's recipe read is the other. Its handler serves a visitor with no token
 * the locked preview the post page shows, and the app's unlock screen falls
 * back to it when the marketplace detail answers 404, so a guest's token turned
 * that "Unlock unavailable" into a 403 the screen reads as a lost connection.
 * Buying, verifying and opening files live on paths of their own, each
 * registered; the path itself stays registered so that a write added to it
 * later is an account's from the start.
 *
 * A GET or HEAD of a path listed here is answered as `public`: a token that is
 * sent must still have a live identity behind it, and need not be a registered
 * one. Every other method keeps the path's policy, so a guest's write is still
 * refused 403 REGISTRATION_REQUIRED before it reaches the route. (Moving the
 * path to the guest list instead would hand that write to the adapter, whose
 * 401 the app reads as a session that has ended.)
 *
 * List a path only when its GET handler serves a request with no Authorization
 * header at all. `route-identity-policy.test.ts` holds each entry to a
 * registered path with a read, sends that read as a guest, and keeps every
 * write of it refused to one.
 */
export const GUEST_READABLE_REGISTERED_ROUTES = [
  '/api/showcase/posts/[postId]/comments',
  '/api/posts/[postId]/resource-bundle',
] as const;

/**
 * Registered-only paths whose listed write a guest may make.
 *
 * The share counters and the onboarding events were written for a caller who
 * may be no one: a signed-out web visitor's share is counted, and the intro
 * logs a device before it has an account. A guest's app sends its token with
 * every request, so asking the path's question of those writes refused the
 * app guest what a visitor with no token is served: its shares never reached
 * the counts, and every intro event after the guest session started was
 * dropped, which left the onboarding funnel without its top.
 *
 * A guest's report is narrower. A guest may flag a generation its own credits
 * made (the store asks for in-app reporting of AI output, and a guest creates);
 * the moderation adapter admits that one and answers every other guest report
 * 403 REGISTRATION_REQUIRED itself.
 *
 * A guest may also delete itself (product decision D5, 2026-10-15): the
 * account route takes a guest's token, needs no fresh sign-in from it (a guest
 * has none to give), and removes the guest identity and what it made through
 * the same deletion pipeline as an account's. The path stays registered, so a
 * write added to it later is an account's from the start.
 *
 * A request whose method and path are listed here is answered as `guest`: a
 * token that is sent must still have a live identity behind it. Every other
 * method keeps the path's policy.
 *
 * List a write only when its handler takes a guest as its caller, and never
 * answers one 401: the app reads a 401 as a session that has ended.
 * `route-identity-policy.test.ts` sends each listed write as a guest.
 */
export const GUEST_WRITABLE_REGISTERED_ROUTES = [
  { method: 'POST', route: '/api/onboarding/events' },
  { method: 'POST', route: '/api/showcase/share' },
  { method: 'POST', route: '/api/profile/share' },
  { method: 'POST', route: '/api/moderation/reports' },
  { method: 'DELETE', route: '/api/account' },
] as const;

export const ROUTE_IDENTITY_POLICY: Readonly<Record<string, RouteIdentityPolicy>> =
  Object.freeze({
    ...Object.fromEntries(GUEST_ROUTES.map((route) => [route, 'guest' as const])),
    ...Object.fromEntries(REGISTERED_ROUTES.map((route) => [route, 'registered' as const])),
    ...Object.fromEntries(PUBLIC_ROUTES.map((route) => [route, 'public' as const])),
    ...Object.fromEntries(SERVICE_ROUTES.map((route) => [route, 'service' as const])),
  });

export function routeIdentityPolicy(route: string): RouteIdentityPolicy | null {
  return ROUTE_IDENTITY_POLICY[route] ?? null;
}

function routeSegmentsMatch(template: string, pathname: string) {
  const templateSegments = template.split('/').filter(Boolean);
  const pathnameSegments = pathname.split('/').filter(Boolean);
  return templateSegments.length === pathnameSegments.length
    && templateSegments.every((segment, index) => (
      /^\[[A-Za-z0-9_]+\]$/.test(segment)
      || segment === pathnameSegments[index]
    ));
}

/** Resolves a concrete request pathname against the registry's dynamic routes. */
export function routeIdentityPolicyForPathname(pathname: string): RouteIdentityPolicy | null {
  const exact = routeIdentityPolicy(pathname);
  if (exact) return exact;

  for (const [template, policy] of Object.entries(ROUTE_IDENTITY_POLICY)) {
    if (routeSegmentsMatch(template, pathname)) return policy;
  }

  return null;
}

/**
 * The policy one request is admitted under: its path's own, except the read of
 * a path in `GUEST_READABLE_REGISTERED_ROUTES` and a write listed in
 * `GUEST_WRITABLE_REGISTERED_ROUTES`. Admission asks this, not the path alone.
 */
export function routeIdentityPolicyForRequest(pathname: string, method: string): RouteIdentityPolicy | null {
  const policy = routeIdentityPolicyForPathname(pathname);
  if (policy !== 'registered') return policy;

  const verb = method.toUpperCase();
  if (GUEST_WRITABLE_REGISTERED_ROUTES.some((write) => (
    write.method === verb && routeSegmentsMatch(write.route, pathname)
  ))) {
    return 'guest';
  }
  if (verb !== 'GET' && verb !== 'HEAD') return policy;

  return GUEST_READABLE_REGISTERED_ROUTES.some((template) => routeSegmentsMatch(template, pathname))
    ? 'public'
    : policy;
}
