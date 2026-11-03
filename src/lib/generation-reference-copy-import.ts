import type { SupabaseClient } from '@supabase/supabase-js';

import { isGuestUser } from '@/lib/account-identity';
import { logBackendError } from '@/lib/backend-logger';
import { isRecipeFileInput, recipeFileCopyOf } from '@/lib/generation-input-origin';
import { isAlreadyExistsStorageError, type SharedInputMediaImportResult } from '@/lib/generation-input-media-import';
import { isUserRelationshipBlocked } from '@/lib/moderation-service';
import { loadGenerationRecipeReferenceCopies } from '@/lib/post-resource-bundles-server';
import {
  isRecipeImportSource,
  parseGenerationReferenceCopyPath,
  RECIPE_FILES_BUCKET,
  RECIPE_IMPORT_FOLDER,
  recipeCopyOfSource,
  recipeImportPath,
} from '@/lib/recipe-file-paths';
import { resolveRemixAccess, type RemixAccessGeneration } from '@/lib/remix-access';
import { createServiceClient } from '@/lib/server-helpers';
import { getCanonicalStoredMediaLocation, getUserOwnedStoredMediaLocation } from '@/lib/storage-ownership';

/** Where a run start keeps another account's media it may use: as `importSharedGenerationInputMedia` does. */
const GENERATION_INPUTS_BUCKET = 'generation_inputs';
const SIGNED_URL_TTL_SECONDS = 3600;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** What the remix gate reads of a creation, its run links included (`RemixAccessGeneration`). */
const GENERATION_SELECT = 'id, user_id, is_public, share_input_media_for_remix, template_run_id, template_run_step_id';

/** What one run start has read of a viewer's unlock of a creation: the copies it lets them import, or why none. */
type RecipeCopyAccess =
  | { outcome: 'entitled'; copyPaths: ReadonlySet<string> }
  | { outcome: 'not-eligible' }
  | { outcome: 'failed' };

/**
 * One run start's reads of its caller's unlocks, by creation. A remix of an unlocked recipe can
 * restore several of its copies, and a start resolves each reference on its own (at once, or stage by
 * stage), so each read the gate, the recipe and the creation's rows again. Shared by a start's
 * references, the unlock is read once per creation for the whole run, and still at every start.
 */
export type RecipeCopyReads = Map<string, Promise<RecipeCopyAccess>>;

export function createRecipeCopyReads(): RecipeCopyReads {
  return new Map();
}

export interface GenerationReferenceCopyImportDependencies {
  createServiceClient?: typeof createServiceClient;
  isUserRelationshipBlocked?: typeof isUserRelationshipBlocked;
  loadGenerationRecipeReferenceCopies?: typeof loadGenerationRecipeReferenceCopies;
}

/**
 * Whether the viewer may reuse the copies the recipe on this creation's post holds, read now, and
 * which: entitlement to reuse, not to read. The remix source's own gate (`resolveRemixAccess`) first,
 * as `/api/remix-source` asks it, after refusing a guest anyone else's creation as that route does:
 * the post shows the creation (public, not archived, visible to moderation, its creator's own), the
 * generation is still public, it is no template's result, and neither has blocked the other. A post
 * deleted since (its tombstone takes the generation private) refuses too. Then the recipe's copies,
 * read on from what the gate read (`loadGenerationRecipeReferenceCopies`): the recipe as it stands and
 * the version the viewer bought, a retired one included, and none once a refund took the purchase.
 */
