import { NextResponse } from 'next/server';

type SupabaseRpcResult = {
  data: unknown;
  error: { message?: string } | Error | null;
};

type SupabaseRpcClient = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<SupabaseRpcResult>;
};

export type BackendRateLimitOptions = {
  scope: string;
  key: string;
  limit: number;
  windowSeconds: number;
};

export type BackendRateLimitState = {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
  resetAt: string;
};

export const MEDIA_GENERATION_RATE_LIMIT = {
  scope: 'media-generation:start',
  limit: 30,
  windowSeconds: 10 * 60,
} as const;

export const MEDIA_TEMPLATE_MUTATION_RATE_LIMIT = {
  scope: 'media-template:mutate',
  limit: 120,
  windowSeconds: 10 * 60,
} as const;

export const GENERATION_LIFECYCLE_MUTATION_RATE_LIMIT = {
  scope: 'generation-lifecycle:mutate',
  limit: 60,
  windowSeconds: 10 * 60,
} as const;

export const POST_MUTATION_RATE_LIMIT = {
  scope: 'post:mutate',
  limit: 60,
  windowSeconds: 10 * 60,
} as const;

export const PROMPT_ENHANCEMENT_RATE_LIMIT = {
  scope: 'prompt-enhancement',
  limit: 60,
  windowSeconds: 10 * 60,
} as const;

export const CONTACT_SUBMISSION_RATE_LIMIT = {
  scope: 'contact:submit',
  limit: 10,
  windowSeconds: 10 * 60,
} as const;

// An account's messages to support, keyed by the account: room for a person
// who writes in several short lines, not for a script.
export const SUPPORT_MESSAGE_RATE_LIMIT = {
  scope: 'support:message',
  limit: 20,
  windowSeconds: 10 * 60,
} as const;

// Edits, deletes for everyone and reactions in a support conversation, by
// either side's account: a person tidying a few messages, not a script.
export const SUPPORT_ACTION_RATE_LIMIT = {
  scope: 'support:action',
  limit: 60,
  windowSeconds: 10 * 60,
} as const;

// "typing…" pings (one every 3 s while the text changes) and read receipts
// from an open support thread: a person typing for most of ten minutes fits.
export const SUPPORT_SIGNAL_RATE_LIMIT = {
  scope: 'support:signal',
  limit: 400,
  windowSeconds: 10 * 60,
} as const;

// Help & Support's Updates and Roadmap lists, keyed by the reader, or by the
// network for a visitor without an account: a person paging and coming back,
// and the unread dot's one-row read on each launch, fit easily.
export const SUPPORT_HUB_READ_RATE_LIMIT = {
  scope: 'support-hub:read',
  limit: 300,
  windowSeconds: 10 * 60,
} as const;

// Reactions on updates and roadmap items, keyed by the account: a person
// changing their mind a few times on each, not a script.
export const SUPPORT_HUB_REACTION_RATE_LIMIT = {
  scope: 'support-hub:reaction',
  limit: 120,
  windowSeconds: 10 * 60,
} as const;

// Browsers can emit several violations during one page load, so this is high
// enough for diagnostics while still bounding a public unauthenticated sink.
export const CSP_REPORT_RATE_LIMIT = {
  scope: 'security:csp-report',
  limit: 120,
  windowSeconds: 10 * 60,
} as const;

export const ADMIN_CONTENT_MODERATION_RATE_LIMIT = {
  scope: 'admin-content-moderation',
  limit: 60,
  windowSeconds: 10 * 60,
} as const;

export const ADMIN_USER_SANCTION_RATE_LIMIT = {
  scope: 'admin-user-sanction',
  limit: 30,
  windowSeconds: 10 * 60,
} as const;

export const POST_REPORT_RATE_LIMIT = {
  scope: 'post-report:submit',
  limit: 10,
  windowSeconds: 10 * 60,
} as const;

export const POST_COMMENT_CREATE_RATE_LIMIT = {
  scope: 'post-comment:create',
  limit: 20,
  windowSeconds: 10 * 60,
} as const;

