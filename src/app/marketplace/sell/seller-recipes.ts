import type { MarketplaceQualityAssessment } from '@/lib/marketplace-trust';
import {
  formatUnlockCountLabel,
  formatUsdCents,
  getPostResourceKindLabel,
  type MarketplacePriceQuote,
} from '@/lib/post-resource-bundles';
import { formatRecipeCreditPrice } from '@/lib/showcase-asset-labels';

export type SellerRecipeKind = 'prompt' | 'workflow' | 'files' | 'notes' | 'remix';

export interface SellerRecipePost {
  id: string;
  title: string;
  visibility: string;
  archivedAt: string | null;
  /** The seller deleted the post after a sale; buyers keep the recipe. */
  tombstoned?: boolean;
  reviewStatus?: 'visible' | 'flagged' | 'hidden';
  postFormat?: string;
  mediaKind?: string | null;
  mediaUrl?: string | null;
  mediaPreviewUrl?: string | null;
  saveCount?: number;
  remixCount?: number;
  shareVisitCount?: number;
}

/**
 * What the seller page reads of each recipe and its post: the server's
 * dashboard row (`getSellerPostResourceBundleDashboard`), narrowed to the
 * fields drawn here.
 */
export interface SellerRecipe {
  id: string;
  postId: string;
  title: string;
  summary: string;
  previewText: string;
  accessMode: 'free' | 'paid';
  status: 'draft' | 'published';
  priceUsdCents: number;
  priceQuote?: MarketplacePriceQuote;
  /** Paid unlocks. */
  salesCount: number;
  /** Free unlocks, which stopped counting as sales on 2026-10-17 (decision 6). */
  freeUnlockCount: number;
  earningsUsdCents: number;
  resourceKinds: SellerRecipeKind[];
  createdAt: string;
  updatedAt?: string;
  /** The seller removed the recipe after it was unlocked; its buyers keep it. */
  retiredAt?: string | null;
  quality?: MarketplaceQualityAssessment;
  post: SellerRecipePost | null;
}

/** Where this page's links come back to (`returnTo`), and the name the editor and the post page give it (`from`). */
export const SELLER_RETURN_PATH = '/marketplace/sell';
const SELLER_RETURN_QUERY = `from=seller&returnTo=${encodeURIComponent(SELLER_RETURN_PATH)}`;

/** The composer, for a post that is not up yet. */
export const SELLER_NEW_POST_HREF = `/post/new?${SELLER_RETURN_QUERY}`;

/** A recipe's own section of its post's editor. */
export function buildEditRecipeHref(postId: string): string {
  return `/post/${postId}/edit?${SELLER_RETURN_QUERY}#recipe`;
}

/**
 * A post's editor opened to add its first recipe, as Studio's Add recipe opens
 * it (`recipe=add`, A-F17): headed "Add a recipe to this post", no mode chosen.
 */
export function buildAddRecipeHref(postId: string): string {
  return `/post/${postId}/edit?recipe=add&${SELLER_RETURN_QUERY}#recipe`;
}

export type SellerRecipeTone = 'neutral' | 'warning' | 'danger';

/**
 * Where a recipe stands, in the app's words where the app names the same state
 * (`ugc-mobile/app/seller-dashboard.tsx`):
 *
 * - `live`: unlocked from its post, and the listing check lets it into the
 *   marketplace. It says nothing, so the rows that need the seller stand out.
 * - `unlisted`: unlocked from its post (checkout asks only that the recipe is
 *   published on a public, visible post), but the listing check keeps it out
 *   of the marketplace, and says why.
 * - `not-live`: nobody can unlock it. Every cause is named: the database makes
 *   a recipe on a private or archived post a draft
 *   (`posts_sync_resource_bundle_exposure`), so "Draft" alone would hide that
 *   the post is what to fix. `draftOnly` when the draft is all there is.
 * - `removed`: the seller removed it after it was unlocked; its buyers keep
 *   it, and its post takes a recipe again in the editor.
 * - `ended`: its post was deleted after it was unlocked. Its buyers keep it;
 *   there is nothing left to sell or fix.
 */
