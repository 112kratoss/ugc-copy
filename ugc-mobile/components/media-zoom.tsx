import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from 'react';
import { Image } from 'expo-image';
import { useNavigation } from 'expo-router';
import { VideoView, type VideoPlayer } from 'expo-video';
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  Extrapolation,
  interpolate,
  makeMutable,
  runOnJS,
  useAnimatedProps,
  useAnimatedStyle,
  useDerivedValue,
  useFrameCallback,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import {
  advanceZoomFlight,
  beginZoomFlight,
  clearHiddenZoomSources,
  clearPendingZoomOrigin,
  computeZoomFrame,
  getHeldZoomPicture,
  getHeldZoomPictureToken,
  getZoomFlight,
  getZoomSource,
  holdZoomPicture,
  isReturnableRect,
  landZoomFlight,
  markZoomFlightDisplayed,
  peekPendingZoomOrigin,
  registerZoomSource,
  reverseZoomFlightTime,
  setPendingZoomOrigin,
  setZoomSourceHidden,
  subscribeToHeldZoomPicture,
  subscribeToZoomFlights,
  type ZoomFlight,
  type ZoomGeometry,
  type ZoomOrigin,
  type ZoomPreview,
  type ZoomRect,
  type ZoomSize,
  type ZoomStill,
  type ZoomVideo,
} from '@/lib/media-zoom-transition';
import {
  MediaZoomVideoOfferContext,
  type MediaZoomVideoOffer,
  type OfferMediaZoomVideo,
} from '@/lib/media-zoom-video-offer';
import { adoptVideoPlayer, lendVideoPlayer, releaseAdoptedVideoPlayer, returnVideoPlayer } from '@/lib/video-player-loans';
import { FEED_VIDEO_VIEW_PROPS } from '@/lib/feed-video-view-props';
import type { ImmersivePreviewItem } from '@/lib/immersive-preview-view-model';
import { LetterboxBands } from '@/components/letterbox-bands';
import { TopScrim } from '@/components/top-scrim';
import { resolvedTopInset } from '@/lib/safe-area';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * The zoom that carries a tapped tile into the full-screen reel and back.
 *
 * A tile hands over its rectangle (`useMediaZoomSource`), and the reel opens
 * inside a window that grows from it (`useMediaZoomStage` + `MediaZoomStage`).
 * The reel's own rail and caption sit inside that window, so they are revealed
 * by it opening rather than arriving after the media has landed — the failure
 * the first attempt at this (53f24df, reverted) was cut for.
 *
 * The movement itself does not belong to the reel. It runs in
 * `MediaZoomFlightLayer`, mounted once above the navigator, and starts on the
 * frame after the tap with the tile's own picture; the reel joins it whenever
 * it has mounted and takes over underneath. That is what makes the tap and the
 * growth one gesture on a device where the reel needs a few hundred
 * milliseconds to draw anything at all.
 *
 * `lib/media-zoom-transition.ts` holds the geometry, the clock and the register
 * of tiles.
 */

/**
 * How long the movement takes, in the frames it is given. Long enough to read
 * as the media growing rather than cutting, short enough that the reader is
 * never waiting on it. Instagram's grid-to-reel zoom lands in about 170 ms.
 */
const OPEN_MS = 220;
const CLOSE_MS = 200;
/**
 * Strength of the ease-out both directions run on: the movement is quickest
 * where the eye is, at the start, and settles into whatever it is landing on.
 * 3 is a cubic ease-out; higher is sharper off the mark and slower to settle.
 */
const ZOOM_EASE_POWER = 3;
/**
 * The flight is stepped by the frames the device actually delivers, not by the
 * clock, and a step is capped here. Mounting the reel blocks the UI thread for
 * a stretch on a slow device; a clock-timed animation would be most of the way
 * through by its first frame after that, while this one pauses and then plays
 * out in full.
 */
const MAX_FLIGHT_STEP_MS = 34;
/**
 * The flight moves once the layer has actually drawn its picture — a frame or
 * two after being asked for it, from memory — so the first thing seen moving
 * is the picture and not a placeholder. A picture that never arrives must not
 * hold the flight up for longer than this.
 */
const TAKEOFF_DEADLINE_MS = 50;
/**
 * The same wait for a flight carrying a playing video. Both platforms report
 * the layer's view drawing its first frame — Android too, since ExoPlayer
 * reports a first frame for every new surface — and the flight leaves on that;
 * this is only the net for a report that never comes. Until then the window is
 * see-through and the tile shows under it.
 */
const VIDEO_TAKEOFF_DEADLINE_MS = 90;
/**
 * How long the reel's own view has to draw a lent video before the layer's view
 * of it lets go. On Android taking the player moves its surface, and the view
 * it left keeps its last frame on screen in the meantime.
 */
const VIDEO_ATTACH_SETTLE_MS = 90;
/**
 * From which point of the flight the reel's black ground comes up around the
 * window — and below which it is gone again as the window shrinks. Until then
 * the screen the reel came from is what the movement plays over, as it is in
 * Instagram.
 */
const GROUND_RAMP_FROM = 0.8;
/** The rail and caption belong to a window that is the whole screen. */
const CHROME_FROM = 0.995;
/**
 * A closing post carries its rail and caption down into the tile, fading, the
 * way Instagram's does — rather than cutting them away on the collapse's first
 * frame, which read as the post being replaced by its picture.
 *
 * Read on the close's own clock (1 at the reel, 0 at the tile) and not on the
 * window, which is front-loaded: a fade tied to the window would be over within
 * two frames, while the picture still filled most of the screen.
 */
const CLOSE_CHROME_HOLD = 0.95;
const CLOSE_CHROME_GONE = 0.3;
/**
 * How far the picture has grown before the reel is pushed: all the way. Mounting
 * the reel is the heaviest thing the app does, and the UI thread is held for a
 * stretch of it. Pushed at the tap, it would hold the flight's first frames;
 * pushed at 0.8, as it was, a traced S24 held one 42 ms frame in the flight's
 * last stretch — four frames of a 120 Hz screen, seen as the landing catching.
 * Landed, the picture is standing still, and the reel under it is not yet seen.
 */
const OPEN_PUSH_AT = 1;
/** The reel is pushed by this many ms after the flight begins, whatever its progress. */
const OPEN_PUSH_DEADLINE_MS = 450;
/** How long the layer's picture takes to give way to the reel underneath it. */
const HANDOFF_FADE_MS = 120;
/**
 * Last resort if that fade's callback never lands. Not a clock the fade is
 * expected to beat: it runs on the UI thread, which a reel can hold for a
 * stretch, and a reel declared open while its picture is still half over it
 * starts its video under that picture — the clip and its own poster, both on
 * screen, a few frames apart.
 */
const HANDOFF_FADE_SAFETY_MS = 1500;
/** How long the tile's picture inside the reel takes to give way to the reel's own. */
const CARRIED_FADE_MS = 90;
/** Two frames: long enough for a window that has been committed to have been drawn. */
const DRAWN_GRACE_MS = 120;
/** A reel that never says it has drawn anything is uncovered anyway after this. */
const DRAWN_DEADLINE_MS = 500;
/**
 * How long a landed reel waits for what it mounts on landing — its own rail and
 * caption, and the slides beside the one it opened on — to be drawn before it is
 * uncovered anyway. Mounting them holds the UI thread for a stretch; under the
 * landed picture that stretch is a still frame, while during the flight it is
 * the growing picture stuttering, and after the reel is uncovered it is the
 * reel's video stopping just after it started.
 */
const LANDED_WORK_DEADLINE_MS = 450;
/** And one whose navigator never reports its transition over is uncovered after this. */
const SETTLE_DEADLINE_MS = 700;
/**
 * A reel that never reports a painted picture — a slide whose media failed, a
 * source still loading — must not keep the tile's copy up forever.
 */
const CARRIED_DEADLINE_MS = 2500;
/** Nor may a push that never arrives leave a picture pinned over the app. */
const HOLD_DEADLINE_MS = 2500;
/** A reel with no tile to grow from or return to dissolves over this instead. */
const PLAIN_FADE_MS = 150;
/** Last resort if an animation callback never lands, so the reel cannot stick. */
const DISMISS_SAFETY_MS = CLOSE_MS + 220;

/**
 * Whether the reel itself can shrink over the screen it returns to.
 *
 * Android: the reel is a transparent modal (see `app/_layout.tsx`), so the
 * screen beneath stays attached and drawn the whole time the reel is up, and
 * the reel's own window — video still playing — shrinks over it, with the pop
 * dispatched once it has landed.
 *
 * iOS: nothing is drawn beneath a pushed screen, and the moment a pop commits
 * react-native-screens replaces the popped screen with a snapshot
 * (`RNSScreen.mm`, `setViewToSnapshot`), so nothing the reel animates after the
 * pop is ever seen. There the reel steps aside, the layer above the navigator
 * takes its picture, and the pop runs under that picture as it shrinks.
 */