export const POST_COMMENT_MUTATION_RATE_LIMIT = {
  scope: 'post-comment:mutate',
  limit: 30,
  windowSeconds: 10 * 60,
} as const;

/**
 * A like or a dislike on a comment. Its own budget, well above an edit's or a
 * delete's: a reader likes their way down a thread, and that must not leave
 * them unable to delete their own comment.
 */
export const POST_COMMENT_REACTION_RATE_LIMIT = {
  scope: 'post-comment:react',
  limit: 120,
  windowSeconds: 10 * 60,
} as const;

export const MODERATION_REPORT_RATE_LIMIT = {
  scope: 'moderation-report:submit',
  limit: 10,
  windowSeconds: 10 * 60,
} as const;

export const USER_BLOCK_MUTATION_RATE_LIMIT = {
  scope: 'user-block:mutate',
  limit: 30,
  windowSeconds: 10 * 60,
} as const;

export const CREATOR_FOLLOW_MUTATION_RATE_LIMIT = {
  scope: 'creator-follow:mutate',
  limit: 60,
  windowSeconds: 10 * 60,
} as const;

/**
 * Not a refusal: the push a post's save alert may send, named or not, keyed by
 * creator and post and claimed only once an alert has been written anew. A
 * creator's phone hears about one post's saves at most once a quarter-hour, as
 * it did when every save alert was grouped; later alerts in that quarter-hour
 * wait in Alerts.
 */
export const POST_SAVE_PUSH_RATE_LIMIT = {
  scope: 'post-save:push',
  limit: 1,
  windowSeconds: 15 * 60,
} as const;

/** Recording that an account was told creators can see who saved: once per account, retried by each new device. */
export const SAVER_NOTICE_RECORD_RATE_LIMIT = {
  scope: 'saver-notice:record',
  limit: 20,
  windowSeconds: 10 * 60,
} as const;

export const CREDIT_ORDER_RATE_LIMIT = {
  scope: 'credit-order:create',
  limit: 10,
  windowSeconds: 10 * 60,
} as const;

export const CREDIT_ORDER_VERIFY_RATE_LIMIT = {
  scope: 'credit-order:verify',
  limit: 30,
  windowSeconds: 10 * 60,
} as const;

export const MARKETPLACE_ORDER_RATE_LIMIT = {
  scope: 'marketplace-order:create',
  limit: 10,
  windowSeconds: 10 * 60,
} as const;

export const MARKETPLACE_ORDER_VERIFY_RATE_LIMIT = {
  scope: 'marketplace-order:verify',
  limit: 30,
  windowSeconds: 10 * 60,
} as const;

export const MARKETPLACE_ASSET_SAVE_RATE_LIMIT = {
  scope: 'marketplace-asset:save',
  limit: 60,
  windowSeconds: 10 * 60,
} as const;

export const MARKETPLACE_ASSET_IMPORT_RATE_LIMIT = {
  scope: 'marketplace-asset:import',
  limit: 30,
  windowSeconds: 10 * 60,
} as const;

export const POST_RESOURCE_ORDER_RATE_LIMIT = {
  scope: 'post-resource-order:create',
  limit: 10,
  windowSeconds: 10 * 60,
} as const;

export const POST_RESOURCE_ORDER_VERIFY_RATE_LIMIT = {
  scope: 'post-resource-order:verify',
  limit: 30,
  windowSeconds: 10 * 60,
} as const;

// Deliberately far tighter than the user-facing limits above: there is exactly
// one legitimate admin, so a burst of attempts is credential stuffing rather
// than a real operator retrying a typo.
export const ADMIN_LOGIN_RATE_LIMIT = {
  scope: 'admin:login',
  limit: 8,
  windowSeconds: 15 * 60,
} as const;

// Money-touching and bounded by how fast a human can review a case. A burst
// here means a stuck retry loop or a compromised session, not support work.
export const ADMIN_CREDIT_ADJUSTMENT_RATE_LIMIT = {
  scope: 'admin:credit-adjustment',
  limit: 30,
  windowSeconds: 10 * 60,
} as const;

