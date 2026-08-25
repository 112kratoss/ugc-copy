import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import type { SupabaseClient } from '@supabase/supabase-js';

import { sanitizeWorkflowSettingsForRemix } from '@/lib/generation-input-media';
import { isAudioModel } from '@/lib/models';
import { remixCreatePathForCategory } from '@/lib/remix-tools';
import { isUserRelationshipBlocked } from '@/lib/moderation-service';
import { notifyPostSocialActivity } from '@/lib/mobile-notifications';
import { findPublicPostReferenceByIdOrGenerationId } from '@/lib/posts-server';

type PostReference = {
  id: string;
  generation_id?: string | null;
  user_id?: string | null;
  category?: string | null;
};

type GenerationRow = {
  id?: string | null;
  user_id?: string | null;
  is_public?: boolean | null;
  share_input_media_for_remix?: boolean | null;
  category?: string | null;
  model?: string | null;
  prompt?: string | null;
  workflow_settings?: unknown;
};

export type ShowcaseRemixServiceDependencies = {
  findPublicPostReferenceByIdOrGenerationId: typeof findPublicPostReferenceByIdOrGenerationId;
  isUserRelationshipBlocked: typeof isUserRelationshipBlocked;
  notifyPostSocialActivity: typeof notifyPostSocialActivity;
};

export type ShowcaseRemixResponseBody = {
  success: true;
  redirectTo: string;
  prefill: {
    prompt: string;
    settings: unknown;
  };
};

export type ShowcaseRemixServiceResult =
  | {
      ok: true;
      body: ShowcaseRemixResponseBody;
    }
  | {
      ok: false;
      status: 400 | 404;
      body: {
        error: string;
      };
    };

function resolveDependencies(
  dependencies: Partial<ShowcaseRemixServiceDependencies> | undefined,
): ShowcaseRemixServiceDependencies {
  return {
    findPublicPostReferenceByIdOrGenerationId:
      dependencies?.findPublicPostReferenceByIdOrGenerationId ?? findPublicPostReferenceByIdOrGenerationId,
    isUserRelationshipBlocked: dependencies?.isUserRelationshipBlocked ?? isUserRelationshipBlocked,
    notifyPostSocialActivity: dependencies?.notifyPostSocialActivity ?? notifyPostSocialActivity,
  };
}

async function isPostInteractionUnavailable({
  actorUserId,
  creatorUserId,
  dependencies,
  serviceClient,
}: {
  actorUserId: string;
  creatorUserId: string | null | undefined;
  dependencies: ShowcaseRemixServiceDependencies;
  serviceClient: SupabaseClient;
}) {
  if (!creatorUserId || creatorUserId === actorUserId) return false;

  try {
    return await dependencies.isUserRelationshipBlocked({
      adminSupabase: serviceClient,
      firstUserId: actorUserId,
      secondUserId: creatorUserId,
    });
  } catch (error) {
    logBackendError('failed_to_verify_block_state_before_remixing_showcase_content', { error: error });
    return true;
  }
}

export async function remixShowcasePostForRoute({
  actorUserId,
  dependencies,
  referenceId,
  serviceClient,
}: {
  actorUserId: string;
  dependencies?: Partial<ShowcaseRemixServiceDependencies>;
  referenceId: string;
  serviceClient: SupabaseClient;
}): Promise<ShowcaseRemixServiceResult> {
  const resolvedDependencies = resolveDependencies(dependencies);
  const post = await resolvedDependencies.findPublicPostReferenceByIdOrGenerationId(
    referenceId,
    serviceClient,
  ) as PostReference | null;

  if (!post) {
    return {
      ok: false,
      status: 404,
      body: { error: 'Creation is private or not found' },
    };
  }
  if (await isPostInteractionUnavailable({
    actorUserId,
    creatorUserId: post.user_id,
    dependencies: resolvedDependencies,
    serviceClient,
  })) {
    return {
      ok: false,
      status: 404,
      body: { error: 'Creation is private or not found' },
    };
  }

  if (!post.generation_id) {
    return {
      ok: false,
      status: 400,
      body: { error: 'Only generation-backed posts can be remixed' },
    };
  }

  // Authenticated clients hold no read grant on prompt/workflow_settings, so
  // this read must be service-role. The access decision therefore lives in the
  // explicit gate below, not in RLS: the actor must own the generation, or the
  // generation must still be public and belong to the post's creator.
  const { data: generation, error: generationError } = await serviceClient
    .from('generations')
    .select('id, user_id, is_public, share_input_media_for_remix, category, model, prompt, workflow_settings')
    .eq('id', post.generation_id)
    .maybeSingle();

  const generationRow = generation as GenerationRow | null;
  const isOwner = Boolean(generationRow?.user_id && generationRow.user_id === actorUserId);
  const isPubliclyRemixable = Boolean(
    generationRow?.is_public === true
    && generationRow.user_id
    && generationRow.user_id === post.user_id,
  );
  if (generationError || !generationRow?.id || !(isOwner || isPubliclyRemixable)) {
    if (generationError) {
      logBackendError('failed_to_load_linked_generation_for_remix', { error: generationError });
    }
    return {
      ok: false,
      status: 404,
      body: { error: 'Linked generation not found' },
    };
  }

  // No create tool takes audio, and the prefill endpoint answers 400 for an
  // audio source. Refuse here, with a reason, rather than emitting a redirect
  // to the image tool for the viewer to discover it there. Publishing blocks
  // audio today (showcase-publish-service), so this guards against that gate
  // moving rather than a live path — and it refuses before the remix is
  // counted, so a refusal never inflates the creator's remix count.
  if (generationRow.category === 'audio' || isAudioModel(generationRow.model ?? '')) {
    return {
      ok: false,
      status: 400,
      body: { error: 'Audio creations cannot be remixed yet' },
    };
  }

  const { error: rpcError } = await serviceClient.rpc('increment_post_remix_count', {
    p_post_id: post.id,
  });

  if (rpcError) {
    logBackendError('error_incrementing_remix_count', { error: rpcError });
  }

  await resolvedDependencies.notifyPostSocialActivity(serviceClient, {
    type: 'post_remixed',
    recipientUserId: post.user_id,
    actorUserId,
    postId: post.id,
  });

  const redirectPath = remixCreatePathForCategory(generationRow.category ?? post.category);
  const rawSettings =
    generationRow.workflow_settings && typeof generationRow.workflow_settings === 'object'
      ? generationRow.workflow_settings as Record<string, unknown>
      : {};
  const includeInputMedia = isOwner
    || (isPubliclyRemixable && generationRow.share_input_media_for_remix === true);

  return {
    ok: true,
    body: {
      success: true,
      redirectTo: `${redirectPath}?remix=${generationRow.id}&remixPost=${post.id}`,
      prefill: {
        prompt: generationRow.prompt || '',
        settings: sanitizeWorkflowSettingsForRemix(rawSettings, includeInputMedia),
      },
    },
  };
}
