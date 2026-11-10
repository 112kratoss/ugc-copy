/**
 * iOS: a still picture's own flight home into its tile when the reel's Back is
 * pressed (owner, 2026-11-10, after UIKit's zoom with the page cut down under
 * it: "it is not smooth", then "what is instagram using ?" and "can you build
 * it").
 *
 * UIKit's zoom moves the reel's page on its own spring from the frame the
 * bar's Back pops it, about 8% smaller in its first frame whatever it is
 * lined up with (a mark put on the tile's own frame, so that the page had
 * nowhere to go, still shrank and slid; simulator, 2026-11-10). Anything the
 * app adds once it hears of the pop, 10 to 70 ms later, is a second movement
 * laid over that one. So the picture is taken out of the page before UIKit
 * draws its first frame, and flown by the app alone:
 *
 * - While a reel rests on a picture its tile shows, the picture is drawn a
 *   second time above the navigator, unseen, in the same place
 *   (`ReelCloseFlightLayer`, components/reel-close-flight.ios.tsx).
 * - A finger lifting off the bar's Back is read on the UI thread, ahead of the
 *   button itself (`ReelCloseFlightTouches`). In that same frame the copy and
 *   a black ground under it are shown and the reel's page is hidden
 *   (`takeOffReelCloseFlight`), so UIKit pops, and brings the feed back, with
 *   a page that has nothing left in it to be seen moving.
 * - The copy then travels to the tile on one curve, its crop and corners
 *   changing all the way, while the ground fades over the feed. It lands on
 *   the tile, which shows again under it, and fades.
 *
 * The edge swipe, the drag down and a video's Back are UIKit's zoom as they
 * were (components/reel-close-morph.tsx).
 *
 * This file is the part with no React in it: the flight's shared values, its
 * curves, and what the JS thread does around it.
 */
import { makeMutable, runOnJS, runOnUI, withTiming } from 'react-native-reanimated';

import { holdAppleZoomReturnPicture, releaseAppleZoomReturnPicture } from '@/lib/apple-zoom-surface';
import { hideZoomSourceUntilLanding, showZoomSourceAtLanding, type ZoomRect, type ZoomSize } from '@/lib/media-zoom-transition';

/** How long the picture takes from the page to its tile, in frames no longer than `REEL_CLOSE_FLIGHT_MAX_STEP_MS`. */
export const REEL_CLOSE_FLIGHT_MS = 340;
/**
 * The longest step one frame may take. The pop under the flight has the UI
 * thread do the navigator's work in the flight's first frames; timed by the
 * clock the picture would jump ahead by every frame that work held, where
 * stepped it waits and then goes on from where it was.
 */
export const REEL_CLOSE_FLIGHT_MAX_STEP_MS = 20;
/**
 * How far along its way the picture counts as landed: the tile shows again
 * under it and it starts to fade, while it settles the last point or two. The
 * curve spends a third of its time on that last hundredth, and waiting it out
 * kept the tile's badge and names away for 100 ms after the picture had
 * visibly stopped (filmed 2026-11-10).
 */
export const REEL_CLOSE_FLIGHT_LANDS_AT = 0.985;
/** The share of the flight by which the black under the picture has gone. */
export const REEL_CLOSE_FLIGHT_GROUND_GONE_AT = 0.5;
/** How long the landed picture takes to give way to the tile under it. */
export const REEL_CLOSE_FLIGHT_LANDING_FADE_MS = 120;
/**
 * How long a flight waits to hear that the reel is being popped. The lift it
 * took off on was over the bar's Back, and the button, which is UIKit's, may
 * still not have taken it for a press.
 */
export const REEL_CLOSE_FLIGHT_UNCONFIRMED_MS = 250;
/** How far a finger may move on the bar's Back and still be pressing it. */
export const REEL_BACK_PRESS_SLOP = 10;

export interface ReelCloseFlightPlan {
  /** The reel whose picture flies (`nextReelCloseFlightId`). */
  reelId: number;
  /** Where the picture sits on the reel's page. */
  from: ZoomRect;
  /** The tile it lands in, and the tile's corners. */
  to: ZoomRect;
  radius: number;
  /** The view of that tile UIKit's zoom would shrink the reel into (`appleZoomSourceId`). */
  sourceId: string;
  /**
   * How far up from the bottom of the screen the picture is not drawn, as it
   * leaves and once the black under it has gone (`reelCloseFlightFloor`): both
   * 0 unless its tile sits under its screen's bar.
   */
  floorFrom: number;
  floorTo: number;
  /** What stands up out of that bar, which the picture is not drawn over either: from where, how wide, how high. */
  capLeft: number;
  capWidth: number;
  capHeight: number;
  /** Where the bar's Back is on screen (`reelBackButtonRegion`). */
  back: ZoomRect;
}

