import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from 'react';
import { Image } from 'expo-image';
import { useNavigation } from 'expo-router';
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
} from '@/lib/media-zoom-transition';

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
 * From which point of the flight the reel's black ground comes up around the
 * window — and below which it is gone again as the window shrinks. Until then
 * the screen the reel came from is what the movement plays over, as it is in
 * Instagram.
 */
const GROUND_RAMP_FROM = 0.8;
/**
 * The rail and caption are there only while the window is the whole screen:
 * they cut away on the first frame of a collapse rather than fading, as
 * Instagram's do. A fade would cost a frame of offscreen compositing for every
 * gradient in them, and nobody is looking at a caption that is shrinking.
 */
const CHROME_FROM = 0.995;
/**
 * How far the picture has grown before the reel is pushed. Mounting the reel
 * is the heaviest thing the app does, and the UI thread is held for a stretch
 * of it; by this point the window is nearly the screen and moving a few pixels
 * a frame, so that stretch is barely seen. Pushed at the tap instead, it would
 * hold the flight's first frames — the very moment the growth has to be seen.
 */
const OPEN_PUSH_AT = 0.8;
/** The reel is pushed by this many ms after the flight begins, whatever its progress. */
const OPEN_PUSH_DEADLINE_MS = 150;
/** How long the layer's picture takes to give way to the reel underneath it. */
const HANDOFF_FADE_MS = 120;
/** How long the tile's picture inside the reel takes to give way to the reel's own. */
const CARRIED_FADE_MS = 90;
/** Two frames: long enough for a window that has been committed to have been drawn. */
const DRAWN_GRACE_MS = 120;
/** A reel that never says it has drawn anything is uncovered anyway after this. */
const DRAWN_DEADLINE_MS = 500;
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
 * takes its picture, and the pop runs under that picture as it shrinks — the
 * screen coming back is drawn from the collapse's first frame.
 */
const LIVE_CLOSE = Platform.OS === 'android';
/**
 * On Android the navigator runs no animation for the reel (the zoom is the
 * animation), so a reel with no tile dissolves on its own instead of cutting.
 */
