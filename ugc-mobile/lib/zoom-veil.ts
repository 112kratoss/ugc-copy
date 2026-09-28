import { createContext } from 'react';
import type { Animated } from 'react-native';
import { makeMutable, withDelay, withTiming, type SharedValue } from 'react-native-reanimated';

import { isAppleZoomAvailable } from './apple-zoom-available';
import type { ZoomRect } from './media-zoom-transition';

/**
 * How much of the screen a reel grew out of is covered in black while UIKit's
 * zoom runs (lib/apple-zoom.ts): 1 from the tap until the reel has landed, and
 * again until a close has shrunk it most of the way back; 0 otherwise.
 *
 * UIKit crossfades the tile into the reel as the window grows, and the reel
 * back into the tile as it shrinks. A crossfade is two pictures at part
 * opacity, and between them whatever lies beneath shows through: for a quarter
 * of a second the growing picture was washed with the light feed behind it,
 * measured on the simulator as the picture's darkest pixels lifting from 22 to
 * 67 of 255. UIKit's own dimming of that feed is slight while the crossfade
 * runs (even told to dim to black it takes 250 ms to get there, the crossfade
 * is over by then, and the close bled the same way) and offers no control over
 * the crossfade itself, so the app covers the feed in black under the
 * transition, the way Photos darkens its grid, and the pictures cross over
 * black instead. The veil lifts as a close begins — after the crossfade, over
 * the rest of the shrink — so the feed comes back behind the shrinking picture.
 *
 * The veil darkens with the growing picture: from the tap until the reel has
 * landed its opacity follows the reel's own transition, which react-native-
 * screens drives on the native thread (`followZoomVeilTransition`), so the feed
 * does not go black while the reel's route is still being built. Landed, it
 * rests at full cover (`settleZoomVeil`). A close the reader drives with a
 * gesture follows the transition again, since a gesture can be held or
 * reversed indefinitely; Back fades out on a timer.
 *
 * Every screen a reel can grow out of has a veil of its own (`ZoomVeilScope` in
 * components/zoom-veil.tsx), and a tap drops the veil of the screen its tile is
 * on. Only the reel that tap opened lifts, holds or lets go of it
 * (`ZoomVeilDrop`). One veil shared by every screen was read and written by
 * every reel: a creator page pushed from a reel went black while the reel's
 * transition moved, and a reel opened from that page took the veil down under
 * the first reel as it closed, which then shrank into its tile over the lit
 * feed with its own black bands showing around the picture.
 *
 * The tile itself stays clear of the veil until the transition begins (the
 * screen's `hole`): UIKit takes the tile's picture into its own view only as
 * the push starts, some frames after the tap, and a veil over the tile too
 * blacked the whole screen out for that stretch before the picture appeared.
 *
 * Android and iOS before 18 open the reel another way and never veil.
 */

/** The tapped tile's rectangle on screen and the radius its corners are drawn with. */
export interface ZoomVeilHole extends ZoomRect {
  radius?: number;
}

/** What one screen's veil is drawn from (components/zoom-veil.tsx). */
export interface ScreenVeil {
  /** How much of the screen is covered, while the veil is not following a transition. */
  cover: SharedValue<number>;
  /** The tapped tile, left clear until the transition begins; null for none. */
  hole: SharedValue<ZoomVeilHole | null>;
}

/**
 * The veil one tap dropped: the screen it covers, and which of that screen's
 * drops it is. The reel the tap opened carries it (`ZoomOrigin.veil`) and hands
 * it to everything below; a reel whose drop a later tap has replaced touches
 * nothing.
 */
export interface ZoomVeilDrop {
  readonly owner: string;
  readonly serial: number;
}

/** A reel's transition as its screen's veil opacity; see components/apple-zoom-progress.ios.tsx. */
export type ZoomVeilTransition = Animated.AnimatedInterpolation<number>;

/**
 * Names the screen a tile is on, for the veil its tap drops. Provided by
 * `ZoomVeilScope`, which draws that screen's veil; a tile outside any scope
 * drops none.
 */
export const ZoomVeilOwnerContext = createContext<string | null>(null);

/**
 * After the crossfade at the start of a close, before the feed comes back:
 * measured on the simulator, the reel and the tile cross over 130–170 ms into
 * a close, which the veil has to outlast.
 */
