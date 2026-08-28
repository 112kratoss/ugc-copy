import { logBackendError } from '@/lib/backend-logger';
import { isUserRelationshipBlocked } from '@/lib/moderation-service';
import { loadGenerationRecipeRemixInputMediaByPostId } from '@/lib/post-resource-bundles-server';
import { createServiceClient } from '@/lib/server-helpers';
import { getCanonicalStoredMediaLocation } from '@/lib/storage-ownership';

const GENERATION_INPUTS_BUCKET = 'generation_inputs';
const REMIX_IMPORT_FOLDER = 'remix-imports';
const SIGNED_URL_TTL_SECONDS = 3600;
const MAX_POSTS_PER_GENERATION = 5;

export type SharedInputMediaImportResult =
  /** Not a shared generation input the viewer may use — the caller's ownership error stands. */
  | { outcome: 'not-eligible' }
  /** The viewer is entitled to this media but the copy could not be prepared — retryable. */
  | { outcome: 'failed' }
  | { outcome: 'imported'; storagePath: string; signedUrl: string };

export interface SharedInputMediaImportDependencies {
  createServiceClient?: typeof createServiceClient;
  isUserRelationshipBlocked?: typeof isUserRelationshipBlocked;
  loadGenerationRecipeRemixInputMediaByPostId?: typeof loadGenerationRecipeRemixInputMediaByPostId;
}

function isAlreadyExistsStorageError(error: { statusCode?: string | number; message?: string; error?: string }): boolean {
  return String(error.statusCode ?? '') === '409'
    || error.error === 'Duplicate'
    || /already exists/i.test(error.message ?? '');
}

/**
 * Copies a shared generation input into the caller's own storage prefix.
 *
 * A remix (or an unlocked recipe) deliberately hands the viewer the original
 * creator's reference media, but every generation start requires references to
 * live under the caller's own `<userId>/…` prefix — the path prefix *is* the
 * ownership model. This bridges the two: when the submitted reference resolves
 * to another user's durable input object, re-derive the sharing decision
 * server-side (never from the client's signed URL) and, if the viewer is
 * entitled to remix it, copy the object into
 * `generation_inputs/<viewer>/remix-imports/<sourceGenerationId>/<file>`.
 * The deterministic destination makes retries and repeated remixes reuse one
 * copy, and the remix keeps working even if the creator later deletes the
 * original or stops sharing.
 *
 * Only durable inputs (rows in `generation_input_media`) are importable;
 * legacy pre-durable references stay rejected until the repair backfill
 * reaches them.
 */
export async function importSharedGenerationInputMedia(params: {
  /** The reference exactly as submitted — a storage path or storage-object URL. */
  source: string;
  viewerUserId: string;
  dependencies?: SharedInputMediaImportDependencies;
}): Promise<SharedInputMediaImportResult> {
  const location = getCanonicalStoredMediaLocation(params.source, {
    allowedBuckets: [GENERATION_INPUTS_BUCKET],
  });
  if (!location) return { outcome: 'not-eligible' };

  const ownerUserId = location.filePath.split('/')[0];
  if (!ownerUserId || ownerUserId === params.viewerUserId) return { outcome: 'not-eligible' };

  const adminSupabase = (params.dependencies?.createServiceClient ?? createServiceClient)();
  const storagePathKey = `${location.bucket}/${location.filePath}`;

  const mediaRowResult = await adminSupabase
    .from('generation_input_media')
    .select('id, generation_id, user_id, storage_path')
    .eq('storage_path', storagePathKey)
    .limit(1);
  if (mediaRowResult.error) {
    logBackendError('failed_to_load_shared_input_media_row_for_import', { error: mediaRowResult.error });
    return { outcome: 'failed' };
  }
  const mediaRow = (mediaRowResult.data ?? [])[0] as
    | { id: string; generation_id: string; user_id: string; storage_path: string }
    | undefined;
  if (!mediaRow || mediaRow.user_id !== ownerUserId) return { outcome: 'not-eligible' };

  const generationResult = await adminSupabase
    .from('generations')
    .select('id, user_id, is_public, share_input_media_for_remix')
    .eq('id', mediaRow.generation_id)
    .maybeSingle();
  if (generationResult.error) {
    logBackendError('failed_to_load_generation_for_shared_input_import', { error: generationResult.error });
    return { outcome: 'failed' };
  }
  const generation = generationResult.data as
    | { id: string; user_id: string | null; is_public: boolean | null; share_input_media_for_remix?: boolean | null }
    | null;
  if (!generation || generation.user_id !== ownerUserId) return { outcome: 'not-eligible' };

  // Mirrors the remix-source block gate: a check that errors open is not a gate.
  let blocked = true;
  try {
    blocked = await (params.dependencies?.isUserRelationshipBlocked ?? isUserRelationshipBlocked)({
      adminSupabase,
      firstUserId: params.viewerUserId,
      secondUserId: ownerUserId,
    });
  } catch (error) {
    logBackendError('failed_to_verify_block_state_before_shared_input_import', { error });
  }
  if (blocked) return { outcome: 'not-eligible' };

  // Free sharing first (the same predicate the remix-source endpoint serves
  // media under), then the paid recipe entitlement via a post that links this
  // generation — that loader re-checks purchase, allowRemix, and eligibility.
  let authorized = generation.is_public === true && generation.share_input_media_for_remix === true;
  if (!authorized) {
    const postsResult = await adminSupabase
      .from('posts')
      .select('id')
      .eq('generation_id', generation.id)
      .limit(MAX_POSTS_PER_GENERATION);
    if (postsResult.error) {
      logBackendError('failed_to_load_posts_for_shared_input_import', { error: postsResult.error });
      return { outcome: 'failed' };
    }
    const loadRecipeInputMedia = params.dependencies?.loadGenerationRecipeRemixInputMediaByPostId
      ?? loadGenerationRecipeRemixInputMediaByPostId;
    for (const post of (postsResult.data ?? []) as Array<{ id: string }>) {
      const items = await loadRecipeInputMedia({
        postId: post.id,
        generationId: generation.id,
        viewerUserId: params.viewerUserId,
        adminSupabase,
      });
      if (items.some((item) => item.storagePath === storagePathKey)) {
        authorized = true;
        break;
      }
    }
  }
  if (!authorized) return { outcome: 'not-eligible' };

  const fileName = location.filePath.split('/').pop() ?? 'input';
  const destinationFilePath = `${params.viewerUserId}/${REMIX_IMPORT_FOLDER}/${mediaRow.generation_id}/${fileName}`;

  const copyResult = await adminSupabase.storage
    .from(location.bucket)
    .copy(location.filePath, destinationFilePath);
  if (copyResult.error && !isAlreadyExistsStorageError(copyResult.error)) {
    logBackendError('failed_to_copy_shared_input_media_for_import', { error: copyResult.error });
    return { outcome: 'failed' };
  }

  const signedResult = await adminSupabase.storage
    .from(location.bucket)
    .createSignedUrl(destinationFilePath, SIGNED_URL_TTL_SECONDS);
  if (signedResult.error || !signedResult.data?.signedUrl) {
    logBackendError('failed_to_sign_imported_shared_input_media', { error: signedResult.error });
    return { outcome: 'failed' };
  }

  return {
    outcome: 'imported',
    storagePath: `${location.bucket}/${destinationFilePath}`,
    signedUrl: signedResult.data.signedUrl,
  };
}
