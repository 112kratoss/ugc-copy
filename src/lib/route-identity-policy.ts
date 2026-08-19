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
 *   public      no authentication, or optional auth where guests read as signed out
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

  // Every credit-funded creation tool.
  '/api/generate',
  '/api/generate-image',
  '/api/generate-video',
  '/api/enhance-prompt',
  '/api/generation-models/quote',
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
  '/api/uploads/media/sign',
  '/api/uploads/media/read-url',
  '/api/uploads/workflow-asset/sign',
  '/api/uploads/workflow-asset/read-url',
  '/api/media',
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
  // Identity of record. Profile mutation shares a path with the read above and
  // is gated inside the adapter by method.
  '/api/profile/validate',
  '/api/profile/media/sign',
  '/api/profile/media/cleanup',
  '/api/profile/share',
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
  '/api/showcase/saved-media',
  '/api/showcase/saved-state',
  '/api/showcase/share',
  '/api/showcase/posts/[postId]/comments',
  '/api/showcase/posts/[postId]/comments/[commentId]',
  '/api/profile/follow',
  '/api/profile/follow/notify',
  '/api/moderation/reports',
  '/api/moderation/blocks/[userId]',
  '/api/remix-source',

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
  '/api/templates',
  '/api/templates/mine',
  '/api/templates/[id]',
  '/api/templates/[id]/publish',
  '/api/templates/[id]/disable',
  '/api/templates/[id]/test',
  '/api/templates/[id]/runs',
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
 * Optional-auth surfaces treat a guest as an unsigned viewer: a guest has no
 * follows, saves or blocks to personalise against, and feeding an anonymous id
 * into viewer-scoped queries would attribute engagement to an identity that is
 * about to be linked away.
 */
const PUBLIC_ROUTES = [
  '/api/app-version',
  '/api/contact',
  '/api/fx',
  '/api/generation-models',
  '/api/source-tools',
  '/api/seedance-assets',
  '/api/creators/[username]',
  '/api/showcase/feed',
  '/api/showcase/feed/events',
  '/api/showcase/posts/[postId]',
  '/api/showcase/preview',
  '/api/marketplace/resources',
  '/api/marketplace/resources/[resourceId]',
  '/api/security/csp-report',
] as const;

/** Cron, webhooks, ops and the admin console: no end-user identity involved. */
const SERVICE_ROUTES = [
  '/api/admin/session',
  '/api/admin/users/credits',
  '/api/admin/payouts',
  '/api/admin/moderation/post-reports',
  '/api/admin/moderation/subject-reports',
  '/api/admin/users/sanctions',
  '/api/admin/moderation/generations',
  '/api/admin/contact',
  '/api/cron/account-deletion-resweeps',
  '/api/cron/backend-alert-delivery',
  '/api/cron/backend-jobs',
  '/api/cron/feed-maintenance',
  '/api/cron/generation-completions',
  '/api/cron/generation-model-verification',
  '/api/cron/media-preview-repair',
  '/api/cron/media-upload-reclaim',
  '/api/cron/mobile-push-receipts',
  '/api/cron/operational-data-retention',
  '/api/cron/referral-rewards',
  '/api/cron/workflow-run-steps',
  '/api/ops/backend-alerts',
  '/api/ops/backend-costs',
  '/api/ops/backend-dashboard',
  '/api/ops/backend-health',
  '/api/razorpay/webhook',
  '/api/webhooks/kie',
  '/api/mobile/commerce/revenuecat-webhook',
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
