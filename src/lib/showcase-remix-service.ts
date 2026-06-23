import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

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
    notifyPostSocialActivity: dependencies?.notifyPostSocialActivity ?? notifyPostSocialActivity,
  };
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
    console.error('Error incrementing remix count:', rpcError);
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
