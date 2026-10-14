import type { ViewToken } from '@shopify/flash-list';

import { SHOWCASE_MAX_ACTIVE_VIDEO_PREVIEWS, SHOWCASE_MAX_PREPARED_VIDEO_PREVIEWS } from '@/lib/media-performance';
import { selectActiveShowcaseVideoIds, selectPreparedShowcaseVideoIds } from '@/lib/showcase-display';
import type { ShowcaseFeedItem } from '@/lib/types';

/**
 * How long to wait after a drag ends before concluding that momentum will
 * never arrive. `onScrollEndDrag` reports a velocity, but a fling that the
 * platform never follows with `onMomentumScrollBegin` would otherwise leave
 * the feed stuck in `settling` and never elect anything.
 */
export const SHOWCASE_SETTLE_CONFIRM_MS = 120;

/**
 * A drag that releases at or below this speed has come to rest, so it can
 * elect immediately instead of paying the confirm delay. Deliberately small:
 * guessing "at rest" wrongly elects mid-fling, which is the flicker.
 */
export const SHOWCASE_DRAG_END_REST_VELOCITY = 0.1;

export type ShowcaseScrollPhase = 'idle' | 'dragging' | 'settling' | 'momentum';

export interface ShowcaseActivationState {
  scroll: ShowcaseScrollPhase;
  /** Latest viewability report, buffered while the feed is in motion. */
  candidates: ShowcaseFeedItem[];
  /** Committed winners. Reference-stable when an election changes nothing. */
  activeIds: string[];
  /**
   * Both set from the autoplay preference against the network
   * (`lib/autoplay-preference.ts`). True: a report taken in motion elects
   * nothing, even among drawn players.
   */
  electOnlyAtRest: boolean;
  /** How many neighbour players the feed may prepare: `selectPreparedActivationIds`. */
  preparedLimit: number;
}

export type ShowcaseActivationEvent =
  | { type: 'dragBegin' }
  | { type: 'dragEnd'; velocityY?: number }
  | { type: 'momentumBegin' }
  | { type: 'momentumEnd' }
  | { type: 'settleTimeout' }
  | { type: 'viewableItemsChanged'; items: ShowcaseFeedItem[] }
  | { type: 'policyChanged'; electOnlyAtRest: boolean; preparedLimit: number }
  | { type: 'reset' };

export const INITIAL_SHOWCASE_ACTIVATION_STATE: ShowcaseActivationState = {
  scroll: 'idle',
  candidates: [],
  activeIds: [],
  electOnlyAtRest: false,
  preparedLimit: SHOWCASE_MAX_PREPARED_VIDEO_PREVIEWS,
};

