import { describe, expect, it } from 'vitest';

import { NO_VIEWER_STATE, getMarketplaceCardAccess, marketplaceOwnRecipeRules } from '@/app/marketplace/marketplace-card-access';
import { ownRecipeFirstPaintRules } from '@/lib/own-recipe-first-paint';
import { formatPostResourcePriceLabel } from '@/lib/post-resource-bundles';

const paid = {
  id: 'bundle-1',
  accessMode: 'paid' as const,
  priceUsdCents: 900,
  priceQuote: { formatted: '$9.00', note: null, currency: 'USD', amount: 9 },
  seller: { id: 'seller-1', username: 'maya', name: 'Maya', avatar: null },
};
const free = { ...paid, id: 'bundle-2', accessMode: 'free' as const, priceUsdCents: 0 };

// The catalog is one cached page for everyone; the viewer's own state comes
// after it and re-labels the card as every other card is labelled (B-F2).
describe('a marketplace card and its viewer', () => {
  it('prices a recipe for a viewer who has not got it, or no viewer', () => {
    expect(getMarketplaceCardAccess(paid, NO_VIEWER_STATE)).toMatchObject({ accessLabel: '900 credits', unlockLabel: `Unlock for ${formatPostResourcePriceLabel(900, '$9.00')}`, isFree: false });
    expect(getMarketplaceCardAccess(free, NO_VIEWER_STATE)).toMatchObject({ accessLabel: 'Free recipe', unlockLabel: 'View free recipe', isFree: true });
    expect(getMarketplaceCardAccess(paid, { viewerUserId: 'buyer-1', unlockedBundleIds: new Set(['other']) }))
      .toMatchObject({ accessLabel: '900 credits', viewerHasUnlocked: false, isOwner: false });
  });

  // The glossary: a recipe the viewer has reads "Unlocked", never its price.
  it('says "Unlocked" and "View recipe" for a recipe the viewer has, free or paid, with no price', () => {
    const viewer = { viewerUserId: 'buyer-1', unlockedBundleIds: new Set(['bundle-1', 'bundle-2']) };
    expect(getMarketplaceCardAccess(paid, viewer)).toMatchObject({ accessLabel: 'Unlocked', unlockLabel: 'View recipe', viewerHasUnlocked: true });
    expect(getMarketplaceCardAccess(free, viewer)).toMatchObject({ accessLabel: 'Unlocked', unlockLabel: 'View recipe', viewerHasUnlocked: true });
  });

  it("says \"Your recipe\" on the seller's own, whatever else is on record", () => {
    const viewer = { viewerUserId: 'seller-1', unlockedBundleIds: new Set(['bundle-1']) };
    expect(getMarketplaceCardAccess(paid, viewer)).toMatchObject({ accessLabel: 'Your recipe', unlockLabel: 'View recipe', isOwner: true });
    expect(getMarketplaceCardAccess(paid, { viewerUserId: null, unlockedBundleIds: new Set() }).isOwner).toBe(false);
  });
});

// A seller's own cards at their first paint (sweep of 2026-11-17): the page's provider checks the
// session afresh on every visit, and until it named the seller their cards read "Free recipe" and
// "View free recipe". `ownershipOf` is what the page knows of whose a seller's recipe is at a render
// (`useCreatorOwnershipResolver`).
describe('a seller\'s own card before the page has named the viewer', () => {
  const ownership = (bySeller: Record<string, 'owner' | 'owner-checking' | 'unread' | 'other'>) => (
    (sellerId: string) => bySeller[sellerId] ?? 'other'
  );

  it('reads as theirs while their session cookie names them and the check is out', () => {
    const viewer = { viewerUserId: null, unlockedBundleIds: new Set<string>(), ownershipOf: ownership({ 'seller-1': 'owner-checking' }) };
    expect(getMarketplaceCardAccess(free, viewer)).toMatchObject({ accessLabel: 'Your recipe', unlockLabel: 'View recipe', isOwner: true, ownRecipeMark: undefined });
    expect(getMarketplaceCardAccess(paid, viewer)).toMatchObject({ accessLabel: 'Your recipe', unlockLabel: 'View recipe', isOwner: true });
  });

  it('marks the seller where no one can be read yet, with their words beside everyone else\'s', () => {
    const viewer = { viewerUserId: null, unlockedBundleIds: new Set<string>(), ownershipOf: ownership({ 'seller-1': 'unread' }) };
    expect(getMarketplaceCardAccess(free, viewer)).toEqual(expect.objectContaining({
      accessLabel: 'Free recipe',
      unlockLabel: 'View free recipe',
      isOwner: false,
      ownRecipeMark: 'seller-1',
      ownerAccessLabel: 'Your recipe',
      ownerUnlockLabel: 'View recipe',
    }));
    expect(getMarketplaceCardAccess(paid, viewer)).toMatchObject({ accessLabel: '900 credits', ownRecipeMark: 'seller-1', ownerAccessLabel: 'Your recipe' });
  });

  it('offers it to anyone else, unmarked', () => {
    const viewer = { viewerUserId: 'buyer-1', unlockedBundleIds: new Set<string>(), ownershipOf: ownership({}) };
    expect(getMarketplaceCardAccess(free, viewer)).toMatchObject({ accessLabel: 'Free recipe', unlockLabel: 'View free recipe', isOwner: false, ownRecipeMark: undefined });
  });

  it('writes the first-paint rules once for each seller a card is marked for, and none once the viewer is read', () => {
    const other = { ...free, id: 'bundle-3', seller: { id: 'seller-2', username: 'ari', name: 'Ari', avatar: null } };
    const unread = { viewerUserId: null, unlockedBundleIds: new Set<string>(), ownershipOf: ownership({ 'seller-1': 'unread', 'seller-2': 'unread' }) };
    const rules = marketplaceOwnRecipeRules([paid, free, other], unread);
    expect(rules).toBe(ownRecipeFirstPaintRules('seller-1') + ownRecipeFirstPaintRules('seller-2'));
    expect(marketplaceOwnRecipeRules([paid, free, other], { ...unread, ownershipOf: ownership({ 'seller-1': 'owner' }) })).toBe('');
    expect(marketplaceOwnRecipeRules([paid], NO_VIEWER_STATE)).toBe('');
  });
});
