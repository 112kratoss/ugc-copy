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
}

export const NO_VIEWER_STATE: MarketplaceViewerState = { viewerUserId: null, unlockedBundleIds: new Set() };

/**
 * A card's words for one recipe and this viewer: the badge prices it in
 * credits, or says "Unlocked" for one they have and "Your recipe" for their
 * own, as every other card does (audit B-F2). The price pill names the ways to
 * pay, and is not drawn once there is nothing to pay (the glossary: never the
 * price on a recipe the viewer has); the card's action then reads "View recipe".
 */
export function getMarketplaceCardAccess(
  asset: Pick<MarketplaceResourceListItem, 'id' | 'accessMode' | 'priceUsdCents' | 'seller'> & {
    priceQuote: Pick<MarketplaceResourceListItem['priceQuote'], 'formatted'>;
  },
  viewer: MarketplaceViewerState,
) {
  const isOwner = Boolean(viewer.viewerUserId) && asset.seller.id === viewer.viewerUserId;
  const viewerHasUnlocked = viewer.unlockedBundleIds.has(asset.id);
  const isFree = asset.accessMode === 'free' || asset.priceUsdCents === 0;
  const priceLabel = isFree ? 'Free' : formatPostResourcePriceLabel(asset.priceUsdCents, asset.priceQuote.formatted);

  const hasIt = isOwner || viewerHasUnlocked;

  return {
    isFree,
    isOwner,
    viewerHasUnlocked,
    priceLabel: hasIt ? null : priceLabel,
    accessLabel: getAssetAccessLabel(
      { accessMode: asset.accessMode, priceUsdCents: asset.priceUsdCents, viewerHasUnlocked },
      { isOwner },
    ),
    unlockLabel: hasIt
      ? 'View recipe'
      : isFree
        ? 'View free recipe'
        : `Unlock for ${priceLabel}`,
  };
}
