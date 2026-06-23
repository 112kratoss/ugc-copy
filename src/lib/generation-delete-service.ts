import type { SupabaseClient } from '@supabase/supabase-js';

import {
  BackendRateLimitError,
  GENERATION_LIFECYCLE_MUTATION_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { getStoredMediaLocation, type MediaBucket } from '@/lib/media-urls';

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
  request: Request;
}

async function getAuthenticatedUserId(supabase: GenerationDeleteClient) {
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  return authError || !user ? null : user.id;
}

function addStoredMediaPath(paths: RemovablePath[], value: string | null | undefined) {
  if (!value) {
    return;
  }

  const location = getStoredMediaLocation(value);
  if (!location) {
    return;
  }

  paths.push({
    bucket: location.bucket,
    path: location.filePath,
  });
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
}: GenerationDeleteRouteInput): Promise<GenerationDeleteRouteResult> {
  const supabase = createUserSupabase() as GenerationDeleteClient;
  const userId = await getAuthenticatedUserId(supabase);

  if (!userId) {
    return {
      ok: false,
      body: { error: 'Unauthorized' },
      status: 401,
    };
  }

  try {
    const adminSupabase = createAdminSupabase() as GenerationDeleteClient;
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

      console.error('Failed to enforce generation delete rate limit:', error);
      return { ok: false, body: { error: 'Failed to delete creation.' }, status: 500 };
    }

    const { data: generationData, error: generationError } = await adminSupabase
      .from('generations')
      .select('id, user_id, output_url, showcase_asset_path')
      .eq('id', generationId)
      .eq('user_id', userId)
      .maybeSingle();
    const generation = generationData as GenerationDeleteRow | null;

    if (generationError) {
      console.error('Failed to load generation before delete:', generationError);
      return { ok: false, body: { error: 'Failed to delete creation.' }, status: 500 };
    }

    if (!generation) {
      return { ok: false, body: { error: 'Creation not found.' }, status: 404 };
    }

    const { data: linkedPosts, error: linkedPostsError } = await adminSupabase
      .from('posts')
      .select('id')
      .eq('generation_id', generationId)
      .eq('user_id', userId);

    if (linkedPostsError) {
      console.error('Failed to load linked posts before generation delete:', linkedPostsError);
      return { ok: false, body: { error: 'Failed to delete creation.' }, status: 500 };
    }

    const hasLinkedPosts = Array.isArray(linkedPosts) && linkedPosts.length > 0;
    const removablePaths: RemovablePath[] = [];

    const { data: inputMediaRows, error: inputMediaError } = await adminSupabase
      .from('generation_input_media')
      .select('storage_path')
      .eq('generation_id', generationId)
      .eq('user_id', userId);

    if (inputMediaError) {
      console.error('Failed to load generation input media before delete:', inputMediaError);
    } else {
      for (const row of (inputMediaRows ?? []) as Array<{ storage_path: string | null }>) {
        addStoredMediaPath(removablePaths, row.storage_path);
      }
    }

    if (!hasLinkedPosts) {
      addStoredMediaPath(removablePaths, generation.output_url);

      if (generation.showcase_asset_path) {
        removablePaths.push({
          bucket: 'showcase_media',
          path: generation.showcase_asset_path,
        });
      }
    }

    const { error: deleteError } = await adminSupabase
      .from('generations')
      .delete()
      .eq('id', generationId)
      .eq('user_id', userId);

    if (deleteError) {
      console.error('Failed to delete generation:', deleteError);
      return { ok: false, body: { error: 'Failed to delete creation.' }, status: 500 };
    }

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
    console.error('Failed to delete owner generation:', error);
    return { ok: false, body: { error: 'Failed to delete creation.' }, status: 500 };
  }
}
