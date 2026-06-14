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
  previewUrl: string | null;
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
  const unlock = cardUnlock(item);

  return {
    id: item.id,
    item,
    title: item.title || item.prompt || 'Community post',
    prompt: item.body || item.prompt || 'A creator-ready idea from the Magicbooklet community.',
    previewKind: textOnly ? 'text' : 'media',
    creatorLabel: item.creator.username || item.creator.name,
    creatorAvatar: item.creator.avatar,
    mediaUrl: item.mediaUrl,
    previewUrl: item.mediaItems?.[0]?.previewUrl ?? null,
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

export function getShowcaseMediaHeight(card: ShowcaseMasonryCard, columnWidth: number) {
  if (card.previewKind === 'text' || !card.aspectRatio) {
    return card.height;
  }
  return Math.round(Math.max(180, Math.min(320, columnWidth / card.aspectRatio)));
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

function cardUnlock(item: ShowcaseFeedItem): ShowcaseMasonryUnlock | null {
  if (item.asset) {
    const free = item.asset.accessMode === 'free';
    return {
      label: free ? 'Free unlock' : item.asset.priceQuote?.formatted ?? 'Paid unlock',
      summary: resourceSummary(item.asset.resourceKinds, item.asset.allowRemix),
      ctaLabel: free ? 'Unlock free' : 'View unlock',
      accent: free ? 'workflow' : 'commerce',
    };
  }

  if (item.canRemix) {
    return {
      label: 'Remixable',
      summary: 'Use this post as a starting point',
      ctaLabel: 'Remix',
      accent: 'motion',
    };
  }

  return null;
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
  if (item.mediaKind === 'video' || item.category === 'video') return [226, 260, 292][variant];
  if (item.category === 'motion') return [236, 268, 304][variant];
  return [218, 248, 284][variant];
}

function getCardAspectRatio(item: ShowcaseFeedItem) {
  const cover = item.mediaItems?.[0];
  if (!cover?.width || !cover.height) {
    return null;
  }
  return cover.width / cover.height;
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