// Destructive and irreversible at the `take_down` end, and bounded by how fast
// a human can actually review a post. A burst means a stuck retry loop or a
// compromised session, not moderation work.
export const ADMIN_POST_MODERATION_RATE_LIMIT = {
  scope: 'admin:post-moderation',
  limit: 30,
  windowSeconds: 10 * 60,
} as const;

export const POST_RESOURCE_FREE_UNLOCK_RATE_LIMIT = {
  scope: 'post-resource-free-unlock:open',
  limit: 60,
  windowSeconds: 10 * 60,
} as const;

export const CREDIT_UNLOCK_RATE_LIMIT = {
  scope: 'credit-unlock:spend',
  limit: 20,
  windowSeconds: 10 * 60,
} as const;

export const MOBILE_COMMERCE_SYNC_RATE_LIMIT = {
  scope: 'mobile-commerce:sync',
  limit: 12,
  windowSeconds: 10 * 60,
} as const;

export const MOBILE_COMMERCE_RESTORE_RATE_LIMIT = {
  scope: 'mobile-commerce:restore',
  limit: 6,
  windowSeconds: 10 * 60,
} as const;

export const ACCOUNT_DELETION_RATE_LIMIT = {
  scope: 'account:delete',
  limit: 3,
  windowSeconds: 60 * 60,
} as const;

export const ONBOARDING_STATE_RATE_LIMIT = {
  scope: 'onboarding:state',
  limit: 120,
  windowSeconds: 10 * 60,
} as const;

export const ONBOARDING_EVENT_RATE_LIMIT = {
  scope: 'onboarding:event',
  limit: 300,
  windowSeconds: 10 * 60,
} as const;

/**
 * Sampled media-failure reports from the mobile app. A client sends at most a
 * few per session, so this only has to stop a broken or hostile sender, not
 * shape normal traffic.
 */
export const MOBILE_MEDIA_DIAGNOSTICS_RATE_LIMIT = {
  scope: 'mobile:media-diagnostics',
  limit: 30,
  windowSeconds: 10 * 60,
} as const;

/**
 * Anonymous playback-metric reports: an app sends at most a dozen per session
 * and normally one or two, so this only caps a misbehaving client.
 */
export const MOBILE_PLAYBACK_METRICS_RATE_LIMIT = {
  scope: 'mobile:playback-metrics',
  limit: 30,
  windowSeconds: 10 * 60,
} as const;

export const WELCOME_CREDIT_CLAIM_RATE_LIMIT = {
  scope: 'credits:welcome-claim',
  limit: 20,
  windowSeconds: 10 * 60,
} as const;

// Keyed on the registering account, not the guest, so a caller cannot reset the
// window by minting a fresh anonymous session. A real user merges once; the
// headroom is for retries after a flaky sign-in.
export const ACCOUNT_MERGE_RATE_LIMIT = {
  scope: 'account:merge-guest',
  limit: 10,
  windowSeconds: 10 * 60,
} as const;

export const MOBILE_PUSH_TOKEN_REGISTER_RATE_LIMIT = {
  scope: 'mobile-push-token:register',
  limit: 20,
  windowSeconds: 10 * 60,
} as const;

export const MOBILE_PUSH_TOKEN_UNREGISTER_RATE_LIMIT = {
  scope: 'mobile-push-token:unregister',
  limit: 20,
  windowSeconds: 10 * 60,
} as const;

export const MOBILE_NOTIFICATION_PREFERENCES_UPDATE_RATE_LIMIT = {
  scope: 'mobile-notification-preferences:update',
  limit: 30,
  windowSeconds: 10 * 60,
} as const;

export const MOBILE_NOTIFICATION_READ_RATE_LIMIT = {
  scope: 'mobile-notifications:read',
  limit: 120,
  windowSeconds: 10 * 60,
} as const;

