import type { FeedVideoActivationStore } from './feed-video-activation';
import {
  FEED_DECELERATION_PER_MS,
  FEED_FAST_COAST_PT_PER_MS,
  FEED_PREPARED_WINDOW_STEP_MS,
  SHOWCASE_MAX_ACTIVE_VIDEO_PREVIEWS,
  SHOWCASE_MAX_PREPARED_VIDEO_PREVIEWS,
} from './media-performance';
import {
  isShowcaseVideoPreviewCandidate,
  selectActiveShowcaseVideoIds,
  selectPreparedShowcaseVideoIds,
} from './showcase-display';
import {
  INITIAL_SHOWCASE_ACTIVATION_STATE,
  reduceShowcaseActivation,
  sameStringList,
  SHOWCASE_SETTLE_CONFIRM_MS,
  type ShowcaseActivationEvent,
} from './showcase-feed-activation';
import type { ShowcaseFeedItem } from './types';

export type HomeFeedPlaybackEvent =
  | ShowcaseActivationEvent
  /** The screen blurred or the app left the foreground: native scroll end events may never arrive. */
  | { type: 'stop' }
  /** The feed's items in card order, for choosing the prepared neighbours. */
  | { type: 'itemsChanged'; items: ShowcaseFeedItem[] };

/**
 * How many videos away from the cards the reader is on a prepared player may be
 * and still be kept when it is not in the window's target. Two covers both
 * neighbours of either card of a pair the reader rocks between.
 */
const KEPT_VIDEO_GAP = 2;

/** Distance in videos (image and text posts do not count) from `id` to the nearest of `rangeIds`. */
function videoGap(items: ShowcaseFeedItem[], id: string, rangeIds: string[]) {
  const videos = items.filter(isShowcaseVideoPreviewCandidate).map((item) => item.id);
  const position = videos.indexOf(id);
  const range = rangeIds.map((rangeId) => videos.indexOf(rangeId)).filter((index) => index !== -1);
  if (position === -1 || !range.length) return Number.POSITIVE_INFINITY;
  return Math.min(...range.map((index) => Math.abs(index - position)));
}

/**
 * How long, from a release at `releaseVelocity` points per millisecond, the
 * feed keeps coasting faster than `FEED_FAST_COAST_PT_PER_MS`: the speed decays
 * by `FEED_DECELERATION_PER_MS` each millisecond, so it crosses the threshold
 * after log(threshold / speed) / log(rate) ms. Zero for a slow or unknown release.
 */
export function fastCoastHoldMs(releaseVelocity: number | undefined) {
  const speed = Math.abs(releaseVelocity ?? 0);
  if (!(speed > FEED_FAST_COAST_PT_PER_MS)) return 0;
  return Math.log(FEED_FAST_COAST_PT_PER_MS / speed) / Math.log(FEED_DECELERATION_PER_MS);
}

/**
 * Decides what the Home feed plays and prepares, and when each change lands.
 *
 * Two rules keep a video's start out of the scroll's frames:
 *
 * - An election in motion is only ever a resume. While the feed moves, a card
 *   may take the slot only if its tile reports a drawn player (the store's
 *   readiness), so flipping it to `active` calls `play()` on a picture already
 *   on screen. A qualified card without one waits for its player to draw, or
 *   for the feed to rest, whichever comes first.
 * - The prepared window moves one step at a time, `FEED_PREPARED_WINDOW_STEP_MS`
 *   apart, starting after the election has been published. Mounting a prepared
 *   player and unmounting a released one are the native view changes that cost
 *   a frame, so none of them shares a commit with the election or with each
 *   other. Releases go before mounts, so live players never exceed one playing
 *   plus `SHOWCASE_MAX_PREPARED_VIDEO_PREVIEWS`, plus one waiting out its
 *   release grace.
 *
 * The election itself touches only the winner and the video it takes over
 * from: the outgoing video stays prepared until the window moves, so the
 * election commit mounts and unmounts nothing.
 *
 * The window only trades one near neighbour for another when the reader has
 * reached a card it was not built around. Scrolling up and down between two
 * cards flips which one plays, and each flip moved a three-player window by one
 * card: one player released and a new one created on the main thread, on every
 * reversal (measured on the iPhone, 2026-09-23). Now a rock between cards the
 * window already covers only flips play and pause; players two or more videos
 * away still go, the card the reader reached always gets its player, and a
 * spare slot is always filled.
 *
 * The window holds while a fling coasts fast (`fastCoastHoldMs`): the cards it
 * passes are gone before a player could draw, and creating one is main-thread
 * work plus synchronous media-server calls in the fling's frames. A finger on
 * the feed, the end of the coast, or its slowing past the threshold lets the
 * window move again, so a slow scroll prepares and starts videos as before.
 */
