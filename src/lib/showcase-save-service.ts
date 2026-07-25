import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  findPublicPostReferenceByIdOrGenerationId,
  isMissingPostsSchemaError,
} from '@/lib/posts-server';
import { isUserRelationshipBlocked } from '@/lib/moderation-service';
import { notifyPostSocialActivity } from '@/lib/mobile-notifications';

type SetPostSaveStateRow = {
  is_saved?: boolean | null;
  save_count?: number | null;
  changed?: boolean | null;
};

type PostSaveFallbackResult = {
  isSaved: boolean;
  saveCount: number;
  changed: boolean;
};

type PostSaveLookupRow = {
  id?: string | null;
};

type PostSaveCountRow = {
  save_count?: number | null;
};

type PostReference = {
  id: string;
  generation_id?: string | null;
  user_id?: string | null;
};

export type ShowcaseSaveServiceDependencies = {
  findPublicPostReferenceByIdOrGenerationId: typeof findPublicPostReferenceByIdOrGenerationId;
  isMissingPostsSchemaError: typeof isMissingPostsSchemaError;
  isUserRelationshipBlocked: typeof isUserRelationshipBlocked;
  notifyPostSocialActivity: typeof notifyPostSocialActivity;
};

export type ShowcaseSaveResponseBody = {
  success: true;
  isSaved: boolean;
  saveCount: number | null;
  changed: boolean;
  message: string;
};

export type ShowcaseSaveServiceResult =
  | {
      ok: true;
      body: ShowcaseSaveResponseBody;
    }
  | {
      ok: false;
      status: 404 | 500;
      body: {
        error: string;
      };
    };

function resolveDependencies(
  dependencies: Partial<ShowcaseSaveServiceDependencies> | undefined,
): ShowcaseSaveServiceDependencies {
  return {
    findPublicPostReferenceByIdOrGenerationId:
      dependencies?.findPublicPostReferenceByIdOrGenerationId ?? findPublicPostReferenceByIdOrGenerationId,
    isMissingPostsSchemaError: dependencies?.isMissingPostsSchemaError ?? isMissingPostsSchemaError,
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
  dependencies: ShowcaseSaveServiceDependencies;
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
    logBackendError('failed_to_verify_block_state_before_saving_showcase_content', { error: error });
    return true;
  }
}

function normalizeSaveSourceSurface(value: unknown) {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().slice(0, 80);
  return normalized.length > 0 ? normalized : null;
}

function normalizeSetPostSaveStateResult(data: unknown) {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== 'object') {
    return null;
  }

  const result = row as SetPostSaveStateRow;
  if (typeof result.is_saved !== 'boolean') {
    return null;
  }

  return {
    isSaved: result.is_saved,
    saveCount: typeof result.save_count === 'number' ? result.save_count : 0,
    changed: Boolean(result.changed),
  };
}

function getSupabaseErrorText(error: unknown) {
  if (!error || typeof error !== 'object') {
    return '';
  }

  const candidate = error as { message?: unknown; details?: unknown; hint?: unknown };
  return [candidate.message, candidate.details, candidate.hint]
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
}

function isMissingSetPostSaveStateFunctionError(error: unknown) {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const code = (error as { code?: unknown }).code;
  return code === 'PGRST202' && getSupabaseErrorText(error).includes('set_post_save_state');
}