const LIVE_CLOSE = Platform.OS === 'android';
/**
 * iOS: the screen a close returns to comes back only once the pop has
 * committed — rendering the reel's unmount took 30–50 ms of JS on an iPhone 16e
 * — and a picture that shrank before then would uncover nothing. Waiting for it
 * was the close's stall: 60–97 ms of a picture standing still after the tap,
 * while the UI thread delivered every frame of the shrink itself on time.
 *
 * So the picture starts shrinking on the frame after the tap, on the close's
 * own curve slowed to a fraction of its speed, over a black ground standing in
 * for the reel's own; the pop's commit releases it to carry on at full speed
 * over the screen it has brought back, and the ground fades out. (Eased to a
 * stop 5% in instead, the start was invisible on film: a thin black edge.)
 */
const CLOSE_CREEPS_UNTIL_POPPED = Platform.OS === 'ios';
/** How much of the close's own speed the picture shrinks at while the pop commits. */
const CLOSE_CREEP_RATE = 0.25;
/** A pop that never reports back releases the creep after this anyway. */
const CLOSE_CREEP_DEADLINE_MS = 300;
/**
 * How long the screen keeps showing the frame it last drew after the pop has
 * committed, while the screen underneath is drawn again: 67–100 ms on an iPhone
 * 16e, measured on film. The close creeps through it rather than racing it; see
 * the reel's unmount.
 */
const CLOSE_REATTACH_MS = 90;
/** The black ground's fade once the screen the close returns to is back. */
const CLOSE_GROUND_FADE_MS = 90;
/**
 * How long an open reel waits, once uncovered or moved to another post, before
 * drawing that post's picture into the layer out of sight — ready, so its close
 * can move on the next frame instead of waiting for the picture to be drawn.
 * Long enough that it never lands on the frames a video starts playing in.
 */
const CLOSE_PICTURE_PREPARE_DELAY_MS = 500;
/**
 * On Android the navigator runs no animation for the reel (the zoom is the
 * animation), so a reel with no tile dissolves on its own instead of cutting.
 */
const PLAIN_DISSOLVE = Platform.OS === 'android';
/**
 * On iOS a reel pushed any other way than under a landed zoom arrives under the
 * navigator's fade (`viewerAnimation` in app/_layout.tsx). Its window must not be
 * uncovered until that fade is over, or the screen beneath shows through it.
 * Pushed with no animation, its transition is over as soon as it has begun.
 */
const WAIT_FOR_TRANSITION = Platform.OS === 'ios';

// ---------------------------------------------------------------------------
// The flight, shared by the layer that steps it and the reel that follows it
// ---------------------------------------------------------------------------

const flightProgress = makeMutable(1);
const flightTime = makeMutable(1);
const flightGeometry = makeMutable<ZoomGeometry>({
  screen: { width: 0, height: 0 },
  tile: null,
  tileRadius: 0,
  aspectRatio: null,
});
const flightFlying = makeMutable(false);
const flightClosing = makeMutable(false);
const flightId = makeMutable(0);
/** Whether the open flight has passed the point at which the reel is pushed. */
const flightPushed = makeMutable(false);
/** The layer's picture: 1 while it is carrying the media, fading at the hand-off. */
const stillOpacity = makeMutable(1);
/**
 * The layer's view of a lent video: 0 until the flight leaves. A new TextureView
 * is opaque and draws black until a frame reaches it, so it is shown only once
 * it has drawn — which is also what lets the flight leave.
 */
const videoSurfaceOpacity = makeMutable(1);
/**
 * Whether the held picture is a lent video, for the layer's UI-thread styles —
 * set with the flight, never derived from the layer's props (see
 * `startZoomFlight`). While it is still the tile, a video's window is
 * see-through, with no bands and no poster in it.
 */
const stillCarriesVideo = makeMutable(false);
/** A close creeping while its pop commits; see `CLOSE_CREEPS_UNTIL_POPPED`. */
const flightCreeping = makeMutable(false);
/** The black ground under a creeping close's picture, standing in for the reel's own. */
const closeGroundOpacity = makeMutable(0);

/** Starts and stops the layer's frame callback; set while the layer is mounted. */
let tickerControl: ((active: boolean) => void) | null = null;
/** The layer's size and page position — the space every tile is measured in. */
let layerScreen: ZoomSize = { width: 0, height: 0 };
let layerOrigin = { x: 0, y: 0 };
/** Re-reads both from the mounted layer; a tile asks when it finds them unset. */
let measureLayerNow: (() => void) | null = null;
/** What to do the moment the layer has drawn the current flight's picture. */
let onFlightDisplayed: { id: number; run: () => void } | null = null;
/** What to do once the open flight has grown far enough for the reel to be pushed. */
let onFlightProgressed: { id: number; run: () => void } | null = null;
/** The picture the layer has actually drawn, if it is the one it is holding. */
let displayedPreview: ZoomPreview | null = null;

function samePicture(a: ZoomPreview | null | undefined, b: ZoomPreview | null | undefined) {
  return Boolean(a && b) && a!.url === b!.url && (a!.cacheKey ?? null) === (b!.cacheKey ?? null);
}

/** Whether the layer draws two holds identically: the same picture, laid out on the same screen. */
function drawsSameStill(a: ZoomStill, b: ZoomStill) {
  return samePicture(a.preview, b.preview)
    && !a.video && !b.video
    && (a.post?.id ?? null) === (b.post?.id ?? null)
    && a.geometry.screen.width === b.geometry.screen.width
    && a.geometry.screen.height === b.geometry.screen.height
    && (a.geometry.aspectRatio ?? null) === (b.geometry.aspectRatio ?? null);
}

/** Holds a picture in the layer, forgetting that the last one was drawn if this is a different one. */
function holdStill(still: ZoomStill | null) {
  const previous = getHeldZoomPicture();
  if (!samePicture(displayedPreview, still?.preview)) displayedPreview = null;
  const token = holdZoomPicture(still);
  // A lent video the layer has stopped drawing ends its loan: back to the tile,
  // or released if the tile has gone. One the reel adopted is the reel's, and
  // the call leaves it alone.
  const lent = previous?.video?.player;
  if (lent && lent !== still?.video?.player) returnVideoPlayer(lent);
  return token;
}

/**
 * Gets the layer's copy of a tile's picture drawn before it is needed — on the
 * finger going down, so that by the time it lifts the picture is on screen and
 * the flight can leave on the very next frame.
 *
 * The tile drew this picture at the tile's size, and the image cache is keyed
 * by size: the layer's screen-sized copy is a fresh decode, some 60–100 ms on
 * a slow device. Spent under the finger it costs nothing; spent after the tap
 * it is exactly the pause this whole layer exists to remove.
 *
 * The letterbox bands are decoded here too — each is the picture blurred, a
 * decode of its own — so the media's shape comes along: bands are placed by
 * it, and a still held without one draws none. Held shapeless, the bands only
 * began loading as the flight left, and the window grew with black above and
 * below the picture until they arrived, around the landing.
 *
 * `standing` holds it for an open reel's close rather than for a finger (see
 * `ZoomStill.standing`).
 *
 * The post's rail and caption are laid out here too, for the same reason as the
 * picture: under the finger they cost nothing, and a flight that has to create
 * them after the tap leaves without them (`ZoomStill.post`).
 */
function prepareZoomPicture(
  preview: ZoomPreview,
  aspectRatio: number | null,
  standing = false,
  post: ImmersivePreviewItem | null = null
) {
  if (!tickerControl || getZoomFlight()) return;
  if (layerScreen.width <= 0) measureLayerNow?.();
  if (layerScreen.width <= 0) return;
  const held = getHeldZoomPicture();
  // By identity, not by id: a post whose counts or saved state have moved on is
  // a different drawing, and this copy is what a close puts on screen.
  if (
    samePicture(held?.preview, preview)
    && Boolean(held?.standing) === standing
    && (held?.post ?? null) === (post ?? null)
  ) return;
  stillOpacity.set(0);
  closeGroundOpacity.set(0);
  stillCarriesVideo.set(false);
  holdStill({ preview, geometry: { screen: layerScreen, tile: null, tileRadius: 0, aspectRatio }, standing, post });
}

/**
 * Begins a flight. One that carries a picture waits to move until the layer
 * has drawn it (`whenDisplayed` runs then; by default it lets the flight go);
 * one that carries nothing moves at once. An open runs `whenProgressed` once
 * the window has grown past `OPEN_PUSH_AT` — or at the deadline, if the frames
 * never come — which is when the reel itself is pushed.
 */
