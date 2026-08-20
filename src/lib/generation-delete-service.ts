import { requireIdentity, resolveLinkedAccountIds } from '@/lib/account-identity';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logBackendError } from '@/lib/backend-logger';

import {
  BackendRateLimitError,
  GENERATION_LIFECYCLE_MUTATION_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { isMediaBucket, type MediaBucket } from '@/lib/media-urls';
import { invalidateShowcaseFeedCache } from '@/lib/showcase-feed-cache';
import {
  getUserOwnedStoredMediaLocation,
  parseCanonicalStorageObjectPath,
} from '@/lib/storage-ownership';

type RouteBody = Record<string, unknown>;
type GenerationDeleteClient = SupabaseClient;
type ShowcaseBucket = 'showcase_media';

type GenerationDeleteRow = {
  id: string;
  user_id: string;
  output_url: string | null;
  showcase_asset_path: string | null;
};

type RemovablePath = {
  bucket: MediaBucket | ShowcaseBucket;
  path: string;
};

export type GenerationDeleteRouteResult =
  | {
    ok: true;
    body: RouteBody;
  }
  | {
    ok: false;
    body: RouteBody;
    status: number;
    rateLimitError?: BackendRateLimitError;
  };

export interface GenerationDeleteRouteInput {
  createAdminSupabase: () => unknown;
  createUserSupabase: () => unknown;
  generationId: string;
  invalidateFeedCache?: typeof invalidateShowcaseFeedCache;
  requireIdentity?: typeof requireIdentity;
  request: Request;
}

function addUserOwnedStoredMediaPath(
  paths: RemovablePath[],
  value: string | null | undefined,
  ownerUserId: string,
  allowedBuckets: readonly MediaBucket[],
) {
  if (!value || !ownerUserId) {
    return;
  }

  const location = getUserOwnedStoredMediaLocation(value, ownerUserId, { allowedBuckets });
  if (!location || !isMediaBucket(location.bucket)) {
    return;
  }

  paths.push({
    bucket: location.bucket,
    path: location.filePath,
  });
}

function addShowcaseMediaPath(
  paths: RemovablePath[],
  value: string | null | undefined,
  generationId: string,
) {
  if (!value) return;
  const canonicalPath = parseCanonicalStorageObjectPath(value, { minimumSegments: 3 });
  if (!canonicalPath) return;
  const [namespace, scopedGenerationId] = canonicalPath.split('/');
  if (namespace !== 'showcase' || scopedGenerationId !== generationId) return;
  paths.push({ bucket: 'showcase_media', path: canonicalPath });
}

async function removeStoragePaths(adminSupabase: GenerationDeleteClient, removablePaths: RemovablePath[]) {
  for (const removablePath of removablePaths) {
    await adminSupabase.storage.from(removablePath.bucket).remove([removablePath.path]);
  }
}

export async function deleteOwnerGenerationForRoute({
  createAdminSupabase,
  createUserSupabase,
  generationId,
  invalidateFeedCache = invalidateShowcaseFeedCache,
  requireIdentity: requireIdentityForRequest = requireIdentity,
}: GenerationDeleteRouteInput): Promise<GenerationDeleteRouteResult> {
  const supabase = createUserSupabase() as GenerationDeleteClient;
  let adminSupabase: GenerationDeleteClient | null = null;
  const getAdminSupabase = () => {
    adminSupabase ??= createAdminSupabase() as GenerationDeleteClient;
    return adminSupabase;
  };
  const identity = await requireIdentityForRequest(supabase, getAdminSupabase);

  if (!identity.ok) {
    return {
      ok: false,
      body: { error: identity.error, code: identity.code },
      status: identity.status,
    };
  }
  const userId = identity.identity.userId;

  try {
    const adminSupabase = getAdminSupabase();
    try {
      await enforceBackendRateLimit(adminSupabase, {
        ...GENERATION_LIFECYCLE_MUTATION_RATE_LIMIT,
        key: userId,
      });
    } catch (error) {
      if (error instanceof BackendRateLimitError) {
        return {
          ok: false,
          body: { error: error.message },
          status: error.status,
          rateLimitError: error,
        };
      }

      logBackendError('failed_to_enforce_generation_delete_rate_limit', { error: error });
      return { ok: false, body: { error: 'Failed to delete creation.' }, status: 500 };
    }

    const ownerUserIds = await resolveLinkedAccountIds(adminSupabase, userId);
    const { data: generationData, error: generationError } = await adminSupabase
      .from('generations')
      .select('id, user_id, output_url, showcase_asset_path')
      .eq('id', generationId)
      .in('user_id', ownerUserIds)
      .is('template_run_id', null)
      .is('template_run_step_id', null)
      .maybeSingle();
    const generation = generationData as GenerationDeleteRow | null;

    if (generationError) {
      logBackendError('failed_to_load_generation_before_delete', { error: generationError });
      return { ok: false, body: { error: 'Failed to delete creation.' }, status: 500 };
    }

    if (!generation) {
      return { ok: false, body: { error: 'Creation not found.' }, status: 404 };
    }

    const { data: linkedPosts, error: linkedPostsError } = await adminSupabase
      .from('posts')
      .select('id')
      .eq('generation_id', generationId)
      .in('user_id', ownerUserIds);

    if (linkedPostsError) {
      logBackendError('failed_to_load_linked_posts_before_generation_delete', { error: linkedPostsError });
      return { ok: false, body: { error: 'Failed to delete creation.' }, status: 500 };
    }

    const hasLinkedPosts = Array.isArray(linkedPosts) && linkedPosts.length > 0;
    const removablePaths: RemovablePath[] = [];

    const { data: inputMediaRows, error: inputMediaError } = await adminSupabase
      .from('generation_input_media')
      .select('user_id, storage_path')
      .eq('generation_id', generationId)
      .in('user_id', ownerUserIds);

    if (inputMediaError) {
      logBackendError('failed_to_load_generation_input_media_before_delete', { error: inputMediaError });
    } else {
      for (const row of (inputMediaRows ?? []) as Array<{ user_id: string; storage_path: string | null }>) {
        if (!ownerUserIds.includes(row.user_id)) continue;
        addUserOwnedStoredMediaPath(
          removablePaths,
          row.storage_path,
          row.user_id,
          ['generation_inputs'],
        );
      }
    }

    if (!hasLinkedPosts) {
      addUserOwnedStoredMediaPath(
        removablePaths,
        generation.output_url,
        generation.user_id,
        ['generated_images', 'generated_videos', 'generated_audio'],
      );
      addShowcaseMediaPath(removablePaths, generation.showcase_asset_path, generation.id);
    }

    const { error: deleteError } = await adminSupabase
      .from('generations')
      .delete()
      .eq('id', generationId)
      .in('user_id', ownerUserIds)
      .is('template_run_id', null)
      .is('template_run_step_id', null);

    if (deleteError) {
      logBackendError('failed_to_delete_generation', { error: deleteError });
      return { ok: false, body: { error: 'Failed to delete creation.' }, status: 500 };
    }

    invalidateFeedCache();
    await removeStoragePaths(adminSupabase, removablePaths);

    return {
      ok: true,
      body: {
        success: true,
        deleted: true,
        linkedPostRetained: hasLinkedPosts,
        message: hasLinkedPosts
          ? 'The creation was deleted from your workspace. Any linked post stays intact, but generation-based remix linkage may no longer work.'
          : 'The creation was deleted from your workspace.',
      },
    };
  } catch (error) {
    logBackendError('failed_to_delete_owner_generation', { error: error });
    return { ok: false, body: { error: 'Failed to delete creation.' }, status: 500 };
  }
}
