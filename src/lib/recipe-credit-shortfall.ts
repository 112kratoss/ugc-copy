/**
 * What a recipe's credit unlock tells a buyer short of its price, on the post
 * page and in the reel, in the app's words (`formatBundleUnlockShortfall`,
 * `ugc-mobile/lib/use-bundle-unlock.ts`).
 *
 * The unlock spends only the balance less the welcome and referral credits
 * (`marketplace_spendable_credits`, `unlock_post_resource_bundle_with_credits`),
 * so a new account whose welcome credits cover the price is still short of it,
 * and the note says why.
 */
export const RECIPE_UNSPENDABLE_CREDITS_NOTE = "Welcome and referral credits can't be spent on recipes.";

/**
 * "You need 25 more credits.", with the note after it when part of the balance
 * is welcome or referral credits. Null when the spendable figure is not known
 * (an unknown figure claims nothing) or covers the price.
 */
export function formatRecipeCreditShortfall(
  spendableCredits: number | null,
  creditCost: number,
  { holdsUnspendableCredits }: { holdsUnspendableCredits: boolean },
): string | null {
  if (spendableCredits === null) return null;
  const shortfall = Math.trunc(creditCost) - Math.max(0, Math.trunc(spendableCredits));
  if (shortfall <= 0) return null;
  const message = `You need ${shortfall.toLocaleString('en-US')} more ${shortfall === 1 ? 'credit' : 'credits'}.`;
  return holdsUnspendableCredits ? `${message} ${RECIPE_UNSPENDABLE_CREDITS_NOTE}` : message;
}
