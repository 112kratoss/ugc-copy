import { CREATOR_PAGE_PATHS } from '@/lib/creator-pages';
import { remixToolCreatePath, type RemixTool } from '@/lib/remix-tools';

/**
 * Pricing's way back (`/pricing?returnTo=`). A top-up pressed in the middle of something says
 * where that was, and Pricing offers it back at its top and beside a settled payment, named by
 * where it goes. Pricing takes back only a path on this site (`resolvePricingReturnTo`, beside
 * the recipe's own top-up link, `buildRecipeTopUpHref`, in `src/app/showcase/recipe-reading.ts`).
 */

/** Where a recipe's top-up comes back to on its post's page (`buildRecipeTopUpHref`). */
export const RECIPE_RETURN_ANCHOR = '#recipe';

const CREATOR_PATHS: ReadonlySet<string> = new Set<string>(CREATOR_PAGE_PATHS);

const PATH_BASE = 'https://magicbooklet.local';

/** Pricing, told the path on this site to offer back. */
export function buildPricingHref(returnTo: string): string {
  return `/pricing?returnTo=${encodeURIComponent(returnTo)}`;
}

/**
 * Top up on a remix: Pricing, told the remix to come back to. A remix's form is never saved as
 * a draft, so the way back is the remix's own address, which opens it on its original again.
 */
export function buildRemixTopUpHref(tool: RemixTool, remixId: string, remixPostId: string | null): string {
  const remix = new URLSearchParams({ remix: remixId });
  if (remixPostId) remix.set('remixPost', remixPostId);
  return buildPricingHref(`${remixToolCreatePath(tool)}?${remix.toString()}`);
}

/** Pricing's words for a way back: to a recipe, to a remix in one of the creators, or to any other page. */
export function pricingReturnLabel(returnTo: string): string {
  try {
    const { pathname, searchParams, hash } = new URL(returnTo, PATH_BASE);
    if (hash === RECIPE_RETURN_ANCHOR) return 'Back to the recipe';
    if (CREATOR_PATHS.has(pathname) && searchParams.get('remix')) return 'Back to your remix';
  } catch {
    // Not a path this can read: it is named as any other page is.
  }
  return 'Go back';
}
