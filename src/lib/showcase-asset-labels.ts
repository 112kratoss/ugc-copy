import { formatBundleAccessLabel } from '@/lib/marketplace-trust';
import type { ShowcaseFeedItem } from '@/lib/showcase';

/**
 * What a recipe that costs nothing is called wherever a post is listed. The app
 * says the same words: `contracts/feed-recipe-chip-v1.json` holds both to them.
 */
export const FREE_RECIPE_LABEL = 'Free recipe';

/**
 * Whether the recipe costs the viewer nothing. Branch for branch the question
 * `getAssetAccessLabel` answers with "Free recipe", so the two cannot disagree
 * about which posts are for sale.
 */
export function isFreeRecipeAsset(asset: NonNullable<ShowcaseFeedItem['asset']>): boolean {
    if (asset.accessMode === 'free') {
        return true;
    }

    return asset.priceQuote ? asset.priceQuote.amountSubunits === 0 : asset.priceUsdCents === 0;
}

/**
 * How a post's attached resource bundle is labelled wherever a post is listed:
 * "Free recipe", "$9.00" (the viewer's quote, where cash is taken) or "50
 * credits". Shared by the Showcase grid, the feed and the creator page so they
 * never drift on wording like "Free recipe" vs "Free unlock".
 */
export function getAssetAccessLabel(asset: NonNullable<ShowcaseFeedItem['asset']>): string {
    return formatBundleAccessLabel({
        accessMode: asset.accessMode,
        priceUsdCents: asset.priceUsdCents,
        priceQuote: asset.priceQuote,
    });
}
