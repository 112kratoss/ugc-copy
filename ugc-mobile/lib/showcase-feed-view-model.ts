import type { ToolAccent } from '@/lib/theme';
import type { ShowcaseFeedItem } from '@/lib/types';
import type { PreviewViewerSource } from './immersive-preview-view-model';
import { formatCompactCount } from './home-view-model';

export interface ShowcaseMasonryCard {
  id: string;
  item: ShowcaseFeedItem;
  title: string;
  prompt: string;
  previewKind: 'media' | 'text';
  creatorLabel: string;
  creatorAvatar: string | null;
  mediaUrl: string | null;
  mediaKind: 'image' | 'video' | null;
  badge: string;
  accent: ToolAccent;
  height: number;
  saveLabel: string;
  remixLabel: string;
  viewerSource: PreviewViewerSource;
  sourceId: string;
}

export interface ShowcaseGridLayout {
  columnGap: number;
  pinGap: number;
  mediaRadius: number;
}

export function buildShowcaseMasonry(items: ShowcaseFeedItem[]) {
  return items.map(showcaseToMasonryCard);
}

export function getShowcaseGridLayout(windowWidth: number): ShowcaseGridLayout {
  const compactPhone = windowWidth < 380;

  return {
    columnGap: compactPhone ? 12 : 14,
    pinGap: compactPhone ? 22 : 24,
    mediaRadius: 18,
  };
}

export function showcaseToMasonryCard(item: ShowcaseFeedItem): ShowcaseMasonryCard {
  const accent = categoryAccent(item.category);
  const textOnly = (item.category === 'text' || item.postFormat === 'text') && !item.mediaUrl;

  return {
    id: item.id,
    item,
    title: item.title || item.prompt || 'Community post',
    prompt: item.body || item.prompt || 'A creator-ready idea from the Magicbooklet community.',
    previewKind: textOnly ? 'text' : 'media',
    creatorLabel: item.creator.username || item.creator.name,
    creatorAvatar: item.creator.avatar,
    mediaUrl: item.mediaUrl,
    mediaKind: item.mediaKind,
    badge: cardBadge(item),
    accent,
    height: cardHeight(item),
    saveLabel: formatCompactCount(item.saveCount),
    remixLabel: formatCompactCount(item.remixCount),
    viewerSource: 'showcase-feed',
    sourceId: item.id,
  };
}

function cardBadge(item: ShowcaseFeedItem) {
  if (item.asset?.accessMode === 'free') return 'Free unlock';
  if (item.asset?.priceQuote?.formatted) return item.asset.priceQuote.formatted;
  if (item.canRemix || item.asset?.allowRemix) return 'Remix';
  if (item.category === 'text' || item.postFormat === 'text') return 'Prompt';
  if (item.mediaKind === 'video' || item.category === 'video') return 'Video';
  if (item.category === 'motion') return 'Motion';
  return 'Image';
}

function cardHeight(item: ShowcaseFeedItem) {
  const variant = stableHeightVariant(item);
  if (item.category === 'text' || item.postFormat === 'text') return [188, 214, 240][variant];
  if (item.mediaKind === 'video' || item.category === 'video') return [226, 260, 292][variant];
  if (item.category === 'motion') return [236, 268, 304][variant];
  return [218, 248, 284][variant];
}

function categoryAccent(category: ShowcaseFeedItem['category']): ToolAccent {
  if (category === 'video') return 'video';
  if (category === 'motion') return 'motion';
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
