import type { ToolAccent } from '@/lib/theme';
import type { ShowcaseFeedItem } from '@/lib/types';
import type { PreviewViewerSource } from './immersive-preview-view-model';
import { HOME_TOOL_SHORTCUTS, formatCompactCount, formatRelativeTime, type HomeToolShortcut } from './home-view-model';
import type { ShowcaseFeedFilters } from './showcase-feed-query';
import {
  cardUnlock,
  canRecreateShowcaseItem,
  type ShowcaseMasonryUnlock,
} from './showcase-feed-view-model';

export type HomeFeedChipId = 'for-you' | 'recent' | 'unlocks';

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
  { id: 'recent', label: 'Recent', filters: { sort: 'recent' } },
  { id: 'unlocks', label: 'Unlocks', filters: { sort: 'for-you', unlock: 'with-unlock' } },
];

export type HomeFeedSlide =
  | { kind: 'workspace'; id: string; title: string; body: string; ctaLabel: string; href: string }
  | { kind: 'tool'; id: string; title: string; body: string; accent: ToolAccent; href: string; previewVariant: HomeToolShortcut['previewVariant'] }
  | { kind: 'promo'; id: string; title: string; body: string; ctaLabel: string; href: string; imageUrl: string | null };

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
  creatorId: string | null;
  timeLabel: string;
  categoryLabel: string;
  accent: ToolAccent;
  mediaUrl: string | null;
  mediaKind: 'image' | 'video' | null;
  previewUrl: string | null;
  previewThumbhash: string | null;
  previewCacheKey: string;
  aspectRatio: number | null;
  unlock: ShowcaseMasonryUnlock | null;
  canRemix: boolean;
  saveLabel: string;
  commentLabel: string;
  remixLabel: string;
  isSaved: boolean;
  viewerSource: PreviewViewerSource;
}

/**
 * Where a tap on the card body should land. Text posts have no media, so the
 * immersive viewer — a full-screen media pager — is the wrong destination for
 * them; the discussion is the payload instead.
 */
export type HomeFeedCardOpenTarget = 'viewer' | 'comments';

const TEXT_BODY_LINES = 8;
const MIXED_BODY_LINES = 3;
const MEDIA_BODY_LINES = 2;
const MIN_MEDIA_HEIGHT = 180;
const MAX_MEDIA_HEIGHT_RATIO = 1.25;
const FALLBACK_MEDIA_ASPECT_RATIO = 4 / 5;
const FALLBACK_VIDEO_ASPECT_RATIO = 16 / 9;

/** Body font sizes the card renders at, mirrored here so line estimates match. */
const TEXT_BODY_FONT_SIZE = 16;
const COMPACT_BODY_FONT_SIZE = 14;
/** Accent rail plus left and right padding the framed text panel adds. */
export const TEXT_PANEL_RAIL_WIDTH = 3;
export const TEXT_PANEL_PADDING = 14;
const TEXT_PANEL_HORIZONTAL_CHROME = TEXT_PANEL_RAIL_WIDTH + TEXT_PANEL_PADDING * 2;
/**
 * Mean glyph advance as a fraction of font size for the system UI face. Only
 * used to decide whether "Read more" is worth offering, so a rough estimate is
 * enough — a wrong call costs an unnecessary (or missing) toggle, never layout.
 */
const AVERAGE_GLYPH_WIDTH_RATIO = 0.52;

export function getHomeFeedChip(id: HomeFeedChipId | string | null | undefined) {
  return HOME_FEED_CHIPS.find((chip) => chip.id === id) ?? HOME_FEED_CHIPS[0];
}

export function getHomeFeedSlides(shortcuts: HomeToolShortcut[] = HOME_TOOL_SHORTCUTS): HomeFeedSlide[] {
  return [
    {
      kind: 'workspace',
      id: 'workspace',
      title: 'Ready when you are',
      body: 'Turn your next idea into a polished post.',
      ctaLabel: 'Create new',
      href: '/(tabs)/creator',
    },
    ...shortcuts
      .filter((shortcut): shortcut is HomeToolShortcut & { href: string } => Boolean(shortcut.href))
      .map((shortcut) => ({
        kind: 'tool' as const,
        id: shortcut.id,
        title: shortcut.title,
        body: shortcut.body,
        accent: shortcut.accent,
        href: shortcut.href,
        previewVariant: shortcut.previewVariant,
      })),
  ];
}

