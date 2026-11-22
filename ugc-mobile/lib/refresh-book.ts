/**
 * The refresh book: a book whose pages turn in a coral circle at the top of a
 * list while it refreshes (`components/refresh-book.tsx`). It stands in for the
 * system's refresh spinner on the app's own lists (Home, Explore, Studio and
 * Alerts, your profile, credit history, templates; another creator's profile
 * and the comments sheet keep the system's), and it is what the reader pulls
 * down: the circle comes down with the finger and the top page lifts as the
 * pull nears the point where it refreshes.
 *
 * - iOS keeps the platform's pull (`UIRefreshControl`, its spinner drawn clear):
 *   it decides when the pull refreshes and holds the list's gap open while the
 *   feed loads. The circle rides down with the content, read from the list's
 *   scroll offset on the UI thread, and settles centred in the gap.
 * - Android's pull is the app's own. The platform's control takes only a
 *   colour, a background and a size from React Native, and asks every touch
 *   tracker above it to stand down as its pull starts, so nothing of the pull
 *   reaches JS. Instead a pan takes the touch (`androidPullDecision`) at the
 *   first move down while the list is at its top, a little before the list's
 *   own scroll would claim it, and the circle follows the finger. Let go past
 *   `ANDROID_PULL_TRIGGER` and the list refreshes; short of it the circle goes
 *   back up. The list does not move under the pull, as Android's never did.
 *   A drag that comes down away from the top and runs on past it is the
 *   platform's control's, kept under the pan for that: once the list's scroll
 *   has claimed a touch, gesture-handler stands every handler down, so no pan
 *   can take it over mid-drag. That control's circle is drawn coral, the
 *   book's size, and comes to rest where the book's does
 *   (`androidSystemPullOffset`), which takes its place at release.
 *
 * Pure: no React Native imports, so the rules and timing can be tested.
 * Functions marked `'worklet'` also run on the UI thread.
 */

export type RefreshBookPlatform = 'ios' | 'android' | string;

/** The circle and the book inside it, in points. */
export const REFRESH_BOOK_CHIP = { size: 56 } as const;
export const REFRESH_BOOK = { width: 30, height: 21 } as const;

/** How many pages turn, and one cycle of all of them, in milliseconds. */
export const REFRESH_BOOK_PAGES = 3;
export const REFRESH_BOOK_CYCLE_MS = 1300;
/** A page turns over this share of the cycle, and each starts this share after the one before. */
const PAGE_TURN_SHARE = 0.5;
const PAGE_STAGGER_SHARE = 0.18;
/**
 * Where in its cycle the book stands at a full pull: the top page lifted most
 * of the way to upright. The turning starts from there, so the page a reader
 * pulled up carries on over when the refresh begins.
 */
export const REFRESH_BOOK_LIFT_PHASE = 0.22;

/**
 * Once up, the chip stays at least this long — about one page turned — so a
 * refresh answered from the cache does not flash a chip for a frame or two.
 */
export const REFRESH_BOOK_MIN_VISIBLE_MS = 650;

/** iOS holds a 60pt gap open while refreshing; the circle rests centred in it. */
const IOS_REFRESH_GAP = 60;
/** How far an iOS pull goes before the book stands fully lifted (the control refreshes at about this). */
const IOS_PULL_FULL = 100;

/** Android: the circle rests this far below the content inset unless given a place. */
const ANDROID_REST_GAP = 8;
/** How far down a finger moves before the pull takes it: under Android's 8dp touch slop, so the pull claims the touch before the list's scroll does. */
export const PULL_ACTIVATE_DISTANCE = 6;
/** A move this far sideways before the pull has claimed the touch leaves it to the row or pager under the finger. */
const PULL_SIDEWAYS_DISTANCE = 6;
/** How far the finger travels, once the pull has it, for the pull to refresh. */
export const ANDROID_PULL_TRIGGER = 110;
/** The circle starts this far above its resting place and reaches it at the trigger. */
const ANDROID_PULL_TRAVEL = 64;
/** Past the trigger the circle follows the finger at a quarter of its pace, to this far below its rest. */
const ANDROID_OVERPULL_RATE = 0.25;
const ANDROID_OVERPULL_MAX = 36;

/**
 * Where the circle's top edge rests, from the top of the list's own box.
 * `contentTop` is the inset the list draws its content below (a status bar it
 * scrolls under, a header over it). iOS rests it in its gap there; Android
 * rests it just under the inset, or at `restTop` where the list's first row
 * is controls (Home's top bar) it should not settle over.
 */
export function refreshBookChipTop(platform: RefreshBookPlatform, contentTop: number, restTop?: number): number {
  if (platform === 'android') return restTop ?? contentTop + ANDROID_REST_GAP;
  return contentTop + (IOS_REFRESH_GAP - REFRESH_BOOK_CHIP.size) / 2;
}

