import type { ImmersivePreviewItem } from './immersive-preview-view-model';
import { isPlaceholderTitle } from './placeholder-title';
import type { CreatorFollowAttribution } from './types';

export interface ReelCaption {
  /** The post's name. Empty for untitled posts. */
  title: string;
  /**
   * The post's own words, when they add something. `showcaseToImmersiveItem`
   * falls back to `title = prompt || displayText` and `displayText = body ||
   * prompt || title`, so an untitled post arrives saying the same thing twice;
   * the caption yields whenever it only repeats the title.
   */
  caption: string;
}

function normalize(value: string) {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** A name handed to a post nobody named (`isPlaceholderTitle`) is not worth a line. */
export function buildReelCaption(item: Pick<ImmersivePreviewItem, 'title' | 'displayText'>): ReelCaption {
  const rawTitle = item.title.trim();
  const title = isPlaceholderTitle(rawTitle) ? '' : rawTitle;
  const caption = item.displayText.trim();
  return {
    title,
    caption: normalize(caption) === normalize(rawTitle) || isPlaceholderTitle(caption) ? '' : caption,
  };
}

export interface ReelFollowTarget {
  creatorId: string;
}

/**
 * Who the Follow button on a reel would follow — someone else's showcase post
 * with a known creator. Your own posts, creations and anything without a
 * creator id get no button at all; a signed-out viewer still sees it, and
 * signing in is the first step of following.
 */
export function getReelFollowTarget(
  item: Pick<ImmersivePreviewItem, 'sourceType' | 'creatorId'>,
  viewerId: string | null | undefined
): ReelFollowTarget | null {
  if (item.sourceType !== 'showcase') return null;
  const creatorId = item.creatorId?.trim();
  if (!creatorId) return null;
  if (viewerId && creatorId === viewerId) return null;
  return { creatorId };
}

/**
 * The post a reel's Follow is pressed on, and the feed delivery that showed it
 * when a ranked feed did, for the server to credit the follow to
 * (`useCreatorFollow`). Null for anything that is not a showcase post.
 */
export function getReelFollowAttribution(
  item: Pick<ImmersivePreviewItem, 'sourceType' | 'showcasePostId' | 'recommendation'>
): CreatorFollowAttribution | null {
  if (item.sourceType !== 'showcase' || !item.showcasePostId) return null;
  return { postId: item.showcasePostId, deliveryId: item.recommendation?.deliveryId ?? null };
}

/**
 * Whether a post drawn before its reel exists — inside the window it grows in
 * out of its tile — may draw the Follow pill.
 *
 * The reel itself draws no pill until it knows whom the reader follows, and asks
 * only once it is up. A window drawn ahead of it may therefore show the pill
 * only for a signed-out reader, who always sees it, or when the answer is
 * already cached: any other pill would appear in the window and then vanish as
 * the reel took over.
 */
export function drawsPreparedFollowPill({
  followTarget,
  signedIn,
  followKnown,
}: {
  followTarget: ReelFollowTarget | null;
  signedIn: boolean;
  /** Whether this creator's follow state is already in hand. */
  followKnown: boolean;
}) {
  if (!followTarget) return false;
  return !signedIn || followKnown;
}

/** What sits under a bare rail icon: the count when there is one, else nothing. */
export function getRailCountLabel(count: number | null | undefined, formatCount: (value: number) => string) {
  if (!count || count <= 0) return null;
  return formatCount(count);
}