function startZoomFlight(
  spec: Omit<ZoomFlight, 'id' | 'displayed'>,
  { whenDisplayed, whenProgressed }: { whenDisplayed?: () => void; whenProgressed?: () => void } = {}
): ZoomFlight {
  const started = beginZoomFlight(spec);
  flightGeometry.set(spec.geometry);
  flightId.set(started.id);
  flightFlying.set(false);
  flightCreeping.set(false);
  closeGroundOpacity.set(0);
  flightPushed.set(spec.direction === 'close');
  onFlightProgressed = whenProgressed ? { id: started.id, run: whenProgressed } : null;
  if (whenProgressed) setTimeout(() => handleFlightProgressed(started.id), OPEN_PUSH_DEADLINE_MS);
  if (spec.direction === 'open') {
    flightTime.set(0);
    flightProgress.set(0);
  } else {
    // From wherever the window is — the screen after a landed open, part way
    // when a close cuts an open short — rather than jumping to the far end.
    flightTime.set(reverseZoomFlightTime(flightProgress.get(), ZOOM_EASE_POWER));
  }
  flightClosing.set(spec.direction === 'close');
  const still: ZoomStill | null = spec.still && spec.preview
    ? {
      preview: spec.preview,
      geometry: spec.geometry,
      video: spec.video ?? null,
      post: spec.post ?? null,
    }
    : null;
  const carriesVideo = Boolean(still?.video);
  // A picture the layer has already drawn — prepared under the finger, or
  // carried by the flight this one reverses — shows at once; a new one is kept
  // invisible until the layer says it has drawn it, so neither a blur nor the
  // window's black ground is ever seen in its place. A video is never already
  // showing — the layer's own view of it has to draw first — but its window is
  // up from the start: see-through until then, with the tile playing under it.
  // (Hidden until take-off instead, the layer's view of the video stalled and
  // the clip froze through the flight.) What makes it see-through is set here,
  // in the same breath: left to follow the layer's props, it reached the UI
  // thread only after React rendered them, and for the frames between the window
  // drew a picture flight's black ground over the tile — ~33 ms of black on
  // every tap on a playing video, on an S24.
  const alreadyShowing = !carriesVideo && Boolean(still) && samePicture(displayedPreview, still?.preview);
  stillCarriesVideo.set(carriesVideo);
  stillOpacity.set(alreadyShowing || carriesVideo ? 1 : 0);
  // A video the layer starts drawing now needs a frame before it can be seen;
  // one it is already drawing — a close turning an open round — does not.
  if (carriesVideo && spec.direction === 'open') videoSurfaceOpacity.set(0);
  // A picture the layer is already drawing, laid out as this flight lays it
  // out — a close's, drawn ahead for it — is kept rather than held again:
  // holding it again would re-render the layer and re-set its image and bands,
  // changing nothing on screen, on the very frames the close starts moving.
  const held = getHeldZoomPicture();
  if (!(alreadyShowing && still && held && drawsSameStill(held, still))) holdStill(still);
  if (!tickerControl) {
    // Nothing to step it — no layer mounted — so it lands at once.
    flightTime.set(spec.direction === 'open' ? 1 : 0);
    flightProgress.set(spec.direction === 'open' ? 1 : 0);
    finishZoomFlight(started.id);
    return started;
  }
  if (!still) {
    takeOffZoomFlight();
    return started;
  }
  onFlightDisplayed = { id: started.id, run: whenDisplayed ?? takeOffZoomFlight };
  if (alreadyShowing) markZoomFlightDisplayed(started.id);
  else setTimeout(() => markZoomFlightDisplayed(started.id), carriesVideo ? VIDEO_TAKEOFF_DEADLINE_MS : TAKEOFF_DEADLINE_MS);
  return started;
}

function takeOffZoomFlight() {
  if (!tickerControl || !getZoomFlight()) return;
  // Whatever the flight carries is drawn by now, or has run out of time to be.
  videoSurfaceOpacity.set(1);
  flightFlying.set(true);
  tickerControl(true);
}

/**
 * Takes off a close whose picture is waiting on the pop: moving at once, but
 * creeping over a black ground until the pop releases it (or the deadline does).
 */
function takeOffCreepingZoomFlight() {
  const current = getZoomFlight();
  if (!tickerControl || !current) return;
  flightCreeping.set(true);
  closeGroundOpacity.set(1);
  takeOffZoomFlight();
  setTimeout(() => releaseZoomFlightCreep(current.id), CLOSE_CREEP_DEADLINE_MS);
}

/** The screen the close returns to is back: the picture shrinks over it at full speed. */
function releaseZoomFlightCreep(id: number) {
  if (getZoomFlight()?.id !== id || !flightCreeping.get()) return;
  flightCreeping.set(false);
  closeGroundOpacity.set(withTiming(0, { duration: CLOSE_GROUND_FADE_MS }));
}

/** The layer's picture is on screen: whatever the flight was waiting for it to do. */
function handleFlightDisplayed(id: number) {
  const handler = onFlightDisplayed;
  if (!handler || handler.id !== id) return;
  onFlightDisplayed = null;
  handler.run();
}

/** The open flight has grown far enough: push the reel. */
function handleFlightProgressed(id: number) {
  const handler = onFlightProgressed;
  if (!handler || handler.id !== id) return;
  onFlightProgressed = null;
  handler.run();
}

function finishZoomFlight(id: number) {
  const landed = landZoomFlight(id);
  // Superseded: the newer flight owns the ticker now.
  if (!landed) return;
  tickerControl?.(false);
  // Landed in the tile, which is drawn underneath by now — the screen it is
  // on has been there for the whole collapse — so the picture lets go at once.
  // Left any longer it would sit over whatever floats above the tile (the tab
  // bar a Home card scrolls under), which the reel never did.
  if (landed.direction === 'close') holdStill(null);
}

/** The layer's picture gives way to the reel underneath it, then is let go. */
function fadeOutZoomStill(onDone: () => void) {
  if (!getHeldZoomPicture()) {
    onDone();
    return;
  }
  const token = getHeldZoomPictureToken();
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    if (getHeldZoomPictureToken() === token) holdStill(null);
    onDone();
  };
  // The reel opens when the picture is actually gone from the screen, which
  // only the UI thread knows. A newer flight cuts the fade short; the reel it
  // was uncovering still opens, and the newer hold keeps its picture.
  stillOpacity.set(withTiming(0, { duration: HANDOFF_FADE_MS }, () => {
    'worklet';
    runOnJS(finish)();
  }));
  setTimeout(finish, HANDOFF_FADE_SAFETY_MS);
}

const MediaZoomSurfaceContext = createContext<string | null>(null);
const MediaZoomChromeContext = createContext<StyleProp<ViewStyle>>(null);
const MediaZoomPaintContext = createContext<(() => void) | null>(null);
const MediaZoomOpenedContext = createContext(true);
const MediaZoomLandedContext = createContext(true);

/**
 * Whether the reel is the thing on screen: the layer's picture has given way
 * to it. Anything the reel can put off until then — a player to create, a
 * badge that would flash over a still — reads it.
 */
export function useMediaZoomOpened() {
  return useContext(MediaZoomOpenedContext);
}

/**
 * Whether the flight the reel grew in has landed and the reel has drawn its
 * picture. What the flight does not show — the rail, the caption, the video's
 * own view — waits for this, so that no frame both moves the picture and creates
 * them, nor creates them together with the reel itself; and the reel is not
 * uncovered until they have been drawn (`reportChromeDrawn`).
 */
export function useMediaZoomLanded() {
  return useContext(MediaZoomLandedContext);
}

/** A video the tile lent the reel, and whether the reel's own view may take its player yet. */
export interface MediaZoomLentVideo {
  video: ZoomVideo;
  /**
   * The reel's view may take the player — from the hand-off on, not before. On
   * Android taking a player moves its surface out of the layer's view, and a
   * picture still growing over the reel would freeze on its last frame.
   */
  attached: boolean;
}

const MediaZoomLentVideoContext = createContext<MediaZoomLentVideo | null>(null);

/**
 * For the reel's video slide: the player the tile lent, when this slide plays
 * the same file — to use in place of building one. Null for every other slide,
 * and for this one too once a hand-off could not adopt it.
 */
export function useMediaZoomLentVideo(url: string) {
  const lent = useContext(MediaZoomLentVideoContext);
  return lent && lent.video.url === url ? lent : null;
}

const reportNothing = () => {};

/**
 * Handed to the reel's media so it can say when it has drawn something. Until
 * then the window shows the tile's own picture.
 */
export function useMediaZoomPaintReport() {
  return useContext(MediaZoomPaintContext) ?? reportNothing;
}

/**
 * Marks a screen whose tiles a reel can grow out of and return to. The id is
 * per mounted screen, so two surfaces showing the same post (Home and Explore,
 * or two creator profiles) never return a reel to the wrong one.
 */
export function MediaZoomSurface({ children }: { children: ReactNode }) {
  const surfaceId = useId();
  return <MediaZoomSurfaceContext.Provider value={surfaceId}>{children}</MediaZoomSurfaceContext.Provider>;
}

export interface MediaZoomSource {
  ref: RefObject<View | null>;
  hiddenStyle: StyleProp<ViewStyle>;
  /** For the finger going down: gets the picture the flight will carry drawn. */
  prepare: () => void;
  /** Measures this tile, starts the flight out of it, then runs `open`. */
  capture: (open: () => void) => void;
  /** Where the tile's video layer offers its player; see `lib/media-zoom-video-offer.ts`. */
  offerVideo: OfferMediaZoomVideo;
}

/**
 * The tile half of the hand-off: registers this tile under the post it shows,
 * measures it when it is tapped, and hides it while the reel stands in for it.
 */
