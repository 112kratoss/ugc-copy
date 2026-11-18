import type { CreatorOwnership } from '@/lib/creator-ownership';
import { ownRecipeFirstPaintRules } from '@/lib/own-recipe-first-paint';
import { formatPostResourcePriceLabel } from '@/lib/post-resource-bundles';
import type { MarketplaceResourceListItem } from '@/lib/post-resource-bundles-server';
import { getAssetAccessLabel } from '@/lib/showcase-asset-labels';

/**
 * What the marketplace knows of the signed-in viewer. The catalog is one
 * cached page for everyone, so this arrives after it: the viewer from the
 * session, what they have from `/api/me/unlocked-recipes`
 * (`useViewerRecipeState`). Empty for a signed-out viewer, and until the
 * read lands.
 */
export interface MarketplaceViewerState {
  viewerUserId: string | null;
  unlockedBundleIds: ReadonlySet<string>;
  /**
   * Whether a seller's recipe is this viewer's own, as the page knows it at this render
   * (`useCreatorOwnershipResolver`): theirs while their session cookie names them and the check is
   * out too, and `unread` in the server's HTML and the render that hydrates it. Absent, only the
   * viewer the check has named (`viewerUserId`) owns anything.
   */
  ownershipOf?: (sellerId: string) => CreatorOwnership;
}

export const NO_VIEWER_STATE: MarketplaceViewerState = { viewerUserId: null, unlockedBundleIds: new Set() };

/** The unlock action's words on a recipe the viewer has or owns: nothing to pay, so no price. */
const HAS_IT_UNLOCK_LABEL = 'View recipe';

function sellerOwnership(sellerId: string, viewer: MarketplaceViewerState): CreatorOwnership {
  if (viewer.ownershipOf) return viewer.ownershipOf(sellerId);
  return viewer.viewerUserId && sellerId === viewer.viewerUserId ? 'owner' : 'other';
}

/**
 * A tile's words for one recipe and this viewer: the chip prices it in
 * credits, or says "Unlocked" for one they have and "Your recipe" for their
 * own, as every other card does (audit B-F2). The unlock action names the ways
 * to pay, and no price once there is nothing to pay (the glossary: never the
 * price on a recipe the viewer has): it then reads "View recipe".
 *
 * Where no one can be read yet (`unread`: the server's HTML, the same for every
 * viewer, and the render that hydrates it), `ownRecipeMark` names the seller, and
 * the tile draws the seller's words (`ownerAccessLabel`, `ownerUnlockLabel`)
 * beside everyone else's, for the list's rules to show each their own before the
 * first paint (`marketplaceOwnRecipeRules`).
 */
export function getMarketplaceCardAccess(
  asset: Pick<MarketplaceResourceListItem, 'id' | 'accessMode' | 'priceUsdCents' | 'seller'> & {
    priceQuote: Pick<MarketplaceResourceListItem['priceQuote'], 'formatted'>;
  },
  viewer: MarketplaceViewerState,
) {
  const ownership = sellerOwnership(asset.seller.id, viewer);
  const isOwner = ownership === 'owner' || ownership === 'owner-checking';
  const viewerHasUnlocked = viewer.unlockedBundleIds.has(asset.id);
  const isFree = asset.accessMode === 'free' || asset.priceUsdCents === 0;
  const hasIt = isOwner || viewerHasUnlocked;
  const access = { accessMode: asset.accessMode, priceUsdCents: asset.priceUsdCents, viewerHasUnlocked };

  return {
    isFree,
    isOwner,
    viewerHasUnlocked,
    accessLabel: getAssetAccessLabel(access, { isOwner }),
    unlockLabel: hasIt
      ? HAS_IT_UNLOCK_LABEL
      : isFree
        ? 'View free recipe'
        : `Unlock for ${formatPostResourcePriceLabel(asset.priceUsdCents, asset.priceQuote.formatted)}`,
    ownRecipeMark: ownership === 'unread' ? asset.seller.id : undefined,
    ownerAccessLabel: getAssetAccessLabel(access, { isOwner: true }),
    ownerUnlockLabel: HAS_IT_UNLOCK_LABEL,
  };
}

/**
 * The rules that show each viewer their own words on a list's tiles before the first paint
 * (`ownRecipeFirstPaintRules`), for every seller a tile is marked for (`ownRecipeMark`), each once.
 * Empty once the viewer can be read: the tiles then draw their words alone.
 */
export function marketplaceOwnRecipeRules(
  assets: ReadonlyArray<Pick<MarketplaceResourceListItem, 'seller'>>,
  viewer: MarketplaceViewerState,
): string {
  const marked = new Set<string>();
  for (const asset of assets) {
    if (sellerOwnership(asset.seller.id, viewer) === 'unread') marked.add(asset.seller.id);
  }
  return Array.from(marked, ownRecipeFirstPaintRules).join('');
}
