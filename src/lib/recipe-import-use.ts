import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendError } from '@/lib/backend-logger';

/**
 * A run start's make or reuse of a recipe import
 * (`generation_inputs/<buyer>/recipe-imports/<seller>/<creation>/<file>`), recorded
 * by the database's clock before the start copies or signs the file
 * (`importGenerationReferenceCopy`, which the generation starts and the Seedance
 * asset prepare both reach through `reuseRecipeFile`).
 *
 * The recipe-copy-sweep job leaves an import alone while it was used in the last
 * hours, and puts one back at once if a use lands after its read
 * (`recipe-copy-sweep.ts`). A start writes its generation row only after it has
 * resolved its inputs, and the Seedance prepare writes none, so this record, not
 * the row, is what tells the sweep an import is in use.
 *
 * False when the record could not be written: the start then answers `failed`
 * (retryable) rather than use an import the sweep could not see, since a fresh
 * import cannot replace one at the same fixed path while another start may be
 * reading it.
 */
export async function recordRecipeImportUse(
  adminSupabase: SupabaseClient,
  buyerUserId: string,
  importFilePath: string,
): Promise<boolean> {
  try {
    const { error } = await adminSupabase.rpc('record_recipe_import_use', {
      p_buyer_user_id: buyerUserId,
      p_object_name: importFilePath,
    });
    if (error) {
      logBackendError('recipe_import_use_record_failed', { error });
      return false;
    }
    return true;
  } catch (error) {
    logBackendError('recipe_import_use_record_failed', { error });
    return false;
  }
}
