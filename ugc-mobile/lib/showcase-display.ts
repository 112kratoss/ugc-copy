import type { ShowcaseFeedItem } from '@/lib/types';

export function isTextOnlyShowcasePost(item: ShowcaseFeedItem) {
  return (item.category === 'text' || item.postFormat === 'text') && !item.mediaUrl;
}

export function getShowcasePostDisplayText(item: ShowcaseFeedItem) {
  return item.body.trim() || item.prompt.trim() || item.title.trim() || 'Community post';
}

export function isShowcaseVideoPreviewCandidate(item: ShowcaseFeedItem) {
  return Boolean(item.mediaUrl) && (item.mediaKind === 'video' || item.category === 'video');
}

export function selectActiveShowcaseVideoId(items: ShowcaseFeedItem[]) {
  return items.find(isShowcaseVideoPreviewCandidate)?.id ?? null;
}

export function selectActiveShowcaseVideoIds(items: ShowcaseFeedItem[], limit = 3) {
  if (limit <= 0) return [];

  const ids: string[] = [];
  for (const item of items) {
    if (!isShowcaseVideoPreviewCandidate(item)) continue;
    ids.push(item.id);
    if (ids.length >= limit) break;
  }

  return ids;
}
