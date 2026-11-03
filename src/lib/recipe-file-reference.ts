import type { SupabaseClient } from '@supabase/supabase-js';

import { resolveGenerationMediaSource, type GenerationMediaSourceOptions } from '@/lib/generation-services';
import { isRecipeImportSource, RECIPE_FILES_BUCKET } from '@/lib/recipe-file-paths';
import { getCanonicalStoredMediaLocation, getUserOwnedStoredMediaLocation } from '@/lib/storage-ownership';

/**
 * A reference that a start sends the provider as given, resolved first where it can be a recipe file:
 * a motion run's character image (`startMotionGeneration` resolves neither of its inputs, and its clip
 * is resolved to be measured), on the app's and the web's starts and a workflow's or a template's step
 * alike. A remix of an unlocked recipe restores that picture from the recipe's copy, a link to the
 * seller's file that went straight to the provider, with no unlock read again and failing there once its
 * hour ran out (2026-11-03). Resolved, a copy, a start's import of one and a kept input of the caller's
 * own (which may be marked as one) are checked against the unlock and imported again
 * (`reuseRecipeFile`), or refused; anything else goes as it went.
 */
export async function resolveRecipeFileReference(
  supabase: SupabaseClient,
  url: string,
  userId: string,
  options: GenerationMediaSourceOptions = {},
  resolve: typeof resolveGenerationMediaSource = resolveGenerationMediaSource,
): Promise<string> {
  const mayBeRecipeFile = Boolean(getCanonicalStoredMediaLocation(url, { allowedBuckets: [RECIPE_FILES_BUCKET] }))
    || isRecipeImportSource(url)
    || Boolean(getUserOwnedStoredMediaLocation(url, userId, { allowedBuckets: ['generation_inputs'] }));
  return mayBeRecipeFile ? resolve(supabase, url, userId, options) : url;
}