export const MOBILE_NOTIFICATION_READ_ALL_RATE_LIMIT = {
  scope: 'mobile-notifications:read-all',
  limit: 30,
  windowSeconds: 10 * 60,
} as const;

export const SHOWCASE_PUBLISH_RATE_LIMIT = {
  scope: 'showcase:publish',
  limit: 20,
  windowSeconds: 10 * 60,
} as const;

/**
 * Public posts an agent may publish for one account per UTC day (owner, 2026-11-09, the MCP
 * server's phase 2), beside the publish route's own 20 per 10 minutes, which every publish still
 * passes through. Not enforced through `check_backend_rate_limit`, which counts attempts: the tool
 * counts the day's successful public publishes in `agent_tool_calls` before it publishes
 * (`countAgentPublicPublishesSince`), so a refused publish spends nothing and a private post is
 * not counted. The window is the UTC day, as the limiter's own windows are aligned.
 *
 * 60 since 2026-11-15 (owner: "make it 60 a day with 20 per 10 minute"); it was 10, a first
 * safety number that stopped a real batch of 18 posts at its tenth. What it is for has not
 * changed: an agent posts at machine speed, and the 20 per 10 minutes alone would let one
 * through with 2,880 public posts a day, each into the feed and the moderation queue.
 */
export const AGENT_PUBLISH_RATE_LIMIT = {
  scope: 'agent:publish-public',
  limit: 60,
  windowSeconds: 24 * 60 * 60,
} as const;

/**
 * `upload_input` calls per account (the MCP server): checked before any byte is fetched, so a
 * loop of large or failing downloads is counted and stopped, where the sign step's own limit
 * (`TEMPORARY_MEDIA_UPLOAD_SIGN_RATE_LIMIT`) would see only the downloads that reached it.
 */
export const AGENT_UPLOAD_INPUT_RATE_LIMIT = {
  scope: 'agent:upload-input',
  limit: 30,
  windowSeconds: 10 * 60,
} as const;

export const SHOWCASE_SHARE_RATE_LIMIT = {
  scope: 'showcase:share',
  limit: 120,
  windowSeconds: 10 * 60,
} as const;

export const PROFILE_SHARE_RATE_LIMIT = {
  scope: 'profile:share',
  limit: 120,
  windowSeconds: 10 * 60,
} as const;

export const SHOWCASE_SAVE_RATE_LIMIT = {
  scope: 'showcase:save',
  limit: 120,
  windowSeconds: 10 * 60,
} as const;

export const SHOWCASE_REMIX_RATE_LIMIT = {
  scope: 'showcase:remix',
  limit: 60,
  windowSeconds: 10 * 60,
} as const;

/**
 * Matched to SHOWCASE_REMIX_RATE_LIMIT on purpose: hydrating a remix is the
 * second half of starting one, so it should not be possible to pull sources
 * faster than remixes can be started. The read is the expensive half — a
 * service-role fetch plus a signed URL minted per restored asset.
 */
export const REMIX_SOURCE_RATE_LIMIT = {
  scope: 'remix-source:load',
  limit: 60,
  windowSeconds: 10 * 60,
} as const;

export const SHOWCASE_PREVIEW_READ_URL_RATE_LIMIT = {
  scope: 'showcase-preview:read-url',
  limit: 240,
  windowSeconds: 10 * 60,
} as const;

export const SHOWCASE_FEED_EVENT_RATE_LIMIT = {
  scope: 'showcase-feed:event',
  limit: 300,
  windowSeconds: 10 * 60,
} as const;

// Public admission happens before body parsing or authentication, so this key
// is necessarily network-scoped. Keep it deliberately coarser than the
// per-actor budget above: many legitimate signed-in viewers can share one NAT,
// while a single source still cannot make JSON parsing unbounded work.
export const SHOWCASE_FEED_EVENT_NETWORK_ADMISSION_RATE_LIMIT = {
  scope: 'showcase-feed:event-network-admission',
  limit: 3_000,
  windowSeconds: 10 * 60,
} as const;