export function useMediaZoomSource({
  itemId,
  radius = 0,
  aspectRatio,
  preview = null,
  post = null,
  enabled = true,
}: {
  itemId: string;
  radius?: number;
  /**
   * width / height of the media as the reel draws it (`mediaItemAspectRatio`
   * on the media the reel opens on), or null when the tile cannot know it.
   * Required, so that no tile leaves it out: a flight without it takes the
   * tile's crop for the media's shape, grows and bands a picture that is not
   * the one the reel shows, and is corrected only once the reel mounts, most of
   * the way through.
   */
  aspectRatio: number | null;
  /** What this tile is showing, so the reel can carry it while it builds. */
  preview?: ZoomPreview | null;
  /**
   * The post as the reel will list it (`buildImmersiveShowcaseItems` with the
   * source the tile opens), so the flight can draw its rail and caption from
   * the first frame; see `ZoomStill.post`. Null flies the picture alone.
   */
  post?: ImmersivePreviewItem | null;
  enabled?: boolean;
}): MediaZoomSource {
  const surfaceId = useContext(MediaZoomSurfaceContext);
  const ref = useRef<View | null>(null);
  const hidden = useSharedValue(0);
  const hiddenStyle = useAnimatedStyle(() => ({ opacity: 1 - hidden.value }));
  const active = Boolean(surfaceId) && enabled && Boolean(itemId);

  const measure = useCallback((report: (rect: ZoomRect | null) => void) => {
    const node = ref.current;
    if (!node || typeof node.measure !== 'function') {
      report(null);
      return;
    }
    // In the layer's own coordinates: page position minus the layer's. Not
    // `measureInWindow` — on Android that window begins below the status bar
    // and cutout, which put every tile some 54dp higher than it was drawn.
    node.measure((_x, _y, width, height, pageX, pageY) => {
      if (!(width > 0 && height > 0) || !Number.isFinite(pageX) || !Number.isFinite(pageY)) {
        report(null);
        return;
      }
      report({ x: pageX - layerOrigin.x, y: pageY - layerOrigin.y, width, height });
    });
  }, []);

  // Registered on what the tile *is*, not on the identity of the object
  // describing it: a preview built during render is a new object every time,
  // and re-registering on every render would churn the whole list.
  const previewUrl = preview?.url ?? null;
  const previewCacheKey = preview?.cacheKey ?? null;
  const previewThumbhash = preview?.thumbhash ?? null;
  useEffect(() => {
    if (!active || !surfaceId) return;
    return registerZoomSource(surfaceId, itemId, {
      radius,
      aspectRatio,
      preview: previewUrl ? { url: previewUrl, cacheKey: previewCacheKey, thumbhash: previewThumbhash } : null,
      measure,
      setHidden: (value) => hidden.set(value ? 1 : 0),
    });
  }, [active, aspectRatio, hidden, itemId, measure, previewCacheKey, previewThumbhash, previewUrl, radius, surfaceId]);

  const prepare = useCallback(() => {
    if (active && preview) prepareZoomPicture(preview, aspectRatio, false, post);
  }, [active, aspectRatio, post, preview]);

  // A ref, not state: the offer changes as players come and go while the feed
  // scrolls, and nothing renders from it — only a tap reads it.
  const videoOfferRef = useRef<MediaZoomVideoOffer | null>(null);
  const offerVideo = useCallback<OfferMediaZoomVideo>((offer) => {
    videoOfferRef.current = offer;
    return () => {
      // A replacement player can mount before the one it replaces unmounts.
      if (videoOfferRef.current === offer) videoOfferRef.current = null;
    };
  }, []);

  const capture = useCallback((open: () => void) => {
    // Nothing to grow: no surface, or no picture to grow with.
    if (!active || !surfaceId || !preview) {
      clearPendingZoomOrigin();
      open();
      return;
    }
    let handled = false;
    const start = (rect: ZoomRect | null) => {
      if (handled) return;
      handled = true;
      // The layer measures itself when it is laid out; a module reloaded since
      // (development) has forgotten, and asks again.
      if (layerScreen.width <= 0) measureLayerNow?.();
      const screen = layerScreen;
      if (!rect || screen.width <= 0 || screen.height <= 0) {
        clearPendingZoomOrigin();
        open();
        return;
      }
      // A video playing in the tile flies itself, not its poster: the poster is
      // the clip's first frame, and the tile has been showing a later one. Only
      // a player that has drawn something can stand in for the tile.
      const offer = videoOfferRef.current;
      const video = offer && offer.hasFrame() && lendVideoPlayer(offer.player, offer.reattach)
        ? { player: offer.player, url: offer.url }
        : null;
      // The reel is pushed once the picture is most of the way to the screen,
      // from a later task than this tap's: a push made here would render the
      // reel inside this very event, and every UI-thread update queued behind
      // it — the flight's own start included — would wait on that render.
      const flight = startZoomFlight({
        direction: 'open',
        geometry: {
          screen,
          tile: rect,
          tileRadius: radius,
          // A tile that does not know its media's shape is taken at its own.
          aspectRatio: aspectRatio ?? rect.width / rect.height,
        },
        preview,
        video,
        post,
        still: true,
      }, { whenProgressed: open });
      setPendingZoomOrigin({
        surfaceId,
        itemId,
        rect,
        radius,
        aspectRatio,
        preview,
        video,
        flightId: flight.id,
        recordedAt: Date.now(),
      });
    };
    measure(start);
    // Fabric answers `measureInWindow` before it returns. A host that does not
    // must never swallow the tap, so the plain open runs instead.
    start(null);
  }, [active, aspectRatio, itemId, measure, post, preview, radius, surfaceId]);

  return { ref, hiddenStyle, prepare, capture, offerVideo };
}

/**
 * Wraps the part of a tile that is the media — the rectangle the reel grows out
 * of, and the one that empties while the reel holds its content.
 */