let reelIds = 0;

/** A number for one mounted reel, never 0. */
export function nextReelCloseFlightId() {
  reelIds += 1;
  return reelIds;
}

/**
 * The bar's Back on the reel: a 44 pt round button, 16 pt in from the leading
 * edge, in a bar that begins at the top inset (iOS 26, measured on an iPhone
 * 17 Pro, 2026-11-10). Taken a little small rather than large: a press that
 * misses this and still pops the reel closes under UIKit's zoom, as before,
 * where one that lands here and does not pop it sets off a flight that has to
 * be called back.
 */
export function reelBackButtonRegion(topInset: number): ZoomRect {
  return { x: 14, y: topInset - 2, width: 48, height: 48 };
}

export function isInReelBackRegion(region: ZoomRect, x: number, y: number) {
  'worklet';
  return x >= region.x && x <= region.x + region.width && y >= region.y && y <= region.y + region.height;
}

// ---------------------------------------------------------------------------
// Curves
// ---------------------------------------------------------------------------

/** How fast the travel's curve settles: higher is quicker off the mark and longer at rest. */
const TRAVEL_STIFFNESS = 9;

/**
 * How far the picture has gone at `time` (both 0 to 1): the curve of a spring
 * with no bounce in it. It starts from rest, so the first frame after the
 * press moves a point or two rather than a tenth of the way, is nine-tenths
 * home at half time and spends the rest settling, as UIKit's own springs do.
 */
export function reelCloseFlightTravel(time: number) {
  'worklet';
  if (!(time > 0)) return 0;
  if (time >= 1) return 1;
  const at = (t: number) => 1 - (1 + TRAVEL_STIFFNESS * t) * Math.exp(-TRAVEL_STIFFNESS * t);
  return at(time) / at(1);
}

/** How much of the black under the picture is left at `time`: all of it at 0, none from `REEL_CLOSE_FLIGHT_GROUND_GONE_AT`. */
export function reelCloseFlightGround(time: number) {
  'worklet';
  const left = 1 - Math.min(1, Math.max(0, time) / REEL_CLOSE_FLIGHT_GROUND_GONE_AT);
  return left * left;
}

/**
 * How a flight is kept from landing on top of the bar its tile sits under
 * (`appleZoomSurfaceBottomBar`): what to hold back of the picture, up from the
 * bottom of the screen, as it leaves (`from`) and from then on (`to`).
 *
 * The flight is drawn above the navigator, bar and all, and the tile is under
 * the bar. Left whole, the picture covered the bar's buttons as it landed and
 * they came back through it as it faded. So its lower edge stops where the bar
 * begins, as though it went in behind the bar: by the time the black over the
 * feed has thinned enough for the bar to be seen (`reelCloseFlightFloorAt`).
 * A picture that fills the screen to its foot starts whole and gives that
 * strip up as the black goes, rather than losing it in its first frame.
 * Nothing is held back for a tile that ends above the bar.
 */
export function reelCloseFlightFloor(
  from: ZoomRect,
  to: ZoomRect,
  screen: ZoomSize,
  bar: { height: number; capWidth: number; capHeight: number }
): Pick<ReelCloseFlightPlan, 'floorFrom' | 'floorTo' | 'capLeft' | 'capWidth' | 'capHeight'> {
  const barTop = screen.height - bar.height;
  if (!(bar.height > 0) || to.y + to.height <= barTop) return { floorFrom: 0, floorTo: 0, capLeft: 0, capWidth: 0, capHeight: 0 };
  return {
    floorFrom: Math.max(0, Math.min(bar.height, screen.height - (from.y + from.height))),
    floorTo: bar.height,
    // The bar's button stands in the middle of the screen.
    capLeft: (screen.width - bar.capWidth) / 2,
    capWidth: bar.capWidth,
    capHeight: bar.capHeight,
  };
}

/**
 * What is held back of the picture at `time` of its flight: `floor` is how far
 * up from the bottom of the screen the bar's own top is, and `cap` how far
 * above that the bar's button stands. Both are given up as the black goes.
 */