// POST /api/showcase/views (post-views-route-adapter-service.ts), per account.
// A batch holds up to 25 views and an account adds at most one a post a day,
// so this bounds the work, not the count.
export const POST_VIEW_RATE_LIMIT = {
  scope: 'post-views:record',
  limit: 300,
  windowSeconds: 10 * 60,
} as const;

// The same route before parsing or authentication, keyed on the network, as
// the feed events' admission is: coarse, because many viewers share an
// address. A guest's views are held per network by the database as well (20
// guests a post a day).
export const POST_VIEW_NETWORK_ADMISSION_RATE_LIMIT = {
  scope: 'post-views:network-admission',
  limit: 3_000,
  windowSeconds: 10 * 60,
} as const;

export const SHOWCASE_FOR_YOU_FEED_READ_RATE_LIMIT = {
  scope: 'showcase-feed:for-you-read',
  limit: 60,
  windowSeconds: 10 * 60,
} as const;

/**
 * The read limits below are deliberately generous: they exist to stop a script,
 * not to shape normal browsing. Every one of these endpoints was previously
 * unthrottled while the mutation paths beside them were covered.
 *
 * Each admitted or rejected request costs a PostgreSQL write transaction. The
 * application deliberately accepts and measures that write budget instead of
 * depending on a second external datastore. CDN and response caching should
 * absorb cacheable traffic before it reaches these origin policies.
 */
export const SHOWCASE_FEED_READ_RATE_LIMIT = {
  scope: 'showcase-feed:read',
  limit: 240,
  windowSeconds: 10 * 60,
} as const;

export const PUBLIC_SEARCH_READ_RATE_LIMIT = {
  scope: 'public-search:read',
  limit: 180,
  windowSeconds: 10 * 60,
} as const;

// A result opened from a search (POST /api/search/opened): one write per press, counted on the
// key /api/search counts on. A person opens a handful of results a minute; this stops a script
// filling the log, at most 17,280 rows a day from one key.
export const SEARCH_OPENED_RATE_LIMIT = {
  scope: 'public-search:opened',
  limit: 120,
  windowSeconds: 10 * 60,
} as const;

// The same write for a guest session, counted against its network as well (review of #826): a
// guest's id is new with every anonymous sign-in, so its own key alone is no limit, and a script
// that minted sessions wrote 120 rows a session. Three guests' worth, as the search's embedding
// allows a network (SEARCH_QUERY_EMBEDDING_GUEST_NETWORK_DAILY_LIMIT): a home or an office behind
// one address is not stopped by one phone. A registered account is counted by its own key only.
export const SEARCH_OPENED_GUEST_NETWORK_RATE_LIMIT = {
  scope: 'public-search:opened-guest-network',
  limit: 360,
  windowSeconds: 10 * 60,
} as const;

export const SHOWCASE_POST_DETAIL_READ_RATE_LIMIT = {
  scope: 'showcase-post:read',
  limit: 300,
  windowSeconds: 10 * 60,
} as const;

// A post's remixes list, opened from its remix count: a page at a time.
export const SHOWCASE_POST_REMIXES_READ_RATE_LIMIT = {
  scope: 'showcase-post-remixes:read',
  limit: 120,
  windowSeconds: 10 * 60,
} as const;

// The app reads the shelf once per visit to Home and on a pull to refresh.
export const HOME_SHELF_READ_RATE_LIMIT = {
  scope: 'home-shelf:read',
  limit: 120,
  windowSeconds: 10 * 60,
} as const;

export const POST_COMMENTS_READ_RATE_LIMIT = {
  scope: 'post-comments:read',
  limit: 300,
  windowSeconds: 10 * 60,
} as const;

/**
 * Higher than its siblings because the studio polls this every 30 seconds
 * while a generation is running — 20 polls per 10 minutes per open tab.
 */
export const OWNER_GENERATIONS_READ_RATE_LIMIT = {
  scope: 'owner-generations:read',
  limit: 400,
  windowSeconds: 10 * 60,
} as const;

