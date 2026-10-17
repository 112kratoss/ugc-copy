import type { ShowcaseFeedItem } from '@/lib/showcase';

/**
 * What a recipe that costs nothing is called wherever a post is listed. The app
 * says the same words: `contracts/feed-recipe-chip-v1.json` holds both to them.
 */
export const FREE_RECIPE_LABEL = 'Free recipe';

/**
 * Whether the recipe costs the viewer nothing. Branch for branch the question
 * `getAssetAccessLabel` answers with "Free recipe", so the two cannot disagree
 * about which posts are for sale. The credit price decides, as in the app
 * (`homeRecipeChip`): the viewer's cash quote no longer reaches a chip, so it
 * has no say in whether one reads free.
 */
export function isFreeRecipeAsset(asset: NonNullable<ShowcaseFeedItem['asset']>): boolean {
    return asset.accessMode === 'free' || asset.priceUsdCents <= 0;
}

/**
 * A recipe's price in the app's words (`formatUnlockCreditPrice` in
 * ugc-mobile/lib/pricing.ts): one credit per US cent, grouped in the app's
 * pinned `en-IN` locale (1,25,000), "credit" for exactly one.
 */
export function formatRecipeCreditPrice(priceUsdCents: number): string {
    const credits = Math.max(0, Math.trunc(priceUsdCents));
    return `${credits.toLocaleString('en-IN')} ${credits === 1 ? 'credit' : 'credits'}`;
}

/**
 * How a post's attached resource bundle is labelled on a chip wherever a post
 * is listed: "Free recipe" or "250 credits", the app's words for the same
 * recipe. It printed the viewer's cash quote ("$2.50", "₹210") where the app
 * printed credits; the buttons and price pills that offer both ways to pay
 * keep the cash figure (`formatPostResourcePriceLabel`). Shared by the
 * Showcase grid, the reel, the feed and the creator page so they never drift
 * on wording like "Free recipe" vs "Free unlock".
 */
export function getAssetAccessLabel(asset: NonNullable<ShowcaseFeedItem['asset']>): string {
    return isFreeRecipeAsset(asset) ? FREE_RECIPE_LABEL : formatRecipeCreditPrice(asset.priceUsdCents);
}
