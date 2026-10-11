import { formatBundleAccessLabel } from '@/lib/marketplace-trust';
import { getBundleAccessLabel } from '@/lib/post-resource-bundles';
import { isGenerationRecipeAssetId, type ShowcaseFeedItem } from '@/lib/showcase';

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
    if (isGenerationRecipeAssetId(asset.id) || asset.accessMode === 'free') {
        return true;
    }

    return asset.priceQuote ? asset.priceQuote.amountSubunits === 0 : asset.priceUsdCents === 0;
}

/**
 * How a post's attached resource bundle is labelled wherever a post is listed.
 * Shared by the Showcase grid and the feed so the two never drift on wording
 * like "Free recipe" vs "Free unlock".
 */
export function getAssetAccessLabel(asset: NonNullable<ShowcaseFeedItem['asset']>): string {
    if (isGenerationRecipeAssetId(asset.id)) {
        return FREE_RECIPE_LABEL;
    }

    if (asset.priceQuote) {
        return formatBundleAccessLabel({
            accessMode: asset.accessMode,
            priceQuote: asset.priceQuote,
        }).replace(/\s+unlock$/i, ' recipe');
    }

    return getBundleAccessLabel(asset.accessMode, asset.priceUsdCents).replace(/\s+unlock$/i, ' recipe');
}
