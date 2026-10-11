import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import contract from '../../contracts/feed-recipe-chip-v1.json';
import { getPostFeedRecipeChip } from '../lib/post-feed-presentation';
import type { ShowcaseAssetSummary } from '../lib/showcase';
import { FREE_RECIPE_LABEL, getAssetAccessLabel, isFreeRecipeAsset } from '../lib/showcase-asset-labels';

// A feed card used to carry a full-width bar under its media, "Free recipe" on
// the web and "Free unlock" in the app, followed by the post's own title again.
// It is a chip at the end of the action row now, drawn only where it says
// something the row does not: a price, or a free recipe on a card with no Remix.
// Web and app share no module (this suite cannot load an app file: the web
// workspace never installs the app's dependencies), so both suites answer the
// same contract: this one for the web's rule,
// `ugc-mobile/__tests__/home-feed-view-model.test.ts` for the app's.
function asset(fields: { accessMode: string; priceUsdCents: number }): ShowcaseAssetSummary {
  return {
    id: 'bundle-1',
    postId: 'post-1',
    title: 'A launch frame',
    previewText: '',
    allowRemix: false,
    ...fields,
  } as ShowcaseAssetSummary;
}

describe("a feed card's recipe chip, on the web and in the app", () => {
  it.each(contract.cases)('draws $name as the contract says', ({ asset: fields, remix, chip }) => {
    const drawn = getPostFeedRecipeChip({ asset: fields ? asset(fields) : null, canRemix: remix });

    expect(drawn).toEqual(chip ? { tone: chip.tone, label: chip.label.web } : null);
  });

  it('is asked the same cases by the app', () => {
    const appTest = readFileSync('ugc-mobile/__tests__/home-feed-view-model.test.ts', 'utf8');

    expect(appTest).toContain("from '../../contracts/feed-recipe-chip-v1.json'");
    expect(appTest).toContain('it.each(feedRecipeChipContract.cases)');
  });

  it('calls a recipe that costs nothing by one name on both', () => {
    expect(FREE_RECIPE_LABEL).toBe(contract.freeLabel);
    expect(readFileSync('ugc-mobile/lib/pricing.ts', 'utf8'))
      .toContain(`export const FREE_RECIPE_LABEL = '${contract.freeLabel}';`);
  });

  // "Free unlock" was the app's name for the same thing on its Explore tiles,
  // its reel, its profile tiles and its marketplace page.
  it.each([
    'ugc-mobile/lib/showcase-feed-view-model.ts',
    'ugc-mobile/lib/immersive-preview-view-model.ts',
    'ugc-mobile/lib/profile-view-model.ts',
    'ugc-mobile/lib/home-feed-view-model.ts',
    'ugc-mobile/app/marketplace/[assetId].tsx',
  ])('leaves no other name for it in %s', (file) => {
    const source = readFileSync(file, 'utf8');

    // The label itself; a comment may still speak of a free unlock, the act.
    expect(source).not.toMatch(/['"`]Free unlock['"`]/);
    expect(source).toContain('FREE_RECIPE_LABEL');
  });

  // The chip decides "for sale" and the label words it: one must not call a
  // recipe free while the other prints a price.
  it.each([
    { id: 'bundle-1', accessMode: 'free', priceUsdCents: 0 },
    { id: 'bundle-1', accessMode: 'free', priceUsdCents: 500 },
    { id: 'bundle-1', accessMode: 'paid', priceUsdCents: 0 },
    { id: 'bundle-1', accessMode: 'paid', priceUsdCents: 250 },
    { id: 'generation-recipe:gen-1', accessMode: 'paid', priceUsdCents: 250 },
    {
      id: 'bundle-1',
      accessMode: 'paid',
      priceUsdCents: 250,
      priceQuote: { formatted: '₹210', amountSubunits: 21000 },
    },
    {
      id: 'bundle-1',
      accessMode: 'paid',
      priceUsdCents: 250,
      priceQuote: { formatted: '₹0', amountSubunits: 0 },
    },
  ])('agrees with the label about whether $id at $accessMode/$priceUsdCents is free', (fields) => {
    const summary = { ...asset(fields), ...fields } as ShowcaseAssetSummary;

    expect(isFreeRecipeAsset(summary)).toBe(getAssetAccessLabel(summary) === FREE_RECIPE_LABEL);
  });

  it('gives the web card the chip from its model, and no bar of its own', () => {
    const card = readFileSync('src/app/feed/FeedPostCard.tsx', 'utf8');

    expect(card).toContain('{card.recipeChip ? (');
    expect(card).toContain('{card.recipeChip.label}');
    // The bar named the recipe by its title, which is the post's title again.
    expect(card).not.toContain('item.asset.title');
    expect(card).not.toContain('getAssetAccessLabel');
  });
});