const PLAIN_DISSOLVE = Platform.OS === 'android';
/**
 * On iOS the reel arrives under the navigator's fade. Its window must not be
 * uncovered until that fade is over, or the screen beneath shows through it.
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

/** Holds a picture in the layer, forgetting that the last one was drawn if this is a different one. */
function holdStill(still: ZoomStill | null) {
  if (!samePicture(displayedPreview, still?.preview)) displayedPreview = null;
  return holdZoomPicture(still);
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
 */
function prepareZoomPicture(preview: ZoomPreview) {
  if (!tickerControl || getZoomFlight()) return;
  if (layerScreen.width <= 0) measureLayerNow?.();
  if (layerScreen.width <= 0) return;
  if (samePicture(getHeldZoomPicture()?.preview, preview)) return;
  stillOpacity.set(0);
  holdStill({ preview, geometry: { screen: layerScreen, tile: null, tileRadius: 0, aspectRatio: null } });
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
  const still = spec.still && spec.preview ? { preview: spec.preview, geometry: spec.geometry } : null;
  // A picture the layer has already drawn — prepared under the finger, or
  // carried by the flight this one reverses — shows at once; a new one is kept
  // invisible until the layer says it has drawn it, so neither a blur nor the
  // window's black ground is ever seen in its place.
  const alreadyShowing = Boolean(still) && samePicture(displayedPreview, still?.preview);
  stillOpacity.set(alreadyShowing ? 1 : 0);
  holdStill(still);
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
  else setTimeout(() => markZoomFlightDisplayed(started.id), TAKEOFF_DEADLINE_MS);
  return started;
}

function takeOffZoomFlight() {
  if (!tickerControl || !getZoomFlight()) return;
  flightFlying.set(true);
  tickerControl(true);
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
  stillOpacity.set(withTiming(0, { duration: HANDOFF_FADE_MS }, (finished) => {
    'worklet';
    if (finished) runOnJS(finish)();
  }));
  // A newer flight cancels the fade; the reel it was uncovering still opens.
  setTimeout(finish, HANDOFF_FADE_MS + 50);
}

const MediaZoomSurfaceContext = createContext<string | null>(null);
const MediaZoomChromeContext = createContext<StyleProp<ViewStyle>>(null);
const MediaZoomPaintContext = createContext<(() => void) | null>(null);
const MediaZoomOpenedContext = createContext(true);

/**
 * Whether the reel is the thing on screen: the layer's picture has given way
 * to it. Anything the reel can put off until then — a player to create, a
 * badge that would flash over a still — reads it.
 */
export function useMediaZoomOpened() {
  return useContext(MediaZoomOpenedContext);
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
}

/**
 * The tile half of the hand-off: registers this tile under the post it shows,
 * measures it when it is tapped, and hides it while the reel stands in for it.
 */
export function useMediaZoomSource({
  itemId,
  radius = 0,
  aspectRatio = null,
  preview = null,
  enabled = true,
}: {
  itemId: string;
  radius?: number;
  aspectRatio?: number | null;
  /** What this tile is showing, so the reel can carry it while it builds. */
  preview?: ZoomPreview | null;
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
    if (active && preview) prepareZoomPicture(preview);
  }, [active, preview]);

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
        still: true,
      }, { whenProgressed: open });
      setPendingZoomOrigin({
        surfaceId,
        itemId,
        rect,
        radius,
        aspectRatio,
        preview,
        flightId: flight.id,
        recordedAt: Date.now(),
      });
    };
    measure(start);
    // Fabric answers `measureInWindow` before it returns. A host that does not
    // must never swallow the tap, so the plain open runs instead.
    start(null);
  }, [active, aspectRatio, itemId, measure, preview, radius, surfaceId]);

  return { ref, hiddenStyle, prepare, capture };
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
        {children}
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
  reducedMotion,
  ready,
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
  reducedMotion: boolean;
  /** The reel has its first slide in place. */
  ready: boolean;
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

  const carriedPreview = origin?.preview ?? null;
  const [carried, setCarried] = useState<ZoomPreview | null>(carriedPreview);
  const carryingRef = useRef(Boolean(carriedPreview));
  const carriedOpacity = useSharedValue(carriedPreview ? 1 : 0);

  const [opened, setOpened] = useState(!zooming);
  const interactive = useSharedValue(zooming ? 0 : 1);
  const openedRef = useRef(!zooming);
  // The flight may have landed before this reel could listen for it.
  const landedRef = useRef(!origin || getZoomFlight()?.id !== origin.flightId);
  const drawnRef = useRef(false);
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
    handoffRef.current = true;
    fadeOutZoomStill(finishOpen);
  }, [finishOpen]);

  const markDrawn = useCallback(() => {
    if (drawnRef.current) return;
    drawnRef.current = true;
    handoff();
  }, [handoff]);

  const markSettled = useCallback(() => {
    if (settledRef.current) return;
    settledRef.current = true;
    handoff();
  }, [handoff]);

  // What the flight reports: its first frame, and its landing.
  useEffect(() => {
    if (!origin) return;
    if (getZoomFlight()?.id !== origin.flightId) landedRef.current = true;
    return subscribeToZoomFlights((event) => {
      const close = closeRef.current;
      if (close && event.flight.id === close.id) {
        // The reel itself has landed in the tile.
        if (event.type === 'landed' && close.live) leave();
        return;
      }
      if (event.flight.id !== origin.flightId || event.type !== 'landed') return;
      landedRef.current = true;
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

  // However the reel leaves — a collapse, a plain pop, a screen replaced under
  // it — every tile it was holding comes back. A reel torn down before the
  // layer's picture was handed over takes that picture with it; a close leaves
  // the layer to finish its own.
  useEffect(() => () => {
    clearHiddenZoomSources();
    const stillClosing = Boolean(closeRef.current) && !closeRef.current!.live;
    if (!openedRef.current && !stillClosing) holdStill(null);
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
      following.set(1);
      // A live close shrinks the reel itself and leaves once it has landed.
      // Otherwise the layer's copy of the picture is drawn over the reel at
      // full size first; then, over the next two frames, the reel steps aside
      // and the pop is dispatched — so that the snapshot the pop takes of the
      // reel is empty and the screen coming back is drawn — and only then does
      // the picture start to shrink, over that screen.
      const flight = startZoomFlight({ direction: 'close', geometry, preview, still: !live }, live ? {} : {
        whenDisplayed: () => {
          stageOpacity.set(0);
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
  }, [following, interactive, leave, origin, plainLeave, reducedMotion, stageOpacity]);

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
  // the reel once the flight has landed, and cuts away on a collapse's first frame.
  const chromeStyle = useAnimatedStyle(() => ({
    opacity: following.value && flightProgress.value < CHROME_FROM ? 0 : 1,
  }));

  const carriedStyle = useAnimatedStyle(() => ({ opacity: carriedOpacity.value }));

  return {
    zooming,
    opened,
    stageProps,
    clipProps,
    stageStyle,
    groundStyle,
    clipStyle,
    pageStyle,
    chromeStyle,
    carried,
    carriedStyle,
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
                {children}
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
export function MediaZoomFlightLayer() {
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
    const next = advanceZoomFlight(flightTime.value, closing, step, closing ? CLOSE_MS : OPEN_MS, ZOOM_EASE_POWER);
    flightTime.value = next.time;
    flightProgress.value = next.progress;
    if (!flightPushed.value && next.progress >= OPEN_PUSH_AT) {
      flightPushed.value = true;
      runOnJS(handleFlightProgressed)(id);
    }
    if (!next.done) return;
    flightFlying.value = false;
    runOnJS(finishZoomFlight)(id);
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
    if (!still) return;
    const deadline = setTimeout(() => holdStill(null), HOLD_DEADLINE_MS);
    return () => clearTimeout(deadline);
  }, [still]);

  // The picture is on screen. A flight carrying it shows it now; one merely
  // prepared under a finger stays out of sight until a flight wants it.
  const reportDisplayed = useCallback(() => {
    displayedPreview = getHeldZoomPicture()?.preview ?? null;
    if (getZoomFlight()) stillOpacity.set(1);
    markZoomFlightDisplayed(flightId.get());
  }, []);

  const frame = useDerivedValue(() => computeZoomFrame(flightGeometry.value, flightProgress.value));

  const clipStyle = useAnimatedStyle(() => ({
    left: frame.value.clip.x,
    top: frame.value.clip.y,
    width: frame.value.clip.width,
    height: frame.value.clip.height,
    borderRadius: frame.value.radius,
    opacity: stillOpacity.value,
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
        // The window is the reel's frame, black ground included: a picture
        // that does not fill the screen leaves the same bands here that the
        // reel draws, so the hand-off between the two changes nothing.
        <Animated.View collapsable={false} style={[{ position: 'absolute', overflow: 'hidden', backgroundColor: '#000' }, clipStyle]}>
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
