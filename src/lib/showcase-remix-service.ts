import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import type { SupabaseClient } from '@supabase/supabase-js';

import { sanitizeWorkflowSettingsForRemix } from '@/lib/generation-input-media';
import { isAudioModel } from '@/lib/models';
import {
  REMIX_UNLOCK_REQUIRED_CODE,
  REMIX_UNLOCK_REQUIRED_MESSAGE,
  resolveRemixAccess,
} from '@/lib/remix-access';
import { remixCreatePathForCategory } from '@/lib/remix-tools';
import { isUserRelationshipBlocked } from '@/lib/moderation-service';
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
      status: 400 | 403 | 404;
      body: {
        error: string;
        code?: string;
      };
    };

function resolveDependencies(
  dependencies: Partial<ShowcaseRemixServiceDependencies> | undefined,
): ShowcaseRemixServiceDependencies {
  return {
    findPublicPostReferenceByIdOrGenerationId:
      dependencies?.findPublicPostReferenceByIdOrGenerationId ?? findPublicPostReferenceByIdOrGenerationId,
    isUserRelationshipBlocked: dependencies?.isUserRelationshipBlocked ?? isUserRelationshipBlocked,
  };
}

function linkedGenerationNotFound(): ShowcaseRemixServiceResult {
  return {
    ok: false,
    status: 404,
    body: { error: 'Linked generation not found' },
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
  // this read must be service-role. The access decision therefore lives in
  // resolveRemixAccess, not in RLS, and it is the same gate /api/remix-source
  // applies: the owner, or anyone else while the post is exposed and any
  // remix-enabled recipe on it is unlocked.
  const { data: generation, error: generationError } = await serviceClient
    .from('generations')
    .select('id, user_id, is_public, share_input_media_for_remix, category, model, prompt, workflow_settings')
    .eq('id', post.generation_id)
    .maybeSingle();

  const generationRow = generation as GenerationRow | null;
  if (generationError || !generationRow?.id) {
    if (generationError) {
      logBackendError('failed_to_load_linked_generation_for_remix', { error: generationError });
    }
    return linkedGenerationNotFound();
  }

  const access = await resolveRemixAccess({
    adminSupabase: serviceClient,
    viewerUserId: actorUserId,
    generation: {
      id: generationRow.id,
      user_id: generationRow.user_id ?? null,
      is_public: generationRow.is_public ?? null,
      share_input_media_for_remix: generationRow.share_input_media_for_remix ?? null,
    },
    requestedPostId: post.id,
    dependencies: { isUserRelationshipBlocked: resolvedDependencies.isUserRelationshipBlocked },
  });
  if (!access.allowed) {
    return access.reason === 'unlock_required'
      ? {
          ok: false,
          status: 403,
          body: { error: REMIX_UNLOCK_REQUIRED_MESSAGE, code: REMIX_UNLOCK_REQUIRED_CODE },
        }
      : linkedGenerationNotFound();
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

  // Opening an editor is not a completed remix. The generation completion
  // ledger counts successful outputs and settlement sends the notification.
  const redirectPath = remixCreatePathForCategory(generationRow.category ?? post.category);
  const rawSettings =
    generationRow.workflow_settings && typeof generationRow.workflow_settings === 'object'
      ? generationRow.workflow_settings as Record<string, unknown>
      : {};
  const includeInputMedia = access.basis === 'owner' || access.includeSharedInputMedia;

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