/**
 * Android's own control, as React Native sets it up (`ReactSwipeRefreshLayout`):
 * its circle rests `offset + 64 - diameter` below the top of the list, and the
 * large circle is 56dp across, the book's own circle.
 */
const ANDROID_SYSTEM_CIRCLE_TARGET = 64;
export const ANDROID_SYSTEM_CIRCLE_LARGE = 56;

/** The `progressViewOffset` that brings Android's own circle to rest at `restTop`, where the book's rests. */
export function androidSystemPullOffset(restTop: number): number {
  return restTop - (ANDROID_SYSTEM_CIRCLE_TARGET - ANDROID_SYSTEM_CIRCLE_LARGE);
}

export type PullDecision = 'wait' | 'pull' | 'pass';

/**
 * Whether Android's pull takes a touch, from how far the finger has moved
 * since it came down (`dx`, `dy`, down positive) and whether the list is at
 * its top. `pass` leaves the touch to what is under it for good; `wait`
 * decides at a later move.
 */
export function androidPullDecision(dx: number, dy: number, atTop: boolean): PullDecision {
  'worklet';
  if (!atTop) return 'pass';
  const sideways = Math.abs(dx);
  if (sideways >= PULL_SIDEWAYS_DISTANCE && sideways >= dy) return 'pass';
  if (dy <= -PULL_ACTIVATE_DISTANCE) return 'pass';
  if (dy >= PULL_ACTIVATE_DISTANCE && dy > sideways) return 'pull';
  return 'wait';
}

/** The pull's own length from the pan's translation: the start distance it took to claim the touch is not counted. */
export function androidPullDistance(translationY: number): number {
  'worklet';
  return Math.max(0, translationY - PULL_ACTIVATE_DISTANCE);
}

/** How far along to refreshing a pull is, 0 to 1. */
export function refreshPullProgress(platform: RefreshBookPlatform, pulled: number): number {
  'worklet';
  const full = platform === 'android' ? ANDROID_PULL_TRIGGER : IOS_PULL_FULL;
  return Math.min(1, Math.max(0, pulled / full));
}

/** Whether letting go of an Android pull this long refreshes. */
export function androidPullRefreshes(distance: number): boolean {
  'worklet';
  return distance >= ANDROID_PULL_TRIGGER;
}

/**
 * The circle's offset from its resting place while pulled. Android: it comes
 * down from above, reaches its rest at the trigger, then gives a little. iOS:
 * it rides with the content, `pulled` points down, at rest when the gap is the
 * control's own 60pt.
 */
export function refreshPullOffset(platform: RefreshBookPlatform, pulled: number): number {
  'worklet';
  if (platform === 'android') {
    const progress = Math.min(1, Math.max(0, pulled / ANDROID_PULL_TRIGGER));
    const overpull = Math.min(ANDROID_OVERPULL_MAX, Math.max(0, pulled - ANDROID_PULL_TRIGGER) * ANDROID_OVERPULL_RATE);
    return -ANDROID_PULL_TRAVEL * (1 - progress) + overpull;
  }
  return pulled - IOS_REFRESH_GAP;
}

/** How far an iOS list is pulled down past its top, from its scroll offset. */
export function iosPulled(contentOffsetY: number): number {
  'worklet';
  return Math.max(0, -contentOffsetY);
}

/**
 * Where in its cycle the book stands: turning on its own clock (a phase that
 * only ever grows, read modulo 1) while refreshing, or lifted by the pull.
 */
export function refreshBookPhase(turning: boolean, clock: number, progress: number): number {
  'worklet';
  if (turning) return clock - Math.floor(clock);
  return progress * REFRESH_BOOK_LIFT_PHASE;
}

/** How long to keep the chip up after its refresh ends. */
export function refreshBookHideDelayMs(shownAtMs: number, nowMs: number): number {
  return Math.max(0, REFRESH_BOOK_MIN_VISIBLE_MS - Math.max(0, nowMs - shownAtMs));
}

/**
 * A page's turn at `phase` (0 to 1 through the cycle): 0 lies flat on the right,
 * -180 flat on the left. Each page lifts, turns and lands in order; at the end
 * of the cycle every page lies on the left and all go back to the right at once,
 * which does not show: a page looks the same on either side.
 */
export function refreshBookPageAngle(phase: number, index: number): number {
  'worklet';
  const start = index * PAGE_STAGGER_SHARE;
  const local = (phase - start) / PAGE_TURN_SHARE;
  if (local <= 0) return 0;
  if (local >= 1) return -180;
  // Ease in and out: a page lifts slowly, falls quickly through the middle and settles.
  const eased = local < 0.5 ? 2 * local * local : 1 - ((-2 * local + 2) ** 2) / 2;
  return -180 * eased;
}
