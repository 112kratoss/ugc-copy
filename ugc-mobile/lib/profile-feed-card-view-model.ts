import { estimateWrappedLineCount } from './home-feed-view-model';
import type { ImmersivePreviewItem } from './immersive-preview-view-model';
import { formatRelativeTime } from './home-view-model';
import type { ToolAccent } from './theme';
import { getViewerStateChip, type ViewerStateTone } from './viewer-actions';

const MIN_MEDIA_HEIGHT = 180;
const MAX_MEDIA_HEIGHT_RATIO = 1.25;
const FALLBACK_MEDIA_ASPECT_RATIO = 4 / 5;
const FALLBACK_VIDEO_ASPECT_RATIO = 16 / 9;
const BODY_LINES = 2;
const TEXT_BODY_LINES = 6;
/** Matches the single size PostTextBlock renders every body at. */
const BODY_FONT_SIZE = 14;

/**
 * How long the feed keeps trying to bring the tapped card on screen once the
 * card is in the list.
 *
 * Landing is a retry, not a single shot: `initialScrollIndex` is only honoured at
 * mount, card heights settle as bodies wrap, and the queries behind the list
 * resolve independently. The old scheme spent five attempts on a fixed schedule
 * ending at 640ms, whether or not anything had rendered, then marked the card
 * landed the first time it was glimpsed — so a slow load used the attempts up
 * and a later reorder left the reader on the wrong card (audit C8). Now the list
 * drives the attempts (the target arriving, the list reporting load or a content
 * size, the card turning viewable), a reorder before the reader moves lands
 * again, and this budget only bounds how long that may take before the feed
 * says it could not get there.
 */
export const FEED_LANDING_BUDGET_MS = 3000;

export type FeedLanding = {
  /**
   * `waiting` for the target to appear in the list; `seeking` it; `landed` on it;
   * `released` for good once the reader scrolled; `failed` when the budget ran out.
   */
  phase: 'waiting' | 'seeking' | 'landed' | 'released' | 'failed';
  /** The index the target held when the landing last saw it; -1 while absent. */
  targetIndex: number;
  /** When the current attempt began, which starts its budget. */
  startedAt: number | null;
  /** Changes on each budget tick so the screen makes another bounded scroll attempt. */
  attempt: number;
};

export type FeedLandingEvent =
  | { type: 'target'; index: number; now: number }
  | { type: 'viewable'; targetVisible: boolean }
  | { type: 'reader-scrolled' }
  | { type: 'tick'; now: number }
  | { type: 'retry'; now: number };

export const INITIAL_FEED_LANDING: FeedLanding = {
  phase: 'waiting', targetIndex: -1, startedAt: null, attempt: 0,
};

export function reduceFeedLanding(state: FeedLanding, event: FeedLandingEvent): FeedLanding {
  // The reader's own scroll outranks the landing for the rest of the visit.
  if (state.phase === 'released') return state;

  switch (event.type) {
    case 'reader-scrolled':
      return { ...state, phase: 'released' };
    case 'target':
      if (event.index < 0) {
        // Gone from the list. The screen shows that as a missing selection; if it
        // comes back, landing starts over.
        return state.phase === 'waiting' ? state : INITIAL_FEED_LANDING;
      }
      if (state.phase !== 'waiting' && event.index === state.targetIndex) return state;
      return { phase: 'seeking', targetIndex: event.index, startedAt: event.now, attempt: 0 };
    case 'viewable':
      return state.phase === 'seeking' && event.targetVisible ? { ...state, phase: 'landed' } : state;
    case 'tick':
      if (state.phase !== 'seeking' || state.startedAt === null) return state;
      return event.now - state.startedAt >= FEED_LANDING_BUDGET_MS
        ? { ...state, phase: 'failed' }
        : { ...state, attempt: state.attempt + 1 };
    case 'retry':
      return state.phase === 'failed'
        ? { ...state, phase: 'seeking', startedAt: event.now, attempt: 0 }
        : state;
  }
}

/**
 * Whether the list should be scrolled to the target now. The first card needs
 * no scroll. An index the list cannot contain is never passed on: FlashList
 * clamps it to the end, which would land the reader on the oldest card instead.
 */
export function shouldScrollToFeedTarget(state: FeedLanding, cardCount: number) {
  return state.phase === 'seeking' && state.targetIndex > 0 && state.targetIndex < cardCount;
}