export function reelCloseFlightFloorAt(plan: Pick<ReelCloseFlightPlan, 'floorFrom' | 'floorTo' | 'capHeight'>, time: number) {
  'worklet';
  const along = Math.min(1, Math.max(0, time) / REEL_CLOSE_FLIGHT_GROUND_GONE_AT);
  return {
    floor: plan.floorFrom + (plan.floorTo - plan.floorFrom) * along,
    // A picture that starts clear of the bar is clear of its button too.
    cap: plan.capHeight * (plan.floorFrom === plan.floorTo ? 1 : along),
  };
}

/**
 * Whether the picture covers what can be seen of its tile at every step of
 * the flight, so that the tile need not be hidden for it. A tile left showing
 * beside the picture flying into it is a second, smaller copy of it. But one
 * that sits under a bar shows through the bar's glass, and hidden for the
 * flight it left that glass dark until the picture landed, when the tile's
 * colours came back into it all at once (filmed 2026-11-10).
 *
 * The picture's window goes from its rectangle on the page to the tile's, each
 * edge straight to the tile's edge, so it covers the tile throughout if it
 * does as it leaves: wider than the tile on both sides, starting above it, and
 * reaching down to the tile's foot or to the bar the tile goes under.
 */
export function reelCloseFlightCoversTile(from: ZoomRect, to: ZoomRect, screenHeight: number, barHeight: number) {
  const seenFoot = Math.min(to.y + to.height, screenHeight - Math.max(0, barHeight));
  return from.x <= to.x && from.x + from.width >= to.x + to.width && from.y <= to.y && from.y + from.height >= seenFoot;
}

export interface ReelCloseFlightFrame {
  /** The window the picture is seen through, on the screen. */
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  /** The picture inside it: scaled about its own centre from its size on the page, and moved by this. */
  scale: number;
  imageX: number;
  imageY: number;
}

/**
 * The picture at `time` of its flight. Its window goes from the picture's
 * rectangle on the page to the tile's, and the picture inside goes from its
 * own size to the size at which it covers the tile, centred on the window:
 * both change by the same share, and the picture covers the window at both
 * ends, so it covers it all the way and the crop closes in gradually.
 */
export function reelCloseFlightFrame(plan: Pick<ReelCloseFlightPlan, 'from' | 'to' | 'radius'>, time: number): ReelCloseFlightFrame {
  'worklet';
  const travelled = reelCloseFlightTravel(time);
  const { from, to } = plan;
  const width = from.width + (to.width - from.width) * travelled;
  const height = from.height + (to.height - from.height) * travelled;
  const cover = from.width > 0 && from.height > 0 ? Math.max(to.width / from.width, to.height / from.height) : 1;
  return {
    x: from.x + (to.x - from.x) * travelled,
    y: from.y + (to.y - from.y) * travelled,
    width,
    height,
    radius: plan.radius * travelled,
    scale: 1 + (cover - 1) * travelled,
    imageX: (width - from.width) / 2,
    imageY: (height - from.height) / 2,
  };
}

// ---------------------------------------------------------------------------
// The flight, on the UI thread
// ---------------------------------------------------------------------------

/** What a press of the bar's Back would fly; null while nothing is ready to. */
export const reelCloseFlightPlan = makeMutable<ReelCloseFlightPlan | null>(null);
/** The flight in the air, or landed and fading; null otherwise. */
export const reelCloseFlightFlying = makeMutable<ReelCloseFlightPlan | null>(null);
/** How far through its time that flight is, 0 to 1. */
export const reelCloseFlightTime = makeMutable(0);
/** The flown picture's opacity: 1 until it has landed. */
export const reelCloseFlightPicture = makeMutable(1);
/** The reel whose page is hidden under a flight (`nextReelCloseFlightId`); 0 for none. */
export const reelCloseFlightHides = makeMutable(0);
/**
 * The tile view UIKit's zoom is kept from closing in on while a picture flies
 * (`AppleZoomReturnPictureView`); null with none in the air.
 */
export const reelCloseFlightSource = makeMutable<string | null>(null);
const flightSerial = makeMutable(0);

/**
 * Sets the armed picture off, in the frame this is called in: for the worklet
 * that reads the finger lifting off the bar's Back. Returns whether it did.
 */
