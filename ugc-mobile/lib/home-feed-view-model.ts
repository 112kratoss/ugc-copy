import type { ToolAccent } from '@/lib/theme';
import type { ShowcaseFeedItem } from '@/lib/types';
import { formatCompactCount, formatRelativeTime } from './home-view-model';
import { MODEL_DISPLAY_NAMES } from './model-display-names';
import { isPlaceholderTitle } from './placeholder-title';
import { FREE_RECIPE_LABEL, formatUnlockCreditPrice } from './pricing';
import type { ShowcaseFeedFilters } from './showcase-feed-query';
import { getShowcaseRemixAccess, type ShowcaseRemixAccess } from './showcase-remix-access';

export type HomeFeedChipId = 'for-you' | 'recent' | 'unlocks' | 'notes';

export interface HomeFeedChip {
  id: HomeFeedChipId;
  label: string;
  /**
   * Kept as `ShowcaseFeedFilters` so `createShowcaseFeedQueryKey` produces keys
   * under the same `['showcase-feed','infinite',userId]` prefix the immersive
   * viewer already scans — home cards then open the viewer without a refetch.
   */
  filters: ShowcaseFeedFilters;
}

export const HOME_FEED_CHIPS: HomeFeedChip[] = [
  { id: 'for-you', label: 'For You', filters: { sort: 'for-you' } },
  /**
   * Posts with writing. The API's `category=text` lane returns text-only posts
   * and mixed ones (media with a written body) — home is the surface that
   * renders a body at all, since the Showcase grid drops text-only posts.
   */
  { id: 'notes', label: 'Notes', filters: { sort: 'for-you', category: 'text' } },
  { id: 'recent', label: 'Recent', filters: { sort: 'recent' } },
  { id: 'unlocks', label: 'Recipes', filters: { sort: 'for-you', unlock: 'with-unlock' } },
];

export interface HomeFeedCard {
  id: string;
  item: ShowcaseFeedItem;
  previewKind: 'media' | 'text' | 'mixed';
  title: string;
  bodyText: string;
  bodyLines: number;
  creatorLabel: string;
  creatorName: string;
  creatorAvatar: string | null;
  timeLabel: string;
  categoryLabel: string;
  /**
   * The model's product name after the category ("Video · Kling 2.5"), as the
   * web card's metadata line names it; null for text posts and for a model the
   * bundled catalog does not know, so a slug is never shown.
   */
  modelLabel: string | null;
  accent: ToolAccent;
  mediaUrl: string | null;
  mediaKind: 'image' | 'video' | null;
  previewUrl: string | null;
  /**
   * Not drawn by the card but read off the list's viewability tokens: on iOS
   * the tab bar takes its tint from the card nearest it
   * (`selectBottomVisibleAmbientSource`, lib/tab-bar-ambient.ts).
   */
  previewThumbhash: string | null;
  aspectRatio: number | null;
  /**
   * What a tap on Remix has to get through first; null when the post has
   * nothing to remix, which is the only case with no Remix action.
   */
  remixAccess: ShowcaseRemixAccess | null;
  saveLabel: string;
  commentLabel: string;
  /** `Remix`, with its count; behind a paid unlock, the price of that unlock. */
  remixLabel: string;
  remixAccessibilityLabel: string;
  /** The recipe behind the post, where the action row has reason to name it. */
  recipeChip: HomeFeedRecipeChip | null;
  isSaved: boolean;
}

/**
 * Where a tap on the card body should land. The immersive viewer is the
 * showcase reel — a vertical swipe there pages through other showcase posts —
 * so a text post opens its own screen instead of joining that reel.
 */
export type HomeFeedCardOpenTarget = 'viewer' | 'post';

const TEXT_BODY_LINES = 6;
const MIXED_BODY_LINES = 3;
const MEDIA_BODY_LINES = 2;
const MIN_MEDIA_HEIGHT = 180;
const MAX_MEDIA_HEIGHT_RATIO = 1.25;
const FALLBACK_MEDIA_ASPECT_RATIO = 4 / 5;
const FALLBACK_VIDEO_ASPECT_RATIO = 16 / 9;

/** Every kind renders its body at one size; only the line estimate reads this. */
const BODY_FONT_SIZE = 14;
/**
 * Mean glyph advance as a fraction of font size for the system UI face. Only
 * used to decide whether "Read more" is worth offering, so a rough estimate is
 * enough — a wrong call costs an unnecessary (or missing) toggle, never layout.
 */
