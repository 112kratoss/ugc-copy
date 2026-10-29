import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { isOwnOrLinkedAccountId } from '@/lib/account-identity';
import { logBackendError } from '@/lib/backend-logger';
import { isUserRelationshipBlocked } from '@/lib/moderation-service';
import { resolvePostRemixCapability } from '@/lib/post-resource-bundles';
import { isMissingPostResourceBundlesSchemaError } from '@/lib/posts-server';
import { isTemplateResultGeneration } from '@/lib/template-result';

export const REMIX_UNLOCK_REQUIRED_CODE = 'REMIX_UNLOCK_REQUIRED';
export const REMIX_UNLOCK_REQUIRED_MESSAGE = 'Unlock this post to remix it.';
export const TEMPLATE_RESULT_REMIX_CODE = 'TEMPLATE_RESULT_NOT_REMIXABLE';
export const TEMPLATE_RESULT_REMIX_MESSAGE = 'Template results cannot be remixed. Use the template again to make another.';

export type RemixAccessGeneration = {
  id: string;
  user_id: string | null;
  is_public: boolean | null;
  share_input_media_for_remix?: boolean | null;
  /**
   * The creation's run links (`template-result.ts`), read with it. Required, so
   * a caller cannot leave them out and have a template result read as ordinary.
   */
  template_run_id: string | null;
  template_run_step_id: string | null;
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
      /**
       * The viewer unlocked a recipe whose creator offered its inputs (the
       * stored `allow_remix`), so its reference media is theirs to restore.
       */
      recipeEntitled: boolean;
    }
  | {
      allowed: false;
      /** `template_result`: the owner's own template result, which nobody remixes. */
      reason: 'not_found' | 'unlock_required' | 'template_result';
    };

export type RemixAccessDependencies = {
  /** Asks only whether the viewer owns the generation, never the post check. */
  isOwnOrLinkedAccountId: typeof isOwnOrLinkedAccountId;
  isUserRelationshipBlocked: typeof isUserRelationshipBlocked;
};

const REMIX_POST_SELECT =
  'id, user_id, generation_id, category, post_format, source_kind, visibility, archived_at, review_status';

const NOT_FOUND = { allowed: false, reason: 'not_found' } as const;
const TEMPLATE_RESULT = { allowed: false, reason: 'template_result' } as const;

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
 * either endpoint. The generation start's copy of a creator's freely shared
 * inputs (`generation-input-media-import.ts`) asks here too.
 *
 * - Nobody may restore a template result (`template-result.ts`): its recipe
 *   and model are the template author's. Its owner is told why; anyone else
 *   gets the answer a private source gets, and its post offers no Remix.
 * - The owner, or a guest identity since linked to them, may restore anything else.
 * - Anyone else needs the generation to be public and its post to be exposed
 *   right now: public, not archived, visible to moderation, and the creator's
 *   own. The generation flag alone is not trusted, because it is a copy of the
 *   post's state and a copy can lag behind the post. A creation made as a
 *   guest is the creator's own too: publish files it under the account the
 *   guest was linked to, while the generation keeps the guest's id. The block
 *   check asks about that account, the one a viewer sees on the post.
 * - A published recipe on the post includes its Remix, free or paid, whatever
 *   its stored `allow_remix` says (2026-10-27): the unlock protects the
 *   creation's prompt and settings as well as the items attached to it, so a
 *   viewer who has not unlocked it gets `unlock_required`. A free recipe is
 *   claimed by the Remix tap itself, on the clients. The creation's inputs are
 *   another matter: they go to someone who unlocked it (`recipeEntitled`) only
 *   where the creator's stored switch offered them, as before.
 *
 * A read that fails throws instead of allowing. The routes turn that into a
 * 500, and a blocked-state check that fails counts as blocked. A generation
 * start asks here before crediting a remix (`source-generation.ts`), and counts
 * a failure as no remix rather than failing the run.
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

  const ownsGeneration = await resolved.isOwnOrLinkedAccountId(adminSupabase, viewerUserId, generation.user_id);
  if (isTemplateResultGeneration(generation)) {
    return ownsGeneration ? TEMPLATE_RESULT : NOT_FOUND;
  }

  if (ownsGeneration) {
    return {
      allowed: true,
      basis: 'owner',
      post: null,
      includeSharedInputMedia: true,
      recipeEntitled: false,
    };
  }

  if (generation.is_public !== true || !generation.user_id) {
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
    !post?.user_id
    || post.visibility !== 'public'
    || post.archived_at
    || post.review_status !== 'visible'
    || (requestedPostId && requestedPostId !== post.id)
  ) {
    return NOT_FOUND;
  }

  // The post must be the creator's: its owner made the generation under their
  // own id or as a guest since linked to them (an id match needs no read).
  // Asked directly, not through `dependencies`, which answer for the viewer.
  // A lookup that fails reads as not linked.
  const creatorUserId = post.user_id;
  if (!(await isOwnOrLinkedAccountId(adminSupabase, creatorUserId, generation.user_id))) {
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
  const viewerHasPurchased = bundle
    ? await hasPurchasedBundle(adminSupabase, bundle.id, viewerUserId)
    : false;

  const { capability } = resolvePostRemixCapability({
    generationId: post.generation_id,
    postFormat: post.post_format,
    category: post.category,
    sourceKind: post.source_kind,
    resourceBundle: bundle
      ? { viewerCanAccess: viewerHasPurchased, allowRemix: true, items: [] }
      : null,
  });

  if (capability === 'unlock_required') {
    return { allowed: false, reason: 'unlock_required' };
  }
  if (capability !== 'public') {
    return NOT_FOUND;
  }

  return {
    allowed: true,
    basis: viewerHasPurchased ? 'unlocked' : 'public',
    post,
    includeSharedInputMedia: generation.share_input_media_for_remix === true,
    // Only the creator's stored switch hands the creation's inputs to a buyer.
    recipeEntitled: viewerHasPurchased && bundle?.allow_remix === true,
  };
}
