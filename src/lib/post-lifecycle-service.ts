import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  BackendRateLimitError,
  POST_MUTATION_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { logBackendError, logBackendWarning } from '@/lib/backend-logger';
import { removeQueuedPostMediaPublicCopies, syncPostMediaPublicCopies } from '@/lib/post-media-public-copies';
import {
  invalidateShowcaseFeedAndRefreshPostPages,
  invalidateShowcaseFeedCache,
} from '@/lib/showcase-feed-cache';

/** The public copies of a post's uploaded media (post-media-public-copies.ts); a test seam. */
export type PostLifecyclePublicCopies = {
  sync: typeof syncPostMediaPublicCopies;
  removeQueued: typeof removeQueuedPostMediaPublicCopies;
};

const defaultPublicCopies: PostLifecyclePublicCopies = {
  sync: syncPostMediaPublicCopies,
  removeQueued: removeQueuedPostMediaPublicCopies,
};

type ArchivedPostRow = {
  id: string;
  generation_id?: string | null;
};

type RestoredPostRow = {
  id: string;
  generation_id?: string | null;
  visibility?: 'public' | 'unlisted' | 'private' | null;
  showcase_asset_path?: string | null;
};

export type PostLifecycleResult =
  | {
    ok: true;
    body: {
      success: true;
      archived?: true;
      restored?: true;
    };
  }
  | {
    ok: false;
    status: 404 | 409 | 500;
    body: {
      error: string;
      code?: typeof POST_DELETED_CODE;
    };
  }
  | {
    ok: false;
    rateLimitError: BackendRateLimitError;
  };

export const POST_DELETED_CODE = 'POST_DELETED' as const;

/**
 * A post deleted while it had buyers is tombstoned (private + archived) and
 * kept only so they keep what they paid for. Restoring it would put it back on
 * show and editing it would rewrite it, so both answer this instead.
 */
export function createPostDeletedRefusal() {
  return {
    ok: false as const,
    status: 409 as const,
    body: {
      error: 'This post was deleted. Buyers keep their copy.',
      code: POST_DELETED_CODE,
    },
  };
}

async function enforcePostLifecycleRateLimit(adminSupabase: SupabaseClient, ownerUserId: string) {
  try {
    await enforceBackendRateLimit(adminSupabase, {
      ...POST_MUTATION_RATE_LIMIT,
      key: ownerUserId,
    });

    return null;
  } catch (error) {
    return error;
  }
}

export async function archiveOwnerPostForRoute({
  adminSupabase,
  now = () => new Date(),
  ownerUserId,
  postId,
  publicCopies = defaultPublicCopies,
}: {
  adminSupabase: SupabaseClient;
  now?: () => Date;
  ownerUserId: string;
  postId: string;
  publicCopies?: PostLifecyclePublicCopies;
}): Promise<PostLifecycleResult> {
  const rateLimitError = await enforcePostLifecycleRateLimit(adminSupabase, ownerUserId);
  if (rateLimitError) {
    if (rateLimitError instanceof BackendRateLimitError) {
      return { ok: false, rateLimitError };
    }

    return {
      ok: false,
      status: 500,
      body: { error: 'Failed to archive post.' },
    };
  }

  const { data, error } = await adminSupabase
    .from('posts')
    .update({
      archived_at: now().toISOString(),
      archived_by_user_id: ownerUserId,
    })
    .eq('id', postId)
    .eq('user_id', ownerUserId)
    .is('archived_at', null)
    .select('id, generation_id')
    .maybeSingle();
  const post = data as ArchivedPostRow | null;

  if (error) {
    return {
      ok: false,
      status: 500,
      body: { error: 'Failed to archive post.' },
    };
  }

  if (!post) {
    return {
      ok: false,
      status: 404,
      body: { error: 'Post not found.' },
    };
  }

  // A removal: every cached page that showed the post is dropped at once.
  invalidateShowcaseFeedCache();

  // The archive queued the public copies of its uploaded media in the same
  // statement; they go now, and the job retries any that fail.
  try {
    await publicCopies.removeQueued(adminSupabase, { postId: post.id });
  } catch (copyRemovalError) {
    logBackendError('failed_to_remove_public_post_media_after_archive', { error: copyRemovalError });
  }

  // Bundle exposure changes in the same transaction as the post. A separate
  // demotion here could overwrite a newer restore that committed while this
  // request was waiting for the archive response.

  // Setting archived_at took the linked generation off show in that same
  // statement: the posts trigger owns the generation's exposure. The post keeps
  // its showcase path, which is what restore puts back.

  return {
    ok: true,
    body: { success: true, archived: true },
  };
}