const AVERAGE_GLYPH_WIDTH_RATIO = 0.52;

/**
 * Each item's card, for as long as the item object lives. FlashList re-renders
 * a cell whose item is a new object, and every page, save and refetch rebuilds
 * the lane's cards; a save writes a new object for the saved post alone
 * (`applyShowcaseSaveStateToFeedResponse`), and a refetch keeps the objects of
 * the posts it did not change. Items are never edited in place, so a card can
 * be handed back while its item is the same object and the clock and the
 * viewer, its other inputs, still give the same `timeLabel` and owner.
 */
const homeFeedCardCache = new WeakMap<ShowcaseFeedItem, { card: HomeFeedCard; viewerId: string | null }>();

/**
 * Sibling of `buildShowcaseMasonry`. Home renders every post format in one
 * column, so — unlike the grid — it keeps text posts and never drops an item
 * for a preview that has not finished baking. `viewerId` is the signed-in
 * viewer's, so their own recipe reads "Your recipe" (`homeRecipeChip`).
 */
export function buildHomeFeedCards(
  items: ShowcaseFeedItem[],
  now = new Date(),
  viewerId: string | null = null,
): HomeFeedCard[] {
  return items.map((item) => {
    const cached = homeFeedCardCache.get(item);
    if (
      cached
      && cached.viewerId === viewerId
      && cached.card.timeLabel === formatRelativeTime(item.createdAt, now)
    ) return cached.card;

    const card = showcaseToHomeFeedCard(item, now, viewerId);
    homeFeedCardCache.set(item, { card, viewerId });
    return card;
  });
}

export function showcaseToHomeFeedCard(
  item: ShowcaseFeedItem,
  now = new Date(),
  viewerId: string | null = null,
): HomeFeedCard {
  const hasMedia = Boolean(item.mediaUrl);
  const bodyText = (item.body || '').trim();
  const previewKind = resolveHomePreviewKind(item, hasMedia, bodyText);
  const cover = item.mediaItems?.[0];
  const preview = cover?.preview;
  const creatorName = item.creator.name || item.creator.username || 'Creator';
  const title = homeCardTitle(item, previewKind);
  const remixAccess = getShowcaseRemixAccess(item);
  // A remix behind a paid unlock is sold from its own pill: the lock, and the
  // price where "Remix" would be. A second pill for the price would not fit
  // beside it on a phone, and both would open the same unlock.
  const remixPrice = remixAccess === 'paid-unlock' && item.asset && item.asset.priceUsdCents > 0
    ? formatUnlockCreditPrice(item.asset.priceUsdCents)
    : null;

  return {
    id: item.id,
    item,
    previewKind,
    title,
    bodyText: homeCardBody(item, previewKind),
    bodyLines: homeCardBodyLines(previewKind),
    creatorLabel: item.creator.username ? `@${item.creator.username}` : creatorName,
    creatorName,
    creatorAvatar: item.creator.avatar,
    timeLabel: formatRelativeTime(item.createdAt, now),
    categoryLabel: homeCategoryLabel(item),
    modelLabel: previewKind === 'text' ? null : homeModelLabel(item.model),
    accent: homeCardAccent(item),
    mediaUrl: item.mediaUrl,
    mediaKind: item.mediaKind,
    previewUrl: preview?.previewUrl ?? cover?.previewUrl ?? null,
    previewThumbhash: preview?.thumbhash ?? cover?.previewThumbhash ?? null,
    aspectRatio: getHomeCardAspectRatio(item),
    remixAccess,
    saveLabel: formatFeedActionLabel(item.saveCount, 'Save'),
    commentLabel: formatFeedActionLabel(item.commentCount, 'Comment'),
    remixLabel: remixPrice ?? (item.remixCount > 0 ? `Remix · ${formatCompactCount(item.remixCount)}` : 'Remix'),
    // A free unlock asks nothing of the viewer, so only a paid one is announced.
    remixAccessibilityLabel: remixAccess === 'paid-unlock'
      ? `Unlock ${title} to remix it${remixPrice ? `, ${remixPrice}` : ''}`
      : `Remix ${title}`,
    recipeChip: homeRecipeChip(item, title, remixAccess, {
      isOwner: Boolean(viewerId && item.creator.id === viewerId),
    }),
    isSaved: Boolean(item.isSaved),
  };
}