/** How long a slide rests on screen before the rotation advances. */
export const HOME_SLIDE_INTERVAL_MS = 4600;
/**
 * Grace period after a manual swipe before the timer takes back over. Long
 * enough that a slide someone deliberately scrolled to is never yanked away
 * mid-read.
 */
export const HOME_SLIDE_RESUME_DELAY_MS = 7000;

/**
 * How many times the slides are laid out end to end.
 *
 * Three, so the carousel can live in the middle pass with a full copy of the
 * rail on either side. That is what makes the loop seamless in both
 * directions: every position the rotation is corrected to has the same
 * neighbours — including the sliver of the previous card showing at the left
 * edge — as the position it was corrected from, so the correction moves no
 * pixels. Two passes cannot do this; the first slide of pass one has nothing
 * to its left, which both blocks a backward swipe and makes the wrap visibly
 * pop as that sliver appears and disappears.
 */
export const HOME_SLIDE_LOOP_PASSES = 3;

export interface HomeLoopedSlide {
  key: string;
  slide: HomeFeedSlide;
}

/**
 * Repeats the slides so the rail extends past both ends of what is on screen.
 * A lone slide has nothing to rotate through, so it is laid out once.
 */
export function buildLoopedHomeSlides(slides: HomeFeedSlide[]): HomeLoopedSlide[] {
  const passes = slides.length > 1 ? HOME_SLIDE_LOOP_PASSES : 1;

  return Array.from({ length: passes }, (_, pass) =>
    slides.map((slide) => ({ key: `${slide.id}-${pass}`, slide }))
  ).flat();
}

/**
 * Where the carousel sits at rest: the first slide of the middle pass. Landing
 * here rather than at 0 means a backward swipe has real cards to travel onto,
 * so the first slide continues from the last instead of hitting a dead end.
 */
export function getInitialHomeSlideIndex(slideCount: number) {
  return slideCount > 1 ? slideCount : 0;
}

/**
 * Next position in the rotation.
 *
 * The index is free to leave the middle pass in either direction — that is how
 * the carousel keeps travelling the way it was already going instead of
 * sweeping back through everything it just showed. `foldHomeSlideOffset`
 * brings it home once the scroll settles.
 */
export function advanceHomeSlide(currentIndex: number, slideCount: number) {
  if (slideCount <= 1) return 0;

  return currentIndex + 1;
}

/** Width of one full pass of slides — the period of the repeated rail. */
export function getHomeSlidePassWidth(slideCount: number, slideWidth: number, gap: number) {
  return slideCount * (slideWidth + gap);
}

/**
 * Translates a settled scroll offset into the middle pass by whole passes.
 *
 * This is the recentering step, done in offset space rather than index space
 * on purpose: shifting by an exact multiple of the pass width maps every
 * on-screen pixel onto its copy one pass over, so the correction is invisible
 * even when the scroll rested a few pixels off a snap point. Snapping to a
 * slide's canonical offset instead would fold that fractional error into the
 * jump and show up as a flick.
 */
export function foldHomeSlideOffset(offset: number, passWidth: number) {
  if (passWidth <= 0) return offset;

  let folded = offset;
  while (folded < passWidth) folded += passWidth;
  while (folded >= passWidth * 2) folded -= passWidth;

  return folded;
}

/** Left edge of `index`, matching the list's `snapToInterval`. */
export function getHomeSlideOffset(index: number, slideWidth: number, gap: number) {
  return Math.max(0, index) * (slideWidth + gap);
}

/**
 * Which laid-out position a scroll offset landed on. `itemCount` is the length
 * of the repeated list, not the slide count — a swipe can legitimately settle
 * inside the second pass.
 */
export function getHomeSlideIndexFromOffset(
  offset: number,
  slideWidth: number,
  gap: number,
  itemCount: number
) {
  const interval = slideWidth + gap;
  if (interval <= 0 || itemCount <= 0) return 0;

  return Math.min(itemCount - 1, Math.max(0, Math.round(offset / interval)));
}

/**
 * Motion that starts on its own has to be able to stop on its own too: it
 * pauses off-screen (a timer scrolling an unmounted-from-view list is wasted
 * work), while a finger is on it, and entirely under Reduce Motion — an
 * unattended carousel is exactly the auto-updating content that setting exists
 * to silence.
 */