export const ZOOM_VEIL_LIFT_DELAY_MS = 150;
/** Over which the feed comes back: the rest of the visible shrink, which lands at about 300 ms. */
export const ZOOM_VEIL_LIFT_MS = 200;
/** A veil no reel claims — the push never came — lifts by itself after this. */
export const ZOOM_VEIL_DEADLINE_MS = 4000;

interface ScreenVeilState {
  owner: string;
  veil: ScreenVeil;
  /** The latest drop on this screen; see `ZoomVeilDrop`. */
  serial: number;
  claimed: boolean;
  closing: 'timed' | 'interactive' | null;
  deadline: ReturnType<typeof setTimeout> | null;
  /** The transition of the reel this screen's latest drop opened, once that reel has bound it. */
  transition: ZoomVeilTransition | null;
  /** Whether the veil's opacity follows `transition` (nothing at all until one is bound). */
  following: boolean;
}

const screens = new Map<string, ScreenVeilState>();
/**
 * Kept apart from `screens`: a screen's veil subscribes as it mounts, which can
 * come before the screen registers, and a remounted screen registers anew.
 */
const listeners = new Map<string, Set<() => void>>();
let serials = 0;

function notify(owner: string) {
  listeners.get(owner)?.forEach((listener) => listener());
}

function clearDeadline(state: ScreenVeilState) {
  if (!state.deadline) return;
  clearTimeout(state.deadline);
  state.deadline = null;
}

function setFollowing(state: ScreenVeilState, following: boolean) {
  if (state.following === following) return;
  state.following = following;
  notify(state.owner);
}

/** The screen `drop` covers, while `drop` is still that screen's latest. */
function screenOf(drop: ZoomVeilDrop | null | undefined): ScreenVeilState | null {
  if (!drop) return null;
  const state = screens.get(drop.owner);
  return state && state.serial === drop.serial ? state : null;
}

function uncover(state: ScreenVeilState) {
  clearDeadline(state);
  state.claimed = false;
  state.closing = null;
  setFollowing(state, false);
  state.veil.hole.set(null);
  state.veil.cover.set(0);
}

/** The values one screen's veil is drawn from, clear. */
export function createScreenVeil(): ScreenVeil {
  return { cover: makeMutable(0), hole: makeMutable<ZoomVeilHole | null>(null) };
}

/** Lets taps on `owner`'s tiles drop `veil`; the returned function forgets it again. */
export function registerScreenVeil(owner: string, veil: ScreenVeil) {
  const state: ScreenVeilState = {
    owner,
    veil,
    serial: 0,
    claimed: false,
    closing: null,
    deadline: null,
    transition: null,
    following: false,
  };
  screens.set(owner, state);
  notify(owner);
  return () => {
    if (screens.get(owner) !== state) return;
    clearDeadline(state);
    screens.delete(owner);
    notify(owner);
  };
}

/**
 * The tap that opens a reel: `owner`'s screen goes black around the tapped
 * tile, under the transition that follows. `hole` is the tile on screen. Null
 * where nothing was dropped: no zoom, or a tile on no veiled screen.
 */
export function dropZoomVeil(owner: string | null, hole: ZoomVeilHole | null): ZoomVeilDrop | null {
  if (!isAppleZoomAvailable() || !owner) return null;
  const state = screens.get(owner);
  if (!state) return null;
  serials += 1;
  const drop: ZoomVeilDrop = { owner, serial: serials };
  state.serial = drop.serial;
  state.claimed = false;
  state.closing = null;
  // Clear until the reel's transition is bound and moving.
  state.transition = null;
  state.following = true;
  notify(owner);
  state.veil.hole.set(hole);
  state.veil.cover.set(1);
  clearDeadline(state);
  state.deadline = setTimeout(() => {
    state.deadline = null;
    if (!state.claimed) clearZoomVeil(drop);
  }, ZOOM_VEIL_DEADLINE_MS);
  return drop;
}

/** The reel that was pushed is up: the veil is its to lift. */
export function claimZoomVeil(drop: ZoomVeilDrop | null) {
  const state = screenOf(drop);
  if (!state) return;
  state.claimed = true;
  clearDeadline(state);
}