export interface ProfileFeedCard {
  id: string;
  item: ImmersivePreviewItem;
  title: string;
  bodyText: string;
  bodyLines: number;
  isTextOnly: boolean;
  hasMedia: boolean;
  /**
   * A creation whose only file is gone. The card draws that state where the
   * media would be, so the card the reader opened is visibly the one they tapped.
   */
  sourceUnavailable: boolean;
  creatorLabel: string;
  creatorName: string;
  creatorAvatar: string | null;
  timeLabel: string;
  categoryLabel: string;
  accent: ToolAccent;
  aspectRatio: number | null;
  unlockLabel: string | null;
  unlockSummary: string | null;
  state: { label: string; tone: ViewerStateTone } | null;
}

export function buildProfileFeedCards(items: ImmersivePreviewItem[], now?: Date): ProfileFeedCard[] {
  return items.map((item) => toProfileFeedCard(item, now));
}

export function toProfileFeedCard(item: ImmersivePreviewItem, now?: Date): ProfileFeedCard {
  const isTextOnly = item.previewKind === 'text';
  const hasMedia = !isTextOnly && item.mediaItems.length > 0;
  const bodyText = profileCardBody(item);
  const creatorName = item.creatorLabel.replace(/^@/, '') || 'Creator';

  return {
    id: item.id,
    item,
    title: item.title.trim() || item.displayText.trim() || 'Untitled',
    bodyText,
    bodyLines: isTextOnly ? TEXT_BODY_LINES : BODY_LINES,
    isTextOnly,
    hasMedia,
    sourceUnavailable: !isTextOnly && item.availability === 'source-unavailable',
    creatorLabel: item.creatorLabel,
    creatorName,
    creatorAvatar: item.creatorAvatar,
    timeLabel: item.createdAt ? formatRelativeTime(item.createdAt, now) : '',
    categoryLabel: item.details?.categoryLabel ?? item.badge,
    accent: profileCardAccent(item),
    aspectRatio: profileCardAspectRatio(item),
    unlockLabel: profileCardUnlockLabel(item),
    unlockSummary: profileCardUnlockSummary(item),
    state: getViewerStateChip(item),
  };
}

/**
 * Mirrors `canExpandHomeFeedBody`: only a caption expands in place. A text
 * post's card opens the post instead, so its clamp just ends in an ellipsis.
 */
export function canExpandProfileFeedBody(card: ProfileFeedCard, contentWidth: number) {
  if (!card.bodyText || card.isTextOnly) return false;

  return estimateWrappedLineCount(card.bodyText, contentWidth, BODY_FONT_SIZE) > card.bodyLines;
}

/**
 * The title already carries the prompt for most owned media, so repeating it as
 * the body would render the same sentence twice on one card.
 */
function profileCardBody(item: ImmersivePreviewItem) {
  const body = (item.details?.body || item.displayText || '').trim();
  if (!body) return '';
  const title = item.title.trim();
  return normalize(body) === normalize(title) ? '' : body;
}

function normalize(value: string) {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function profileCardAccent(item: ImmersivePreviewItem): ToolAccent {
  if (item.previewKind === 'text') return 'amber';
  if (item.mediaKind === 'video') return 'video';
  if (item.badge === 'Motion') return 'motion';
  return 'image';
}

function profileCardAspectRatio(item: ImmersivePreviewItem) {
  const cover = item.mediaItems[0];
  return ratioFromDimensions(cover?.width, cover?.height)
    ?? ratioFromDimensions(cover?.preview?.width, cover?.preview?.height);
}

function ratioFromDimensions(width?: number | null, height?: number | null) {
  if (!width || !height || width <= 0 || height <= 0) return null;
  return width / height;
}

function profileCardUnlockLabel(item: ImmersivePreviewItem) {
  const unlock = item.details?.unlock ?? null;
  if (!unlock) return null;
  return unlock.accessMode === 'free' ? 'Free unlock' : unlock.priceLabel;
}

function profileCardUnlockSummary(item: ImmersivePreviewItem) {
  const unlock = item.details?.unlock ?? null;
  if (!unlock) return null;
  return unlock.previewText?.trim() || 'Reusable resources are attached to this post.';
}

/** Height of the plate an unavailable creation draws in place of its media. */
const UNAVAILABLE_PLATE_HEIGHT = 200;

export function getProfileFeedMediaHeight(card: ProfileFeedCard, contentWidth: number) {
  if (card.sourceUnavailable) return UNAVAILABLE_PLATE_HEIGHT;
  if (!card.hasMedia) return 0;
  const fallback = card.item.mediaKind === 'video'
    ? FALLBACK_VIDEO_ASPECT_RATIO
    : FALLBACK_MEDIA_ASPECT_RATIO;
  const ratio = card.aspectRatio ?? fallback;
  const height = contentWidth / ratio;
  return Math.round(Math.max(MIN_MEDIA_HEIGHT, Math.min(height, contentWidth * MAX_MEDIA_HEIGHT_RATIO)));
}
