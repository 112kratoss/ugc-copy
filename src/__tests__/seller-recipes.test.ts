import { describe, expect, it } from 'vitest';

import type { MarketplaceQualityAssessment } from '@/lib/marketplace-trust';
import {
  buildAddRecipeHref,
  buildEditRecipeHref,
  describePaidRecipesNotOnSale,
  filterSellerRecipes,
  formatCount,
  formatPostEngagement,
  formatSellerRecipePrice,
  formatSellerRecipeDetails,
  getPaidRecipesNotOnSale,
  getSellerRecipeState,
  isSellerRecipeOnSale,
  sortSellerRecipes,
  type SellerRecipe,
} from '@/app/marketplace/sell/seller-recipes';

const recipe = (overrides: Partial<SellerRecipe> = {}, post: Partial<NonNullable<SellerRecipe['post']>> = {}): SellerRecipe => ({
  id: 'bundle-1',
  postId: 'post-1',
  title: 'Recipe',
  summary: '',
  previewText: '',
  accessMode: 'paid',
  status: 'published',
  priceUsdCents: 900,
  salesCount: 0,
  freeUnlockCount: 0,
  earningsUsdCents: 0,
  resourceKinds: ['prompt'],
  createdAt: '2026-10-01T00:00:00.000Z',
  quality: { eligible: true, issues: [] },
  post: { id: 'post-1', title: 'Post', visibility: 'public', archivedAt: null, reviewStatus: 'visible', ...post },
  ...overrides,
});

const turnedDown: MarketplaceQualityAssessment = {
  eligible: false,
  issues: [{ code: 'x', field: 'previewText', message: 'Add a preview.' }],
};

