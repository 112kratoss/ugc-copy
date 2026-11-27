import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import { createHash, randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  BackendRateLimitError,
  POST_MUTATION_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import {
  preparePostCreationSubmission,
  type PostCreationSubmissionResult,
} from '@/lib/post-creation-submission-service';
import {
  publishPreparedPost,
  type PostPublishResult,
} from '@/lib/post-publish-service';
import {
  listSourceToolsCatalog,
} from '@/lib/source-tools-server';
import type { SourceToolOption } from '@/lib/source-tools';
import type { ShowcaseVisibility } from '@/lib/showcase';
import type { PostResourceBundleStatus } from '@/lib/post-resource-bundles';

/**
 * A post an `Idempotency-Key` already names, as far as a repeated create needs it (audit
 * 2026-11-27, finding 4; `createPost.idempotency` in `contracts/mobile-api-v1.json`).
 */
export type ExistingPostForCreate = {
  userId: string;
  visibility: ShowcaseVisibility;
  postFormat: string | null;
  createdAt: string | null;
  tombstoned: boolean;
  mediaCount: number;
  bundleStatus: PostResourceBundleStatus | null;
};

type ExistingPostRead = { ok: true; post: ExistingPostForCreate | null } | { ok: false };

type CreateOwnerPostDependencies = {
  listSourceToolsCatalog?: () => Promise<SourceToolOption[]>;
  preparePostCreationSubmission?: typeof preparePostCreationSubmission;
  publishPreparedPost?: typeof publishPreparedPost;
  readExistingPostForCreate?: (adminSupabase: SupabaseClient, postId: string) => Promise<ExistingPostRead>;
};

const IDEMPOTENCY_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The composer's key, when the header holds a UUID; anything else is no key, and creates as before. */
export function readPostCreateIdempotencyKey(value: string | null | undefined): string | null {
  const key = value?.trim().toLowerCase() ?? '';
  return IDEMPOTENCY_KEY_PATTERN.test(key) ? key : null;
}

const CREATE_KEY_POST_ID_NAMESPACE = 'magicbooklet:composer-create-post:v1';

/**
 * The id of the post this account creates under this key. Never the key itself: a client-chosen
 * id could take a generation's id (which `/showcase/<id>` falls back to) or a deleted post's, whose
 * old links and alerts would then open the new post. Derived as the MCP path derives its ids
 * (`agentUploadPostId`): a SHA-256 of the parts, marked version 4 with RFC 4122's variant, the
 * form account deletion's path pattern takes.
 */
export function postIdForCreateKey(userId: string, key: string): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([CREATE_KEY_POST_ID_NAMESPACE, userId.trim().toLowerCase(), key.trim().toLowerCase()]))
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * How long a claim on a key stands for the request that took it: longer than `/api/posts` can run
 * (`maxDuration` 300 s). A claim older than this belongs to a request that died.
 */
export const POST_CREATE_CLAIM_WINDOW_MS = 330_000;

const IDEMPOTENT_CREATE_IN_PROGRESS = {
  ok: false as const,
  status: 409 as const,
  body: { error: 'This post is still being saved. Try again in a moment.', code: 'POST_CREATE_IN_PROGRESS' as const },
};
const IDEMPOTENT_CREATE_CONFLICT = {
  ok: false as const,
  status: 409 as const,
  body: { error: 'This post could not be saved. Try again.', code: 'IDEMPOTENCY_KEY_CONFLICT' as const },
};
/** What `publishPreparedPost` answers when the post was made but its promotion failed. */
const PROMOTION_FAILED = {
  ok: false as const,
  status: 500 as const,
  body: { error: 'Your post was saved as a private draft, but publishing failed. Open it from your posts to publish again.' },
};