export function shouldAutoAdvanceHomeSlides({
  slideCount,
  isFocused,
  isInteracting,
  reduceMotion,
}: {
  slideCount: number;
  isFocused: boolean;
  isInteracting: boolean;
  reduceMotion: boolean;
}) {
  return slideCount > 1 && isFocused && !isInteracting && !reduceMotion;
}

/**
 * Sibling of `buildShowcaseMasonry`. Home renders every post format in one
 * column, so — unlike the grid — it keeps text posts and never drops an item
 * for a preview that has not finished baking.
 */
export function buildHomeFeedCards(items: ShowcaseFeedItem[]): HomeFeedCard[] {
  return items.map(showcaseToHomeFeedCard);
}

export function showcaseToHomeFeedCard(item: ShowcaseFeedItem): HomeFeedCard {
  const hasMedia = Boolean(item.mediaUrl);
  const bodyText = (item.body || '').trim();
  const previewKind = resolveHomePreviewKind(item, hasMedia, bodyText);
  const cover = item.mediaItems?.[0];
  const preview = cover?.preview;
  const creatorName = item.creator.name || item.creator.username || 'Creator';

  return {
    id: item.id,
    item,
    previewKind,
    title: homeCardTitle(item, previewKind),
    bodyText: homeCardBody(item, previewKind),
    bodyLines: homeCardBodyLines(previewKind),
    creatorLabel: item.creator.username ? `@${item.creator.username}` : creatorName,
    creatorName,
    creatorAvatar: item.creator.avatar,
    creatorId: item.creator.id,
    timeLabel: formatRelativeTime(item.createdAt),
    categoryLabel: homeCategoryLabel(item),
    accent: homeCardAccent(item),
    mediaUrl: item.mediaUrl,
    mediaKind: item.mediaKind,
    previewUrl: preview?.previewUrl ?? cover?.previewUrl ?? null,
    previewThumbhash: preview?.thumbhash ?? cover?.previewThumbhash ?? null,
    previewCacheKey: preview?.cacheKey ?? cover?.previewCacheKey ?? cover?.id ?? item.id,
    aspectRatio: getHomeCardAspectRatio(item),
    unlock: cardUnlock(item),
    canRemix: canRecreateShowcaseItem(item),
    saveLabel: formatFeedActionLabel(item.saveCount, 'Save'),
    commentLabel: formatFeedActionLabel(item.commentCount, 'Comment'),
    remixLabel: item.remixCount > 0 ? `Remix · ${formatCompactCount(item.remixCount)}` : 'Remix',
    isSaved: Boolean(item.isSaved),
    viewerSource: 'showcase-feed',
  };
}

/**
 * Mirrors web's `formatActionLabel` (src/lib/post-feed-presentation.ts): count
 * labels read as verbs until there is real social proof, so a young feed does
 * not present a wall of zeros.
 */
function formatFeedActionLabel(count: number | null | undefined, verb: string) {
  return (count ?? 0) > 0 ? formatCompactCount(count) : verb;
}

function homeCardBodyLines(previewKind: HomeFeedCard['previewKind']) {
  if (previewKind === 'text') return TEXT_BODY_LINES;
  if (previewKind === 'mixed') return MIXED_BODY_LINES;
  return MEDIA_BODY_LINES;
}

/**
 * A text post is the only card whose body is the post itself, so it reads at
 * body size inside its own panel; every other kind captions media below it.
 */
export function getHomeFeedBodyFontSize(card: HomeFeedCard) {
  return card.previewKind === 'text' ? TEXT_BODY_FONT_SIZE : COMPACT_BODY_FONT_SIZE;
}

export function isFramedHomeFeedBody(card: HomeFeedCard) {
  return card.previewKind === 'text';
}

export function getHomeFeedCardOpenTarget(card: HomeFeedCard): HomeFeedCardOpenTarget {
  return card.previewKind === 'text' ? 'comments' : 'viewer';
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

/** True when the collapsed body hides content worth a "Read more" tap. */
export function canExpandHomeFeedBody(card: HomeFeedCard, contentWidth: number) {
  if (!card.bodyText) return false;

  const width = isFramedHomeFeedBody(card)
    ? contentWidth - TEXT_PANEL_HORIZONTAL_CHROME
    : contentWidth;

  return estimateWrappedLineCount(card.bodyText, width, getHomeFeedBodyFontSize(card)) > card.bodyLines;
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

function isPlaceholderTitle(value: string) {
  return /^(untitled(?: creation| note)?|community post)$/i.test(value.trim());
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
