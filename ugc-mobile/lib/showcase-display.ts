import { getShowcaseFeedStreamUrl, getShowcasePreviewMediaItems } from '@/lib/showcase-media';
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

/**
 * Whether a feed tile's cover is actually streaming rather than showing its
 * poster — which is what decides if the corner play badge still belongs.
 *
 * The badge wears the system's play control: a filled triangle in a circle.
 * Playing video asks a custom player to "reference the behavior and interface
 * of the system video player", because "a custom experience that diverges
 * slightly from the system-provided experience can cause frustration". A play
 * control drawn over a video that is already playing is exactly that divergence
 * — so the badge marks a poster, and disappears once the poster does.
 *
 * Election is not enough on its own: a card can win the autoplay slot and still
 * show its poster forever when the server decided this item is poster-only
 * (`feedStreamUrl` null), and Reduce Motion turns every activation off. Both
 * cases have to keep the badge, which is why the caller passes `active` already
 * resolved against the motion preference.
 */
export function isShowcaseCoverVideoStreaming(item: ShowcaseFeedItem, active: boolean) {
  if (!active) return false;

  const cover = getShowcasePreviewMediaItems(item)[0];
  return Boolean(cover && cover.mediaKind === 'video' && getShowcaseFeedStreamUrl(cover));
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
