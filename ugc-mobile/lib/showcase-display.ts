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

/**
 * Picks which visible videos may play, holding the ones already playing.
 *
 * `items` arrives in feed order, so "first qualified" means topmost on screen,
 * not most visible — `ViewToken` carries `isViewable` and nothing finer, so
 * there is no visible fraction to rank by without measuring layout ourselves.
 * Promoting purely by position would therefore let a video entering at the top
 * edge take the slot from one the reader is actually watching.
 *
 * So an id in `currentActiveIds` keeps its slot for as long as it stays
 * qualified, and positional order only fills the slots left over. Because
 * viewability is thresholded, "still qualified" means "still substantially on
 * screen" rather than "not yet completely gone".
 */
export function selectActiveShowcaseVideoIds(
  items: ShowcaseFeedItem[],
  limit = 3,
  currentActiveIds: string[] = [],
) {
  if (limit <= 0) return [];

  const qualified: string[] = [];
  for (const item of items) {
    if (!isShowcaseVideoPreviewCandidate(item)) continue;
    qualified.push(item.id);
  }

  const held = currentActiveIds.filter((id) => qualified.includes(id)).slice(0, limit);
  if (held.length >= limit) return held;

  const promoted = qualified.filter((id) => !held.includes(id));
  return [...held, ...promoted.slice(0, limit - held.length)];
}
