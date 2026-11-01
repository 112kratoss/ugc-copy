import type { ToolAccent } from '@/lib/theme';
import type { ShowcaseFeedItem } from '@/lib/types';
import { isPlaceholderTitle } from './placeholder-title';
import { resourceKindLabel } from './post-resource-bundle-view-model';
import { FREE_RECIPE_LABEL, formatUnlockCreditPrice } from './pricing';
import { isTextOnlyShowcasePost } from './showcase-display';
import { getShowcaseRemixAccess } from './showcase-remix-access';

export interface ShowcaseMasonryCard {
  id: string;
  item: ShowcaseFeedItem;
  title: string;
  creatorLabel: string;
  creatorAvatar: string | null;
  mediaUrl: string | null;
  previewUrl: string | null;
  /**
   * Not drawn by the pin but read off the list's viewability tokens: on iOS
   * the tab bar takes its tint from the card nearest it
   * (`selectBottomVisibleAmbientSource`, lib/tab-bar-ambient.ts).
   */
  previewThumbhash: string | null;
  mediaKind: 'image' | 'video' | null;
  badge: string;
  accent: ToolAccent;
  unlock: ShowcaseMasonryUnlock | null;
  aspectRatio: number | null;
  height: number;
}

export interface ShowcaseMasonryUnlock {
  label: string;
  summary: string;
  ctaLabel: string;
  accent: ToolAccent;
}

export interface ShowcaseGridLayout {
  columnGap: number;
  pinGap: number;
  mediaRadius: number;
}

const MIN_SHOWCASE_MEDIA_HEIGHT = 104;
const MAX_SHOWCASE_MEDIA_HEIGHT = 320;
const FALLBACK_VIDEO_ASPECT_RATIO = 16 / 9;

/**
 * Each item's card, for as long as the item object lives. FlashList re-renders
 * a pin whose item is a new object, and every page, save and refetch rebuilds
 * the lane's cards; a save writes a new object for the saved post alone
 * (`applyShowcaseSaveStateToFeedResponse`), and a refetch keeps the objects of
 * the posts it did not change. A card is built from its item and nothing else,
 * and items are never edited in place, so the same item object always has the
 * same card.
 */
const masonryCardCache = new WeakMap<ShowcaseFeedItem, ShowcaseMasonryCard>();

/**
 * Showcase is the media grid. Text-only posts belong to the home feed, which
 * can render a written post at full width — the grid can only offer them a
 * media-shaped tile. The filter lives here rather than in the screen so the
 * "every masonry card has media" invariant holds for anything that builds one.
 */
export function buildShowcaseMasonry(items: ShowcaseFeedItem[]) {
  return items
    .filter((item) => !isTextOnlyShowcasePost(item))
    .map((item) => {
      let card = masonryCardCache.get(item);
      if (!card) {
        card = showcaseToMasonryCard(item);
        masonryCardCache.set(item, card);
      }
      return card;
    });
}

export function getShowcaseGridLayout(windowWidth: number): ShowcaseGridLayout {
  const compactPhone = windowWidth < 380;

  return {
    columnGap: compactPhone ? 7 : 8,
    pinGap: compactPhone ? 14 : 16,
    mediaRadius: compactPhone ? 17 : 18,
  };
}

export function showcaseToMasonryCard(item: ShowcaseFeedItem): ShowcaseMasonryCard {
  const accent = item.creationMode === 'motion' ? 'motion' : categoryAccent(item.category);
  const unlock = cardUnlock(item);
  const cover = item.mediaItems?.[0];
  const preview = cover?.preview;

  return {
    id: item.id,
    item,
    title: cardTitle(item),
    creatorLabel: item.creator.username || item.creator.name,
    creatorAvatar: item.creator.avatar,
    mediaUrl: item.mediaUrl,
    previewUrl: preview?.previewUrl ?? cover?.previewUrl ?? null,
    previewThumbhash: preview?.thumbhash ?? cover?.previewThumbhash ?? null,
    mediaKind: item.mediaKind,
    badge: unlock?.label ?? cardBadge(item),
    accent,
    unlock,
    aspectRatio: getCardAspectRatio(item),
    height: cardHeight(item),
  };
}

function cardTitle(item: ShowcaseFeedItem) {
  const title = item.title?.trim();
  if (title && !isPlaceholderTitle(title)) return title;

  const textPost = item.category === 'text' || item.postFormat === 'text';
  const contentCandidates = textPost
    ? [item.body, item.prompt]
    : [item.prompt, item.body];

  for (const candidate of contentCandidates) {
    const clean = candidate?.trim();
    if (clean && !isPlaceholderTitle(clean)) return clean;
  }

  if (item.creationMode === 'motion') return 'Motion creation';
  if (item.mediaKind === 'video' || item.category === 'video') return 'Video creation';
  if (textPost) return 'Creator note';
  return 'Image creation';
}

export function getShowcaseMediaHeight(
  card: ShowcaseMasonryCard,
  columnWidth: number,
  resolvedAspectRatio?: number | null
) {
  const aspectRatio = normalizeAspectRatio(resolvedAspectRatio)
    ?? card.aspectRatio
    ?? (card.mediaKind === 'video' && card.previewUrl ? FALLBACK_VIDEO_ASPECT_RATIO : null);
  if (!aspectRatio) return card.height;

  return Math.round(Math.max(
    MIN_SHOWCASE_MEDIA_HEIGHT,
    Math.min(MAX_SHOWCASE_MEDIA_HEIGHT, columnWidth / aspectRatio)
  ));
}

