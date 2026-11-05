import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  isRemixRecipeMode,
  remixRecipeRefusal,
  type RemixRecipeMode,
} from '../../ugc-mobile/lib/creation-recipe/creation-recipe';

/**
 * The terms a creation's run carries as a remix, written by the database when
 * the run starts (`record_generation_remix_terms`,
 * 20261105123244_remix_runs_record_their_recipe_terms.sql): whether the post it
 * remixed had a free or a paid recipe, which recipe, and the chain's first
 * creation. All null for a creation that remixed nobody else's post.
 */
export type RemixRecipeTerms = {
  mode: RemixRecipeMode | null;
  bundleId: string | null;
  originGenerationId: string | null;
};

export const NO_REMIX_RECIPE_TERMS: RemixRecipeTerms = { mode: null, bundleId: null, originGenerationId: null };

export const REMIX_RECIPE_TERMS_UNREADABLE_ERROR = "Could not check this creation's remix terms. Try again.";

type RemixRecipeTermsRow = {
  remix_recipe_mode: string | null;
  remix_recipe_bundle_id: string | null;
  remix_origin_generation_id: string | null;
};

/**
 * Reads a creation's remix terms with the service client (clients hold no read
 * on `generations`). A read that fails throws: the publish and edit routes then
 * refuse rather than let a paid remix go public under a free recipe.
 */
export async function loadRemixRecipeTerms(
  supabase: SupabaseClient,
  generationId: string,
): Promise<RemixRecipeTerms> {
  const { data, error } = await supabase
    .from('generations')
    .select('remix_recipe_mode, remix_recipe_bundle_id, remix_origin_generation_id')
    .eq('id', generationId)
    .maybeSingle();

  if (error) throw error;
  const row = data as RemixRecipeTermsRow | null;
  if (!row) return NO_REMIX_RECIPE_TERMS;

  return {
    mode: isRemixRecipeMode(row.remix_recipe_mode) ? row.remix_recipe_mode : null,
    bundleId: row.remix_recipe_bundle_id ?? null,
    originGenerationId: row.remix_origin_generation_id ?? null,
  };
}

/**
 * The 400 body for a public post whose recipe breaks its creation's remix
 * terms (`accessMode` 'none' is no recipe), or null where it keeps them.
 */
export function getRemixRecipeTermsRefusalBody(
  terms: Pick<RemixRecipeTerms, 'mode'>,
  accessMode: string | null | undefined,
): { error: string; code: string; field: 'resourceBundle' } | null {
  const refusal = remixRecipeRefusal(terms.mode, accessMode ?? 'none');
  return refusal ? { ...refusal, field: 'resourceBundle' } : null;
}
