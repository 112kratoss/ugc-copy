import type { ToolAccent } from '@/lib/theme';
import type { ShowcaseFeedItem } from '@/lib/types';
import type { PreviewViewerSource } from './immersive-preview-view-model';
import { formatCompactCount } from './home-view-model';
import { isTextOnlyShowcasePost } from './showcase-display';

export interface ShowcaseMasonryCard {
  id: string;
  item: ShowcaseFeedItem;
  title: string;
  prompt: string;
  creatorLabel: string;
  creatorAvatar: string | null;
  mediaUrl: string | null;
  previewUrl: string | null;
  previewThumbhash: string | null;
  previewCacheKey: string;
  mediaKind: 'image' | 'video' | null;
  badge: string;
  accent: ToolAccent;
  unlock: ShowcaseMasonryUnlock | null;
  aspectRatio: number | null;
  height: number;
  saveLabel: string;
  remixLabel: string;
  viewerSource: PreviewViewerSource;
  sourceId: string;
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
 * Showcase is the media grid. Text-only posts belong to the home feed, which
 * can render a written post at full width — the grid can only offer them a
 * media-shaped tile. The filter lives here rather than in the screen so the
 * "every masonry card has media" invariant holds for anything that builds one.
 */
export function buildShowcaseMasonry(items: ShowcaseFeedItem[]) {
  return items
    .filter((item) => !isTextOnlyShowcasePost(item))
    .map(showcaseToMasonryCard);
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
    prompt: item.body || item.prompt || 'A creator-ready idea from the Magicbooklet community.',
    creatorLabel: item.creator.username || item.creator.name,
    creatorAvatar: item.creator.avatar,
    mediaUrl: item.mediaUrl,
    previewUrl: preview?.previewUrl ?? cover?.previewUrl ?? null,
    previewThumbhash: preview?.thumbhash ?? cover?.previewThumbhash ?? null,
    previewCacheKey: preview?.cacheKey ?? cover?.previewCacheKey ?? cover?.id ?? item.id,
    mediaKind: item.mediaKind,
    badge: unlock?.label ?? cardBadge(item),
    accent,
    unlock,
    aspectRatio: getCardAspectRatio(item),
    height: cardHeight(item),
    saveLabel: formatCompactCount(item.saveCount),
    remixLabel: formatCompactCount(item.remixCount),
    viewerSource: 'showcase-feed',
    sourceId: item.id,
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

function isPlaceholderTitle(value: string) {
  return /^(untitled(?: creation)?|community post)$/i.test(value.trim());
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

function cardBadge(item: ShowcaseFeedItem) {
  if (item.asset?.accessMode === 'free') return 'Free unlock';
  if (item.asset?.priceQuote?.formatted) return item.asset.priceQuote.formatted;
  if (canRecreateShowcaseItem(item)) return 'Remix';
  if (item.category === 'text' || item.postFormat === 'text') return 'Prompt';
  if (item.creationMode === 'motion') return 'Motion';
  if (item.mediaKind === 'video' || item.category === 'video') return 'Video';
  return 'Image';
}

export function cardUnlock(item: ShowcaseFeedItem): ShowcaseMasonryUnlock | null {
  if (item.asset) {
    const free = item.asset.accessMode === 'free';
    return {
      label: free ? 'Free unlock' : item.asset.priceQuote?.formatted ?? 'Paid unlock',
      summary: resourceSummary(item.asset.resourceKinds, item.asset.allowRemix),
      ctaLabel: free ? 'Get resources — Free' : 'View unlock',
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

function isAppCreatedShowcaseItem(item: ShowcaseFeedItem) {
  return typeof item.generationId === 'string' && item.generationId.trim().length > 0;
}

export function canRecreateShowcaseItem(item: ShowcaseFeedItem) {
  return isAppCreatedShowcaseItem(item) && item.canRemix;
}

function resourceSummary(kinds: string[] | undefined, allowRemix: boolean) {
  const labels = (kinds ?? []).map(resourceKindLabel).filter(Boolean);
  const unique = Array.from(new Set(labels));
  if (allowRemix && !unique.includes('Remix')) unique.push('Remix');
  return unique.length ? unique.join(' + ') : 'Creator resources';
}

function resourceKindLabel(kind: string) {
  if (kind === 'prompt') return 'Prompt';
  if (kind === 'workflow') return 'Workflow';
  if (kind === 'files') return 'Files';
  if (kind === 'notes') return 'Notes';
  if (kind === 'remix') return 'Remix';
  return '';
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
