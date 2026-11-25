import { isViewCountShown } from './view-count/view-count';
import { SHOWCASE_QUALIFIED_IMPRESSION_VIEWABILITY } from './showcase-feed-events';

/**
 * When a post shown large has been looked at (post view counts, step 3): half
 * of it on screen for a second while the app is in front. It is the feed's
 * qualified impression (`SHOWCASE_QUALIFIED_IMPRESSION_VIEWABILITY`, 50% for
 * 1,000 ms), the rule Home's cards and the feed's reel are counted by, so a
 * view means the same wherever it was seen (owner, 2026-11-23: "Seen 1 s,
 * shown large").
 */

/** How long a look takes before it is a view. */
export const POST_VIEW_QUALIFY_MS = SHOWCASE_QUALIFIED_IMPRESSION_VIEWABILITY.minimumViewTime;
/** The share of a post that has to be on screen. */
export const POST_VIEW_VISIBLE_SHARE = SHOWCASE_QUALIFIED_IMPRESSION_VIEWABILITY.itemVisiblePercentThreshold / 100;

/**
 * Whether a post laid out at `top` (its height `height`) in a scroller showing
 * `viewportHeight` from `scrollOffset` is looked at: half of it on screen, or
 * across the middle of the screen, which is what a post taller than two
 * screens can show (across the middle, at least half the screen is the post;
 * for a shorter post it adds nothing, more than half of it being on screen
 * then). The web's post page asks the same (`usePostViewOnScreen`).
 */
export function isPostLookOnScreen({
  top,
  height,
  scrollOffset,
  viewportHeight,
}: {
  top: number;
  height: number;
  scrollOffset: number;
  viewportHeight: number;
}): boolean {
  if (!(height > 0) || !(viewportHeight > 0)) return false;
  const visibleTop = Math.max(top, scrollOffset);
  const visibleBottom = Math.min(top + height, scrollOffset + viewportHeight);
  if (visibleBottom - visibleTop >= height * POST_VIEW_VISIBLE_SHARE) return true;
  const middle = scrollOffset + viewportHeight / 2;
  return top <= middle && top + height >= middle;
}

type Timer = ReturnType<typeof setTimeout>;

/**
 * The second of one post's looks. A look starts when the post is on screen
 * while the app is in front and ends when either stops; once it has lasted
 * the second, `onLooked` is told, once for that look. The second does not run
 * while the app is in the background: leaving ends the look, and coming back
 * starts a new one, which needs its own whole second, as the feed's impression
 * does. Every look reports; the reporter keeps one a reader, post and UTC day,
 * so a view whose send failed is sent by the next look, and a post left on
 * screen past midnight UTC is that day's view at its next look.
 */
export function createPostViewLook({
  onLooked,
  qualifyMs = POST_VIEW_QUALIFY_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}: {
  onLooked: () => void;
  qualifyMs?: number;
  setTimer?: (callback: () => void, ms: number) => Timer;
  clearTimer?: (timer: Timer) => void;
}) {
  let onScreen = false;
  let foreground = false;
  let lookReported = false;
  let timer: Timer | null = null;
  let disposed = false;

  const stop = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const update = () => {
    if (disposed) return;
    if (!onScreen || !foreground) {
      stop();
      lookReported = false;
      return;
    }
    if (lookReported || timer !== null) return;
    timer = setTimer(() => {
      timer = null;
      lookReported = true;
      onLooked();
    }, qualifyMs);
  };

  return {
    /** Whether the post is on screen, half of it (`isPostLookOnScreen`). */
    setOnScreen(next: boolean) {
      if (onScreen === next) return;
      onScreen = next;
      update();
    },
    /** Whether the app is in front (`AppState` reads `active`). */
    setForeground(next: boolean) {
      if (foreground === next) return;
      foreground = next;
      update();
    },
    /** The post is gone from the page: no look of it can end in a view. */
    dispose() {
      disposed = true;
      stop();
    },
  };
}

export type PostViewLook = ReturnType<typeof createPostViewLook>;

/** What a slide or a page knows of the post it shows, for its view. */
export interface PostViewReportTarget {
  showcasePostId: string | null;
  creatorId?: string | null;
  visibility?: string | null;
  archivedAt?: string | null;
  recommendation?: { deliveryId?: string | null } | null;
}

/**
 * The post whose view a page or a reel slide reports, or null where it reports
 * none:
 *
 * - a post a feed delivered, in the reel opened on the feed: its impression
 *   counts it (`countedByFeedImpression`; the reel files one for every
 *   delivered post on the feed's lanes, Explore's included);
 * - a post that is not public, or taken down: the server counts none;
 * - the reader's own post: the creator's views never count;
 * - a creation with no post.
 *
 * A post under its mature-content cover counts while only the cover shows,
 * as on the web (owner, 2026-11-24: "Keep counting").
 */
export function viewReportPostId(
  target: PostViewReportTarget | null | undefined,
  { viewerIdentity, countedByFeedImpression = false }: { viewerIdentity: string | null; countedByFeedImpression?: boolean },
): string | null {
  if (!target?.showcasePostId) return null;
  if (countedByFeedImpression) return null;
  if (!isViewCountShown({ visibility: target.visibility ?? undefined, archived: Boolean(target.archivedAt) })) return null;
  if (viewerIdentity && target.creatorId === viewerIdentity) return null;
  return target.showcasePostId;
}

/**
 * Whether the reel's slide is counted by the impression the reel files for it:
 * a reel opened on the feed's lanes files one for each post a feed delivered
 * (`app/viewer.tsx`), which the server counts as the post's view.
 */
export function isCountedByReelImpression(
  source: string,
  target: Pick<PostViewReportTarget, 'recommendation'> | null | undefined,
): boolean {
  return source === 'showcase-feed' && Boolean(target?.recommendation?.deliveryId);
}
