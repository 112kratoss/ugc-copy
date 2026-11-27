import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import { randomUUID } from 'node:crypto';
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
 * A post an `Idempotency-Key` already names, as far as a repeated create needs it. The key is the
 * post's id (audit 2026-11-27, finding 4; `createPost.idempotency` in
 * `contracts/mobile-api-v1.json`).
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

/**
 * Versions 1 to 5 with RFC 4122's variant: the ids account deletion reads a post's storage paths
 * by (`account-deletion-service.ts`), so a key that becomes a post id never strands an erasure.
 */
const IDEMPOTENCY_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The composer's key, when the header holds a UUID; anything else is no key, and creates as before. */
export function readPostCreateIdempotencyKey(value: string | null | undefined): string | null {
  const key = value?.trim().toLowerCase() ?? '';
  return IDEMPOTENCY_KEY_PATTERN.test(key) ? key : null;
}

/**
 * How long a media post's row may stand without its files while the create that made it is still
 * running: the route's own limit (`maxDuration` of `/api/posts`).
 */
export const POST_CREATE_IN_PROGRESS_WINDOW_MS = 300_000;

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

/**
 * What a create under a key some post already has answers. The account's own post is answered as
 * the create that made it answered (`publishPreparedPost`'s body); another account's, or one
 * deleted since, is refused without a word about it. A media post holding none of its files is
 * still being saved by the request that made it (the post's row comes before its media), or was
 * left so by a create that failed midway: never answered as made. The MCP publish path reads a
 * repeat the same way (`mcp-server-service.ts`).
 */
function answerExistingPostForCreate(
  existing: ExistingPostForCreate,
  { postId, ownerUserId, now }: { postId: string; ownerUserId: string; now: number },
): CreateOwnerPostRouteResult {
  if (existing.userId !== ownerUserId || existing.tombstoned) return IDEMPOTENT_CREATE_CONFLICT;
  if (existing.mediaCount === 0 && existing.postFormat !== 'text') {
    const createdAt = existing.createdAt ? Date.parse(existing.createdAt) : Number.NaN;
    return Number.isFinite(createdAt) && now - createdAt < POST_CREATE_IN_PROGRESS_WINDOW_MS
      ? IDEMPOTENT_CREATE_IN_PROGRESS
      : IDEMPOTENT_CREATE_CONFLICT;
  }
  const isPrivate = existing.visibility === 'private';
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
  /** The composer's key (`readPostCreateIdempotencyKey`): the new post's id, and a repeat's answer. */
  idempotencyKey?: string | null;
  now?: () => number;
  dependencies?: CreateOwnerPostDependencies;
}): Promise<CreateOwnerPostRouteResult> {
  try {
    await enforceBackendRateLimit(adminSupabase, {
      ...POST_MUTATION_RATE_LIMIT,
      key: ownerUserId,
    });
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

  const resolvedDependencies = resolveDependencies(dependencies);
  // Before the form is read: a repeat answers from what is stored, never from what it sends.
  if (idempotencyKey) {
    const existing = await resolvedDependencies.readExistingPostForCreate(adminSupabase, idempotencyKey);
    if (!existing.ok) {
      logBackendError('failed_to_read_post_for_idempotent_create', { postId: idempotencyKey });
      return { ok: false, status: 500, body: { error: 'Failed to create post.' } };
    }
    if (existing.post) {
      return answerExistingPostForCreate(existing.post, { postId: idempotencyKey, ownerUserId, now: now() });
    }
  }

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
    postId: idempotencyKey ?? createPostId(),
    submission: preparedSubmission.submission,
  });
}