export function takeOffReelCloseFlight() {
  'worklet';
  const plan = reelCloseFlightPlan.value;
  if (!plan || reelCloseFlightFlying.value) return false;
  const serial = flightSerial.value + 1;
  flightSerial.value = serial;
  reelCloseFlightTime.value = 0;
  reelCloseFlightPicture.value = 1;
  reelCloseFlightFlying.value = plan;
  reelCloseFlightHides.value = plan.reelId;
  reelCloseFlightSource.value = plan.sourceId;
  let last = -1;
  let elapsed = 0;
  let landed = false;
  const step = (now: number) => {
    // Called back, or over.
    if (flightSerial.value !== serial || !reelCloseFlightFlying.value) return;
    if (last >= 0) elapsed += Math.min(now - last, REEL_CLOSE_FLIGHT_MAX_STEP_MS);
    last = now;
    const time = Math.min(1, elapsed / REEL_CLOSE_FLIGHT_MS);
    reelCloseFlightTime.value = time;
    if (!landed && reelCloseFlightTravel(time) >= REEL_CLOSE_FLIGHT_LANDS_AT) {
      landed = true;
      runOnJS(landReelCloseFlight)(serial);
    }
    // It goes on settling under its own fade.
    if (time < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  runOnJS(noteReelCloseFlightTookOff)(serial, plan.reelId);
  return true;
}

function endFlightOnUI(serial: number, showPage: boolean) {
  runOnUI(() => {
    'worklet';
    if (flightSerial.value !== serial) return;
    reelCloseFlightFlying.value = null;
    reelCloseFlightSource.value = null;
    reelCloseFlightTime.value = 0;
    reelCloseFlightPicture.value = 1;
    if (showPage) reelCloseFlightHides.value = 0;
  })();
}

// ---------------------------------------------------------------------------
// Around the flight, on the JS thread
// ---------------------------------------------------------------------------

/** The picture the layer draws for a reel at rest, and where. */
export interface ReelCloseFlightPictureSpec {
  /** One reel, post and picture. */
  key: string;
  url: string;
  cacheKey: string | null;
  /** Where the reel's page draws it. */
  from: ZoomRect;
}

interface ArmedTile {
  reelId: number;
  surfaceId: string;
  itemId: string;
  /** The tile is kept out of sight until the picture is on it (`reelCloseFlightCoversTile` says when it need not be). */
  hidden: boolean;
}

interface Flight extends ArmedTile {
  serial: number;
  /** The navigator has said the reel is being popped. */
  confirmed: boolean;
  unconfirmed: ReturnType<typeof setTimeout> | null;
}

let picture: ReelCloseFlightPictureSpec | null = null;
let displayedKey: string | null = null;
/** A picture its reel has let go of while it was still in the air. */
let withdrawnKey: string | null = null;
let armedTile: ArmedTile | null = null;
let flight: Flight | null = null;
let landing: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

/** Hears every change to the picture, to whether it is drawn and to whether a press is armed. */
export function subscribeToReelCloseFlight(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getReelCloseFlightPicture() {
  return picture;
}

/** Whether the layer has drawn the picture under `key`. */
export function isReelCloseFlightPictureDisplayed(key: string | null) {
  return key !== null && displayedKey === key;
}

/** Whether a press of the bar's Back would set a picture off. */
export function isReelCloseFlightArmed() {
  return armedTile !== null;
}

/** A reel resting on a picture its tile shows: the layer draws it, unseen, ready to fly. */
export function offerReelCloseFlightPicture(spec: ReelCloseFlightPictureSpec) {
  // One still in the air is not replaced under it.
  if (flight || landing) return;
  const same = picture !== null && picture.key === spec.key
    && picture.from.x === spec.from.x && picture.from.y === spec.from.y
    && picture.from.width === spec.from.width && picture.from.height === spec.from.height;
  if (same) return;
  if (picture?.key !== spec.key) displayedKey = null;
  picture = spec;
  withdrawnKey = null;
  emit();
}

/** The reel no longer rests on that picture. One in the air stays until it has landed. */
export function withdrawReelCloseFlightPicture(key: string) {
  if (picture?.key !== key) return;
  if (flight || landing || reelCloseFlightFlying.value) {
    withdrawnKey = key;
    return;
  }
  picture = null;
  displayedKey = null;
  emit();
}

/** For the layer: its picture is on the glass. */
export function noteReelCloseFlightPictureDisplayed(key: string) {
  if (picture?.key !== key || displayedKey === key) return;
  displayedKey = key;
  emit();
}

/** The drawn picture has a tile to land in: a press of the bar's Back flies it there. */
export function armReelCloseFlight(plan: ReelCloseFlightPlan, tile: { surfaceId: string; itemId: string; hidden: boolean }) {
  const was = armedTile !== null;
  armedTile = { reelId: plan.reelId, ...tile };
  reelCloseFlightPlan.value = plan;
  if (!was) emit();
}

/** That reel's picture has nowhere to land, or is no longer the one on screen. */
export function disarmReelCloseFlight(reelId: number) {
  if (armedTile?.reelId !== reelId) return;
  armedTile = null;
  reelCloseFlightPlan.value = null;
  emit();
}

function noteReelCloseFlightTookOff(serial: number, reelId: number) {
  const tile = armedTile?.reelId === reelId ? armedTile : null;
  if (!tile) {
    // Disarmed in the frame it took off: there is no tile to answer for.
    endFlightOnUI(serial, true);
    return;
  }
  flight = {
    ...tile,
    serial,
    confirmed: false,
    unconfirmed: setTimeout(() => callBackReelCloseFlight(serial), REEL_CLOSE_FLIGHT_UNCONFIRMED_MS),
  };
  // The tile stays out of sight until the picture is on it, unless the picture
  // covers it all the way; and the copy of the picture it held for UIKit's
  // zoom goes, or UIKit would fly that one under this one on a curve of its own.
  if (tile.hidden) hideZoomSourceUntilLanding(tile.surfaceId, tile.itemId);
  releaseAppleZoomReturnPicture(tile.surfaceId, tile.itemId, false);
}

/**
 * For the reel, as the navigator says it is being popped: whether its picture
 * is flying home, and so whether there is nothing left for UIKit's zoom to be
 * helped with.
 */
export function confirmReelCloseFlight(reelId: number) {
  if (!flight || flight.reelId !== reelId) return false;
  flight.confirmed = true;
  if (flight.unconfirmed) clearTimeout(flight.unconfirmed);
  flight.unconfirmed = null;
  return true;
}

/** The press did not pop the reel after all: the page comes back as it was. */
function callBackReelCloseFlight(serial: number) {
  if (!flight || flight.serial !== serial || flight.confirmed) return;
  const { surfaceId, itemId } = flight;
  flight = null;
  endFlightOnUI(serial, true);
  showZoomSourceAtLanding();
  holdAppleZoomReturnPicture(surfaceId, itemId);
  settlePicture();
}

function landReelCloseFlight(serial: number) {
  if (!flight || flight.serial !== serial) return;
  if (flight.unconfirmed) clearTimeout(flight.unconfirmed);
  flight = null;
  // The tile shows again under the picture, in the picture's own shape, and
  // the picture fades over it: the tile's marks come back through it.
  showZoomSourceAtLanding();
  reelCloseFlightPicture.value = withTiming(0, { duration: REEL_CLOSE_FLIGHT_LANDING_FADE_MS });
  landing = setTimeout(() => {
    landing = null;
    // The reel's page stays hidden: UIKit has yet to take it away.
    endFlightOnUI(serial, false);
    settlePicture();
  }, REEL_CLOSE_FLIGHT_LANDING_FADE_MS + 40);
}

/** Drops a picture its reel let go of while it flew. */
function settlePicture() {
  if (withdrawnKey === null || picture?.key !== withdrawnKey) return;
  withdrawnKey = null;
  picture = null;
  displayedKey = null;
  emit();
}

/** The reel has gone: nothing of it is hidden any more. */
export function forgetReelCloseFlight(reelId: number) {
  disarmReelCloseFlight(reelId);
  runOnUI(() => {
    'worklet';
    if (reelCloseFlightHides.value === reelId) reelCloseFlightHides.value = 0;
  })();
}

/** Test seam: this module's state is deliberately global, so tests reset it. */
export function resetReelCloseFlight() {
  if (flight?.unconfirmed) clearTimeout(flight.unconfirmed);
  if (landing) clearTimeout(landing);
  flight = null;
  landing = null;
  picture = null;
  displayedKey = null;
  withdrawnKey = null;
  armedTile = null;
  listeners.clear();
  reelCloseFlightPlan.value = null;
  reelCloseFlightFlying.value = null;
  reelCloseFlightTime.value = 0;
  reelCloseFlightPicture.value = 1;
  reelCloseFlightHides.value = 0;
  reelCloseFlightSource.value = null;
  flightSerial.value = 0;
}