export interface HomeFeedRecipeChip {
  /** `Free recipe`, the price in credits as the app sells an unlock, `Unlocked` or `Your recipe`. */
  label: string;
  accessibilityLabel: string;
  tone: 'free' | 'paid';
  /**
   * What the chip says, which picks its icon: a price, a free recipe, one the
   * viewer has (a check), or the viewer's own.
   */
  kind: 'price' | 'free' | 'unlocked' | 'owner';
}

/**
 * The recipe behind a post, as a chip at the end of the card's action row. It
 * is drawn only where it says something the row does not already:
 *
 * - the viewer's own recipe says "Your recipe", and one they have (bought or
 *   opened free) "Unlocked", wherever it is, in place of the price it kept
 *   after buying (audit B-F2, 2026-10-27). The owner is asked first; whose
 *   post it is comes from the caller, who knows the signed-in viewer;
 * - a paid recipe always shows its price, so a post that sells something is
 *   visible while scrolling. Where the recipe is what locks Remix, that pill
 *   carries the price instead, and there is no second one;
 * - a free one shows only on a card with no Remix, where it is the one way to
 *   the prompt. Beside Remix it would say nothing Remix does not: that tap
 *   takes a free unlock on its way.
 *
 * It replaced a full-width row under the media that repeated the post's title.
 * Mirrors `getPostFeedRecipeChip` in src/lib/post-feed-presentation.ts;
 * `contracts/feed-recipe-chip-v1.json` holds both to the same cases.
 */
export function homeRecipeChip(
  item: Pick<ShowcaseFeedItem, 'asset'>,
  title: string,
  remixAccess: ShowcaseRemixAccess | null,
  viewer: { isOwner?: boolean } = {},
): HomeFeedRecipeChip | null {
  const asset = item.asset;
  if (!asset) return null;

  // The web's words (`OWN_RECIPE_LABEL`, `RECIPE_UNLOCKED_LABEL`), held to the contract.
  if (viewer.isOwner) {
    return { label: 'Your recipe', accessibilityLabel: `Your recipe for ${title}`, tone: 'free', kind: 'owner' };
  }
  if (asset.viewerHasUnlocked) {
    return { label: 'Unlocked', accessibilityLabel: `Recipe for ${title}, unlocked`, tone: 'free', kind: 'unlocked' };
  }

  if (asset.accessMode !== 'free' && asset.priceUsdCents > 0) {
    // The locked Remix pill already carries this price (`remixLabel`).
    if (remixAccess === 'paid-unlock') return null;
    const price = formatUnlockCreditPrice(asset.priceUsdCents);
    return { label: price, accessibilityLabel: `Recipe for ${title}, ${price}`, tone: 'paid', kind: 'price' };
  }

  if (remixAccess) return null;
  return { label: FREE_RECIPE_LABEL, accessibilityLabel: `${FREE_RECIPE_LABEL} for ${title}`, tone: 'free', kind: 'free' };
}

/**
 * Mirrors web's `formatActionLabel` (src/lib/post-feed-presentation.ts): count
 * labels read as verbs until there is real social proof, so a young feed does
 * not present a wall of zeros.
 */
function formatFeedActionLabel(count: number | null | undefined, verb: string) {
  return (count ?? 0) > 0 ? formatCompactCount(count) : verb;
}

/**
 * Mirrors the web's `getPostModelDisplayName`, from the same names
 * (`MODEL_DISPLAY_NAMES`): model ids are internal slugs (`gpt-image-2`), and
 * `magicbooklet`, `manual`, `template-workflow`, an outside tool's id or an
 * unknown slug answer null so the line omits the model rather than leak it.
 */
export function homeModelLabel(model: string | null | undefined): string | null {
  if (!model || !Object.hasOwn(MODEL_DISPLAY_NAMES, model)) return null;
  return MODEL_DISPLAY_NAMES[model];
}

function homeCardBodyLines(previewKind: HomeFeedCard['previewKind']) {
  if (previewKind === 'text') return TEXT_BODY_LINES;
  if (previewKind === 'mixed') return MIXED_BODY_LINES;
  return MEDIA_BODY_LINES;
}

export function getHomeFeedCardOpenTarget(card: HomeFeedCard): HomeFeedCardOpenTarget {
  return card.previewKind === 'text' ? 'post' : 'viewer';
}

