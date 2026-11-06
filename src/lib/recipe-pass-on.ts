import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendError } from '@/lib/backend-logger';
import {
  generationReferenceCopyFolder,
  parseGenerationReferenceCopyPath,
  RECIPE_FILES_BUCKET,
} from '@/lib/recipe-file-paths';
import { getCanonicalStoredMediaLocation } from '@/lib/storage-ownership';

/**
 * What a remix's recipe passes on of the recipe its run remixed (remix plan, phase 1b; owner,
 * 2026-11-05: a remix's recipe holds what its run used, and a remix pays the post it remixed in full).
 *
 * B's run used A's recipe's copies of A's creation's inputs through B's unlock, and keeps each as an
 * input marked as a recipe file (`isRecipeFileInput`), recording the copy it stands for. Those copies
 * sit in one folder, `post_resource_files/<A>/generation-references/<A's creation>/`, the folder of the
 * recipe the database recorded for B's run as it started (`generations.remix_recipe_bundle_id`, which
 * B's own re-runs inherit). An input standing for a copy in that folder goes on into B's recipe
 * (`passesOnRecipeFile`); a file of any other recipe never does.
 *
 * Each copy passed on records where it came from (`recipe_copy_sources`, written before the copy), and
 * is served only while that file is still its holder's to read (`recipe_copy_source_withheld_at`): a
 * refund, a retracted purchase, or A's creation removed or archived closes B's copy too.
 */

/** The folder of a recipe's copies of its creation's inputs, bucket-qualified, with its trailing slash. */
export function recipePassOnFolder(recipeOwnerUserId: string, recipeCreationId: string): string {
  return `${RECIPE_FILES_BUCKET}/${generationReferenceCopyFolder(recipeOwnerUserId, recipeCreationId)}`;
}

type RunRecipeRef = { id: string; remixRecipeBundleId: string | null | undefined };

/**
 * The folder each of these runs passes on from: that of the recipe the run remixed, whose creation is
 * its post's (or the creation that post lost to a delete, whose copies keep their folder). Runs that
 * remixed no recipe are left out, as is one whose recipe or post is gone. Throws when a read fails, so
 * a caller never takes a failure for "nothing to pass on" or for leave to pass on.
 */
export async function loadRecipePassOnFolders(
  supabase: SupabaseClient,
  runs: readonly RunRecipeRef[],
): Promise<Map<string, string>> {
  const folders = new Map<string, string>();
  const bundleIds = [...new Set(runs.flatMap((run) => (run.remixRecipeBundleId ? [run.remixRecipeBundleId] : [])))];
  if (bundleIds.length === 0) return folders;

  const { data: bundles, error: bundleError } = await supabase
    .from('post_resource_bundles')
    .select('id, owner_user_id, post_id')
    .in('id', bundleIds);
  if (bundleError) throw bundleError;
  const bundleRows = (bundles ?? []) as Array<{ id: string; owner_user_id: string | null; post_id: string | null }>;
  const postIds = [...new Set(bundleRows.flatMap((bundle) => (bundle.post_id ? [bundle.post_id] : [])))];
  if (postIds.length === 0) return folders;

  const { data: posts, error: postError } = await supabase
    .from('posts')
    .select('id, generation_id, deleted_generation_id')
    .in('id', postIds);
  if (postError) throw postError;
  const creationByPost = new Map(((posts ?? []) as Array<{ id: string; generation_id: string | null; deleted_generation_id: string | null }>)
    .flatMap((post) => {
      const creationId = post.generation_id ?? post.deleted_generation_id;
      return creationId ? [[post.id, creationId] as const] : [];
    }));
  const folderByBundle = new Map(bundleRows.flatMap((bundle) => {
    const creationId = bundle.post_id ? creationByPost.get(bundle.post_id) : undefined;
    return bundle.owner_user_id && creationId ? [[bundle.id, recipePassOnFolder(bundle.owner_user_id, creationId)] as const] : [];
  }));

  for (const run of runs) {
    const folder = run.remixRecipeBundleId ? folderByBundle.get(run.remixRecipeBundleId) : undefined;
    if (folder) folders.set(run.id, folder);
  }
  return folders;
}

/** `loadRecipePassOnFolders` for one run, its recipe read from the run itself: null where it remixed none. */
export async function loadRecipePassOnFolder(supabase: SupabaseClient, generationId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('generations')
    .select('id, remix_recipe_bundle_id')
    .eq('id', generationId)
    .maybeSingle();
  if (error) throw error;
  const run = data as { id: string; remix_recipe_bundle_id: string | null } | null;
  if (!run?.remix_recipe_bundle_id) return null;
  const folders = await loadRecipePassOnFolders(supabase, [{ id: run.id, remixRecipeBundleId: run.remix_recipe_bundle_id }]);
  return folders.get(run.id) ?? null;
}

/**
 * Records where a passed-on copy comes from, before its bytes are copied, so no copy of a recipe file
 * is ever served without it. A copy's path is fixed by its input, and so is the file that input stands
 * for: a row already there is this one. False when the write fails; the copy is then not made.
 */
export async function recordRecipeCopySource(
  supabase: SupabaseClient,
  copy: { copyPath: string; sourceFile: string; holderUserId: string },
): Promise<boolean> {
  const copyPath = copy.copyPath.startsWith(`${RECIPE_FILES_BUCKET}/`) ? copy.copyPath : `${RECIPE_FILES_BUCKET}/${copy.copyPath}`;
  const { error } = await supabase
    .from('recipe_copy_sources')
    .upsert(
      { copy_path: copyPath, source_file: copy.sourceFile, holder_user_id: copy.holderUserId },
      { onConflict: 'copy_path', ignoreDuplicates: true },
    );
  if (error) {
    logBackendError('recipe_copy_source_record_failed', { error });
    return false;
  }
  return true;
}

/**
 * A copy in this account's own recipe files (`post_resource_files/<account>/generation-references/…`),
 * as a path or a storage link, bucket-qualified; null for anything else. Such a copy is the account's
 * own file unless its recipe passed it on (`loadRecipeCopySource`).
 */
export function ownRecipeCopyPath(source: unknown, accountUserId: string): string | null {
  if (typeof source !== 'string' || !source.trim()) return null;
  const location = getCanonicalStoredMediaLocation(source, { allowedBuckets: [RECIPE_FILES_BUCKET] });
  const copy = location ? parseGenerationReferenceCopyPath(location.filePath) : null;
  return copy && copy.ownerUserId === accountUserId ? `${RECIPE_FILES_BUCKET}/${location!.filePath}` : null;
}

/**
 * Where a passed-on copy came from (`recipe_copy_sources`): the recipe file it stands for, null for a
 * copy that was never passed on. `copyPath` is bucket-qualified, as `ownRecipeCopyPath` gives it.
 * Throws when the read fails, so a caller never takes a failure for "the account's own file".
 */
export async function loadRecipeCopySource(
  supabase: SupabaseClient,
  copyPath: string,
): Promise<{ sourceFile: string } | null> {
  const { data, error } = await supabase
    .from('recipe_copy_sources')
    .select('source_file')
    .eq('copy_path', copyPath)
    .maybeSingle();
  if (error) throw error;
  const row = data as { source_file: string } | null;
  return row ? { sourceFile: row.source_file } : null;
}
