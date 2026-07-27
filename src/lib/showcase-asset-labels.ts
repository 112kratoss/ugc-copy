import { formatBundleAccessLabel } from '@/lib/marketplace-trust';
import { getBundleAccessLabel } from '@/lib/post-resource-bundles';
import { isGenerationRecipeAssetId, type ShowcaseFeedItem } from '@/lib/showcase';

/**
 * How a post's attached resource bundle is labelled wherever a post is listed.
 * Shared by the Showcase grid and the feed so the two never drift on wording
 * like "Free recipe" vs "Free unlock".
 */
export function getAssetAccessLabel(asset: NonNullable<ShowcaseFeedItem['asset']>): string {
    if (isGenerationRecipeAssetId(asset.id)) {
        return 'Free recipe';
    }

    if (asset.priceQuote) {
        return formatBundleAccessLabel({
            accessMode: asset.accessMode,
            priceQuote: asset.priceQuote,
        }).replace(/\s+unlock$/i, ' recipe');
    }

    return getBundleAccessLabel(asset.accessMode, asset.priceUsdCents).replace(/\s+unlock$/i, ' recipe');
}