export function MediaZoomSourceView({
  source,
  style,
  children,
}: {
  source: MediaZoomSource;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  return (
    // Both wrappers stay out of the layout's way: `flexBasis: 'auto'` keeps a
    // tile that sizes itself from its media (a feed card) at its own height,
    // while `flexGrow` lets one that fills a slot its parent sized (a profile
    // tile, which is `flex: 1` inside a fixed cell) still fill it. Without the
    // grow those tiles collapse to nothing.
    <Animated.View collapsable={false} style={[ZOOM_SOURCE_FILL, style, source.hiddenStyle]}>
      <View ref={source.ref} collapsable={false} style={ZOOM_SOURCE_FILL}>
        <MediaZoomVideoOfferContext.Provider value={source.offerVideo}>
          {children}
        </MediaZoomVideoOfferContext.Provider>
      </View>
    </Animated.View>
  );
}

const ZOOM_SOURCE_FILL = { flexGrow: 1, flexBasis: 'auto' } as const;

export interface MediaZoomStageValue {
  /** True while the reel is growing out of, or shrinking back into, a tile. */
  zooming: boolean;
  /** Latches once the reel is the thing on screen: work it can defer waits on this. */
  opened: boolean;
  /**
   * Latches once the flight has landed, before the reel is uncovered. The
   * picture on screen is standing still from here, so heavy work the reel has
   * put off — its neighbouring slides and their players, which hold the UI
   * thread for a stretch — is done now, unseen, rather than once the reel is up
   * and its video has started moving.
   */
  landed: boolean;
  /**
   * Latches once the reel has drawn its picture, or stopped waiting for it. The
   * reel is pushed as the flight lands, and what it mounts after its picture —
   * the rail, the caption, the video's own view — waits for this as well as for
   * `landed`: mounted with the reel, they made its one long frame longer still.
   */
  drawn: boolean;
  /**
   * For a slide beside the one the reel opened on, when it has been laid out:
   * the neighbours have been mounted and drawn, and the reel can be uncovered.
   */
  reportNeighbourDrawn: () => void;
  /**
   * For the slide the reel is on, when the rail and caption it mounts on landing
   * have been laid out: they fade in with the reel, so it waits for them.
   */
  reportChromeDrawn: () => void;
  /**
   * Latches once that rail and caption have been drawn (or the wait for them
   * has run out). The neighbouring slides mount after it rather than with it:
   * together they held an S24's UI thread for one 59 ms frame, two frames of a
   * video still playing in the landed picture.
   */
  chromeDrawn: boolean;
  /**
   * Touch handling for the stage and its window, switched on the UI thread: a
   * reel in flight takes every touch itself and answers none, without the
   * React re-render of the whole reel that flipping a prop would cost.
   */
  stageProps: Partial<{ pointerEvents: 'box-none' | 'auto' }>;
  clipProps: Partial<{ pointerEvents: 'box-none' | 'none' }>;
  stageStyle: StyleProp<ViewStyle>;
  groundStyle: StyleProp<ViewStyle>;
  clipStyle: StyleProp<ViewStyle>;
  pageStyle: StyleProp<ViewStyle>;
  chromeStyle: StyleProp<ViewStyle>;
  /** The tile's picture, held over the reel's media until the reel has drawn its own. */
  carried: ZoomPreview | null;
  /** The tile's playing video, for the slide that plays it; see `useMediaZoomLentVideo`. */
  lentVideo: MediaZoomLentVideo | null;
  carriedStyle: StyleProp<ViewStyle>;
  /** The carried picture has been drawn: the reel's window is on screen. */
  reportCarriedDrawn: () => void;
  reportPainted: () => void;
  /** Closes the reel: shrinks it back into the current post's tile, then leaves. */
  dismiss: () => void;
}

/**
 * The reel half of the hand-off. Returns the styles `MediaZoomStage` draws with
 * and the dismissal the reel's own exits run through.
 */
export function useMediaZoomStage({
  screen,
  initialItemId,
  activeItemId,
  aspectRatio,
  activePicture = null,
  activePost = null,
  reducedMotion,
  ready,
  expectsNeighbours,
  onExit,
}: {
  screen: ZoomSize;
  /** The post the reel was opened on, which is what a hand-off is keyed to. */
  initialItemId: string;
  /** The post the reader is on now — the tile a close returns to. */
  activeItemId: string | null;
  /** width / height of the media the reel is drawing, so the flight lands on it. */
  aspectRatio: number | null;
  /** The picture the reel is drawing now, for a close that has to leave the reel behind. */
  activePicture?: ZoomPreview | null;
  /**
   * The post the reel is on, so a close carries its rail and caption down into
   * the tile instead of shrinking a bare picture (`ZoomStill.post`).
   */
  activePost?: ImmersivePreviewItem | null;
  reducedMotion: boolean;
  /** The reel has its first slide in place. */
  ready: boolean;
  /**
   * The reel has slides beside the one it opens on, which it mounts once the
   * flight lands and which report `reportNeighbourDrawn`. A reel of one post
   * has none to wait for.
   */
  expectsNeighbours: boolean;
  onExit: () => void;
}): MediaZoomStageValue {
  const [origin] = useState<ZoomOrigin | null>(() => (
    reducedMotion ? null : peekPendingZoomOrigin(initialItemId, Date.now())
  ));
  const zooming = Boolean(origin);
  const navigation = useNavigation();

  // 1 while this reel's window is the flight's window; 0 when it is simply the screen.
  const following = useSharedValue(zooming ? 1 : 0);
  const localGeometry = useSharedValue<ZoomGeometry>({ screen, tile: null, tileRadius: 0, aspectRatio: null });
  const stageOpacity = useSharedValue(zooming || reducedMotion || !PLAIN_DISSOLVE ? 1 : 0);

  // A lent video is drawn by the reel's own slide from the moment it is
  // adopted, so there is no copy of the tile's poster to carry over it — a
  // poster left there would sit on top of the video it stands in for.
  const lentVideo = origin?.video ?? null;
  const [videoHandoff, setVideoHandoff] = useState<'pending' | 'attached' | 'failed'>(lentVideo ? 'pending' : 'failed');
  const adoptedVideoRef = useRef<VideoPlayer | null>(null);
  const carriedPreview = lentVideo ? null : origin?.preview ?? null;
  const [carried, setCarried] = useState<ZoomPreview | null>(carriedPreview);
  const carryingRef = useRef(Boolean(carriedPreview));
  const carriedOpacity = useSharedValue(carriedPreview ? 1 : 0);

  const [opened, setOpened] = useState(!zooming);
  const interactive = useSharedValue(zooming ? 0 : 1);
  const openedRef = useRef(!zooming);
  // The flight may have landed before this reel could listen for it.
  const landedRef = useRef(!origin || getZoomFlight()?.id !== origin.flightId);
  const [landed, setLanded] = useState(landedRef.current);
  const neighboursDrawnRef = useRef(!zooming);
  const chromeDrawnRef = useRef(!zooming);
  const [chromeDrawn, setChromeDrawn] = useState(!zooming);
  const expectsNeighboursRef = useRef(expectsNeighbours);
  expectsNeighboursRef.current = expectsNeighbours;
  const drawnRef = useRef(false);
  const [drawn, setDrawn] = useState(!zooming);
  const settledRef = useRef(!zooming || !WAIT_FOR_TRANSITION);
  const handoffRef = useRef(!zooming);
  const dismissingRef = useRef(false);
  const leftRef = useRef(false);
  const closeRef = useRef<{ id: number; live: boolean } | null>(null);
  /** The flight this reel follows and may reshape: its open, then its close. */
  const ownFlightRef = useRef<number | null>(origin?.flightId ?? null);
  const hiddenItemRef = useRef<string | null>(null);
  const activeItemRef = useRef(activeItemId ?? initialItemId);
  activeItemRef.current = activeItemId ?? initialItemId;
  const screenRef = useRef(screen);
  screenRef.current = screen;
  const aspectRef = useRef(aspectRatio);
  aspectRef.current = aspectRatio;
  const pictureRef = useRef(activePicture);
  pictureRef.current = activePicture;
  const postRef = useRef(activePost);
  postRef.current = activePost;
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  const updateGeometry = useCallback((patch: Partial<ZoomGeometry>) => {
    localGeometry.set({ ...localGeometry.get(), ...patch });
    // Only the flight this reel is part of; never one another tile has started.
    if (ownFlightRef.current !== null && ownFlightRef.current === flightId.get()) {
      flightGeometry.set({ ...flightGeometry.get(), ...patch });
    }
  }, [localGeometry]);

  useEffect(() => {
    updateGeometry({ screen });
  }, [screen.height, screen.width, updateGeometry]);

  useEffect(() => {
    if (aspectRatio) updateGeometry({ aspectRatio });
  }, [aspectRatio, updateGeometry]);

  // The reel stands in for one tile at a time: the one it opened from until the
  // reader swipes, then whichever post they are on. Both swaps happen under a
  // reel that covers the screen, so neither is visible.
  const holdTile = useCallback((itemId: string | null) => {
    const surfaceId = origin?.surfaceId;
    if (!surfaceId || hiddenItemRef.current === itemId) return;
    if (hiddenItemRef.current) setZoomSourceHidden(surfaceId, hiddenItemRef.current, false);
    hiddenItemRef.current = itemId;
    if (itemId) setZoomSourceHidden(surfaceId, itemId, true);
  }, [origin]);

  const leave = useCallback(() => {
    if (leftRef.current) return;
    leftRef.current = true;
    clearHiddenZoomSources();
    onExitRef.current();
  }, []);

  // The reel is the thing on screen now.
  const finishOpen = useCallback(() => {
    if (openedRef.current) return;
    openedRef.current = true;
    setOpened(true);
    if (!dismissingRef.current) interactive.set(1);
    holdTile(activeItemRef.current);
    if (landedRef.current) following.set(0);
  }, [following, holdTile, interactive]);

  /**
   * Uncovers the reel: once the flight has landed, the reel's window has been
   * drawn and the navigator has finished bringing the screen in, the layer's
   * picture fades and the reel — the same picture, in the same place, with its
   * rail and caption — is what is left.
   */
  const handoff = useCallback(() => {
    if (handoffRef.current || dismissingRef.current) return;
    if (!landedRef.current || !drawnRef.current || !settledRef.current) return;
    // Its rail, caption and neighbours mount once the flight lands, holding the
    // UI thread; the reel is uncovered after that, not into it.
    if (!chromeDrawnRef.current) return;
    if (!neighboursDrawnRef.current && expectsNeighboursRef.current) return;
    handoffRef.current = true;
    // A lent video: the reel adopts the player and its slide's view takes it,
    // and the layer's view lets go once that view has had a frame to draw. A
    // loan that has already ended — the reel took too long — leaves the slide
    // to build a player of its own, as it would have without one.
    if (lentVideo && adoptVideoPlayer(lentVideo.player)) {
      adoptedVideoRef.current = lentVideo.player;
      setVideoHandoff('attached');
      setTimeout(() => fadeOutZoomStill(finishOpen), VIDEO_ATTACH_SETTLE_MS);
      return;
    }
    if (lentVideo) setVideoHandoff('failed');
    fadeOutZoomStill(finishOpen);
  }, [finishOpen, lentVideo]);

  const markDrawn = useCallback(() => {
    if (drawnRef.current) return;
    drawnRef.current = true;
    setDrawn(true);
    handoff();
  }, [handoff]);

  const markSettled = useCallback(() => {
    if (settledRef.current) return;
    settledRef.current = true;
    handoff();
  }, [handoff]);

  // Every layout of a neighbour lands here while the reel is used, so all but
  // the first cost one comparison.
  const reportNeighbourDrawn = useCallback(() => {
    if (neighboursDrawnRef.current) return;
    neighboursDrawnRef.current = true;
    handoff();
  }, [handoff]);

  const reportChromeDrawn = useCallback(() => {
    if (chromeDrawnRef.current) return;
    chromeDrawnRef.current = true;
    setChromeDrawn(true);
    handoff();
  }, [handoff]);

  // What is slow to mount on landing does not keep the reel covered for long.
  useEffect(() => {
    if (!zooming || !landed) return;
    const deadline = setTimeout(() => {
      chromeDrawnRef.current = true;
      setChromeDrawn(true);
      reportNeighbourDrawn();
      handoff();
    }, LANDED_WORK_DEADLINE_MS);
    return () => clearTimeout(deadline);
  }, [handoff, landed, reportNeighbourDrawn, zooming]);

  // A reel that turns out to have no neighbours after all has nothing to wait for.
  useEffect(() => {
    if (!expectsNeighbours) handoff();
  }, [expectsNeighbours, handoff]);

  // What the flight reports: its first frame, and its landing.
  useEffect(() => {
    if (!origin) return;
    if (getZoomFlight()?.id !== origin.flightId) {
      landedRef.current = true;
      setLanded(true);
    }
    return subscribeToZoomFlights((event) => {
      const close = closeRef.current;
      if (close && event.flight.id === close.id) {
        // The reel itself has landed in the tile.
        if (event.type === 'landed' && close.live) leave();
        return;
      }
      if (event.flight.id !== origin.flightId || event.type !== 'landed') return;
      landedRef.current = true;
      setLanded(true);
      if (openedRef.current) following.set(0);
      else handoff();
    });
  }, [following, handoff, leave, origin]);

  // The navigator's own transition. Its length differs by platform and
  // direction; the event is the honest signal, the timer the safety net.
  useEffect(() => {
    if (!zooming || !WAIT_FOR_TRANSITION) return;
    const listen = navigation.addListener as unknown as (
      type: 'transitionEnd',
      listener: (event: { data?: { closing?: boolean } }) => void
    ) => () => void;
    const unsubscribe = listen('transitionEnd', (event) => {
      if (!event.data?.closing) markSettled();
    });
    const deadline = setTimeout(markSettled, SETTLE_DEADLINE_MS);
    return () => {
      unsubscribe();
      clearTimeout(deadline);
    };
  }, [markSettled, navigation, zooming]);

  // A reel with nothing to draw — a status slide, media that failed, a source
  // still loading — is uncovered on this instead.
  useEffect(() => {
    if (!zooming) return;
    const deadline = setTimeout(markDrawn, DRAWN_DEADLINE_MS);
    return () => clearTimeout(deadline);
  }, [markDrawn, zooming]);

  // With no picture carried, the reel having a slide in place is the signal
  // that its window has something in it.
  useEffect(() => {
    if (!zooming || !ready || carryingRef.current) return;
    const grace = setTimeout(markDrawn, DRAWN_GRACE_MS);
    return () => clearTimeout(grace);
  }, [markDrawn, ready, zooming]);

  const reportCarriedDrawn = useCallback(() => {
    markDrawn();
  }, [markDrawn]);

  // The reel has drawn its own picture: the tile's copy gives way to it.
  const reportPainted = useCallback(() => {
    markDrawn();
    if (!carryingRef.current) return;
    carryingRef.current = false;
    carriedOpacity.set(withTiming(0, { duration: CARRIED_FADE_MS }, (done) => {
      'worklet';
      if (done) runOnJS(setCarried)(null);
    }));
  }, [carriedOpacity, markDrawn]);

  useEffect(() => {
    if (!carryingRef.current) return;
    const deadline = setTimeout(() => {
      carryingRef.current = false;
      carriedOpacity.set(0);
      setCarried(null);
    }, CARRIED_DEADLINE_MS);
    return () => clearTimeout(deadline);
  }, [carriedOpacity]);

  // A reel with no tile arrives by dissolving where the navigator would cut.
  useEffect(() => {
    if (zooming || reducedMotion || !PLAIN_DISSOLVE) return;
    stageOpacity.set(withTiming(1, { duration: PLAIN_FADE_MS }));
  }, [reducedMotion, stageOpacity, zooming]);

  useEffect(() => {
    if (openedRef.current && !dismissingRef.current) holdTile(activeItemId);
  }, [activeItemId, holdTile]);

  // The post a close would shrink — its picture and its chrome — drawn into the
  // layer ahead of time and out of sight, so the close finds it on screen and
  // moves on the next frame. Redrawn for each post the reader moves to, for a
  // post whose own counts have moved on, and on coming back from a screen
  // pushed over the reel, which may have held a picture of its own.
  const prepareClosePicture = useCallback(() => {
    if (!openedRef.current || dismissingRef.current || leftRef.current) return;
    const handle = getZoomSource(origin?.surfaceId, activeItemRef.current);
    const picture = pictureRef.current ?? handle?.preview ?? null;
    if (picture) {
      prepareZoomPicture(picture, aspectRef.current ?? handle?.aspectRatio ?? null, true, postRef.current);
    }
  }, [origin]);
  const activePictureUrl = activePicture?.url ?? null;
  const activePictureCacheKey = activePicture?.cacheKey ?? null;
  useEffect(() => {
    if (!CLOSE_CREEPS_UNTIL_POPPED || !zooming || !opened) return;
    const timer = setTimeout(prepareClosePicture, CLOSE_PICTURE_PREPARE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [activeItemId, activePicture, activePictureCacheKey, activePictureUrl, activePost, opened, prepareClosePicture, zooming]);
  useEffect(() => {
    if (!CLOSE_CREEPS_UNTIL_POPPED || !zooming) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = navigation.addListener('focus', () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(prepareClosePicture, CLOSE_PICTURE_PREPARE_DELAY_MS);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [navigation, prepareClosePicture, zooming]);

  // However the reel leaves — a collapse, a plain pop, a screen replaced under
  // it — every tile it was holding comes back. A reel torn down before the
  // layer's picture was handed over takes that picture with it; a close leaves
  // the layer to finish its own.
  useEffect(() => () => {
    clearHiddenZoomSources();
    const close = closeRef.current;
    const stillClosing = Boolean(close) && !close!.live;
    // This unmount is the pop committing. The screen the close returns to is
    // back in the tree, but not yet on the display: drawing it again costs
    // 67–100 ms during which nothing reaches the screen at all, filmed on an
    // iPhone 16e. A picture released to full speed here spends that stretch
    // shrinking unseen and is all but landed when the display catches up — five
    // closes out of five jumped. It keeps creeping through it instead, so the
    // screen wakes on a picture around half way down with its own landing in
    // the tile still to come.
    if (stillClosing) {
      setTimeout(() => releaseZoomFlightCreep(close!.id), CLOSE_REATTACH_MS);
    }
    // Taken along: a picture not yet handed over, or one drawn for a close that never came.
    if (!stillClosing && (!openedRef.current || getHeldZoomPicture()?.standing)) holdStill(null);
    // The reel owns a video it adopted, for as long as the reel is up.
    if (adoptedVideoRef.current) releaseAdoptedVideoPlayer(adoptedVideoRef.current);
  }, []);

  // Nothing to shrink into.
  const plainLeave = useCallback(() => {
    // A reel left before the layer's picture was handed over takes it along.
    if (!openedRef.current) holdStill(null);
    if (!PLAIN_DISSOLVE || reducedMotion || !openedRef.current) {
      leave();
      return;
    }
    stageOpacity.set(withTiming(0, { duration: PLAIN_FADE_MS }, () => {
      'worklet';
      runOnJS(leave)();
    }));
    setTimeout(leave, PLAIN_FADE_MS + 100);
  }, [leave, reducedMotion, stageOpacity]);

  const dismiss = useCallback(() => {
    if (dismissingRef.current || leftRef.current) return;
    dismissingRef.current = true;
    interactive.set(0);
    if (!origin || reducedMotion) {
      plainLeave();
      return;
    }
    // Closed before the layer's picture was ever handed over: that picture is
    // still up, so it simply turns round, whatever the platform.
    const beforeHandoff = !openedRef.current;
    const handle = getZoomSource(origin.surfaceId, activeItemRef.current);
    if (!handle) {
      plainLeave();
      return;
    }
    handle.measure((rect) => {
      if (!isReturnableRect(rect, screenRef.current)) {
        plainLeave();
        return;
      }
      const live = LIVE_CLOSE && !beforeHandoff;
      const geometry: ZoomGeometry = {
        screen: screenRef.current,
        tile: rect,
        tileRadius: handle.radius,
        aspectRatio: aspectRef.current ?? handle.aspectRatio ?? rect.width / rect.height,
      };
      // What shrinks when the reel cannot: what the reader was looking at, or
      // the tile's own picture when the reel was never uncovered.
      const preview = beforeHandoff ? origin.preview : (pictureRef.current ?? handle.preview);
      // The window contains the tile at every step of a collapse, so the tile
      // can come back now, under cover, and be there when the reel lets go.
      clearHiddenZoomSources();
      hiddenItemRef.current = null;
      // Only a live close shrinks the reel's own window. One that shrinks the
      // layer's picture hides the reel, which then stays put: a reel following
      // the flight has its window laid out again on every frame, all of it
      // while the pop is unmounting that reel.
      following.set(live ? 1 : 0);
      // A live close shrinks the reel itself and leaves once it has landed.
      // Otherwise the layer's copy of the picture is drawn over the reel at
      // full size first; then, over the next two frames, the reel steps aside
      // and the pop is dispatched — so that the snapshot the pop takes of the
      // reel is empty and the screen coming back is drawn — and only then does
      // the picture start to shrink, over that screen.
      // Closed before the hand-off, a lent video is still the layer's to draw,
      // so it turns round with the flight rather than giving way to a poster.
      const video = beforeHandoff ? lentVideo : null;
      // The post shrinks whole: the layer draws its rail and caption over the
      // picture and fades them out as the window comes down. A live close has
      // the reel's own chrome to fade instead (`chromeStyle`).
      const post = live ? null : postRef.current;
      const flight = startZoomFlight({ direction: 'close', geometry, preview, video, post, still: !live }, live ? {} : {
        whenDisplayed: () => {
          stageOpacity.set(0);
          if (CLOSE_CREEPS_UNTIL_POPPED) {
            // Moving from the next frame. The pop goes a frame later, once the
            // reel is out of sight, and its commit is what releases the picture
            // (the reel's unmount, below).
            takeOffCreepingZoomFlight();
            requestAnimationFrame(leave);
            return;
          }
          requestAnimationFrame(() => {
            leave();
            requestAnimationFrame(takeOffZoomFlight);
          });
        },
      });
      closeRef.current = { id: flight.id, live };
      ownFlightRef.current = flight.id;
      // With no layer to step it the flight has already landed.
      if (live && !getZoomFlight()) leave();
      // The safety net, in case the flight never reports back.
      setTimeout(leave, DISMISS_SAFETY_MS);
    });
  }, [following, interactive, leave, lentVideo, origin, plainLeave, reducedMotion, stageOpacity]);

  const stageProps = useAnimatedProps(() => ({
    pointerEvents: interactive.value ? ('box-none' as const) : ('auto' as const),
  }));

  const clipProps = useAnimatedProps(() => ({
    pointerEvents: interactive.value ? ('box-none' as const) : ('none' as const),
  }));

  const frame = useDerivedValue(() => (
    following.value
      ? computeZoomFrame(flightGeometry.value, flightProgress.value)
      : computeZoomFrame(localGeometry.value, 1)
  ));

  const stageStyle = useAnimatedStyle(() => ({ opacity: stageOpacity.value }));

  const groundStyle = useAnimatedStyle(() => ({
    opacity: following.value
      ? interpolate(flightProgress.value, [GROUND_RAMP_FROM, 1], [0, 1], Extrapolation.CLAMP)
      : 1,
  }));

  const clipStyle = useAnimatedStyle(() => ({
    left: frame.value.clip.x,
    top: frame.value.clip.y,
    width: frame.value.clip.width,
    height: frame.value.clip.height,
    borderRadius: frame.value.radius,
  }));

  const pageStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: frame.value.translateX },
      { translateY: frame.value.translateY },
      { scale: frame.value.scale },
    ],
  }));

  // The chrome belongs to a reel that is the whole screen: it is uncovered with
  // the reel once the flight has landed, and on a collapse the reel shrinks with
  // it — fading, not cut away (`CLOSE_CHROME_HOLD`).
  const chromeStyle = useAnimatedStyle(() => {
    if (!following.value) return { opacity: 1 };
    if (flightClosing.value) {
      return {
        opacity: interpolate(flightTime.value, [CLOSE_CHROME_GONE, CLOSE_CHROME_HOLD], [0, 1], Extrapolation.CLAMP),
      };
    }
    return { opacity: flightProgress.value < CHROME_FROM ? 0 : 1 };
  });

  const carriedStyle = useAnimatedStyle(() => ({ opacity: carriedOpacity.value }));

  const lentVideoValue = useMemo<MediaZoomLentVideo | null>(() => (
    lentVideo && videoHandoff !== 'failed'
      ? { video: lentVideo, attached: videoHandoff === 'attached' }
      : null
  ), [lentVideo, videoHandoff]);

  return {
    zooming,
    opened,
    landed,
    drawn,
    reportNeighbourDrawn,
    reportChromeDrawn,
    chromeDrawn,
    stageProps,
    clipProps,
    stageStyle,
    groundStyle,
    clipStyle,
    pageStyle,
    chromeStyle,
    carried,
    carriedStyle,
    lentVideo: lentVideoValue,
    reportCarriedDrawn,
    reportPainted,
    dismiss,
  };
}