/** The push has begun: UIKit is drawing the tile's picture above the veil now, so the veil covers the tile too. */
export function closeZoomVeilHole(drop: ZoomVeilDrop | null) {
  screenOf(drop)?.veil.hole.set(null);
}

/**
 * The reel `drop` opened hands its screen's veil its own transition. The
 * returned function takes it back, for a reel leaving React.
 */
export function followZoomVeilTransition(drop: ZoomVeilDrop, transition: ZoomVeilTransition) {
  const state = screenOf(drop);
  if (!state) return () => {};
  state.transition = transition;
  notify(state.owner);
  return () => {
    if (state.transition !== transition) return;
    state.transition = null;
    state.following = false;
    notify(state.owner);
  };
}

/**
 * The reel has landed, or is on top again: its screen's veil rests at full
 * cover. What the reel's own screen does beneath a screen pushed over it — a
 * creator page slides over it, and back off it — is no business of the veil,
 * which is under the reel all that time.
 */
export function settleZoomVeil(drop: ZoomVeilDrop | null) {
  const state = screenOf(drop);
  if (!state || state.closing) return;
  setFollowing(state, false);
  state.veil.cover.set(1);
}

/**
 * A close has begun: the screen comes back behind the shrinking reel. One the
 * reader drives with a gesture follows the reel's transition, which a finger
 * can hold or reverse; Back fades the veil out on a timer.
 */
export function liftZoomVeil(drop: ZoomVeilDrop | null, interactive = false) {
  const state = screenOf(drop);
  if (!state) return;
  clearDeadline(state);
  state.veil.hole.set(null);
  if (interactive && state.transition) {
    state.closing = 'interactive';
    state.veil.cover.set(1);
    setFollowing(state, true);
    return;
  }
  if (state.closing === 'interactive') return;
  state.closing = 'timed';
  setFollowing(state, false);
  state.veil.cover.set(withDelay(ZOOM_VEIL_LIFT_DELAY_MS, withTiming(0, { duration: ZOOM_VEIL_LIFT_MS })));
  state.deadline = setTimeout(() => clearZoomVeil(drop), ZOOM_VEIL_LIFT_DELAY_MS + ZOOM_VEIL_LIFT_MS);
}

/** A close let go of before it committed: the reel is back, and so is the veil. */
export function holdZoomVeil(drop: ZoomVeilDrop | null) {
  const state = screenOf(drop);
  if (!state) return;
  clearDeadline(state);
  state.closing = null;
  setFollowing(state, false);
  state.veil.hole.set(null);
  state.veil.cover.set(1);
}

/** Nothing is left to veil: gone at once. */
export function clearZoomVeil(drop: ZoomVeilDrop | null) {
  const state = screenOf(drop);
  if (state) uncover(state);
}

/**
 * The reel has gone from React. A Back close under way keeps fading: Back
 * takes the reel out of React before UIKit's shrink has begun
 * (react-native-screens pops a snapshot of it), and clearing the veil then put
 * the lit feed behind the whole close. Any other veil goes at once.
 */
export function releaseZoomVeil(drop: ZoomVeilDrop | null) {
  const state = screenOf(drop);
  if (!state || state.closing === 'timed') return;
  uncover(state);
}

/**
 * What `owner`'s veil is drawn at: null for its own `cover`, 0 while it waits
 * for a reel's transition, or that transition.
 */
export function getZoomVeilOpacity(owner: string): ZoomVeilTransition | 0 | null {
  const state = screens.get(owner);
  if (!state?.following) return null;
  return state.transition ?? 0;
}

export function subscribeToZoomVeilOpacity(owner: string, listener: () => void) {
  let set = listeners.get(owner);
  if (!set) {
    set = new Set();
    listeners.set(owner, set);
  }
  const subscribed = set;
  subscribed.add(listener);
  return () => {
    subscribed.delete(listener);
    if (subscribed.size === 0 && listeners.get(owner) === subscribed) listeners.delete(owner);
  };
}

/** Test support: every screen forgotten, every timer stopped. */
export function resetZoomVeil() {
  screens.forEach(clearDeadline);
  screens.clear();
  listeners.clear();
  serials = 0;
}
