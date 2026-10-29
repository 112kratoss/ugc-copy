import { getSafeInternalReturnPath } from '@/lib/share';

/**
 * How a recipe reads to a buyer on the web: the post page's panel, the reel
 * (which draws the same panel) and the buyer library. What goes together, in
 * which order and under which name is the rule the app reads by too,
 * `ugc-mobile/lib/recipe-reading/recipe-reading.ts`, shared by relative import
 * so the two cannot drift (recipe reading review, 2026-10-29).
 */
export {
  describeRecipeCardPreview,
  describeRecipeFile,
  describeRecipeGroup,
  groupRecipeForReading,
  parseGenerationSetupNotes,
  recipeItemKind,
  recipeLinkLabel,
  recipeMediaKind,
  shouldShowRecipeItemTitle,
  type RecipeGroupKind,
  type RecipeReadingGroup,
} from '../../../ugc-mobile/lib/recipe-reading/recipe-reading';

/** The buyer's library: Studio's "Unlocked recipes" tab. */
export const UNLOCKED_RECIPES_PATH = '/creations?view=unlocks';

/**
 * "Buy credits" from a recipe: Pricing, told where the recipe is so it can
 * offer the way back ("Back to the recipe"). The recipe's own anchor replaces
 * any the path had; the whole path travels encoded, its `#` included.
 */
export function buildRecipeTopUpHref(recipePath: string): string {
  const hashIndex = recipePath.indexOf('#');
  const path = hashIndex >= 0 ? recipePath.slice(0, hashIndex) : recipePath;
  return `/pricing?returnTo=${encodeURIComponent(`${path}#recipe`)}`;
}

/**
 * The recipe Pricing was sent from, if it is a path on this site; anything
 * else (another origin, a scheme, Pricing itself) is no way back.
 */
export function resolvePricingReturnTo(value: string | string[] | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const path = getSafeInternalReturnPath(value, '');
  if (!path || path.startsWith('/pricing')) return null;
  return path;
}
