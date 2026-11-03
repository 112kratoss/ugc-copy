import { logBackendError } from '@/lib/backend-logger';
import type { SharedInputMediaImportResult } from '@/lib/generation-input-media-import';
import { loadGenerationRecipeReferenceCopiesByPostId } from '@/lib/post-resource-bundles-server';
import { createServiceClient } from '@/lib/server-helpers';
import { getCanonicalStoredMediaLocation } from '@/lib/storage-ownership';

const RECIPE_FILES_BUCKET = 'post_resource_files';
/** Where a run start keeps another account's media it may use: as `importSharedGenerationInputMedia` does. */
const GENERATION_INPUTS_BUCKET = 'generation_inputs';
const REMIX_IMPORT_FOLDER = 'remix-imports';
const SIGNED_URL_TTL_SECONDS = 3600;
const COPY_FOLDER = 'generation-references';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface GenerationReferenceCopyImportDependencies {
  createServiceClient?: typeof createServiceClient;
  loadGenerationRecipeReferenceCopiesByPostId?: typeof loadGenerationRecipeReferenceCopiesByPostId;
}

/** As the shared-input import reads it: a retry reuses the copy an earlier run already made. */
function isAlreadyExistsStorageError(error: { statusCode?: string | number; message?: string; error?: string }): boolean {
  return String(error.statusCode ?? '') === '409'
    || error.error === 'Duplicate'
    || /already exists/i.test(error.message ?? '');
}

/**
 * A recipe's copy of one of its creation's saved inputs, handed to a run start
 * by a remix of that recipe (owner, 2026-11-03).
 *
 * A remix whose creator keeps the run's inputs to themselves restores the ones
 * "Include creation references" copied into the recipe its buyer unlocked
 * (`resolveWithheldRemixInputs`). That copy is the seller's file, in
 * `post_resource_files/<seller>/generation-references/<generation>/<file>`,
 * and a run start takes only the caller's own files, so the remix was refused
 * at Generate. This copies it into the caller's folder, as
 * `importSharedGenerationInputMedia` does a creator's freely shared input,
 * once the unlock is read again now: the seller's post for that creation, and
 * this exact file among the copies the recipe version this viewer has holds
 * (`loadGenerationRecipeReferenceCopiesByPostId`). A refund since the remix
 * ends it; a recipe its seller retired stays its buyers', as their files do.
 *
 * Answers as the shared import does: `not-eligible` for anything else, the
 * caller's ownership error then standing, and `failed` (retryable) when a read,
 * the copy or its signing fails.
 */
export async function importGenerationReferenceCopy(params: {
  /** The reference exactly as submitted: a storage path or storage-object URL. */
  source: string;
  viewerUserId: string;
  dependencies?: GenerationReferenceCopyImportDependencies;
}): Promise<SharedInputMediaImportResult> {
  const location = getCanonicalStoredMediaLocation(params.source, {
    allowedBuckets: [RECIPE_FILES_BUCKET],
  });
  if (!location) return { outcome: 'not-eligible' };

  // `<seller>/generation-references/<generation>/<file>`, and nothing deeper.
  const [sellerUserId = '', folder, generationId = '', fileName, ...deeper] = location.filePath.split('/');
  if (
    folder !== COPY_FOLDER
    || !fileName
    || deeper.length > 0
    // Both are ids: a segment that is none names no account or creation.
    || !UUID_PATTERN.test(sellerUserId)
    || !UUID_PATTERN.test(generationId)
    // The seller's own copy is theirs: their run reads it as their own file.
    || sellerUserId === params.viewerUserId
  ) {
    return { outcome: 'not-eligible' };
  }

  const adminSupabase = (params.dependencies?.createServiceClient ?? createServiceClient)();

  // The creation's post, which is the seller's (posts.generation_id is unique).
  const postResult = await adminSupabase
    .from('posts')
    .select('id')
    .eq('generation_id', generationId)
    .eq('user_id', sellerUserId)
    .maybeSingle();
  if (postResult.error) {
    logBackendError('failed_to_load_post_for_recipe_copy_import', { error: postResult.error });
    return { outcome: 'failed' };
  }
  const postId = (postResult.data as { id: string } | null)?.id;
  if (!postId) return { outcome: 'not-eligible' };

  // The creation's saved inputs, which the recipe's copies are named after.
  const rowsResult = await adminSupabase
    .from('generation_input_media')
    .select('id')
    .eq('generation_id', generationId);
  if (rowsResult.error) {
    logBackendError('failed_to_load_inputs_for_recipe_copy_import', { error: rowsResult.error });
    return { outcome: 'failed' };
  }
  const inputRowIds = ((rowsResult.data ?? []) as Array<{ id: string }>).map((row) => row.id);
  if (inputRowIds.length === 0) return { outcome: 'not-eligible' };

  let copies: Awaited<ReturnType<typeof loadGenerationRecipeReferenceCopiesByPostId>>;
  try {
    copies = await (params.dependencies?.loadGenerationRecipeReferenceCopiesByPostId ?? loadGenerationRecipeReferenceCopiesByPostId)({
      postId,
      generationId,
      viewerUserId: params.viewerUserId,
      inputRowIds,
      adminSupabase,
      signUrls: false,
    });
  } catch (error) {
    logBackendError('failed_to_load_recipe_for_recipe_copy_import', { error });
    return { outcome: 'failed' };
  }
  const storagePathKey = `${RECIPE_FILES_BUCKET}/${location.filePath}`;
  if (![...copies.values()].some((copy) => copy.storagePath === storagePathKey)) {
    return { outcome: 'not-eligible' };
  }

  // The shared import's destination, beside its copies: deterministic, so a retry or a
  // second remix reuses the one copy, and the run keeps working whatever the seller edits.
  const destinationFilePath = `${params.viewerUserId}/${REMIX_IMPORT_FOLDER}/${generationId}/${fileName}`;
  const copyResult = await adminSupabase.storage
    .from(RECIPE_FILES_BUCKET)
    .copy(location.filePath, destinationFilePath, { destinationBucket: GENERATION_INPUTS_BUCKET });
  if (copyResult.error && !isAlreadyExistsStorageError(copyResult.error)) {
    logBackendError('failed_to_copy_recipe_copy_for_import', { error: copyResult.error });
    return { outcome: 'failed' };
  }

  const signedResult = await adminSupabase.storage
    .from(GENERATION_INPUTS_BUCKET)
    .createSignedUrl(destinationFilePath, SIGNED_URL_TTL_SECONDS);
  if (signedResult.error || !signedResult.data?.signedUrl) {
    logBackendError('failed_to_sign_imported_recipe_copy', { error: signedResult.error });
    return { outcome: 'failed' };
  }

  return {
    outcome: 'imported',
    storagePath: `${GENERATION_INPUTS_BUCKET}/${destinationFilePath}`,
    signedUrl: signedResult.data.signedUrl,
  };
}
