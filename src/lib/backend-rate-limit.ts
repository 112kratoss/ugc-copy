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

export const CREATOR_FOLLOW_NOTIFICATION_RATE_LIMIT = {
  scope: 'creator-follow:notify',
  limit: 30,
  windowSeconds: 10 * 60,
} as const;

export const CREATOR_FOLLOW_MUTATION_RATE_LIMIT = {
  scope: 'creator-follow:mutate',
  limit: 60,
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

export const SHOWCASE_POST_DETAIL_READ_RATE_LIMIT = {
  scope: 'showcase-post:read',
  limit: 300,
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