export async function readExistingPostForCreate(
  adminSupabase: SupabaseClient,
  postId: string,
): Promise<ExistingPostRead> {
  const post = await adminSupabase
    .from('posts')
    .select('id, user_id, visibility, post_format, created_at, tombstoned_at')
    .eq('id', postId)
    .maybeSingle();
  if (post.error) return { ok: false };
  if (!post.data) return { ok: true, post: null };
  const row = post.data as {
    user_id: string;
    visibility: ShowcaseVisibility;
    post_format: string | null;
    created_at: string | null;
    tombstoned_at: string | null;
  };
  const [media, bundle] = await Promise.all([
    adminSupabase.from('post_media').select('id', { count: 'exact', head: true }).eq('post_id', postId),
    adminSupabase.from('post_resource_bundles').select('status').eq('post_id', postId).maybeSingle(),
  ]);
  if (media.error || typeof media.count !== 'number' || bundle.error) return { ok: false };
  return {
    ok: true,
    post: {
      userId: row.user_id,
      visibility: row.visibility,
      postFormat: row.post_format,
      createdAt: row.created_at,
      tombstoned: Boolean(row.tombstoned_at),
      mediaCount: media.count,
      bundleStatus: (bundle.data as { status?: PostResourceBundleStatus } | null)?.status ?? null,
    },
  };
}

type ClaimResult = { kind: 'claimed' } | { kind: 'held'; claimedAt: string | null } | { kind: 'error' };

/**
 * Takes the key for this request before anything is written (`post_create_claims`, primary key on
 * the account and the key). Only the request that inserted the claim runs the create, so two
 * requests with one key never copy media to the same paths or write the same post row.
 */
async function claimPostCreate(
  adminSupabase: SupabaseClient,
  claim: { userId: string; key: string; postId: string },
): Promise<ClaimResult> {
  const inserted = await adminSupabase.from('post_create_claims').insert({
    user_id: claim.userId,
    idempotency_key: claim.key,
    post_id: claim.postId,
  });
  if (!inserted.error) return { kind: 'claimed' };
  if ((inserted.error as { code?: unknown }).code !== '23505') return { kind: 'error' };
  const held = await adminSupabase
    .from('post_create_claims')
    .select('claimed_at')
    .eq('user_id', claim.userId)
    .eq('idempotency_key', claim.key)
    .maybeSingle();
  if (held.error) return { kind: 'held', claimedAt: null };
  return { kind: 'held', claimedAt: (held.data as { claimed_at?: string } | null)?.claimed_at ?? null };
}

/**
 * Gives the key back after an attempt that made nothing, so the client's retry of it can run. Only
 * the request that took the claim calls this, and only once no post row has the id: a draft a
 * failed promotion left is answered by the replay instead.
 */
async function releaseClaimIfNothingMade(
  adminSupabase: SupabaseClient,
  read: (adminSupabase: SupabaseClient, postId: string) => Promise<ExistingPostRead>,
  claim: { userId: string; key: string; postId: string },
) {
  try {
    const existing = await read(adminSupabase, claim.postId);
    if (!existing.ok || existing.post) return;
    await adminSupabase
      .from('post_create_claims')
      .delete()
      .eq('user_id', claim.userId)
      .eq('idempotency_key', claim.key);
  } catch (error) {
    // The claim stays; the key reads as in progress, then as used, and the client makes a new one.
    logBackendError('failed_to_release_post_create_claim', { error });
  }
}

function readRequestedVisibility(formData: FormData): ShowcaseVisibility {
  const value = formData.get('visibility');
  // As `preparePostCreationSubmission` reads it: private (or the retired unlisted), else public.
  return value === 'private' || value === 'unlisted' ? 'private' : 'public';
}

/**
 * What a create under a key whose post already exists answers. The account's own post is answered
 * as the create that made it answered (`publishPreparedPost`'s body). A post deleted since is
 * refused. A media post holding none of its files is still being saved by the request that made it
 * (the post's row comes before its media) or was left so by a create that failed midway. A private
 * post asked for as public is the draft a failed promotion left, and is answered with that failure
 * again: a request for public is never answered ok and private.
 */
