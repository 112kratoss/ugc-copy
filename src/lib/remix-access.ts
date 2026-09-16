import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { isOwnOrLinkedAccountId } from '@/lib/account-identity';
import { logBackendError } from '@/lib/backend-logger';
import { isUserRelationshipBlocked } from '@/lib/moderation-service';
import { resolvePostRemixCapability } from '@/lib/post-resource-bundles';
import { isMissingPostResourceBundlesSchemaError } from '@/lib/posts-server';

export const REMIX_UNLOCK_REQUIRED_CODE = 'REMIX_UNLOCK_REQUIRED';
export const REMIX_UNLOCK_REQUIRED_MESSAGE = 'Unlock this post to remix it.';

export type RemixAccessGeneration = {
  id: string;
  user_id: string | null;
  is_public: boolean | null;
  share_input_media_for_remix?: boolean | null;
};

export type RemixAccessPost = {
  id: string;
  user_id: string | null;
  generation_id: string | null;
  category: string | null;
  post_format: string | null;
  source_kind: string | null;
  visibility: string | null;
  archived_at: string | null;
  review_status: string | null;
};

export type RemixAccessDecision =
  | {
      allowed: true;
      basis: 'owner';
      post: null;
      includeSharedInputMedia: true;
      recipeEntitled: false;
    }
  | {
      allowed: true;
      basis: 'public' | 'unlocked';
      post: RemixAccessPost;
      /** The creator chose to hand their own input files to remixers. */
      includeSharedInputMedia: boolean;
      /** The viewer bought the recipe, so its reference media is theirs to restore. */
      recipeEntitled: boolean;
    }
  | {
      allowed: false;
      reason: 'not_found' | 'unlock_required';
    };

export type RemixAccessDependencies = {
  isOwnOrLinkedAccountId: typeof isOwnOrLinkedAccountId;
  isUserRelationshipBlocked: typeof isUserRelationshipBlocked;
};

const REMIX_POST_SELECT =
  'id, user_id, generation_id, category, post_format, source_kind, visibility, archived_at, review_status';

const NOT_FOUND = { allowed: false, reason: 'not_found' } as const;

type RemixBundleRow = {
  id: string;
  status: string | null;
  allow_remix: boolean | null;
};

async function loadPublishedBundle(
  adminSupabase: SupabaseClient,
  postId: string,
): Promise<RemixBundleRow | null> {
  const { data, error } = await adminSupabase
    .from('post_resource_bundles')
    .select('id, status, allow_remix')
    .eq('post_id', postId)
    .maybeSingle();

  if (error) {
    if (isMissingPostResourceBundlesSchemaError(error)) return null;
    throw error;
  }

  const row = data as RemixBundleRow | null;
  // Only a published recipe gates someone who has not bought it. That is the
  // predicate getPostResourceBundleDetailByPostId applies before the post
  // surface reports `unlock_required`, so the two cannot disagree.
  return row?.status === 'published' ? row : null;
}

async function hasPurchasedBundle(
  adminSupabase: SupabaseClient,
  bundleId: string,
  viewerUserId: string,
): Promise<boolean> {
  const { data, error } = await adminSupabase
    .from('post_resource_bundle_purchases')
    .select('id')
    .eq('bundle_id', bundleId)
    .eq('buyer_user_id', viewerUserId)
    .maybeSingle();

  if (error) {
    if (isMissingPostResourceBundlesSchemaError(error)) return false;
    throw error;
  }

  return Boolean(data);
}

/**
 * Whether a viewer may restore a generation's recipe — its prompt, its settings
 * and, where allowed, its input media — into their own editor.
 *
 * POST /api/showcase/remix and GET /api/remix-source both answer from here.
 * Each used to make its own call, and neither asked what the post surface asks,
 * so a viewer shown "unlock to remix" could read the recipe straight from
 * either endpoint.
 *
 * - The owner, or a guest identity since linked to them, always may.
 * - Anyone else needs the generation to be public and its post to be exposed
 *   right now: public, not archived, visible to moderation, and the creator's
 *   own. The generation flag alone is not trusted, because it is a copy of the
 *   post's state and a copy can lag behind the post.
 * - When a published recipe has remixing switched on (`allow_remix`), the
 *   unlock protects the original recipe as well as the files attached to it:
 *   a viewer who has not bought it gets `unlock_required`. A recipe that does
 *   not sell remixing leaves remixing public; its unlock covers only the
 *   attached resources.
 *
 * A read that fails throws instead of allowing. The routes turn that into a
 * 500, and a blocked-state check that fails counts as blocked.
 */
export async function resolveRemixAccess({
  adminSupabase,
  viewerUserId,
  generation,
  requestedPostId = null,
  dependencies,
}: {
  adminSupabase: SupabaseClient;
  viewerUserId: string;
  generation: RemixAccessGeneration;
  /** The post the caller came from. It must be the generation's own post. */
  requestedPostId?: string | null;
  dependencies?: Partial<RemixAccessDependencies>;
}): Promise<RemixAccessDecision> {
  const resolved: RemixAccessDependencies = {
    isOwnOrLinkedAccountId: dependencies?.isOwnOrLinkedAccountId ?? isOwnOrLinkedAccountId,
    isUserRelationshipBlocked: dependencies?.isUserRelationshipBlocked ?? isUserRelationshipBlocked,
  };

  if (await resolved.isOwnOrLinkedAccountId(adminSupabase, viewerUserId, generation.user_id)) {
    return {
      allowed: true,
      basis: 'owner',
      post: null,
      includeSharedInputMedia: true,
      recipeEntitled: false,
    };
  }

  const creatorUserId = generation.user_id;
  if (generation.is_public !== true || !creatorUserId) {
    return NOT_FOUND;
  }

  const { data: postData, error: postError } = await adminSupabase
    .from('posts')
    .select(REMIX_POST_SELECT)
    .eq('generation_id', generation.id)
    .maybeSingle();

  if (postError) {
    throw postError;
  }

  const post = postData as RemixAccessPost | null;
  if (
    !post
    || post.user_id !== creatorUserId
    || post.visibility !== 'public'
    || post.archived_at
    || post.review_status !== 'visible'
    || (requestedPostId && requestedPostId !== post.id)
  ) {
    return NOT_FOUND;
  }

  let blocked = true;
  try {
    blocked = await resolved.isUserRelationshipBlocked({
      adminSupabase,
      firstUserId: viewerUserId,
      secondUserId: creatorUserId,
    });
  } catch (error) {
    logBackendError('failed_to_verify_block_state_before_remix_access', { error });
  }
  if (blocked) {
    return NOT_FOUND;
  }

  const bundle = await loadPublishedBundle(adminSupabase, post.id);
  const viewerHasPurchased = bundle?.allow_remix === true
    ? await hasPurchasedBundle(adminSupabase, bundle.id, viewerUserId)
    : false;

  const { capability } = resolvePostRemixCapability({
    generationId: post.generation_id,
    postFormat: post.post_format,
    category: post.category,
    sourceKind: post.source_kind,
    resourceBundle: bundle
      ? { viewerCanAccess: viewerHasPurchased, allowRemix: bundle.allow_remix, items: [] }
      : null,
  });

  if (capability === 'unlock_required') {
    return { allowed: false, reason: 'unlock_required' };
  }
  if (capability !== 'public') {
    return NOT_FOUND;
  }

  const unlocked = bundle?.allow_remix === true && viewerHasPurchased;
  return {
    allowed: true,
    basis: unlocked ? 'unlocked' : 'public',
    post,
    includeSharedInputMedia: generation.share_input_media_for_remix === true,
    recipeEntitled: unlocked,
  };
}
