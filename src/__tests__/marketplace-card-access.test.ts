import { describe, expect, it } from 'vitest';

import { NO_VIEWER_STATE, getMarketplaceCardAccess } from '@/app/marketplace/marketplace-card-access';
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
    expect(getMarketplaceCardAccess(paid, viewer)).toMatchObject({ accessLabel: 'Unlocked', unlockLabel: 'View recipe', viewerHasUnlocked: true, priceLabel: null });
    expect(getMarketplaceCardAccess(free, viewer)).toMatchObject({ accessLabel: 'Unlocked', unlockLabel: 'View recipe', viewerHasUnlocked: true, priceLabel: null });
  });

  it("says \"Your recipe\" on the seller's own, whatever else is on record", () => {
    const viewer = { viewerUserId: 'seller-1', unlockedBundleIds: new Set(['bundle-1']) };
    expect(getMarketplaceCardAccess(paid, viewer)).toMatchObject({ accessLabel: 'Your recipe', unlockLabel: 'View recipe', isOwner: true, priceLabel: null });
    expect(getMarketplaceCardAccess(paid, { viewerUserId: null, unlockedBundleIds: new Set() }).isOwner).toBe(false);
  });
});