async function readPostSaveCount(serviceClient: SupabaseClient, postId: string) {
  const { data, error } = await serviceClient
    .from('posts')
    .select('save_count')
    .eq('id', postId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  const row = data as PostSaveCountRow | null;
  return typeof row?.save_count === 'number' ? row.save_count : 0;
}

async function resolveLegacyIdempotentSaveState({
  post,
  requestedSaveState,
  serviceClient,
  userId,
}: {
  post: { id: string };
  requestedSaveState: boolean;
  serviceClient: SupabaseClient;
  userId: string;
}): Promise<PostSaveFallbackResult> {
  const { data: existingSave, error: saveLookupError } = await serviceClient
    .from('post_saves')
    .select('id')
    .eq('post_id', post.id)
    .eq('user_id', userId)
    .maybeSingle();

  if (saveLookupError) {
    throw saveLookupError;
  }

  const isCurrentlySaved = Boolean((existingSave as PostSaveLookupRow | null)?.id);

  if (isCurrentlySaved === requestedSaveState) {
    return {
      isSaved: requestedSaveState,
      saveCount: await readPostSaveCount(serviceClient, post.id),
      changed: false,
    };
  }

  const legacySaveResult = await serviceClient.rpc('toggle_post_save', {
    p_post_id: post.id,
    p_user_id: userId,
  });

  if (legacySaveResult.error) {
    throw legacySaveResult.error;
  }

  if (typeof legacySaveResult.data !== 'boolean') {
    throw new Error('Legacy save fallback returned an invalid result');
  }

  return {
    isSaved: legacySaveResult.data,
    saveCount: await readPostSaveCount(serviceClient, post.id),
    changed: true,
  };
}

async function recordPostSaveEvent({
  actorUserId,
  changed,
  isSaved,
  postId,
  requestedState,
  serviceClient,
  sourceSurface,
}: {
  actorUserId: string;
  changed: boolean;
  isSaved: boolean;
  postId: string;
  requestedState: boolean;
  serviceClient: SupabaseClient;
  sourceSurface: string | null;
}) {
  try {
    const { error } = await serviceClient
      .from('post_save_events')
      .insert({
        user_id: actorUserId,
        post_id: postId,
        requested_state: requestedState,
        result_state: isSaved,
        changed,
        source_surface: sourceSurface,
      });

    if (error) {
      logBackendError('failed_to_record_post_save_event', { error: error });
    }
  } catch (error) {
    logBackendError('failed_to_record_post_save_event', { error: error });
  }
}

export async function saveShowcasePostForRoute({
  actorUserId,
  dependencies,
  referenceId,
  requestedSaveState,
  serviceClient,
  sourceSurface,
}: {
  actorUserId: string;
  dependencies?: Partial<ShowcaseSaveServiceDependencies>;
  referenceId: string;
  requestedSaveState: boolean | null;
  serviceClient: SupabaseClient;
  sourceSurface: unknown;
}): Promise<ShowcaseSaveServiceResult> {
  const resolvedDependencies = resolveDependencies(dependencies);
  const post = await resolvedDependencies.findPublicPostReferenceByIdOrGenerationId(referenceId) as PostReference | null;
  if (!post) {
    return { ok: false, status: 404, body: { error: 'Post not found' } };
  }
  if (await isPostInteractionUnavailable({
    actorUserId,
    creatorUserId: post.user_id,
    dependencies: resolvedDependencies,
    serviceClient,
  })) {
    return { ok: false, status: 404, body: { error: 'Post not found' } };
  }

  let isSaved: boolean | null = null;
  let saveCount: number | null = null;
  let changed = true;
  let rpcError: unknown = null;

  if (requestedSaveState !== null) {
    const postSaveResult = await serviceClient.rpc('set_post_save_state', {
      p_post_id: post.id,
      p_user_id: actorUserId,
      p_should_save: requestedSaveState,
    });

    const normalizedResult = normalizeSetPostSaveStateResult(postSaveResult.data);
    isSaved = normalizedResult?.isSaved ?? null;
    saveCount = normalizedResult?.saveCount ?? null;
    changed = normalizedResult?.changed ?? false;
    rpcError = postSaveResult.error;
  } else {
    const postSaveResult = await serviceClient.rpc('toggle_post_save', {
      p_post_id: post.id,
      p_user_id: actorUserId,
    });

    isSaved = typeof postSaveResult.data === 'boolean' ? postSaveResult.data : null;
    rpcError = postSaveResult.error;
  }

  if (
    requestedSaveState !== null
    && rpcError
    && isMissingSetPostSaveStateFunctionError(rpcError)
  ) {
    const legacyState = await resolveLegacyIdempotentSaveState({
      post,
      requestedSaveState,
      serviceClient,
      userId: actorUserId,
    });

    isSaved = legacyState.isSaved;
    saveCount = legacyState.saveCount;
    changed = legacyState.changed;
    rpcError = null;
  } else if (rpcError && resolvedDependencies.isMissingPostsSchemaError(rpcError)) {
    const legacySaveResult = await serviceClient.rpc('toggle_showcase_save', {
      p_generation_id: post.generation_id ?? post.id,
      p_user_id: actorUserId,
    });

    isSaved = typeof legacySaveResult.data === 'boolean' ? legacySaveResult.data : null;
    saveCount = null;
    changed = true;
    rpcError = legacySaveResult.error;
  }

  if (rpcError) {
    logBackendError('error_toggling_save', { error: rpcError });
    return { ok: false, status: 500, body: { error: 'Failed to update save status' } };
  }

  if (isSaved === null) {
    return { ok: false, status: 500, body: { error: 'Failed to update save status' } };
  }

  if (requestedSaveState !== null) {
    await recordPostSaveEvent({
      actorUserId,
      changed,
      isSaved,
      postId: post.id,
      requestedState: requestedSaveState,
      serviceClient,
      sourceSurface: normalizeSaveSourceSurface(sourceSurface),
    });
  }

  if (isSaved && (requestedSaveState === null || changed)) {
    await resolvedDependencies.notifyPostSocialActivity(serviceClient, {
      type: 'post_saved',
      recipientUserId: post.user_id,
      actorUserId,
      postId: post.id,
    });
  }

  return {
    ok: true,
    body: {
      success: true,
      isSaved,
      saveCount,
      changed,
      message: isSaved ? 'Saved to bookmarks' : 'Removed from bookmarks',
    },
  };
}