// Only read when the restore matched nothing: tells a deleted post from one
// that is missing, not the caller's, or not archived.
async function explainUnrestoredPost(
  adminSupabase: SupabaseClient,
  ownerUserId: string,
  postId: string,
): Promise<PostLifecycleResult> {
  const { data, error } = await adminSupabase
    .from('posts')
    .select('tombstoned_at')
    .eq('id', postId)
    .eq('user_id', ownerUserId)
    .maybeSingle();

  if (error) {
    return {
      ok: false,
      status: 500,
      body: { error: 'Failed to restore post.' },
    };
  }

  if ((data as { tombstoned_at?: string | null } | null)?.tombstoned_at) {
    return createPostDeletedRefusal();
  }

  return {
    ok: false,
    status: 404,
    body: { error: 'Post not found.' },
  };
}

export async function restoreOwnerPostForRoute({
  adminSupabase,
  ownerUserId,
  postId,
  publicCopies = defaultPublicCopies,
}: {
  adminSupabase: SupabaseClient;
  ownerUserId: string;
  postId: string;
  publicCopies?: PostLifecyclePublicCopies;
}): Promise<PostLifecycleResult> {
  const rateLimitError = await enforcePostLifecycleRateLimit(adminSupabase, ownerUserId);
  if (rateLimitError) {
    if (rateLimitError instanceof BackendRateLimitError) {
      return { ok: false, rateLimitError };
    }

    return {
      ok: false,
      status: 500,
      body: { error: 'Failed to restore post.' },
    };
  }

  // The tombstone guard sits in the update itself, so a delete committing while
  // this request waits can never be undone by it.
  const { data, error } = await adminSupabase
    .from('posts')
    .update({
      archived_at: null,
      archived_by_user_id: null,
    })
    .eq('id', postId)
    .eq('user_id', ownerUserId)
    .not('archived_at', 'is', null)
    .is('tombstoned_at', null)
    .select('id, generation_id, visibility, showcase_asset_path')
    .maybeSingle();
  const post = data as RestoredPostRow | null;

  if (error) {
    return {
      ok: false,
      status: 500,
      body: { error: 'Failed to restore post.' },
    };
  }

  if (!post) {
    return explainUnrestoredPost(adminSupabase, ownerUserId, postId);
  }

  // A public post back on show gets its uploaded media's public copies again
  // before its pages are refreshed, so they name them.
  if (post.visibility === 'public') {
    try {
      await publicCopies.sync(adminSupabase, post.id);
    } catch (copyError) {
      logBackendWarning('failed_to_copy_public_post_media', { error: copyError });
    }
  }

  // Nothing is removed: the post's pages are refreshed in the background, and
  // the not-found its page may hold since the archive is dropped at once
  // (a private post's page stays a not-found either way).
  await invalidateShowcaseFeedAndRefreshPostPages(adminSupabase, {
    postId: post.id,
    generationId: post.generation_id ?? null,
    creatorId: ownerUserId,
    arrived: post.visibility !== 'private',
  });

  // Clearing archived_at put the linked generation back on show in that same
  // statement, from the post's own visibility and the showcase path the post
  // kept, and re-promoted the recipe: the posts triggers own both.

  return {
    ok: true,
    body: { success: true, restored: true },
  };
}