async function readRecipeCopyAccess(
  adminSupabase: SupabaseClient,
  viewerUserId: string,
  generationId: string,
  dependencies: GenerationReferenceCopyImportDependencies | undefined,
): Promise<RecipeCopyAccess> {
  const generationResult = await adminSupabase
    .from('generations')
    .select(GENERATION_SELECT)
    .eq('id', generationId)
    .maybeSingle();
  if (generationResult.error) {
    logBackendError('failed_to_load_generation_for_recipe_copy_import', { error: generationResult.error });
    return { outcome: 'failed' };
  }
  const generation = generationResult.data as RemixAccessGeneration | null;
  if (!generation?.user_id) return { outcome: 'not-eligible' };

  try {
    const viewer = await adminSupabase.auth.admin.getUserById(viewerUserId);
    if (viewer.error) throw viewer.error;
    if (!viewer.data.user || isGuestUser(viewer.data.user)) return { outcome: 'not-eligible' };

    const access = await resolveRemixAccess({
      adminSupabase,
      viewerUserId,
      generation,
      dependencies: {
        isUserRelationshipBlocked: dependencies?.isUserRelationshipBlocked ?? isUserRelationshipBlocked,
      },
    });
    // The owner's run reads their own files; a post with no recipe holds no copies.
    if (!access.allowed || access.basis === 'owner' || !access.recipe) return { outcome: 'not-eligible' };

    // The creation's saved inputs, which the recipe's copies are named after.
    const rowsResult = await adminSupabase
      .from('generation_input_media')
      .select('id')
      .eq('generation_id', generation.id);
    if (rowsResult.error) throw rowsResult.error;
    const inputRowIds = ((rowsResult.data ?? []) as Array<{ id: string }>).map((row) => row.id);
    if (inputRowIds.length === 0) return { outcome: 'not-eligible' };

    const copies = await (dependencies?.loadGenerationRecipeReferenceCopies ?? loadGenerationRecipeReferenceCopies)({
      adminSupabase,
      recipe: access.recipe,
      generationId: generation.id,
      viewerUserId,
      inputRowIds,
      signUrls: false,
    });
    return { outcome: 'entitled', copyPaths: new Set([...copies.values()].map((copy) => copy.storagePath)) };
  } catch (error) {
    // A read that fails is retried, never taken for "not theirs", a failed purchase read included.
    logBackendError('failed_to_read_unlock_for_recipe_copy_import', { error });
    return { outcome: 'failed' };
  }
}

/**
 * A recipe's copy of one of its creation's saved inputs, handed to a run start
 * by a remix of that recipe (owner, 2026-11-03).
 *
 * A remix whose creator keeps the run's inputs to themselves restores the ones
 * "Include creation references" copied into the recipe its buyer unlocked
 * (`resolveWithheldRemixInputs`). That copy is the seller's file, in
 * `post_resource_files/<seller>/generation-references/<generation>/<file>`
 * (`parseGenerationReferenceCopyPath`), and a run start takes only the caller's
 * own files, so the remix was refused at Generate. This copies it into the
 * caller's folder, `generation_inputs/<caller>/recipe-imports/<seller>/<generation>/<file>`,
 * once their right to reuse it is read again now (`readRecipeCopyAccess`): the
 * file must be among the copies the version of the recipe they bought holds. A
 * refund, a block, or a post taken down or deleted since the remix ends it; a
 * recipe its seller retired stays its buyers', as their files do. The run's
 * input keeps the mark of a recipe file (`isRecipeFileInput`), so it is never
 * handed on from the caller's creation.
 *
 * `reads` is the start's own memo of those reads, so a start with several
 * references reads each creation's unlock once.
 *
 * Answers as the shared import does: `not-eligible` for anything else, the
 * caller's ownership error then standing, and `failed` (retryable) when a read,
 * the copy or its signing fails.
 */
