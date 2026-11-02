import { requireIdentity, resolveLinkedAccountIds } from '@/lib/account-identity';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logBackendError } from '@/lib/backend-logger';

import {
  BackendRateLimitError,
  GENERATION_LIFECYCLE_MUTATION_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { isMediaBucket, type MediaBucket } from '@/lib/media-urls';
import { providerTrackFolder } from '@/lib/generation-provider-tracks';
import {
  POST_MEDIA_PATH_COLUMNS,
  PRIVATE_POST_MEDIA_BUCKET,
  PRIVATE_POST_MEDIA_PREFIX,
  postMediaStorageBucket,
} from '@/lib/post-media-storage';
import { invalidateShowcaseFeedCache } from '@/lib/showcase-feed-cache';
import {
  getCanonicalStoredMediaLocation,
  getUserOwnedStoredMediaLocation,
  parseCanonicalStorageObjectPath,
} from '@/lib/storage-ownership';
import { queueUnrecordedShowcaseMedia } from '@/lib/unrecorded-showcase-media';

type RouteBody = Record<string, unknown>;
type GenerationDeleteClient = SupabaseClient;
/** The creation's copy: `showcase/<creation>/` in public, `private-posts/<creation>/` for one marked NSFW. */
type CopyBucket = 'showcase_media' | typeof PRIVATE_POST_MEDIA_BUCKET;

type GenerationDeleteRow = {
  id: string;
  user_id: string;
  output_url: string | null;
  showcase_asset_path: string | null;
  playback_rendition_path?: string | null;
  preview_url?: string | null;
  display_url?: string | null;
  workflow_settings?: unknown;
};

/** A post the delete unlinked, with what it names: it keeps serving the creation's copy. */
type RemainingPostRow = {
  id: string;
  output_url: string | null;
  showcase_asset_path: string | null;
  post_media?: Array<Record<string, string | null>> | null;
};

type RemovablePath = {
  bucket: MediaBucket | CopyBucket;
  path: string;
};

/**
 * Every file the creation's row records, read from the delete's own RETURNING:
 * a derivative that finishes after the first read is still named here.
 */
const GENERATION_DELETE_COLUMNS = [
  'id',
  'user_id',
  'output_url',
  'showcase_asset_path',
  'playback_rendition_path',
  'preview_url',
  'display_url',
  'workflow_settings',
].join(', ');

const GENERATED_MEDIA_BUCKETS: readonly MediaBucket[] = ['generated_images', 'generated_videos', 'generated_audio'];

const REMAINING_POST_COLUMNS = `id, output_url, showcase_asset_path, post_media(${POST_MEDIA_PATH_COLUMNS.join(', ')})`;

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

/** The creation's copy under its own folder, public or (marked NSFW) private; null for anything else. */
function getCreationCopyPath(
  value: string | null | undefined,
  generationId: string,
): string | null {
  if (!value) return null;
  const canonicalPath = parseCanonicalStorageObjectPath(value, { minimumSegments: 3 });
  if (!canonicalPath) return null;
  const [namespace, scopedGenerationId] = canonicalPath.split('/');
  if ((namespace !== 'showcase' && namespace !== 'private-posts') || scopedGenerationId !== generationId) return null;
  return canonicalPath;
}

/**
 * The copies of the run's tracks converted for its provider (generation-provider-tracks), which no
 * input row names. A failed listing leaves them for account deletion rather than failing the delete.
 */
async function listProviderTrackCopies(
  adminSupabase: GenerationDeleteClient,
  ownerUserId: string,
  generationId: string,
): Promise<RemovablePath[]> {
  const folder = providerTrackFolder(ownerUserId, generationId);
  try {
    const { data, error } = await adminSupabase.storage.from('generation_inputs').list(folder);
    if (error) throw error;
    return (data ?? [])
      .filter((entry) => entry.id && entry.name)
      .map((entry) => ({ bucket: 'generation_inputs' as const, path: `${folder}/${entry.name}` }));
  } catch (error) {
    logBackendError('failed_to_list_provider_track_copies_for_delete', { error });
    return [];
  }
}

/** The outputs past the first that a run of several records in its settings (`persistGeneratedOutputList`). */
function getRecordedOutputPaths(workflowSettings: unknown): string[] {
  if (!workflowSettings || typeof workflowSettings !== 'object') return [];
  const outputs = (workflowSettings as { outputs?: unknown }).outputs;
  if (!Array.isArray(outputs)) return [];
  return outputs.flatMap((output) => {
    const storagePath = output && typeof output === 'object'
      ? (output as { storagePath?: unknown }).storagePath
      : null;
    return typeof storagePath === 'string' && storagePath ? [storagePath] : [];
  });
}

/**
 * The private files the creation's row recorded, under its owner's folder of
 * the generated buckets only: the original, its preview and display, the
 * playback rendition, and each further output of a run that made several.
 */
function getRecordedPrivatePaths(deleted: GenerationDeleteRow): RemovablePath[] {
  const paths: RemovablePath[] = [];
  for (const value of [
    deleted.output_url,
    deleted.preview_url,
    deleted.display_url,
    ...getRecordedOutputPaths(deleted.workflow_settings),
  ]) {
    addUserOwnedStoredMediaPath(paths, value, deleted.user_id, GENERATED_MEDIA_BUCKETS);
  }
  addUserOwnedStoredMediaPath(paths, deleted.playback_rendition_path, deleted.user_id, ['generated_videos']);
  return paths;
}

/**
 * What the posts the delete unlinked still name, as `<bucket>/<path>` for a
 * private file and as the object path for anything in the public folder.
 * Null when they could not be read: the caller then removes nothing a post
 * could need.
 */
async function loadNamesOfRemainingPosts(
  adminSupabase: GenerationDeleteClient,
  generationId: string,
): Promise<{ posts: number; names: Set<string> } | null> {
  // `posts.generation_id` is ON DELETE SET NULL, and the posts trigger records
  // the creation in `deleted_generation_id` in the delete's own statement. Read
  // after the delete, this sees every post the delete unlinked, one linked by
  // a publish racing the first read included.
  const { data, error } = await adminSupabase
    .from('posts')
    .select(REMAINING_POST_COLUMNS)
    .eq('deleted_generation_id', generationId);

  if (error) {
    logBackendError('failed_to_load_posts_after_generation_delete', { error, generationId });
    return null;
  }

  const names = new Set<string>();
  const rows = (data ?? []) as unknown as RemainingPostRow[];
  for (const post of rows) {
    const values = [
      post.output_url,
      post.showcase_asset_path,
      ...(post.post_media ?? []).flatMap((media) => POST_MEDIA_PATH_COLUMNS.map((column) => media[column])),
    ];
    for (const value of values) {
      if (!value) continue;
      const location = getCanonicalStoredMediaLocation(value, { allowedBuckets: GENERATED_MEDIA_BUCKETS });
      if (location) names.add(`${location.bucket}/${location.filePath}`);
      const objectPath = parseCanonicalStorageObjectPath(value, { minimumSegments: 3 });
      if (objectPath) names.add(objectPath);
    }
  }
  return { posts: rows.length, names };
}

/**
 * One request a bucket. A removal that fails or throws is logged with its
 * paths, and a public copy goes to the revocation queue, whose job retries it
 * (keeping it if something names it again by then). The creation is already
 * deleted: nothing here turns that into a failure.
 */
async function removeStoragePaths(
  adminSupabase: GenerationDeleteClient,
  removablePaths: RemovablePath[],
  generationId: string,
) {
  const pathsByBucket = new Map<RemovablePath['bucket'], string[]>();
  for (const { bucket, path } of removablePaths) {
    const paths = pathsByBucket.get(bucket) ?? [];
    if (!paths.includes(path)) paths.push(path);
    pathsByBucket.set(bucket, paths);
  }

  const failedPublicPaths: string[] = [];
  const failedPrivateCopies: string[] = [];
  for (const [bucket, paths] of pathsByBucket) {
    let error: unknown = null;
    try {
      ({ error } = await adminSupabase.storage.from(bucket).remove(paths));
    } catch (thrown) {
      error = thrown;
    }
    if (!error) continue;

    logBackendError('failed_to_remove_deleted_generation_media', { error, generationId, bucket, paths });
    if (bucket === 'showcase_media') failedPublicPaths.push(...paths);
    if (bucket === PRIVATE_POST_MEDIA_BUCKET) failedPrivateCopies.push(...paths);
  }

  if (failedPublicPaths.length > 0) {
    await queueUnrecordedShowcaseMedia(adminSupabase, failedPublicPaths);
  }
  if (failedPrivateCopies.length > 0) {
    await queuePrivateCopyCleanup(adminSupabase, failedPrivateCopies, generationId);
  }
}

/**
 * A creation's private copy (`private-posts/<creation>/`) that failed to go
 * goes to the private bucket's cleanup outbox, whose job removes it only once
 * `private_post_media_is_referenced` finds nothing naming it (purchase
 * snapshots included). Handed over only when no post of the deleted creation
 * remains: that function finds a post's own folder, not a creation's, and no
 * new post can link a deleted creation. Never throws.
 */
async function queuePrivateCopyCleanup(
  adminSupabase: GenerationDeleteClient,
  paths: string[],
  generationId: string,
) {
  try {
    const { error } = await adminSupabase
      .from('post_media_object_cleanup')
      .upsert(paths.map((storage_path) => ({ storage_path })), { onConflict: 'storage_path', ignoreDuplicates: true });
    if (error) throw error;
  } catch (error) {
    logBackendError('failed_to_queue_deleted_generation_private_copy', { error, generationId, paths });
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
      .select('id, user_id, output_url, showcase_asset_path, playback_rendition_path')
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

    const { data: deletedRows, error: deleteError } = await adminSupabase
      .from('generations')
      .delete()
      .eq('id', generationId)
      .in('user_id', ownerUserIds)
      .is('template_run_id', null)
      .is('template_run_step_id', null)
      .select(GENERATION_DELETE_COLUMNS);

    if (deleteError) {
      logBackendError('failed_to_delete_generation', { error: deleteError });
      return { ok: false, body: { error: 'Failed to delete creation.' }, status: 500 };
    }

    const deleted = (deletedRows as unknown as GenerationDeleteRow[] | null)?.[0];
    if (!deleted) return { ok: false, body: { error: 'Creation not found.' }, status: 404 };
    // A linked post never reads these, so they go whether or not one keeps the creation's copy.
    removablePaths.push(...await listProviderTrackCopies(adminSupabase, deleted.user_id, deleted.id));

    // DELETE RETURNING captures a derivative that finishes after the initial
    // owner/retention read. Cleaning that old snapshot could strand its bytes.
    //
    // A post the delete unlinked keeps serving the creation's copy, and a
    // private one its original (`posts.output_url`), so exactly what those
    // posts name stays. Nothing else reads the creation's private preview,
    // display, playback rendition or further outputs once its row is gone:
    // they go now. The post's delete later takes the original it kept
    // (post-delete-service). Unreadable posts keep everything a post could name.
    const remainingPosts = await loadNamesOfRemainingPosts(adminSupabase, deleted.id);
    const postsRemain = hasLinkedPosts || (remainingPosts?.posts ?? 0) > 0;
    const copyPath = getCreationCopyPath(deleted.showcase_asset_path, deleted.id);
    const queuedPublicPaths: string[] = [];

    if (remainingPosts !== null) {
      removablePaths.push(...getRecordedPrivatePaths(deleted).filter(({ bucket, path }) => (
        !remainingPosts.names.has(`${bucket}/${path}`)
      )));

      if (copyPath && !remainingPosts.names.has(copyPath)) {
        if (remainingPosts.posts === 0) {
          removablePaths.push({ bucket: postMediaStorageBucket(copyPath), path: copyPath });
        } else if (!copyPath.startsWith(PRIVATE_POST_MEDIA_PREFIX)) {
          // A post still serves the creation's folder: the revocation job
          // decides, keeping the copy if a post or its media row names it and
          // waiting out a sweep's lease before it removes it.
          queuedPublicPaths.push(copyPath);
        }
        // A private copy (marked NSFW) stays here while a post remains: the
        // revocation queue's RPC takes only showcase/ paths. The post's own
        // delete queues the copy its showcase_asset_path names, under the
        // creation it recorded (posts_sync_generation_exposure), and the job
        // removes it from post_media (showcase-revocation-postgrest pins it).
        // A private copy no remaining post names is left to the orphan listing.
      }
    }

    invalidateFeedCache();
    await removeStoragePaths(adminSupabase, removablePaths, deleted.id);
    if (queuedPublicPaths.length > 0) {
      await queueUnrecordedShowcaseMedia(adminSupabase, queuedPublicPaths);
    }

    return {
      ok: true,
      body: {
        success: true,
        deleted: true,
        linkedPostRetained: postsRemain,
        message: postsRemain
          ? 'The creation was deleted from your workspace. Any linked post stays intact, but generation-based remix linkage may no longer work.'
          : 'The creation was deleted from your workspace.',
      },
    };
  } catch (error) {
    logBackendError('failed_to_delete_owner_generation', { error: error });
    return { ok: false, body: { error: 'Failed to delete creation.' }, status: 500 };
  }
}