export type SellerRecipeState =
  | { kind: 'live' }
  | { kind: 'unlisted'; label: string; tone: SellerRecipeTone; issue: string }
  | { kind: 'not-live'; label: string; tone: SellerRecipeTone; issue?: string; draftOnly: boolean }
  | { kind: 'removed'; label: string; tone: SellerRecipeTone }
  | { kind: 'ended'; label: string; tone: SellerRecipeTone };

const TONE_WEIGHT: Record<SellerRecipeTone, number> = { neutral: 0, warning: 1, danger: 2 };

export function getSellerRecipeState(recipe: SellerRecipe): SellerRecipeState {
  const post = recipe.post;
  if (post?.tombstoned) return { kind: 'ended', label: 'Deleted · buyers keep access', tone: 'neutral' };
  if (recipe.retiredAt) return { kind: 'removed', label: 'Removed · buyers keep access', tone: 'neutral' };

  const causes: Array<{ label: string; tone: SellerRecipeTone }> = [];
  if (recipe.status !== 'published') causes.push({ label: 'Draft', tone: 'warning' });
  if (!post) {
    causes.push({ label: 'Post unavailable', tone: 'danger' });
  } else {
    // Checkout and the listing take only a post review shows: any other state
    // keeps the recipe off sale, one this page has no words for too.
    const review = post.reviewStatus ?? 'visible';
    if (review === 'hidden') causes.push({ label: 'Hidden in review', tone: 'danger' });
    else if (review === 'flagged') causes.push({ label: 'Flagged for review', tone: 'warning' });
    else if (review !== 'visible') causes.push({ label: 'In review', tone: 'warning' });
    if (post.archivedAt) causes.push({ label: 'Archived post', tone: 'neutral' });
    else if (post.visibility !== 'public') causes.push({ label: 'Private post', tone: 'neutral' });
  }
  // The listing check's first issue says what to fix, whatever else holds.
  const issue = recipe.quality && !recipe.quality.eligible
    ? recipe.quality.issues[0]?.message ?? 'Improve this recipe before it appears in the marketplace.'
    : undefined;

  if (causes.length > 0) {
    const tone = causes.reduce<SellerRecipeTone>(
      (worst, cause) => (TONE_WEIGHT[cause.tone] > TONE_WEIGHT[worst] ? cause.tone : worst),
      'neutral',
    );
    return {
      kind: 'not-live',
      label: causes.map((cause) => cause.label).join(' · '),
      tone,
      issue,
      draftOnly: causes.length === 1 && recipe.status !== 'published',
    };
  }
  if (issue) return { kind: 'unlisted', label: 'Not in the marketplace', tone: 'warning', issue };
  return { kind: 'live' };
}

/** Whether buyers can unlock the recipe now, from its post. */
export function isSellerRecipeOnSale(state: SellerRecipeState): boolean {
  return state.kind === 'live' || state.kind === 'unlisted';
}

/** The post's title, which is what the marketplace calls the recipe, else the recipe's own. */
export function getSellerRecipeTitle(recipe: Pick<SellerRecipe, 'title' | 'post'>): string {
  return recipe.post?.title?.trim() || recipe.title.trim() || 'Untitled recipe';
}

export function getSellerRecipeUnlockCount(recipe: Pick<SellerRecipe, 'salesCount' | 'freeUnlockCount'>): number {
  return recipe.salesCount + recipe.freeUnlockCount;
}

/** The price chip: "Free", or the price in credits as every other chip shows it (en-IN, "1,25,000 credits"). */
export function formatSellerRecipePrice(recipe: Pick<SellerRecipe, 'accessMode' | 'priceUsdCents'>): string {
  return recipe.accessMode === 'free' ? 'Free' : formatRecipeCreditPrice(recipe.priceUsdCents);
}

/** "1,234 saves": a count grouped as the page's count columns are, with its noun. */
export function formatCount(count: number, one: string, many: string): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;
}

/**
 * The line under a recipe's title: what it holds and what it sold, once anyone
 * paid for it or while it is on sale. The sum is what buyers paid: the
 * recipe's `earnings_usd_cents` adds the whole price of each sale, of which the
 * seller keeps their share (the Earnings tile's figures). Free unlocks are the
 * Unlocks column's.
 */