function answerExistingPostForCreate(
  existing: ExistingPostForCreate,
  { postId, ownerUserId, now, requestedVisibility }: {
    postId: string;
    ownerUserId: string;
    now: number;
    requestedVisibility: ShowcaseVisibility;
  },
): CreateOwnerPostRouteResult {
  if (existing.userId !== ownerUserId || existing.tombstoned) return IDEMPOTENT_CREATE_CONFLICT;
  if (existing.mediaCount === 0 && existing.postFormat !== 'text') {
    const createdAt = existing.createdAt ? Date.parse(existing.createdAt) : Number.NaN;
    return Number.isFinite(createdAt) && now - createdAt < POST_CREATE_CLAIM_WINDOW_MS
      ? IDEMPOTENT_CREATE_IN_PROGRESS
      : IDEMPOTENT_CREATE_CONFLICT;
  }
  const isPrivate = existing.visibility === 'private';
  if (isPrivate && requestedVisibility !== 'private') return PROMOTION_FAILED;
  return {
    ok: true,
    body: {
      success: true,
      postId,
      visibility: existing.visibility,
      showcasePath: isPrivate ? null : `/showcase/${postId}`,
      ownerPath: `/post/${postId}/edit`,
      resourceBundlePath: existing.bundleStatus === 'draft' || isPrivate
        ? `/post/${postId}/edit#recipe`
        : `/showcase/${postId}#recipe`,
      resourceBundleStatus: existing.bundleStatus,
    },
  };
}

type PostCreationSubmissionFailure = Extract<PostCreationSubmissionResult, { ok: false }>;

type CreateOwnerPostRouteResult =
  | PostPublishResult
  | typeof IDEMPOTENT_CREATE_IN_PROGRESS
  | typeof IDEMPOTENT_CREATE_CONFLICT
  | typeof PROMOTION_FAILED
  | PostCreationSubmissionFailure
  | {
      ok: false;
      status: 429 | 500;
      body: {
        error: string;
        code?: 'RATE_LIMITED';
        retryAfterSeconds?: number;
        limit?: number;
        resetAt?: string;
      };
      rateLimitError?: BackendRateLimitError;
    };

function resolveDependencies(dependencies: CreateOwnerPostDependencies | undefined) {
  return {
    listSourceToolsCatalog: dependencies?.listSourceToolsCatalog ?? listSourceToolsCatalog,
    preparePostCreationSubmission: dependencies?.preparePostCreationSubmission ?? preparePostCreationSubmission,
    publishPreparedPost: dependencies?.publishPreparedPost ?? publishPreparedPost,
    readExistingPostForCreate: dependencies?.readExistingPostForCreate ?? readExistingPostForCreate,
  };
}

function createRateLimitResult(error: BackendRateLimitError): CreateOwnerPostRouteResult {
  return {
    ok: false,
    status: 429,
    rateLimitError: error,
    body: {
      error: error.message,
      code: 'RATE_LIMITED',
      retryAfterSeconds: error.retryAfterSeconds,
      limit: error.state.limit,
      resetAt: error.state.resetAt,
    },
  };
}