/**
 * Splits freshly measured aspect ratios into the ones that may be applied now
 * and the ones that have to wait.
 *
 * A resolved ratio changes a card's height, and Collections is explicit about
 * what that costs: "If possible, try to avoid changing the layout while people
 * are viewing and interacting with it, unless it's in response to an explicit
 * action." Roughly a third of the live feed reaches the grid without media
 * dimensions — every legacy generation cover carries `width: null` — so those
 * cards are laid out at a placeholder height and measured afterwards. Applying
 * the measurement the moment it lands is what makes a resting feed resize
 * itself under the reader.
 *
 * So a ratio for a card that is currently on screen is held. When it may land
 * is the screen's call: Explore releases it only once the card is below the
 * last card on screen, or at a refresh, since a card above the screen moves the
 * ones being read too (`partitionAspectRatiosByViewport`, app/(tabs)/showcase.tsx).
 * The cost of the rule is that such a card keeps its placeholder height, and
 * therefore a cover crop, until then — a wrong crop is a smaller harm than a
 * moving page.
 */
export function partitionAspectRatioUpdates(
  updates: Record<string, number>,
  onScreenCardIds: ReadonlySet<string>,
): { apply: Record<string, number>; hold: Record<string, number> } {
  const apply: Record<string, number> = {};
  const hold: Record<string, number> = {};

  for (const [cardId, aspectRatio] of Object.entries(updates)) {
    if (onScreenCardIds.has(cardId)) {
      hold[cardId] = aspectRatio;
    } else {
      apply[cardId] = aspectRatio;
    }
  }

  return { apply, hold };
}

/**
 * Folds resolved ratios into the committed map, returning the *same* object
 * when nothing actually changed so the screen can skip a re-render of every
 * mounted cell on a pointer comparison.
 */
export function mergeAspectRatios(
  current: Record<string, number>,
  updates: Record<string, number>,
): Record<string, number> {
  let next: Record<string, number> | null = null;

  for (const [cardId, aspectRatio] of Object.entries(updates)) {
    if (current[cardId] === aspectRatio) continue;
    next = next ?? { ...current };
    next[cardId] = aspectRatio;
  }

  return next ?? current;
}

function cardBadge(item: ShowcaseFeedItem) {
  if (item.asset?.accessMode === 'free') return FREE_RECIPE_LABEL;
  if (item.asset) return formatUnlockCreditPrice(item.asset.priceUsdCents);
  if (canRecreateShowcaseItem(item)) return 'Remix';
  // A text post is "Text", beside Image, Video and Motion (decision 10,
  // 2026-10-17); "Prompt" names a real prompt only.
  if (item.category === 'text' || item.postFormat === 'text') return 'Text';
  if (item.creationMode === 'motion') return 'Motion';
  if (item.mediaKind === 'video' || item.category === 'video') return 'Video';
  return 'Image';
}

export function cardUnlock(item: ShowcaseFeedItem): ShowcaseMasonryUnlock | null {
  if (item.asset) {
    const free = item.asset.accessMode === 'free';
    return {
      // In credits, as the unlock is paid in the app: never a cash price.
      label: free ? FREE_RECIPE_LABEL : formatUnlockCreditPrice(item.asset.priceUsdCents),
      summary: resourceSummary(item.asset.resourceKinds, item.asset.allowRemix),
      ctaLabel: free ? 'Get resources — Free' : 'View recipe',
      accent: free ? 'workflow' : 'commerce',
    };
  }

  if (canRecreateShowcaseItem(item)) {
    return {
      label: 'Remixable',
      summary: 'Use this post as a starting point',
      ctaLabel: 'Remix',
      accent: 'motion',
    };
  }

  return null;
}

/** Remixable with nothing in the way; a post behind an unlock wears the unlock's badge instead. */
function canRecreateShowcaseItem(item: ShowcaseFeedItem) {
  return getShowcaseRemixAccess(item) === 'open';
}

function resourceSummary(kinds: string[] | undefined, allowRemix: boolean) {
  const labels = (kinds ?? []).map(resourceKindLabel).filter(Boolean);
  const unique = Array.from(new Set(labels));
  if (allowRemix && !unique.includes('Remix')) unique.push('Remix');
  return unique.length ? unique.join(' + ') : 'Creator resources';
}

function cardHeight(item: ShowcaseFeedItem) {
  const variant = stableHeightVariant(item);
  if (item.category === 'text' || item.postFormat === 'text') return [188, 214, 240][variant];
  if (item.creationMode === 'motion') return [236, 268, 304][variant];
  if (item.mediaKind === 'video' || item.category === 'video') return [226, 260, 292][variant];
  return [218, 248, 284][variant];
}

function getCardAspectRatio(item: ShowcaseFeedItem) {
  const cover = item.mediaItems?.[0];
  return ratioFromDimensions(cover?.width, cover?.height)
    ?? ratioFromDimensions(cover?.preview?.width, cover?.preview?.height);
}

function ratioFromDimensions(width: number | null | undefined, height: number | null | undefined) {
  if (!width || !height) return null;
  return normalizeAspectRatio(width / height);
}

function normalizeAspectRatio(value: number | null | undefined) {
  if (!value || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

function categoryAccent(category: ShowcaseFeedItem['category']): ToolAccent {
  if (category === 'video') return 'video';
  if (category === 'text') return 'amber';
  return 'image';
}

function stableHeightVariant(item: ShowcaseFeedItem) {
  const key = `${item.category}:${item.id}:${item.title || item.prompt}`;
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
  }
  return hash % 3;
}