/**
 * Draws the reel inside the window that grows out of the tile. Outside the
 * window is the reel's own ground, which comes up as the window fills the
 * screen and goes again as it shrinks, so the screen the reel came from is
 * what the movement plays over.
 */
export function MediaZoomStage({
  stage,
  screen,
  children,
}: {
  stage: MediaZoomStageValue;
  screen: ZoomSize;
  children: ReactNode;
}) {
  return (
    // While the reel is not interactive the stage takes every touch itself, so
    // nothing reaches the screen showing through underneath it.
    <Animated.View
      collapsable={false}
      animatedProps={stage.stageProps}
      style={[{ flex: 1 }, stage.stageStyle]}
    >
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { backgroundColor: '#000' }, stage.groundStyle]}
      />
      <Animated.View
        collapsable={false}
        animatedProps={stage.clipProps}
        style={[{ position: 'absolute', overflow: 'hidden', backgroundColor: '#000' }, stage.clipStyle]}
      >
        <Animated.View
          collapsable={false}
          style={[{ position: 'absolute', left: 0, top: 0, width: screen.width, height: screen.height }, stage.pageStyle]}
        >
          <MediaZoomChromeContext.Provider value={stage.chromeStyle}>
            <MediaZoomPaintContext.Provider value={stage.reportPainted}>
              <MediaZoomOpenedContext.Provider value={stage.opened}>
                <MediaZoomLandedContext.Provider value={stage.landed && stage.drawn}>
                  <MediaZoomLentVideoContext.Provider value={stage.lentVideo}>
                    {children}
                  </MediaZoomLentVideoContext.Provider>
                </MediaZoomLandedContext.Provider>
              </MediaZoomOpenedContext.Provider>
            </MediaZoomPaintContext.Provider>
          </MediaZoomChromeContext.Provider>
          {/* The tile's own picture, laid where the reel draws its media, until
              the reel has drawn it. Being drawn is also how the reel says its
              window is on screen at all. */}
          {stage.carried ? (
            <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, stage.carriedStyle]}>
              <Image
                source={{ uri: stage.carried.url, cacheKey: stage.carried.cacheKey ?? undefined }}
                placeholder={stage.carried.thumbhash ? { thumbhash: stage.carried.thumbhash } : undefined}
                placeholderContentFit="contain"
                contentFit="contain"
                cachePolicy="memory-disk"
                priority="high"
                transition={0}
                onDisplay={stage.reportCarriedDrawn}
                style={StyleSheet.absoluteFill}
              />
            </Animated.View>
          ) : null}
        </Animated.View>
      </Animated.View>
    </Animated.View>
  );
}