export async function createOwnerPostForRoute({
  adminSupabase,
  ownerUserId,
  readFormData,
  createPostId = randomUUID,
  idempotencyKey = null,
  now = Date.now,
  dependencies,
}: {
  adminSupabase: SupabaseClient;
  ownerUserId: string;
  readFormData: () => Promise<FormData>;
  createPostId?: () => string;
  /** The composer's key (`readPostCreateIdempotencyKey`): one create, and what a repeat is answered by. */
  idempotencyKey?: string | null;
  now?: () => number;
  dependencies?: CreateOwnerPostDependencies;
}): Promise<CreateOwnerPostRouteResult> {
  const resolvedDependencies = resolveDependencies(dependencies);
  let formRead: Promise<FormData> | null = null;
  const readFormOnce = () => {
    formRead ??= readFormData();
    return formRead;
  };

  if (!idempotencyKey) {
    const limited = await enforceCreateRateLimit(adminSupabase, ownerUserId);
    if (limited) return limited;
    return prepareAndPublish(adminSupabase, ownerUserId, createPostId(), readFormOnce, resolvedDependencies);
  }

  const claim = { userId: ownerUserId, key: idempotencyKey, postId: postIdForCreateKey(ownerUserId, idempotencyKey) };

  // 1. A repeat is answered from what is stored, before the rate limit: a replay spends no count.
  const existing = await resolvedDependencies.readExistingPostForCreate(adminSupabase, claim.postId);
  if (!existing.ok) {
    logBackendError('failed_to_read_post_for_idempotent_create', { postId: claim.postId });
    return { ok: false, status: 500, body: { error: 'Failed to create post.' } };
  }
  if (existing.post) {
    let requestedVisibility: ShowcaseVisibility = 'public';
    if (existing.post.visibility === 'private') {
      try {
        requestedVisibility = readRequestedVisibility(await readFormOnce());
      } catch {
        return { ok: false, status: 400, body: { error: 'Invalid post form data.' } };
      }
    }
    return answerExistingPostForCreate(existing.post, {
      postId: claim.postId,
      ownerUserId,
      now: now(),
      requestedVisibility,
    });
  }

  const limited = await enforceCreateRateLimit(adminSupabase, ownerUserId);
  if (limited) return limited;

  // 2. The claim, before any side effect: only the request that inserted it goes on.
  const claimed = await claimPostCreate(adminSupabase, claim);
  if (claimed.kind === 'error') {
    logBackendError('failed_to_claim_post_create', { postId: claim.postId });
    return { ok: false, status: 500, body: { error: 'Failed to create post.' } };
  }
  if (claimed.kind === 'held') {
    const claimedAt = claimed.claimedAt ? Date.parse(claimed.claimedAt) : Number.NaN;
    return Number.isFinite(claimedAt) && now() - claimedAt >= POST_CREATE_CLAIM_WINDOW_MS
      ? IDEMPOTENT_CREATE_CONFLICT
      : IDEMPOTENT_CREATE_IN_PROGRESS;
  }

  // 3. This request holds the key, and only it writes under this post id.
  let result: CreateOwnerPostRouteResult;
  try {
    result = await prepareAndPublish(adminSupabase, ownerUserId, claim.postId, readFormOnce, resolvedDependencies);
  } catch (error) {
    await releaseClaimIfNothingMade(adminSupabase, resolvedDependencies.readExistingPostForCreate, claim);
    throw error;
  }
  if (!result.ok) {
    await releaseClaimIfNothingMade(adminSupabase, resolvedDependencies.readExistingPostForCreate, claim);
  }
  return result;
}

async function enforceCreateRateLimit(
  adminSupabase: SupabaseClient,
  ownerUserId: string,
): Promise<CreateOwnerPostRouteResult | null> {
  try {
    await enforceBackendRateLimit(adminSupabase, {
      ...POST_MUTATION_RATE_LIMIT,
      key: ownerUserId,
    });
    return null;
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return createRateLimitResult(error);
    }

    logBackendError('failed_to_enforce_post_creation_rate_limit', { error: error });
    return {
      ok: false,
      status: 500,
      body: { error: 'Failed to create post.' },
    };
  }
}

async function prepareAndPublish(
  adminSupabase: SupabaseClient,
  ownerUserId: string,
  postId: string,
  readFormData: () => Promise<FormData>,
  resolvedDependencies: ReturnType<typeof resolveDependencies>,
): Promise<CreateOwnerPostRouteResult> {
  let formData: FormData;
  try {
    formData = await readFormData();
  } catch {
    return { ok: false, status: 400, body: { error: 'Invalid post form data.' } };
  }
  const sourceToolCatalog = await resolvedDependencies.listSourceToolsCatalog();
  const preparedSubmission = await resolvedDependencies.preparePostCreationSubmission({
    formData,
    userId: ownerUserId,
    sourceToolCatalog,
  });
  if (!preparedSubmission.ok) {
    return preparedSubmission;
  }

  return resolvedDependencies.publishPreparedPost({
    adminSupabase,
    ownerUserId,
    postId,
    submission: preparedSubmission.submission,
  });
}
