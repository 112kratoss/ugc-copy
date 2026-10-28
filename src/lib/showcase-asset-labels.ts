import type { ShowcaseFeedItem } from '@/lib/showcase';

/**
 * What a recipe that costs nothing is called wherever a post is listed. The app
 * says the same words: `contracts/feed-recipe-chip-v1.json` holds both to them.
 */
export const FREE_RECIPE_LABEL = 'Free recipe';

/** A recipe the signed-in viewer has, bought or opened free, in place of its price. */
export const RECIPE_UNLOCKED_LABEL = 'Unlocked';

/** The viewer's own recipe, on their own post. */
export const OWN_RECIPE_LABEL = 'Your recipe';

/**
 * Whether the recipe costs the viewer nothing. Branch for branch the question
 * `getAssetAccessLabel` answers with "Free recipe", so the two cannot disagree
 * about which posts are for sale. The credit price decides, as in the app
 * (`homeRecipeChip`): the viewer's cash quote no longer reaches a chip, so it
 * has no say in whether one reads free.
 */
export function isFreeRecipeAsset(asset: Pick<NonNullable<ShowcaseFeedItem['asset']>, 'accessMode' | 'priceUsdCents'>): boolean {
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
 * What the recipe asks of anyone who has not got it: "Free recipe" or "250
 * credits", whoever is looking. The locked Remix pill wears it, since it is
 * drawn only while the recipe is not the viewer's.
 */
export function getRecipeOfferLabel(asset: Pick<NonNullable<ShowcaseFeedItem['asset']>, 'accessMode' | 'priceUsdCents'>): string {
    return isFreeRecipeAsset(asset) ? FREE_RECIPE_LABEL : formatRecipeCreditPrice(asset.priceUsdCents);
}

/**
 * How a post's attached resource bundle is labelled on a chip wherever a post
 * is listed: "Free recipe" or "250 credits", the app's words for the same
 * recipe. It printed the viewer's cash quote ("$2.50", "₹210") where the app
 * printed credits; the buttons and price pills that offer both ways to pay
 * keep the cash figure (`formatPostResourcePriceLabel`). Shared by the
 * Showcase grid, the reel, the feed and the creator page so they never drift
 * on wording like "Free recipe" vs "Free unlock".
 *
 * A recipe the viewer already has says "Unlocked", and their own "Your
 * recipe", in place of the price: a bought recipe kept its price on every
 * card (audit B-F2, 2026-10-27). Whether the viewer has it rides on the
 * listing (`viewerHasUnlocked`); whether it is theirs is the caller's to say.
 */
export function getAssetAccessLabel(
    asset: Pick<NonNullable<ShowcaseFeedItem['asset']>, 'accessMode' | 'priceUsdCents' | 'viewerHasUnlocked'>,
    viewer: { isOwner?: boolean } = {},
): string {
    if (viewer.isOwner) return OWN_RECIPE_LABEL;
    if (asset.viewerHasUnlocked) return RECIPE_UNLOCKED_LABEL;
    return getRecipeOfferLabel(asset);
}
