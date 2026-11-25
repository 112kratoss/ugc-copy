import { SHOWCASE_QUALIFIED_IMPRESSION_VIEWABILITY } from './showcase-feed-events';

/**
 * When a post shown large has been looked at (post view counts, step 3): half
 * of it on screen for a second while the app is in front. It is the feed's
 * qualified impression (`SHOWCASE_QUALIFIED_IMPRESSION_VIEWABILITY`, 50% for
 * 1,000 ms), the rule the feed's impressions are counted by, so a view means
 * the same wherever it was seen (owner, 2026-11-23: "Seen 1 s, shown large").
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
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}: {
  onLooked: () => void;
  qualifyMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => Timer;
  clearTimer?: (timer: Timer) => void;
}) {
  let onScreen = false;
  let foreground = false;
  let lookReported = false;
  let lookStartedAt: number | null = null;
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
      lookStartedAt = null;
      return;
    }
    if (lookReported || timer !== null) return;
    lookStartedAt = now();
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
    /**
     * Whether the look under way has lasted its second, though its timer may
     * not have fired yet (a busy thread runs it late): what a caller that is
     * ending the look asks before it goes. False once the look has ended.
     */
    hasQualified() {
      return lookReported || (lookStartedAt !== null && now() - lookStartedAt >= qualifyMs);
    },
    /** The post is gone from the page: no look of it can end in a view. */
    dispose() {
      disposed = true;
      stop();
    },
  };
}

export type PostViewLook = ReturnType<typeof createPostViewLook>;

/**
 * The looks of a list's posts, one a post (Home's cards): each post half on
 * screen gets a look of its own, which ends when the post leaves the screen
 * or the list leaves the front, and reports `onLooked(postId)` after its
 * second, as `createPostViewLook` does for one post.
 */
export function createPostViewLookSet({
  onLooked,
  qualifyMs = POST_VIEW_QUALIFY_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}: {
  onLooked: (postId: string) => void;
  qualifyMs?: number;
  setTimer?: (callback: () => void, ms: number) => Timer;
  clearTimer?: (timer: Timer) => void;
}) {
  const looks = new Map<string, PostViewLook>();
  let foreground = false;
  let disposed = false;

  return {
    /** The posts half on screen now (`SHOWCASE_DWELL_VIEWABILITY`'s viewable set): a look starts for each one new. */
    setOnScreen(postIds: Iterable<string>) {
      if (disposed) return;
      const next = new Set(postIds);
      for (const [postId, look] of looks) {
        if (next.has(postId)) continue;
        look.dispose();
        looks.delete(postId);
      }
      for (const postId of next) {
        if (looks.has(postId)) continue;
        const look = createPostViewLook({ onLooked: () => onLooked(postId), qualifyMs, setTimer, clearTimer });
        look.setForeground(foreground);
        look.setOnScreen(true);
        looks.set(postId, look);
      }
    },
    /** Whether the list is in front: its screen focused, the app in the foreground. */
    setForeground(next: boolean) {
      if (disposed || foreground === next) return;
      foreground = next;
      for (const look of looks.values()) look.setForeground(next);
    },
    /** The list is gone: no look of it can end in a view. */
    dispose() {
      disposed = true;
      for (const look of looks.values()) look.dispose();
      looks.clear();
    },
  };
}

export type PostViewLookSet = ReturnType<typeof createPostViewLookSet>;

/** What a page, a card or a reel slide knows of the post it shows, for its view. */
export interface PostViewReportTarget {
  showcasePostId: string | null;
  /**
   * Someone else's post as a list or the read by id carries it (`showcase`).
   * A creation in its owner's library (`generation`) and the owner's own post
   * (`owner-post`) never report, whatever post they are linked to.
   */
  sourceType?: string | null;
  creatorId?: string | null;
  /**
   * Whether the post is known to be public and up: set by the builder that
   * read it (`viewsCountable` on a reel item and a Home card). A post whose
   * visibility the list does not say (Saved's) is not known to be public.
   */
  viewsCountable?: boolean;
}

/**
 * The post whose view a page, a card or a reel slide reports, or null where
 * it reports none:
 *
 * - a post not known to be public, or taken down: the server counts none;
 * - the reader's own post: the creator's views never count;
 * - a creation, or the owner's view of their post.
 *
 * Every other post reports, a post a feed delivered included: its impression
 * is counted as its view too, and the server keeps one mark a person, post and
 * UTC day, so whichever comes first counts and the other adds nothing (review
 * of #929: an impression the server refuses, or files as a repeat of the
 * grid's, would otherwise leave the reel's look uncounted). A post under its
 * mature-content cover counts while only the cover shows, as on the web
 * (owner, 2026-11-24: "Keep counting").
 */
export function viewReportPostId(
  target: PostViewReportTarget | null | undefined,
  { viewerIdentity }: { viewerIdentity: string | null },
): string | null {
  if (!target?.showcasePostId) return null;
  if (target.sourceType !== 'showcase') return null;
  if (target.viewsCountable !== true) return null;
  if (viewerIdentity && target.creatorId === viewerIdentity) return null;
  return target.showcasePostId;
}

/**
 * Whether the reel's slide is looked at: the reel settled on it and in front,
 * not its end slide, and nothing open over it. Details, the comments and the
 * reel's sheets cover the post (they stop its video too), and the post page
 * likewise counts nothing while its Details are open.
 */
export function isReelSlideOnScreen({
  initialPositionReady,
  focused,
  onEndSlide,
  overlayOpen,
}: {
  initialPositionReady: boolean;
  focused: boolean;
  onEndSlide: boolean;
  overlayOpen: boolean;
}): boolean {
  return initialPositionReady && focused && !onEndSlide && !overlayOpen;
}