export function formatSellerRecipeDetails(recipe: SellerRecipe): string {
  const parts: string[] = [];
  const kinds = (recipe.resourceKinds ?? []).map(getPostResourceKindLabel);
  if (kinds.length > 0) parts.push(kinds.join(', '));
  const onSale = recipe.accessMode === 'paid' && isSellerRecipeOnSale(getSellerRecipeState(recipe));
  if (onSale || recipe.salesCount > 0) {
    parts.push(formatUnlockCountLabel('paid', recipe.salesCount));
  }
  if (recipe.earningsUsdCents > 0) {
    parts.push(`${formatUsdCents(recipe.earningsUsdCents)} in sales`);
  }
  return parts.join(' · ');
}

export type SellerRecipeFilter = 'all' | 'live' | 'not-live';
export type SellerRecipeSort = 'unlocks' | 'newest' | 'saves' | 'visits';

export const SELLER_RECIPE_SORTS: ReadonlyArray<{ value: SellerRecipeSort; label: string }> = [
  { value: 'unlocks', label: 'Most unlocked' },
  { value: 'newest', label: 'Newest' },
  { value: 'saves', label: 'Most saved' },
  { value: 'visits', label: 'Most link visits' },
];

/** "Live" is what buyers can unlock now; the rest is "Not live". */
export function filterSellerRecipes(recipes: readonly SellerRecipe[], filter: SellerRecipeFilter): SellerRecipe[] {
  if (filter === 'all') return [...recipes];
  return recipes.filter((recipe) => isSellerRecipeOnSale(getSellerRecipeState(recipe)) === (filter === 'live'));
}

function createdAtTime(recipe: SellerRecipe): number {
  const time = new Date(recipe.createdAt).getTime();
  return Number.isNaN(time) ? 0 : time;
}

/** Sorted by the chosen count, ties newest first, so the order never shuffles between reads. */
export function sortSellerRecipes(recipes: readonly SellerRecipe[], sort: SellerRecipeSort): SellerRecipe[] {
  const count = (recipe: SellerRecipe): number => {
    switch (sort) {
      case 'unlocks':
        return getSellerRecipeUnlockCount(recipe);
      case 'saves':
        return recipe.post?.saveCount ?? 0;
      case 'visits':
        return recipe.post?.shareVisitCount ?? 0;
      case 'newest':
        return 0;
    }
  };
  return [...recipes].sort((first, second) => (
    count(second) - count(first) || createdAtTime(second) - createdAtTime(first)
  ));
}

/**
 * Paid recipes nobody can buy that the seller can still put on sale: not one
 * whose post was deleted or that the seller removed after it sold, and not
 * one the listing check only keeps out of the marketplace, which still sells
 * from its post.
 */
export function getPaidRecipesNotOnSale(recipes: readonly SellerRecipe[]): SellerRecipe[] {
  return recipes.filter((recipe) => (
    recipe.accessMode === 'paid' && getSellerRecipeState(recipe).kind === 'not-live'
  ));
}

/** The callout over the list for paid recipes nobody can buy. */
export function describePaidRecipesNotOnSale(recipes: readonly SellerRecipe[]): { title: string; body: string } | null {
  const count = recipes.length;
  if (count === 0) return null;
  // Drafts the seller left as drafts, not ones the database made drafts
  // because of their post, which their rows name.
  const allDrafts = recipes.every((recipe) => {
    const state = getSellerRecipeState(recipe);
    return state.kind === 'not-live' && state.draftOnly;
  });
  const one = count === 1;
  return {
    title: one ? '1 paid recipe isn’t on sale.' : `${count} paid recipes aren’t on sale.`,
    body: allDrafts
      ? (one ? 'It’s still a draft, so nobody can buy it.' : 'They’re still drafts, so nobody can buy them.')
      : (one ? 'Nobody can buy it until it’s live.' : 'Nobody can buy them until they’re live.'),
  };
}

/** "2 saves · 8 link visits": a post's counts that are above zero, or that it has none yet. */
export function formatPostEngagement(counts: { saveCount?: number; remixCount?: number; shareVisitCount?: number }): string {
  const parts: string[] = [];
  if (counts.saveCount) parts.push(formatCount(counts.saveCount, 'save', 'saves'));
  if (counts.remixCount) parts.push(formatCount(counts.remixCount, 'remix', 'remixes'));
  if (counts.shareVisitCount) parts.push(formatCount(counts.shareVisitCount, 'link visit', 'link visits'));
  return parts.length > 0 ? parts.join(' · ') : 'No saves yet';
}
