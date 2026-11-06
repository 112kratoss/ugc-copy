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
  /**
   * The free or paid terms the creation carries as a remix (`remix_recipe_mode`,
   * 20261105123244). Required, so a caller cannot leave it out and have a
   * version of a paid recipe read as free.
   */
  remix_recipe_mode: string | null;
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
  /** The post's own "Allow remixes" (owner, 2026-11-05); null on a read from before the column. */
  remixes_allowed?: boolean | null;
};

/**
 * The recipe on the creation's post as the gate read it, whatever its state: what restoring the
 * copies a buyer holds reads on from (`loadGenerationRecipeReferenceCopies`), so nothing read here is
 * read again. Only a published recipe gates the Remix, so only of one is the viewer's purchase asked.
 */
export type RemixAccessRecipe = {
  id: string;
  ownerUserId: string | null;
  published: boolean;
  /** Whether the viewer bought it: read for a published recipe; null for any other, which it did not ask. */
  viewerHasPurchased: boolean | null;
};

export type RemixAccessDecision =
  | {
      allowed: true;
      basis: 'owner';
      post: null;
      includeSharedInputMedia: true;
      recipeEntitled: false;
      recipe: null;
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
      /** The post's recipe, published or retired, or null for a post without one. */
      recipe: RemixAccessRecipe | null;
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

/**
 * What the gate is asked for. `remix` (the default): a new remix of the creation, which the remix
 * entry points ask (`/api/remix-source`, `POST /api/showcase/remix`, a start's remix credit in
 * `source-generation.ts`). `reuse`: a run's use of a file the viewer already holds through the
 * creation's post (a recipe's copy they bought, the creator's shared input, the result a remix
 * handed them), which the run start's imports and the Seedance prepare ask. A reuse is no new
 * remix, so neither the post's "Allow remixes" (owner, 2026-11-05: off stops new remixes only, and
 * the files a buyer got stay usable in their own runs) nor a block (owner, 2026-11-06: a block ends
 * what the other person can see or buy, not what they bought) refuses it. Everything else is asked
 * as for a remix: the post still showing the creation, no recipe locked to the viewer, no template's
 * result.
 */
export type RemixAccessPurpose = 'remix' | 'reuse';

const REMIX_POST_SELECT =
  'id, user_id, generation_id, category, post_format, source_kind, visibility, archived_at, review_status, remixes_allowed';

const NOT_FOUND = { allowed: false, reason: 'not_found' } as const;
const TEMPLATE_RESULT = { allowed: false, reason: 'template_result' } as const;

type RemixBundleRow = {
  id: string;
  owner_user_id: string | null;
  status: string | null;
  allow_remix: boolean | null;
  access_mode: string | null;
  retired_at: string | null;
};

async function loadPostBundle(
  adminSupabase: SupabaseClient,
  postId: string,
): Promise<RemixBundleRow | null> {
  const { data, error } = await adminSupabase
    .from('post_resource_bundles')
    .select('id, owner_user_id, status, allow_remix, access_mode, retired_at')
    .eq('post_id', postId)
    .maybeSingle();

  if (error) {
    if (isMissingPostResourceBundlesSchemaError(error)) return null;
    throw error;
  }

  return data as RemixBundleRow | null;
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
 *   creation's prompt as well as the items attached to it, so a viewer who has
 *   not unlocked it gets `unlock_required`. (Its settings are no secret: the
 *   post shows them to everyone since 2026-11-03.) A free recipe is
 *   claimed by the Remix tap itself, on the clients. The creation's inputs are
 *   another matter: they go to someone who unlocked it (`recipeEntitled`) only
 *   where the creator's stored switch offered them, as before.
 * - Its creator's "Allow remixes" off (`posts.remixes_allowed`, owner
 *   2026-11-05) closes new remixes of the post to everyone but its creator.
 *   A `reuse` (`RemixAccessPurpose`) asks neither that switch nor the block.
 *
 * It does not ask whether the viewer is a guest, whom Remix serves only its own
 * creations: every caller refuses a guest anyone else's itself, before asking
 * here (`/api/remix-source`, the proxy for `/api/showcase/remix`, the shared
 * input import and the start's remix credit in `source-generation.ts`).
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
  purpose = 'remix',
  dependencies,
}: {
  adminSupabase: SupabaseClient;
  viewerUserId: string;
  generation: RemixAccessGeneration;
  /** The post the caller came from. It must be the generation's own post. */
  requestedPostId?: string | null;
  /** A new remix (the default), or a run's reuse of a file the viewer holds (`RemixAccessPurpose`). */
  purpose?: RemixAccessPurpose;
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
      recipe: null,
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

  // A block ends new remixes, and a reuse of what the viewer already holds is none (owner,
  // 2026-11-06), so a reuse does not ask.
  if (purpose === 'remix') {
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
  }

  const postBundle = await loadPostBundle(adminSupabase, post.id);
  // Only a published recipe gates someone who has not bought it. That is the
  // predicate getPostResourceBundleDetailByPostId applies before the post
  // surface reports `unlock_required`, so the two cannot disagree.
  const bundle = postBundle?.status === 'published' ? postBundle : null;
  // A paid recipe guards the creation's prompt only while it is live (owner,
  // 2026-11-05: paid stays paid). One still a draft on a public post, short of
  // the listing rules, gated nothing and handed the prompt to anyone, so such a
  // post has no Remix until its recipe goes out. A paid recipe its creator took
  // down after people bought it (retired) is their choice to stop selling, as
  // no recipe is. And a version of someone's paid recipe is remixed only through
  // a paid recipe live on its post, never as an open post.
  const paidRecipeNotLive = postBundle?.access_mode === 'paid'
    && postBundle.status !== 'published'
    && postBundle.status !== 'retired'
    && !postBundle.retired_at;
  const paidVersionWithoutLivePaidRecipe = generation.remix_recipe_mode === 'paid'
    && bundle?.access_mode !== 'paid';
  if (paidRecipeNotLive || paidVersionWithoutLivePaidRecipe) {
    return NOT_FOUND;
  }
  const viewerHasPurchased = bundle
    ? await hasPurchasedBundle(adminSupabase, bundle.id, viewerUserId)
    : false;

  // Its creator's "Allow remixes" (owner, 2026-11-05) closes new remixes of this post to everyone
  // but its creator, who restores their own as the owner above; its recipe can still be claimed or
  // bought, and what a buyer got stays usable in their own runs: a reuse is not asked it. A remix of
  // a remix keeps its own post's switch.
  const { capability } = resolvePostRemixCapability({
    generationId: post.generation_id,
    postFormat: post.post_format,
    category: post.category,
    sourceKind: post.source_kind,
    remixesAllowed: purpose === 'remix' ? post.remixes_allowed : null,
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
    recipe: postBundle
      ? {
          id: postBundle.id,
          ownerUserId: postBundle.owner_user_id,
          published: bundle !== null,
          viewerHasPurchased: bundle ? viewerHasPurchased : null,
        }
      : null,
  };
}