export function sameStringList(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

export function getVisibleCardItems<Card extends { item: ShowcaseFeedItem }>(
  viewableItems: Array<ViewToken<Card>>,
) {
  const items: ShowcaseFeedItem[] = [];

  for (const token of viewableItems) {
    if (!token.isViewable || !token.item) continue;
    items.push(token.item.item);
  }

  return items;
}

/**
 * Decides *when* the showcase's single autoplay slot changes hands.
 *
 * The feed used to re-elect on every viewability tick, so a scroll handed the
 * slot around every ~180ms and each handoff destroyed and rebuilt an ExoPlayer
 * plus its hardware decoder — visible as flicker. Here elections happen only
 * once the feed is at rest; viewability reports taken while it moves are
 * buffered and applied at the next settle.
 *
 * *Which* card then wins is `selectActiveShowcaseVideoIds`, which holds the
 * playing video for as long as it stays viewable. The two rules cover different
 * halves: gating stops handoffs while the feed moves, holding stops them when
 * viewability jitters at rest or a new card appears above the one playing.
 *
 * A feed that keeps players prepared around the playing one can afford to hand
 * the slot over while moving, because starting a player that has drawn is a
 * resume rather than a mount. Such a feed passes `readyWhileMoving`: a report
 * taken in motion then elects among the candidates it accepts, plus the ones
 * already playing, and a winner it rejects waits for its readiness or for rest.
 * `electOnlyAtRest` (on mobile data, under the Wi-Fi only preference) sets
 * readiness aside: a feed that prepares nothing waits for rest, as one without
 * readiness does.
 */
export function reduceShowcaseActivation(
  state: ShowcaseActivationState,
  event: ShowcaseActivationEvent,
  limit: number = SHOWCASE_MAX_ACTIVE_VIDEO_PREVIEWS,
  readyWhileMoving?: (item: ShowcaseFeedItem) => boolean,
): ShowcaseActivationState {
  switch (event.type) {
    case 'reset': {
      // The policy belongs to the phone, not to the list a refetch replaces.
      const { electOnlyAtRest, preparedLimit } = state;
      const initial = INITIAL_SHOWCASE_ACTIVATION_STATE;
      return electOnlyAtRest === initial.electOnlyAtRest && preparedLimit === initial.preparedLimit
        ? initial
        : { ...initial, electOnlyAtRest, preparedLimit };
    }

    case 'policyChanged': {
      const preparedLimit = Math.max(0, event.preparedLimit);
      // Who plays stays as it is: a feed in motion keeps its winner to rest,
      // and the next report or readiness change elects under the new policy.
      return state.electOnlyAtRest === event.electOnlyAtRest && state.preparedLimit === preparedLimit
        ? state
        : { ...state, electOnlyAtRest: event.electOnlyAtRest, preparedLimit };
    }

    case 'viewableItemsChanged': {
      const next = { ...state, candidates: event.items };
      // An idle report is not just the initial mount: layout shifts, refetches
      // and non-animated jumps all land here, and nothing else would re-fire
      // on a resting screen. Skipping them strands a stale winner.
      if (state.scroll === 'idle') return elect(next, limit);
      if (!readyWhileMoving || state.electOnlyAtRest) return next;
      return electAmong(
        next,
        next.candidates.filter((item) => readyWhileMoving(item) || state.activeIds.includes(item.id)),
        limit,
      );
    }

    case 'dragBegin':
      return state.scroll === 'dragging' ? state : { ...state, scroll: 'dragging' };

    case 'dragEnd': {
      // Defensive: the bridge can deliver a stray end without a matching begin.
      if (state.scroll !== 'dragging') return state;
      const velocityY = event.velocityY;
      const restedUnderFinger = velocityY !== undefined
        && Math.abs(velocityY) <= SHOWCASE_DRAG_END_REST_VELOCITY;
      // An unknown velocity is treated as a fling: waiting one confirm window
      // costs nothing, while electing into a fling is the bug being fixed.
      return restedUnderFinger
        ? elect({ ...state, scroll: 'idle' }, limit)
        : { ...state, scroll: 'settling' };
    }

    case 'momentumBegin':
      return { ...state, scroll: 'momentum' };

    case 'momentumEnd':
      // A finger is already back down, so this is the previous fling expiring
      // underneath it. That finger's release owns the next election.
      return state.scroll === 'dragging' ? state : elect({ ...state, scroll: 'idle' }, limit);

    case 'settleTimeout':
      // Stale timer from a settle that momentum already resolved.
      return state.scroll === 'settling' ? elect({ ...state, scroll: 'idle' }, limit) : state;

    default:
      return state;
  }
}

/**
 * The videos a feed keeps a paused, loaded player for beside the one playing
 * (`selectPreparedShowcaseVideoIds`), under the activation's policy. A limit of
 * 0 prepares nothing at all: not the neighbours, and not the card the reader is
 * reaching either, whose player would otherwise start loading before the feed
 * rests.
 */
export function selectPreparedActivationIds(
  state: ShowcaseActivationState,
  items: ShowcaseFeedItem[],
  around: { viewableIds: string[]; anchorIds: string[]; activeIds: string[] },
): string[] {
  if (state.preparedLimit <= 0) return [];
  return selectPreparedShowcaseVideoIds(items, around, state.preparedLimit);
}

function elect(state: ShowcaseActivationState, limit: number): ShowcaseActivationState {
  return electAmong(state, state.candidates, limit);
}

function electAmong(state: ShowcaseActivationState, eligible: ShowcaseFeedItem[], limit: number): ShowcaseActivationState {
  const activeIds = selectActiveShowcaseVideoIds(eligible, limit, state.activeIds);
  // Keep the previous array when the winner is unchanged, so the screen can
  // skip its setState on a pointer comparison.
  return sameStringList(activeIds, state.activeIds) ? state : { ...state, activeIds };
}
