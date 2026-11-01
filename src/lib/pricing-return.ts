/**
 * Pricing's way back (`/pricing?returnTo=`). A top-up pressed in the middle of something says
 * where that was, and Pricing offers it back at its top and beside a settled payment, named by
 * where it goes. Pricing takes back only a path on this site (`resolvePricingReturnTo`, beside
 * the recipe's own top-up link, `buildRecipeTopUpHref`, in `src/app/showcase/recipe-reading.ts`).
 */

/** The creators a remix opens in, `?remix=<generation>&remixPost=<post>`. */
export type RemixCreatorPath = '/create-image' | '/create-video' | '/create-motion';

const REMIX_CREATOR_PATHS: ReadonlySet<string> = new Set<RemixCreatorPath>(['/create-image', '/create-video', '/create-motion']);

/**
 * Top up on a remix: Pricing, told the remix to come back to. A remix's form is never saved as
 * a draft, so the way back is the remix's own address, which opens it on its original again.
 */
export function buildRemixTopUpHref(creatorPath: RemixCreatorPath, remixId: string, remixPostId: string | null): string {
  const remix = new URLSearchParams({ remix: remixId });
  if (remixPostId) remix.set('remixPost', remixPostId);
  return `/pricing?returnTo=${encodeURIComponent(`${creatorPath}?${remix.toString()}`)}`;
}

/**
 * Pricing's words for a way back: to a recipe (its `#recipe` anchor, which
 * `buildRecipeTopUpHref` puts on the post's path), to a remix in one of the creators, or to
 * any other page.
 */
export function pricingReturnLabel(returnTo: string): string {
  const hashIndex = returnTo.indexOf('#');
  if (hashIndex >= 0 && returnTo.slice(hashIndex) === '#recipe') return 'Back to the recipe';
  const path = hashIndex >= 0 ? returnTo.slice(0, hashIndex) : returnTo;
  const queryIndex = path.indexOf('?');
  if (
    queryIndex >= 0
    && REMIX_CREATOR_PATHS.has(path.slice(0, queryIndex))
    && new URLSearchParams(path.slice(queryIndex + 1)).get('remix')
  ) {
    return 'Back to your remix';
  }
  return 'Go back';
}
