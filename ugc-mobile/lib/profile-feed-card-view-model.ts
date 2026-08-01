import type { ImmersivePreviewItem } from './immersive-preview-view-model';
import { formatRelativeTime } from './home-view-model';
import type { ToolAccent } from './theme';
import { getViewerStateChip, type ViewerStateTone } from './viewer-actions';

const MIN_MEDIA_HEIGHT = 180;
const MAX_MEDIA_HEIGHT_RATIO = 1.25;
const FALLBACK_MEDIA_ASPECT_RATIO = 4 / 5;
const FALLBACK_VIDEO_ASPECT_RATIO = 16 / 9;
const BODY_LINES = 2;
const TEXT_BODY_LINES = 8;

export interface ProfileFeedCard {
  id: string;
  item: ImmersivePreviewItem;
  title: string;
  bodyText: string;
  bodyLines: number;
  isTextOnly: boolean;
  hasMedia: boolean;
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

export function getProfileFeedMediaHeight(card: ProfileFeedCard, contentWidth: number) {
  if (!card.hasMedia) return 0;
  const fallback = card.item.mediaKind === 'video'
    ? FALLBACK_VIDEO_ASPECT_RATIO
    : FALLBACK_MEDIA_ASPECT_RATIO;
  const ratio = card.aspectRatio ?? fallback;
  const height = contentWidth / ratio;
  return Math.round(Math.max(MIN_MEDIA_HEIGHT, Math.min(height, contentWidth * MAX_MEDIA_HEIGHT_RATIO)));
}
