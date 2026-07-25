import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import type { SupabaseClient } from '@supabase/supabase-js';

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

function getRedirectPathForCategory(category: string | null | undefined): string {
  switch (category) {
    case 'image':
      return '/create-image';
    case 'video':
    case 'ugc-ad':
      return '/create-video';
    case 'motion':
      return '/create-motion';
    default:
      return '/create';
  }
}

export async function remixShowcasePostForRoute({
  actorUserId,
  dependencies,
  referenceId,
  serviceClient,
  userClient,
}: {
  actorUserId: string;
  dependencies?: Partial<ShowcaseRemixServiceDependencies>;
  referenceId: string;
  serviceClient: SupabaseClient;
  userClient: SupabaseClient;
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

  const redirectPath = getRedirectPathForCategory(post.category);

  if (!post.generation_id) {
    return {
      ok: false,
      status: 400,
      body: { error: 'Only generation-backed posts can be remixed' },
    };
  }

  const { error: rpcError } = await serviceClient.rpc('increment_post_remix_count', {
    p_post_id: post.id,
  });

  if (rpcError) {
    logBackendError('error_incrementing_remix_count', { error: rpcError });
  }

  const { data: generation, error: generationError } = await userClient
    .from('generations')
    .select('id, prompt, workflow_settings')
    .eq('id', post.generation_id)
    .single();

  const generationRow = generation as GenerationRow | null;
  if (generationError || !generationRow?.id) {
    return {
      ok: false,
      status: 404,
      body: { error: 'Linked generation not found' },
    };
  }

  await resolvedDependencies.notifyPostSocialActivity(serviceClient, {
    type: 'post_remixed',
    recipientUserId: post.user_id,
    actorUserId,
    postId: post.id,
  });

  return {
    ok: true,
    body: {
      success: true,
      redirectTo: `${redirectPath}?remix=${generationRow.id}&remixPost=${post.id}`,
      prefill: {
        prompt: generationRow.prompt || '',
        settings: generationRow.workflow_settings || {},
      },
    },
  };
}