export const CREATOR_PROFILE_READ_RATE_LIMIT = {
  scope: 'creator-profile:read',
  limit: 300,
  windowSeconds: 10 * 60,
} as const;

export const POST_RESOURCE_FILE_UPLOAD_RATE_LIMIT = {
  scope: 'post-resource-file:upload',
  limit: 30,
  windowSeconds: 10 * 60,
} as const;

export const POST_RESOURCE_FILE_READ_URL_RATE_LIMIT = {
  scope: 'post-resource-file:read-url',
  limit: 120,
  windowSeconds: 10 * 60,
} as const;

export const MEDIA_READ_SIGN_RATE_LIMIT = {
  scope: 'media-read:sign',
  limit: 300,
  windowSeconds: 10 * 60,
} as const;

export const GENERATION_MODEL_QUOTE_RATE_LIMIT = {
  scope: 'generation-model:quote',
  limit: 240,
  windowSeconds: 10 * 60,
} as const;

/**
 * The creators' price lists (`/api/generation-models/quotes`): one request prices a
 * model list or a settings panel, so it is counted apart from the single quote's 240,
 * which the price on Generate keeps to itself.
 */
export const GENERATION_MODEL_QUOTE_BATCH_RATE_LIMIT = {
  scope: 'generation-model:quote-batch',
  limit: 120,
  windowSeconds: 10 * 60,
} as const;

export const TEMPORARY_MEDIA_UPLOAD_SIGN_RATE_LIMIT = {
  scope: 'temporary-media-upload:sign',
  limit: 60,
  windowSeconds: 10 * 60,
} as const;

// One finalization is expected per signed upload, with enough headroom for
// idempotent client retries across every upload surface.
export const UPLOAD_FINALIZE_RATE_LIMIT = {
  scope: 'upload:finalize',
  limit: 120,
  windowSeconds: 10 * 60,
} as const;

export const TEMPORARY_MEDIA_UPLOAD_READ_URL_RATE_LIMIT = {
  scope: 'temporary-media-upload:read-url',
  limit: 120,
  windowSeconds: 10 * 60,
} as const;

export const WORKFLOW_ASSET_UPLOAD_SIGN_RATE_LIMIT = {
  scope: 'workflow-asset-upload:sign',
  limit: 40,
  windowSeconds: 10 * 60,
} as const;

export const WORKFLOW_ASSET_UPLOAD_READ_URL_RATE_LIMIT = {
  scope: 'workflow-asset-upload:read-url',
  limit: 80,
  windowSeconds: 10 * 60,
} as const;

export const PROFILE_MEDIA_UPLOAD_SIGN_RATE_LIMIT = {
  scope: 'profile-media-upload:sign',
  limit: 30,
  windowSeconds: 10 * 60,
} as const;

export const PROFILE_MEDIA_UPLOAD_CLEANUP_RATE_LIMIT = {
  scope: 'profile-media-upload:cleanup',
  limit: 30,
  windowSeconds: 10 * 60,
} as const;

export const PROFILE_VALIDATE_RATE_LIMIT = {
  scope: 'profile:validate',
  limit: 120,
  windowSeconds: 10 * 60,
} as const;

export const PROFILE_UPDATE_RATE_LIMIT = {
  scope: 'profile:update',
  limit: 30,
  windowSeconds: 10 * 60,
} as const;

export const WORKFLOW_ASSISTANT_RATE_LIMIT = {
  scope: 'workflow-assistant',
  limit: 30,
  windowSeconds: 10 * 60,
} as const;

export const WORKFLOW_CANVAS_MUTATION_RATE_LIMIT = {
  scope: 'workflow-canvas:mutate',
  limit: 240,
  windowSeconds: 10 * 60,
} as const;

export const WORKFLOW_BLUEPRINT_RATE_LIMIT = {
  scope: 'workflow-blueprint',
  limit: 30,
  windowSeconds: 10 * 60,
} as const;

export const SEEDANCE_ASSET_RATE_LIMIT = {
  scope: 'seedance-assets:create',
  limit: 60,
  windowSeconds: 10 * 60,
} as const;

