import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendError } from '@/lib/backend-logger';
import { heldRecipeFileOf, type GenerationInputOriginSource } from '@/lib/generation-input-origin';
import { parseGenerationReferenceCopyPath, RECIPE_FILES_BUCKET } from '@/lib/recipe-file-paths';

/**
 * Whether a viewer may use a recipe's file now (owner, 2026-11-04): a buyer's use of the files of a
 * recipe ends with their unlock, and the copies of a creation's inputs stop being served once that
 * creation is removed or archived. Every server read of such a file asks here, and storage asks the
 * same database predicate for a direct read with the viewer's own JWT
 * (`generation_input_object_readable`, 20261103232019):
 *
 * - `loadReadableRecipeFiles`: which of the recipe files a viewer holds they may read now
 *   (`recipe_files_readable_by`): their own; anyone else's only through a purchase that is not
 *   retracted, whose recipe as it stands or bought version still lists the file; and a copy of a
 *   creation's input only while that creation is neither removed nor archived.
 * - `loadWithheldCopies`: which copies are withheld now (`recipe_copies_withheld`), for the reads that
 *   settle the unlock themselves (the recipe's own reads, the remix restore, the run start's import).
 *
 * A remix's recipe passes on the copies of the recipe it remixed (remix plan, phase 1b): such a copy sits
 * under the remix's creation, and is also withheld once the file it came from is closed to its holder
 * (that file's creation removed or archived, a refund or a retracted purchase), down the chain. The
 * database holds where each came from (`recipe_copy_sources`), so both readers ask it there.
 *
 * Nothing is deleted for an archive: un-archiving the creation serves its copies again.
 */

/** The creation a recipe copy is of, from its path in the recipe files, with or without the bucket. */
export function recipeCopyCreationId(path: string | null | undefined): string | null {
  if (typeof path !== 'string' || !path) return null;
  const objectPath = path.startsWith(`${RECIPE_FILES_BUCKET}/`) ? path.slice(RECIPE_FILES_BUCKET.length + 1) : path;
  return parseGenerationReferenceCopyPath(objectPath)?.generationId ?? null;
}

/**
 * Those of these copies withheld from everyone but their publisher now, as given
 * (`recipe_copies_withheld`): their creation is off public view (`creationMayShareRecipe`'s two marks,
 * an operator's removal or its creator's archive), or a copy a remix's recipe passed on stands on a
 * file closed to its holder. A creation deleted outright withholds nothing, as its post keeps serving
 * it (`posts.deleted_generation_id`). Throws when the read fails: a caller withholds everything rather
 * than take a failure for "all shareable".
 */
export async function loadWithheldCopies(
  adminSupabase: SupabaseClient,
  paths: Iterable<string | null | undefined>,
): Promise<Set<string>> {
  const copies = [...new Set([...paths].filter((path): path is string => Boolean(recipeCopyCreationId(path))))];
  if (copies.length === 0) return new Set();
  const { data, error } = await adminSupabase.rpc('recipe_copies_withheld', { p_paths: copies });
  if (error) throw error;
  return new Set(Array.isArray(data) ? (data as unknown[]).filter((path): path is string => typeof path === 'string') : []);
}

/** Whether a path is one of these withheld copies (`loadWithheldCopies`), as it was given. */
export function isWithheldCopy(path: string | null | undefined, withheld: ReadonlySet<string>): boolean {
  return Boolean(path && withheld.has(path));
}

/**
 * Which of these recipe files (`post_resource_files/<seller>/…`) the viewer may read now, as given.
 * Throws when the read fails, so a caller never takes a failure for leave to read.
 */
export async function loadReadableRecipeFiles(
  adminSupabase: SupabaseClient,
  viewerUserId: string,
  files: Iterable<string>,
): Promise<Set<string>> {
  const paths = [...new Set([...files].filter(Boolean))];
  if (paths.length === 0) return new Set();
  const { data, error } = await adminSupabase.rpc('recipe_files_readable_by', {
    p_viewer_user_id: viewerUserId,
    p_paths: paths,
  });
  if (error) throw error;
  return new Set(Array.isArray(data) ? (data as unknown[]).filter((path): path is string => typeof path === 'string') : []);
}

type HeldInput = GenerationInputOriginSource & { url: string | null };

/**
 * A holder's inputs, those that are a recipe file they may no longer read without their link
 * (`heldRecipeFileOf`): a run's kept input made from a recipe file and a run start's import of one,
 * after a refund or a retracted purchase, or once the copy's creation is removed or archived. An input
 * marked as a recipe file whose file is on no record loses its link too. A read that fails withholds
 * every recipe file of the call, never an input of the holder's own.
 */
export async function withholdUnreadableRecipeFileInputs<T extends HeldInput>(params: {
  adminSupabase: SupabaseClient;
  holderUserId: string;
  items: readonly T[];
}): Promise<T[]> {
  const holder = new Set([params.holderUserId]);
  const held = new Map<T, string>();
  for (const item of params.items) {
    if (!item.url) continue;
    const file = heldRecipeFileOf(item, holder);
    if (file !== null) held.set(item, file);
  }
  if (held.size === 0) return [...params.items];

  let readable = new Set<string>();
  try {
    readable = await loadReadableRecipeFiles(
      params.adminSupabase,
      params.holderUserId,
      [...held.values()].filter(Boolean),
    );
  } catch (error) {
    logBackendError('held_recipe_file_access_read_failed', { error });
  }
  return params.items.map((item) => {
    const file = held.get(item);
    return file === undefined || (file && readable.has(file)) ? item : { ...item, url: null };
  });
}

/**
 * A recipe as someone other than its seller reads it, without the copies of a creation now off public
 * view: its items and its attachments, both of which the file routes sign (the post's recipe for a
 * buyer, the version they bought). In place, on each of the resources given. A read that fails
 * withholds every copy among them, never another file. The seller's own editor is not read through
 * here: the copies are their files, and a save that dropped them would lose them for an un-archive.
 */
export async function withholdCopiesOfCreationsOffView(
  adminSupabase: SupabaseClient,
  resourcesList: ReadonlyArray<{
    items?: Array<{ storagePath?: string | null }>;
    attachments?: Array<{ storagePath?: string | null }>;
  } | null | undefined>,
): Promise<void> {
  const resources = resourcesList.filter((value): value is NonNullable<typeof value> => Boolean(value));
  const paths = resources.flatMap((value) => [...(value.items ?? []), ...(value.attachments ?? [])].map((entry) => entry.storagePath ?? null));
  if (!paths.some((path) => recipeCopyCreationId(path))) return;
  let withheld: ReadonlySet<string> | null = null;
  try {
    withheld = await loadWithheldCopies(adminSupabase, paths);
  } catch (error) {
    logBackendError('recipe_copy_creation_state_read_failed', { error });
  }
  const kept = (entry: { storagePath?: string | null }) => (
    withheld ? !isWithheldCopy(entry.storagePath, withheld) : !recipeCopyCreationId(entry.storagePath)
  );
  for (const value of resources) {
    if (value.items) value.items = value.items.filter(kept);
    if (value.attachments) value.attachments = value.attachments.filter(kept);
  }
}