describe('a recipe on the seller page', () => {
  it.each([
    ['a live recipe', recipe(), 'live', undefined, undefined],
    ['a post deleted after a sale, whatever else holds', recipe({ status: 'draft' }, { tombstoned: true, visibility: 'private' }), 'ended', 'Deleted · buyers keep access', undefined],
    ['a recipe removed after it was unlocked', recipe({ status: 'draft', retiredAt: '2026-10-03T00:00:00.000Z' }), 'removed', 'Removed · buyers keep access', undefined],
    // Review 2: the database makes a recipe on a private or archived post a
    // draft, so "Draft" alone hid that the post is what to fix.
    ['a draft the database made of a recipe on a private post', recipe({ status: 'draft' }, { visibility: 'private' }), 'not-live', 'Draft · Private post', undefined],
    ['a draft on an archived post', recipe({ status: 'draft' }, { archivedAt: '2026-10-02T00:00:00.000Z', visibility: 'private' }), 'not-live', 'Draft · Archived post', undefined],
    ['a draft on a hidden post', recipe({ status: 'draft' }, { reviewStatus: 'hidden' }), 'not-live', 'Draft · Hidden in review', undefined],
    ['a draft the seller left as one', recipe({ status: 'draft' }), 'not-live', 'Draft', undefined],
    ['a draft the listing check turns down, with what to fix', recipe({ status: 'draft', quality: turnedDown }), 'not-live', 'Draft', 'Add a preview.'],
    ['a post hidden in review', recipe({}, { reviewStatus: 'hidden' }), 'not-live', 'Hidden in review', undefined],
    ['a post flagged for review', recipe({}, { reviewStatus: 'flagged' }), 'not-live', 'Flagged for review', undefined],
    // Second review: checkout takes only a post review shows, so a state this
    // page has no words for keeps the recipe off sale too.
    ['a post in a review state the page does not name', recipe({}, { reviewStatus: 'escalated' as never }), 'not-live', 'In review', undefined],
    // Review 5: checkout asks only for a published recipe on a public, visible
    // post, so one the listing check turns down still sells from its post.
    ['a recipe the listing check keeps out of the marketplace', recipe({ quality: turnedDown }), 'unlisted', 'Not in the marketplace', 'Add a preview.'],
  ] as const)('names %s', (_name, value, kind, label, issue) => {
    const state = getSellerRecipeState(value);
    expect(state.kind).toBe(kind);
    expect(state.kind === 'live' ? undefined : state.label).toBe(label);
    expect(state.kind === 'not-live' || state.kind === 'unlisted' ? state.issue : undefined).toBe(issue);
  });

  it('names a recipe whose post could not be read', () => {
    expect(getSellerRecipeState({ ...recipe(), post: null })).toEqual({
      kind: 'not-live',
      label: 'Post unavailable',
      tone: 'danger',
      issue: undefined,
      draftOnly: false,
    });
  });

  it('takes the strongest tone of the causes it names', () => {
    expect(getSellerRecipeState(recipe({ status: 'draft' }, { visibility: 'private' }))).toMatchObject({ tone: 'warning' });
    expect(getSellerRecipeState(recipe({ status: 'draft' }, { reviewStatus: 'hidden' }))).toMatchObject({ tone: 'danger' });
    expect(getSellerRecipeState(recipe({}, { visibility: 'private' }))).toMatchObject({ tone: 'neutral' });
  });

  it('counts a recipe as on sale while buyers can unlock it from its post', () => {
    const live = recipe({ id: 'live' });
    const unlisted = recipe({ id: 'unlisted', quality: turnedDown });
    const draft = recipe({ id: 'draft', status: 'draft' });
    const removed = recipe({ id: 'removed', status: 'draft', retiredAt: '2026-10-03T00:00:00.000Z' });

    expect([live, unlisted, draft, removed].map((item) => isSellerRecipeOnSale(getSellerRecipeState(item)))).toEqual([true, true, false, false]);
    expect(filterSellerRecipes([live, unlisted, draft, removed], 'live').map((item) => item.id)).toEqual(['live', 'unlisted']);
    expect(filterSellerRecipes([live, unlisted, draft, removed], 'not-live').map((item) => item.id)).toEqual(['draft', 'removed']);
  });

  // Review 5 and 6: one that still sells, and one removed or deleted on
  // purpose, are not paid recipes nobody can buy.
  it('counts only paid recipes the seller can still put on sale as not on sale', () => {
    const paidRecipes = [
      recipe({ id: 'draft', status: 'draft' }),
      recipe({ id: 'unlisted', quality: turnedDown }),
      recipe({ id: 'removed', status: 'draft', retiredAt: '2026-10-03T00:00:00.000Z' }),
      recipe({ id: 'deleted', status: 'draft' }, { tombstoned: true, visibility: 'private' }),
      recipe({ id: 'free-draft', status: 'draft', accessMode: 'free', priceUsdCents: 0 }),
    ];

    expect(getPaidRecipesNotOnSale(paidRecipes).map((item) => item.id)).toEqual(['draft']);
  });

  it('says why paid recipes are not on sale, in the singular and the plural', () => {
    expect(describePaidRecipesNotOnSale([])).toBeNull();
    expect(describePaidRecipesNotOnSale([recipe({ status: 'draft' })])).toEqual({
      title: '1 paid recipe isn’t on sale.',
      body: 'It’s still a draft, so nobody can buy it.',
    });
    // A draft only because its post is private is not called "still a draft":
    // its row names the post.
    expect(describePaidRecipesNotOnSale([recipe({ status: 'draft' }, { visibility: 'private' })])).toEqual({
      title: '1 paid recipe isn’t on sale.',
      body: 'Nobody can buy it until it’s live.',
    });
    expect(describePaidRecipesNotOnSale([recipe({ status: 'draft' }), recipe({}, { visibility: 'private' })])).toEqual({
      title: '2 paid recipes aren’t on sale.',
      body: 'Nobody can buy them until they’re live.',
    });
  });

  // "0 sold" says something about a recipe on sale, nothing about a draft. The
  // sum is what buyers paid (review 10), not the seller's share.
  it('counts sales under a paid recipe on sale or once it has sold, never under a draft', () => {
    expect(formatSellerRecipeDetails(recipe())).toBe('Prompt · 0 sold');
    expect(formatSellerRecipeDetails(recipe({ quality: turnedDown }))).toBe('Prompt · 0 sold');
    expect(formatSellerRecipeDetails(recipe({ status: 'draft' }))).toBe('Prompt');
    expect(formatSellerRecipeDetails(recipe({ accessMode: 'free', priceUsdCents: 0 }))).toBe('Prompt');
    expect(formatSellerRecipeDetails(recipe({ status: 'draft', salesCount: 2, earningsUsdCents: 1530 }))).toBe('Prompt · 2 sold · $15.30 in sales');
  });

  // Review 12: the editor names the add intent only with `recipe=add`.
  it('opens the editor at the recipe, to add one or to change it, and comes back here', () => {
    expect(buildAddRecipeHref('post-1')).toBe('/post/post-1/edit?recipe=add&from=seller&returnTo=%2Fmarketplace%2Fsell#recipe');
    expect(buildEditRecipeHref('post-1')).toBe('/post/post-1/edit?from=seller&returnTo=%2Fmarketplace%2Fsell#recipe');
  });

  it('names only the counts a post has, or that it has none yet', () => {
    expect(formatPostEngagement({ saveCount: 2, remixCount: 0, shareVisitCount: 8 })).toBe('2 saves · 8 link visits');
    expect(formatPostEngagement({ saveCount: 1, remixCount: 1, shareVisitCount: 1 })).toBe('1 save · 1 remix · 1 link visit');
    expect(formatPostEngagement({ saveCount: 1234 })).toBe('1,234 saves');
    expect(formatPostEngagement({})).toBe('No saves yet');
    expect(formatCount(1, 'unlock', 'unlocks')).toBe('1 unlock');
  });

  // Second review: the chip grouped en-US where every other recipe chip, web
  // and app (contracts/feed-recipe-chip-v1.json), groups en-IN.
  it('prices a recipe in credits as every other chip does', () => {
    expect(formatSellerRecipePrice({ accessMode: 'paid', priceUsdCents: 125_000 })).toBe('1,25,000 credits');
    expect(formatSellerRecipePrice({ accessMode: 'paid', priceUsdCents: 1 })).toBe('1 credit');
    expect(formatSellerRecipePrice({ accessMode: 'free', priceUsdCents: 0 })).toBe('Free');
  });

  it('breaks a tie newest first, so the order holds between reads', () => {
    const older = recipe({ id: 'older', createdAt: '2026-09-01T00:00:00.000Z', freeUnlockCount: 2 });
    const newer = recipe({ id: 'newer', createdAt: '2026-10-01T00:00:00.000Z', salesCount: 2 });
    const most = recipe({ id: 'most', createdAt: '2026-08-01T00:00:00.000Z', freeUnlockCount: 5 });

    expect(sortSellerRecipes([older, newer, most], 'unlocks').map((item) => item.id)).toEqual(['most', 'newer', 'older']);
    expect(sortSellerRecipes([older, newer, most], 'newest').map((item) => item.id)).toEqual(['newer', 'older', 'most']);
  });
});