export async function importGenerationReferenceCopy(params: {
  /** The reference exactly as submitted: a storage path or storage-object URL. */
  source: string;
  viewerUserId: string;
  reads?: RecipeCopyReads;
  dependencies?: GenerationReferenceCopyImportDependencies;
}): Promise<SharedInputMediaImportResult> {
  const location = getCanonicalStoredMediaLocation(params.source, {
    allowedBuckets: [RECIPE_FILES_BUCKET],
  });
  const copy = location ? parseGenerationReferenceCopyPath(location.filePath) : null;
  if (
    !location
    || !copy
    // Both are ids: a segment that is none names no account or creation.
    || !UUID_PATTERN.test(copy.ownerUserId)
    || !UUID_PATTERN.test(copy.generationId)
    // The seller's own copy is theirs: their run reads it as their own file.
    || copy.ownerUserId === params.viewerUserId
  ) {
    return { outcome: 'not-eligible' };
  }

  const adminSupabase = (params.dependencies?.createServiceClient ?? createServiceClient)();
  const readKey = `${params.viewerUserId}:${copy.generationId}`;
  let read = params.reads?.get(readKey);
  if (!read) {
    read = readRecipeCopyAccess(adminSupabase, params.viewerUserId, copy.generationId, params.dependencies);
    params.reads?.set(readKey, read);
  }
  const access = await read;
  if (access.outcome !== 'entitled') return access;
  if (!access.copyPaths.has(`${RECIPE_FILES_BUCKET}/${location.filePath}`)) {
    return { outcome: 'not-eligible' };
  }

  // Deterministic, beside the shared import's own folder, and naming the copy it was made from
  // (`recipeImportPath`): a retry or a second remix reuses the one copy, the run keeps working
  // whatever the seller edits, and a later use of the import is checked against the unlock again.
  const destinationFilePath = recipeImportPath(params.viewerUserId, copy);
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

/** The folders a run start imports another account's media into: no kept input is stored in either. */
const IMPORT_FOLDERS = new Set(['remix-imports', RECIPE_IMPORT_FOLDER]);

/**
 * A recipe file the caller already holds, used again: the seller's copy itself, a run start's import of
 * one (`recipeImportPath`, in anyone's folder), or a kept input of the caller's own marked as one
 * (`isRecipeFileInput`, whose `recipeFile` names its copy). Each is checked as the copy it stands for is
 * and imported again (`importGenerationReferenceCopy`): signed as the caller's own file, a refund or a
 * block since the remix ended nothing (2026-11-03 re-review). Null for anything else, which a start
 * resolves as it always has; an import of another creator's shared input is the shared import's.
 *
 * Answers as the import does, and `failed` (retryable) when a kept input's row cannot be read: unread,
 * it would be signed as the caller's own.
 */
export async function reuseRecipeFile(params: {
  source: string;
  viewerUserId: string;
  reads?: RecipeCopyReads;
  dependencies?: GenerationReferenceCopyImportDependencies;
}): Promise<SharedInputMediaImportResult | null> {
  const own = new Set([params.viewerUserId]);
  let copySource = recipeCopyOfSource(params.source, own);
  // An import whose path names no copy is none a start made: never the caller's own file either.
  if (!copySource && isRecipeImportSource(params.source)) return { outcome: 'not-eligible' };
  if (!copySource) {
    const kept = getUserOwnedStoredMediaLocation(params.source, params.viewerUserId, { allowedBuckets: [GENERATION_INPUTS_BUCKET] });
    if (!kept || IMPORT_FOLDERS.has(kept.filePath.split('/')[1] ?? '')) return null;
    const adminSupabase = (params.dependencies?.createServiceClient ?? createServiceClient)();
    const { data, error } = await adminSupabase
      .from('generation_input_media')
      .select('metadata')
      .eq('user_id', params.viewerUserId)
      .eq('storage_path', `${GENERATION_INPUTS_BUCKET}/${kept.filePath}`)
      .limit(1);
    if (error) {
      logBackendError('failed_to_read_kept_input_for_recipe_file_reuse', { error });
      return { outcome: 'failed' };
    }
    const row = ((data ?? []) as Array<{ metadata: Record<string, unknown> | null }>)[0];
    if (!row || !isRecipeFileInput({ metadata: row.metadata }, own)) return null;
    copySource = recipeFileCopyOf({ metadata: row.metadata }, own);
    if (!copySource) return { outcome: 'not-eligible' };
  }
  return importGenerationReferenceCopy({
    source: copySource,
    viewerUserId: params.viewerUserId,
    reads: params.reads,
    dependencies: params.dependencies,
  });
}