export function createHomeFeedPlaybackController(store: FeedVideoActivationStore) {
  let activation = INITIAL_SHOWCASE_ACTIVATION_STATE;
  let items: ShowcaseFeedItem[] = [];
  // The last report that had any viewable card, and the videos that report
  // would elect at rest — the winner, or the qualified card whose player is
  // still drawing. Both survive the empty reports that arrive mid-scroll,
  // between two cards, so the window neither collapses on the way nor releases
  // the destination's player before the reader arrives.
  let viewableIds: string[] = [];
  let anchorIds: string[] = [];
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  let stepTimer: ReturnType<typeof setTimeout> | null = null;
  // Until when (Date.now()) the window holds for a fast coast; 0 when it does not.
  let windowHoldUntil = 0;
  // The last two anchors the window was completed around, oldest first.
  let builtFor: string[] = [];

  const readyWhileMoving = (item: ShowcaseFeedItem) => store.isReady(item.id);

  function clearSettleTimer() {
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = null;
  }

  function clearStepTimer() {
    if (stepTimer !== null) clearTimeout(stepTimer);
    stepTimer = null;
  }

  function reelect() {
    activation = reduceShowcaseActivation(
      activation,
      { type: 'viewableItemsChanged', items: activation.candidates },
      SHOWCASE_MAX_ACTIVE_VIDEO_PREVIEWS,
      readyWhileMoving,
    );
    publishElection();
  }

  function dispatch(event: HomeFeedPlaybackEvent) {
    if (event.type === 'itemsChanged') {
      items = event.items;
      scheduleWindowStep();
      return;
    }

    const previousPhase = activation.scroll;
    if (event.type === 'dragEnd') {
      const hold = fastCoastHoldMs(event.velocityY);
      // Whole milliseconds, so the step waiting it out fires after it, not a step later.
      windowHoldUntil = hold > 0 ? Date.now() + Math.ceil(hold) : 0;
    } else if (windowHoldUntil !== 0 && (
      event.type === 'dragBegin' || event.type === 'momentumEnd' || event.type === 'settleTimeout'
      || event.type === 'stop' || event.type === 'reset'
    )) {
      // A finger stopped the coast, or it ended: the step waiting out the hold goes now.
      windowHoldUntil = 0;
      clearStepTimer();
    }
    if (event.type === 'stop') {
      // Focus or background interruption may omit the native end event, so
      // the feed counts as resting and settles on what it holds.
      activation = { ...activation, scroll: 'idle' };
      activation = reduceShowcaseActivation(
        activation,
        { type: 'viewableItemsChanged', items: activation.candidates },
        SHOWCASE_MAX_ACTIVE_VIDEO_PREVIEWS,
      );
    } else {
      activation = reduceShowcaseActivation(activation, event, SHOWCASE_MAX_ACTIVE_VIDEO_PREVIEWS, readyWhileMoving);
    }

    if (activation.scroll !== 'settling') clearSettleTimer();
    else if (previousPhase !== 'settling') {
      clearSettleTimer();
      settleTimer = setTimeout(() => {
        settleTimer = null;
        dispatch({ type: 'settleTimeout' });
      }, SHOWCASE_SETTLE_CONFIRM_MS);
    }

    if (event.type === 'reset') {
      viewableIds = [];
      anchorIds = [];
      builtFor = [];
      clearStepTimer();
      store.publish({ activeIds: [], preparedIds: [] });
      return;
    }

    publishElection();
  }

  function publishElection() {
    const candidateIds = activation.candidates.map((item) => item.id);
    if (candidateIds.length) {
      if (!sameStringList(candidateIds, viewableIds)) viewableIds = candidateIds;
      const anchors = selectActiveShowcaseVideoIds(activation.candidates, SHOWCASE_MAX_ACTIVE_VIDEO_PREVIEWS, activation.activeIds);
      if (!sameStringList(anchors, anchorIds)) anchorIds = anchors;
    }

    const published = store.snapshot();
    if (!sameStringList(activation.activeIds, published.activeIds)) {
      // The video losing the slot keeps its player until the window moves:
      // the reader may come straight back, and unmounting it here would put a
      // native view change in the election's own commit.
      const outgoing = published.activeIds.filter((id) => !activation.activeIds.includes(id));
      const preparedIds = [...new Set([...published.preparedIds, ...outgoing])]
        .filter((id) => !activation.activeIds.includes(id));
      store.publish({ activeIds: activation.activeIds, preparedIds });
    }
    scheduleWindowStep();
  }

  function scheduleWindowStep() {
    // A pending step recomputes the target when it fires, so one timer is enough.
    if (stepTimer !== null) return;
    stepTimer = setTimeout(() => {
      stepTimer = null;
      stepWindow();
    }, Math.max(FEED_PREPARED_WINDOW_STEP_MS, windowHoldUntil - Date.now()));
  }

  /** Moves the published prepared set one tile closer to where it should be. */
  function stepWindow() {
    if (Date.now() < windowHoldUntil) {
      scheduleWindowStep();
      return;
    }
    const { activeIds, preparedIds } = store.snapshot();
    const target = selectPreparedShowcaseVideoIds(
      items,
      { viewableIds, anchorIds, activeIds },
      SHOWCASE_MAX_PREPARED_VIDEO_PREVIEWS,
    );
    const range = anchorIds.length ? anchorIds : viewableIds;
    const gap = (id: string) => videoGap(items, id, range);
    const release = (id: string) => {
      store.publish({ preparedIds: preparedIds.filter((preparedId) => preparedId !== id) });
      scheduleWindowStep();
    };

    // Players the reader has left behind go first, always.
    const distant = preparedIds.find((id) => !target.includes(id) && gap(id) > KEPT_VIDEO_GAP);
    if (distant !== undefined) {
      release(distant);
      return;
    }

    const missing = target.filter((id) => !preparedIds.includes(id));
    if (!missing.length) {
      builtFor = [...builtFor.filter((id) => !anchorIds.includes(id)), ...anchorIds].slice(-2);
      return;
    }
    const hasRoom = new Set([...activeIds, ...preparedIds]).size < SHOWCASE_MAX_ACTIVE_VIDEO_PREVIEWS + SHOWCASE_MAX_PREPARED_VIDEO_PREVIEWS;
    const reached = missing.find((id) => anchorIds.includes(id));
    const movedOn = anchorIds.some((id) => !builtFor.includes(id));
    if (!hasRoom && reached === undefined && !movedOn) return;

    if (!hasRoom) {
      // Make room by releasing the player farthest from the reader.
      const spare = preparedIds
        .filter((id) => !target.includes(id))
        .sort((left, right) => gap(right) - gap(left))[0];
      if (spare !== undefined) release(spare);
      return;
    }
    store.publish({ preparedIds: [...preparedIds, reached ?? missing[0]] });
    scheduleWindowStep();
  }

  return {
    dispatch,
    /**
     * Whether the feed is being dragged, coasting, or has not yet confirmed its
     * rest. Other work on the screen that can wait (the header rail's turn)
     * asks this, so it lands between scrolls rather than in their frames.
     */
    isMoving() {
      return activation.scroll !== 'idle';
    },
    /**
     * Listens for tiles' readiness until the returned disconnect runs, which
     * also cancels pending timers. Shaped for an effect: a remount or a Fast
     * Refresh that disconnects and connects again leaves a working controller.
     */
    connect() {
      // A neighbour's player drawing is what lets a card the reader has
      // reached start while the feed is still moving, so it re-runs the election.
      const unsubscribe = store.subscribeReady(() => reelect());
      return () => {
        unsubscribe();
        clearSettleTimer();
        clearStepTimer();
      };
    },
  };
}