export const WORKFLOW_RUN_RATE_LIMIT = {
  scope: 'workflow-run:start',
  limit: 20,
  windowSeconds: 10 * 60,
} as const;

export class BackendRateLimitError extends Error {
  status = 429;
  retryAfterSeconds: number;
  state: BackendRateLimitState;

  constructor(state: BackendRateLimitState) {
    super('Too many requests. Please wait before trying again.');
    this.name = 'BackendRateLimitError';
    this.retryAfterSeconds = state.retryAfterSeconds;
    this.state = state;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeRateLimitState(value: unknown): BackendRateLimitState {
  if (!isRecord(value)) {
    throw new Error('Rate limit response was invalid');
  }

  return {
    allowed: value.allowed === true,
    limit: Number(value.limit ?? 0),
    remaining: Math.max(0, Number(value.remaining ?? 0)),
    retryAfterSeconds: Math.max(0, Number(value.retryAfterSeconds ?? 0)),
    resetAt: typeof value.resetAt === 'string' ? value.resetAt : new Date().toISOString(),
  };
}

export async function enforceBackendRateLimit(
  client: SupabaseRpcClient,
  options: BackendRateLimitOptions,
): Promise<BackendRateLimitState> {
  if (!options.scope.trim()) throw new Error('Rate limit scope is required');
  if (!options.key.trim()) throw new Error('Rate limit key is required');
  if (!Number.isInteger(options.limit) || options.limit < 1) throw new Error('Rate limit must be a positive integer');
  if (!Number.isInteger(options.windowSeconds) || options.windowSeconds < 1) {
    throw new Error('Rate limit window must be a positive integer');
  }

  const result = await client.rpc('check_backend_rate_limit', {
    p_scope: options.scope,
    p_subject_key: options.key,
    p_limit: options.limit,
    p_window_seconds: options.windowSeconds,
  });

  if (result.error) throw result.error;

  const state = normalizeRateLimitState(result.data);
  if (!state.allowed) {
    throw new BackendRateLimitError(state);
  }

  return state;
}

/**
 * Give back one count `enforceBackendRateLimit` made, in the window it was made in (the state's
 * `resetAt` less the window), so a count made just before a window turned never comes out of the
 * next one. For a request counted before it was admitted and then refused
 * (`showcase-feed-route-adapter-service.ts`). True when a count was given back; false when that
 * window had none left to give. Never takes a count below zero.
 */
export async function refundBackendRateLimit(
  client: SupabaseRpcClient,
  options: { scope: string; key: string; windowSeconds: number; resetAt: string },
): Promise<boolean> {
  if (!options.scope.trim()) throw new Error('Rate limit scope is required');
  if (!options.key.trim()) throw new Error('Rate limit key is required');
  if (!Number.isInteger(options.windowSeconds) || options.windowSeconds < 1) {
    throw new Error('Rate limit window must be a positive integer');
  }
  const resetAtMs = Date.parse(options.resetAt);
  if (!Number.isFinite(resetAtMs)) throw new Error('Rate limit reset time is required');

  const result = await client.rpc('refund_backend_rate_limit', {
    p_scope: options.scope,
    p_subject_key: options.key,
    p_window_start: new Date(resetAtMs - options.windowSeconds * 1000).toISOString(),
  });
  if (result.error) throw result.error;
  return result.data === true;
}

export function createBackendRateLimitResponse(error: BackendRateLimitError) {
  return NextResponse.json({
    error: error.message,
    code: 'RATE_LIMITED',
    retryAfterSeconds: error.retryAfterSeconds,
    limit: error.state.limit,
    resetAt: error.state.resetAt,
  }, {
    status: error.status,
    headers: {
      'Retry-After': String(error.retryAfterSeconds),
      'X-RateLimit-Limit': String(error.state.limit),
      'X-RateLimit-Remaining': String(error.state.remaining),
      'X-RateLimit-Reset': error.state.resetAt,
    },
  });
}