/**
 * Estimates how many lines `text` wraps to at `width`. React Native only
 * reports line counts after layout, and `numberOfLines` truncates the report,
 * so the "Read more" affordance is decided up front from the text itself.
 */
export function estimateWrappedLineCount(text: string, width: number, fontSize: number) {
  if (!text.trim() || width <= 0 || fontSize <= 0) return 0;

  const charactersPerLine = Math.max(1, Math.floor(width / (fontSize * AVERAGE_GLYPH_WIDTH_RATIO)));

  return text.split('\n').reduce((total, paragraph) => {
    const length = paragraph.trim().length;
    // An empty paragraph is still a rendered blank line.
    return total + Math.max(1, Math.ceil(length / charactersPerLine));
  }, 0);
}

/**
 * True when the collapsed body hides content worth a "Read more" tap.
 *
 * A text post never expands in place — tapping the card opens the post, so the
 * clamp ends in an ellipsis that already reads as "there is more".
 */
export function canExpandHomeFeedBody(card: HomeFeedCard, contentWidth: number) {
  if (!card.bodyText || card.previewKind === 'text') return false;

  return estimateWrappedLineCount(card.bodyText, contentWidth, BODY_FONT_SIZE) > card.bodyLines;
}

function resolveHomePreviewKind(
  item: ShowcaseFeedItem,
  hasMedia: boolean,
  bodyText: string
): HomeFeedCard['previewKind'] {
  if (!hasMedia) return 'text';
  // The masonry never renders a mixed post's body; home is the surface that does.
  if (item.postFormat === 'mixed' && bodyText) return 'mixed';
  return 'media';
}

function homeCardTitle(item: ShowcaseFeedItem, previewKind: HomeFeedCard['previewKind']) {
  const title = item.title?.trim();
  if (title && !isPlaceholderTitle(title)) return title;

  const fallback = previewKind === 'media' ? item.prompt : item.body || item.prompt;
  const clean = fallback?.trim();
  if (clean && !isPlaceholderTitle(clean)) return clean;

  if (item.creationMode === 'motion') return 'Motion creation';
  if (item.mediaKind === 'video' || item.category === 'video') return 'Video creation';
  if (previewKind === 'text') return 'Creator note';
  return 'Image creation';
}

function homeCardBody(item: ShowcaseFeedItem, previewKind: HomeFeedCard['previewKind']) {
  const title = homeCardTitle(item, previewKind);
  const candidates = previewKind === 'media'
    ? [item.prompt, item.body]
    : [item.body, item.prompt];

  for (const candidate of candidates) {
    const clean = candidate?.trim();
    // Never repeat the line already shown as the title.
    if (clean && clean !== title) return clean;
  }

  return '';
}

function homeCategoryLabel(item: ShowcaseFeedItem) {
  if (item.creationMode === 'motion') return 'Motion';
  if (item.mediaKind === 'video' || item.category === 'video') return 'Video';
  if (item.category === 'text' || item.postFormat === 'text') return 'Text';
  return 'Image';
}

function homeCardAccent(item: ShowcaseFeedItem): ToolAccent {
  if (item.creationMode === 'motion') return 'motion';
  if (item.mediaKind === 'video' || item.category === 'video') return 'video';
  if (item.category === 'text' || item.postFormat === 'text') return 'amber';
  return 'image';
}

function getHomeCardAspectRatio(item: ShowcaseFeedItem) {
  const cover = item.mediaItems?.[0];
  return ratioFromDimensions(cover?.width, cover?.height)
    ?? ratioFromDimensions(cover?.preview?.width, cover?.preview?.height);
}

function ratioFromDimensions(width: number | null | undefined, height: number | null | undefined) {
  if (!width || !height) return null;
  const ratio = width / height;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : null;
}

/**
 * Full-width media keeps its real aspect ratio, clamped so a very tall portrait
 * post cannot push the next card off the screen.
 */
export function getHomeFeedMediaHeight(card: HomeFeedCard, contentWidth: number) {
  const aspectRatio = card.aspectRatio
    ?? (card.mediaKind === 'video' ? FALLBACK_VIDEO_ASPECT_RATIO : FALLBACK_MEDIA_ASPECT_RATIO);

  return Math.round(Math.max(
    MIN_MEDIA_HEIGHT,
    Math.min(contentWidth * MAX_MEDIA_HEIGHT_RATIO, contentWidth / aspectRatio)
  ));
}