/**
 * The flight itself: the tapped tile's picture inside the window, stepped
 * frame by frame from the tile to the screen and back. Mounted once, above the
 * navigator, so no screen change can take it away mid-movement; it draws
 * nothing at all unless a post is opening or closing.
 */
export function MediaZoomFlightLayer({
  renderPost,
}: {
  /**
   * Draws a post's rail, caption and controls, laid out on the whole screen as
   * the reel lays them out (`ZoomStill.post`). The app shell supplies it, as it
   * owns what that chrome reads — the signed-in reader, whom they follow — and
   * the flight stays a picture in a window.
   */
  renderPost?: (post: ImmersivePreviewItem) => ReactNode;
} = {}) {
  const still = useSyncExternalStore(subscribeToHeldZoomPicture, getHeldZoomPicture, getHeldZoomPicture);
  const layerRef = useRef<View | null>(null);

  // Where the layer is on the page, and how big: the space tiles are measured
  // in. Re-read whenever the layer is laid out again (a rotation, a fold).
  const measureLayer = useCallback(() => {
    layerRef.current?.measure((_x, _y, width, height, pageX, pageY) => {
      if (!(width > 0 && height > 0)) return;
      layerScreen = { width, height };
      layerOrigin = { x: pageX, y: pageY };
    });
  }, []);

  useLayoutEffect(() => {
    measureLayerNow = measureLayer;
    return () => {
      if (measureLayerNow === measureLayer) measureLayerNow = null;
    };
  }, [measureLayer]);

  const ticker = useFrameCallback((frame) => {
    'worklet';
    if (!flightFlying.value) return;
    const id = flightId.value;
    const step = Math.min(frame.timeSincePreviousFrame ?? 16, MAX_FLIGHT_STEP_MS);
    const closing = flightClosing.value;
    // A close waiting on its pop runs its own curve at a fraction of the speed.
    const creeping = closing && flightCreeping.value;
    const next = advanceZoomFlight(
      flightTime.value,
      closing,
      creeping ? step * CLOSE_CREEP_RATE : step,
      closing ? CLOSE_MS : OPEN_MS,
      ZOOM_EASE_POWER
    );
    flightTime.value = next.time;
    flightProgress.value = next.progress;
    const push = !flightPushed.value && next.progress >= OPEN_PUSH_AT;
    if (push) flightPushed.value = true;
    if (next.done) {
      flightFlying.value = false;
      runOnJS(finishZoomFlight)(id);
    }
    // Landed first when both fall on one frame, so the navigator rendering the
    // push already sees a picture that fills the screen (`arrivesUnderLandedZoom`).
    if (push) runOnJS(handleFlightProgressed)(id);
  }, false);

  useLayoutEffect(() => {
    const control = (active: boolean) => ticker.setActive(active);
    tickerControl = control;
    return () => {
      if (tickerControl === control) tickerControl = null;
    };
  }, [ticker]);

  useEffect(() => subscribeToZoomFlights((event) => {
    if (event.type === 'displayed') handleFlightDisplayed(event.flight.id);
  }), []);

  // A push that never arrives — a refused navigation, a crash on the way — or
  // a finger that pressed and then scrolled away must not leave a picture
  // pinned over the app.
  useEffect(() => {
    if (!still || still.standing) return;
    const deadline = setTimeout(() => holdStill(null), HOLD_DEADLINE_MS);
    return () => clearTimeout(deadline);
  }, [still]);

  // The picture is on screen. A flight carrying it shows it now; one merely
  // prepared under a finger stays out of sight until a flight wants it.
  const reportDisplayed = useCallback(() => {
    // A poster prepared under the finger can finish drawing just after the tap
    // has made the hold a lent video's. That flight waits on the video's own
    // frame: shown or taken off on the poster's, it would flash frame zero over
    // the playing tile, or fly an empty window.
    if (getHeldZoomPicture()?.video) return;
    displayedPreview = getHeldZoomPicture()?.preview ?? null;
    if (getZoomFlight()) stillOpacity.set(1);
    markZoomFlightDisplayed(flightId.get());
  }, []);

  // The layer's view of a lent video has drawn (iOS says so; Android relies on
  // the deadline). The poster was never drawn here, so it is not recorded as shown.
  const reportVideoDisplayed = useCallback(() => {
    markZoomFlightDisplayed(flightId.get());
  }, []);

  const videoSurfaceStyle = useAnimatedStyle(() => ({ opacity: videoSurfaceOpacity.value }));
  const closeGroundStyle = useAnimatedStyle(() => ({ opacity: closeGroundOpacity.value }));

  // The reel's top shade comes up with the reel's own ground, over the last
  // stretch of an open; a close carries none, as the reel's chrome cuts away on
  // a collapse's first frame.
  const topInset = resolvedTopInset(useSafeAreaInsets().top);
  const scrimStyle = useAnimatedStyle(() => ({
    opacity: flightClosing.value
      ? 0
      : interpolate(flightProgress.value, [GROUND_RAMP_FROM, 1], [0, 1], Extrapolation.CLAMP),
  }));
  // The bands stay out of a video's window while it is still the tile: the
  // tile shows through that window until the layer's video has drawn.
  const bandStyle = useAnimatedStyle(() => ({
    opacity: stillCarriesVideo.value && flightProgress.value <= 0 ? 0 : 1,
  }));
  // Nor does the poster drawn under the finger show in it, for the frame or two
  // before React swaps it for the video's view: the tile has moved on from it.
  const stillPictureStyle = useAnimatedStyle(() => ({
    opacity: stillCarriesVideo.value ? 0 : 1,
  }));

  const frame = useDerivedValue(() => computeZoomFrame(flightGeometry.value, flightProgress.value));
  const postChrome = still?.post && renderPost ? renderPost(still.post) : null;
  const carriesPost = postChrome !== null;

  // The post's own chrome: kept off a video's tile until the layer's view of it
  // has drawn, as the bands are, and faded out as a close comes down.
  const postChromeStyle = useAnimatedStyle(() => {
    if (stillCarriesVideo.value && flightProgress.value <= 0) return { opacity: 0 };
    if (!flightClosing.value) return { opacity: 1 };
    return {
      opacity: interpolate(flightTime.value, [CLOSE_CHROME_GONE, CLOSE_CHROME_HOLD], [0, 1], Extrapolation.CLAMP),
    };
  });

  const clipStyle = useAnimatedStyle(() => ({
    left: frame.value.clip.x,
    top: frame.value.clip.y,
    width: frame.value.clip.width,
    height: frame.value.clip.height,
    borderRadius: frame.value.radius,
    opacity: stillOpacity.value,
    // A video's window is see-through while it is still the tile: its own view
    // of the player may not have drawn yet, and the tile under it — exactly the
    // same rectangle then — is still showing that video. The black ground is
    // needed only once the window outgrows the tile.
    backgroundColor: stillCarriesVideo.value && flightProgress.value <= 0 ? 'transparent' : '#000',
  }));

  const pageStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: frame.value.translateX },
      { translateY: frame.value.translateY },
      { scale: frame.value.scale },
    ],
  }));

  // The layer's own view is always there, so its place on the page is known
  // before any tile is tapped; it draws nothing until one is.
  return (
    <View ref={layerRef} pointerEvents="none" style={StyleSheet.absoluteFill} onLayout={measureLayer}>
      {still ? (
        // The ground a creeping close shrinks over until its pop has brought
        // the screen back (`CLOSE_CREEPS_UNTIL_POPPED`); out of sight otherwise.
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: '#000' }, closeGroundStyle]} />
      ) : null}
      {still ? (
        // The window is the reel's frame, black ground included: a picture
        // that does not fill the screen leaves the same bands here that the
        // reel draws, so the hand-off between the two changes nothing.
        <Animated.View
          collapsable={false}
          // Fade the picture and its black letterbox as one surface. Android's
          // per-child alpha otherwise lets the black ground darken the image
          // underneath halfway through the handoff. Offscreen only while it is
          // translucent — not a standing hardware layer
          // (`renderToHardwareTextureAndroid`): a layer is as big as this window,
          // which changes size every frame of the flight, and a traced S24 spent
          // up to 7 ms of each of those frames allocating a new one on the GPU.
          needsOffscreenAlphaCompositing
          style={[{ position: 'absolute', overflow: 'hidden' }, clipStyle]}
        >
          {/* The same page the reel draws its media on, at the same transform,
              so the picture here and the reel's are one picture at the
              hand-off. No placeholder: the picture is in memory, and the flight
              waits for it rather than showing a blur in its place. */}
          <Animated.View
            collapsable={false}
            style={[
              { position: 'absolute', left: 0, top: 0, width: still.geometry.screen.width, height: still.geometry.screen.height },
              pageStyle,
            ]}
          >
            {/* The bands around a picture that does not fill the screen, drawn
                as the reel draws them — the picture's own edge mirrored and
                blurred, under the same eased shade — so they do not turn from
                black into the reel's bands at the hand-off. Prepared with the
                picture, under the finger. */}
            <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, bandStyle]}>
              <LetterboxBands
                frame={still.geometry.screen}
                aspectRatio={still.geometry.aspectRatio}
                source={{ uri: still.preview.url, cacheKey: still.preview.cacheKey, thumbhash: still.preview.thumbhash }}
              />
            </Animated.View>
            {still.video ? (
              // The tile's own player, still playing: the flight is the video
              // the reader was watching, not its first frame.
              <Animated.View collapsable={false} pointerEvents="none" style={[StyleSheet.absoluteFill, videoSurfaceStyle]}>
                <VideoView
                  {...FEED_VIDEO_VIEW_PROPS}
                  player={still.video.player}
                  contentFit="contain"
                  onFirstFrameRender={reportVideoDisplayed}
                  pointerEvents="none"
                  style={StyleSheet.absoluteFill}
                />
              </Animated.View>
            ) : (
              <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, stillPictureStyle]}>
                <Image
                  source={{ uri: still.preview.url, cacheKey: still.preview.cacheKey ?? undefined }}
                  contentFit="contain"
                  cachePolicy="memory-disk"
                  priority="high"
                  transition={0}
                  onDisplay={reportDisplayed}
                  style={StyleSheet.absoluteFill}
                />
              </Animated.View>
            )}
            {carriesPost ? (
              // The post itself — its rail, caption, top shade and controls, on
              // the page the picture is on and scaled with it — so the window
              // opens on the whole post rather than on a picture the reel
              // dresses once it lands — and the one a close carries back down
              // into the tile, fading (`postChromeStyle`).
              //
              // A drawing, not the post: the reel underneath owns every control
              // here, so a screen reader must find them there and never twice.
              <Animated.View
                pointerEvents="none"
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                style={[StyleSheet.absoluteFill, postChromeStyle]}
              >
                {postChrome}
              </Animated.View>
            ) : null}
          </Animated.View>
          {/* The reel's top shade, arriving with the window: measured without
              it, the top of the screen darkened by some 77 levels as the reel
              took over, because the shade is the reel's and only appeared as
              this picture let go. Screen-fixed, so outside the page's transform.
              A flight carrying the post draws the shade with it instead. */}
          {carriesPost ? null : (
            <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, scrimStyle]}>
              <TopScrim topInset={topInset} over="media" />
            </Animated.View>
          )}
        </Animated.View>
      ) : null}
    </View>
  );
}

/**
 * A layer of reel chrome — scrims, controls, the rail, the caption — that fades
 * in with the window and out with it. Always a full-bleed layer, so the
 * absolutely-placed controls inside keep their own coordinates.
 */
export function MediaZoomChrome({
  children,
  pointerEvents = 'box-none',
}: {
  children: ReactNode;
  pointerEvents?: 'box-none' | 'none';
}) {
  const chromeStyle = useContext(MediaZoomChromeContext);
  return (
    <Animated.View collapsable={false} pointerEvents={pointerEvents} style={[{ position: 'absolute', inset: 0 }, chromeStyle]}>
      {children}
    </Animated.View>
  );
}
