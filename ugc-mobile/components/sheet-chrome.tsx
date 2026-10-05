import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as ReactNative from 'react-native';

import { touchBelongsToNativeView } from '@/lib/native-touch-owner';
import { appTheme, type ThemeColors } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';

/**
 * The one dismissal contract every bottom sheet in this app shares.
 *
 * HIG Sheets asks for two things that have to arrive together: "Include a
 * grabber in a resizable sheet — a grabber shows people that they can drag the
 * sheet", and "Support swiping to dismiss a sheet. People expect to swipe
 * vertically to dismiss a sheet instead of tapping a dismiss button." Drawing
 * the pill without wiring the drag is worse than drawing nothing: it promises a
 * gesture the sheet does not answer, which is exactly what the Gestures chapter
 * warns about ("if you don't clearly communicate why a gesture doesn't work,
 * people might think your app has frozen").
 *
 * Before this existed the app had three different answers — a pill that dragged
 * (comments), a pill that did nothing (viewer actions, feed feedback, create
 * menu) and a `GripHorizontal` glyph that dragged (the three creator sheets).
 * One import now, so a new sheet cannot invent a fourth.
 *
 * The swipe is answered by the whole sheet, not only the pill. People do not
 * aim for a 4pt strip; they pull the surface they are looking at, the way every
 * system sheet lets them. Two responders share one offset: the grabber takes
 * the touch the moment it lands, and the panel takes a touch only once it has
 * moved down — so a tap inside still reaches its button, and a list inside
 * still scrolls until it reaches its top.
 */

function optionalNativeExport<T>(read: () => T) {
  try {
    return read();
  } catch {
    // Focused component tests mock react-native down to what they render.
    return undefined;
  }
}

const animatedApi = optionalNativeExport(() => ReactNative.Animated);
const panResponderApi = optionalNativeExport(() => ReactNative.PanResponder);
const easingApi = optionalNativeExport(() => ReactNative.Easing);
const NativePressable = optionalNativeExport(() => ReactNative.Pressable);

/**
 * How far the sheet has to travel before releasing dismisses it.
 *
 * A fixed distance rather than a fraction of the window: it keeps the primitive
 * free of `useWindowDimensions`, which the minimal react-native mocks in the
 * focused sheet tests do not provide, and 100pt is within a pixel of what the
 * comments sheet's `min(120, height * 0.12)` resolved to on every phone the app
 * supports.
 */
export const SHEET_DISMISS_DISTANCE = 100;
/** A flick releases early: past this downward velocity, distance stops mattering. */
export const SHEET_DISMISS_VELOCITY = 0.6;
/**
 * The drawer reuses both numbers on its own axis (`home-side-menu`). Its
 * geometry is different enough to need its own responder — horizontal, no
 * grabber, over a scrolling body — but a sheet and a drawer disagreeing about
 * how far is far enough would be the same drift this module exists to stop.
 */
/** Below this the drag is still ambiguous with a scroll, so the sheet does not claim it. */
const SHEET_DRAG_CLAIM_DISTANCE = 6;
/**
 * How far down the sheet has gone by the time the scrim behind it is fully
 * clear. Past the dismiss distance the scrim is still two-thirds there, so a
 * drag that is about to let go reads as "leaving", not "left".
 */
export const SHEET_BACKDROP_FADE_DISTANCE = 320;

// Sheet motion. The panel travels its own measured height so it reads as a
// sheet arriving from the screen edge instead of a box blinking into place,
// and the two directions use opposite curves: entering decelerates into rest,
// leaving accelerates away.
const SHEET_ENTER_DURATION = 300;
const SHEET_EXIT_DURATION = 220;
// Keeps the panel's drop shadow past the screen edge while it is closed.
const SHEET_HIDDEN_SLOP = 24;
// Where a panel waits before it has been laid out: further below its place than
// any screen is tall, so nothing drawn that early can show.
const SHEET_UNMEASURED_OFFSET = 10_000;

// The pill's own geometry, and the target around it. Not spacing tokens: this
// is the shape of one control, the way `hit-target` owns its own floor.
const GRABBER_WIDTH = 42;
const GRABBER_HEIGHT = 4;
const GRABBER_TARGET_PADDING = 8;

type AnimatedViewStyle = ReactNative.Animated.WithAnimatedValue<ReactNative.ViewStyle>;
type PanHandlers = Partial<ReactNative.GestureResponderHandlers>;
type GestureState = ReactNative.PanResponderGestureState;

/** The scroll props a list inside a sheet spreads so the content drag can read it. */
export type SheetScrollProps = Pick<
  ReactNative.ScrollViewProps,
  'bounces' | 'overScrollMode' | 'scrollEventThrottle' | 'onScroll'
>;

export interface SheetDismissDrag {
  /** The grabber's handlers: it takes the touch the moment it lands. `SheetGrabber` spreads them. */
  panHandlers: PanHandlers;
  /**
   * The rest of the sheet's handlers: they take a touch only once it has moved
   * down, so a tap inside still reaches its button. Spread onto the panel — or
   * onto just the header when the body is a list that keeps its own scrolling
   * and composer (comments).
   */
  contentPanHandlers: PanHandlers;
  /**
   * Spread onto a ScrollView inside the panel. The content drag reads the
   * list's offset from it: below the top a downward pull scrolls the list, at
   * the top it moves the sheet — the hand-off every system sheet makes. It also
   * turns off the top-edge bounce, which would otherwise stretch the list at
   * the same moment the sheet starts to follow the finger.
   */
  scrollProps: SheetScrollProps;
  /** Spread onto the sheet panel — a `MotionView` — so it tracks the finger. */
  dragStyle: AnimatedViewStyle | undefined;
  /** Spread onto the scrim, so it thins as the sheet is pulled away. `SheetBackdrop` does. */
  backdropStyle: AnimatedViewStyle | undefined;
  /**
   * The raw offset, for a panel that already composes its own transform and
   * has to fold this into it (`Animated.add`) rather than append a second one.
   */
  translateY: ReactNative.Animated.Value | null;
  /**
   * 1 at rest, 0 once the sheet is `SHEET_BACKDROP_FADE_DISTANCE` down — for a
   * scrim that composes its own opacity with an entrance (`Animated.multiply`).
   */
  backdropOpacity: ReactNative.Animated.AnimatedInterpolation<number> | null;
  onDismiss: () => void;
}

export function useSheetDismissDrag({
  onDismiss,
  visible,
  enabled = true,
  takesTouchDown = true,
}: {
  onDismiss: () => void;
  /**
   * Whether the sheet is on screen. Required, not optional: a drag leaves its
   * offset where the finger let go, which is right for the exit that follows
   * and wrong for the next opening. Four sheets that stay mounted while closed
   * left this out and reopened part-way down the screen, held there until a
   * tap on the grabber sprang them back. A sheet mounted only while it is open
   * passes `true`.
   */
  visible: boolean;
  enabled?: boolean;
  /**
   * Whether the panel takes a touch-down that nothing below it wanted, before
   * it is a pull.
   *
   * Inside a React Native `Modal` it has to (see the content responder below).
   * In the app's own window nothing above the panel takes that touch, and the
   * panel is asked about it again at every move, so it can wait for the pull.
   * A sheet drawn through `OverlayHost` with a scroll view in it passes
   * `false`. Held from its start, the touch is taken from that scroll view on
   * Android: the view that holds a touch for JS intercepts it at the finger's
   * next movement. In the Reference details sheet a slow drag that began on
   * the picture scrolled nothing, and a quick one scrolled only because the
   * scroll view had started before JS answered (Pixel 9a emulator, 2026-10-05).
   *
   * What it costs: while that scroll view has somewhere to scroll, a pull down
   * that starts on its content is the scroll view's and no longer moves the
   * sheet. The title, the grabber and a pull from a button still do, and with
   * nothing to scroll a pull from anywhere does.
   */
  takesTouchDown?: boolean;
}): SheetDismissDrag {
  // A brand-new offset for every opening, rather than one value reset in
  // place. Once the native driver has touched an `Animated.Value` it carries
  // history across the panel's unmount — a dropped native node, a read-back
  // of its last native value scheduled at detach, a JS mirror that read-back
  // overwrites later — and a `setValue(0)` on it while nothing is attached
  // trusts the order those land in. On the emulator the create menu reopened
  // one drag-offset too low about one time in five that way. A fresh value
  // has nothing to remember. Adjusted during render (React's supported
  // pattern for state that follows a prop) so the panel's first frame
  // already sees it.
  const [opening, setOpening] = useState(() => ({ visible, dragY: createOffset() }));
  if (opening.visible !== visible) {
    setOpening({ visible, dragY: visible ? createOffset() : opening.dragY });
  }
  const dragY = opening.dragY;

  // Read through refs: the responders are created once and would otherwise
  // capture the first render's close handler forever.
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const takesTouchDownRef = useRef(takesTouchDown);
  takesTouchDownRef.current = takesTouchDown;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const mountedRef = useRef(true);
  // Where the list inside the sheet is scrolled to, if there is one.
  const scrollOffsetRef = useRef(0);
  // How far the finger had already moved when the sheet took the touch. Zero
  // for the grabber, which takes it on touch-down; a few points for the panel,
  // which takes it once the drag is unambiguous. Subtracting it keeps the
  // panel from jumping under the finger the moment it is claimed.
  const grantOffsetRef = useRef(0);
  // Whether the touch the panel holds has proven itself a pull. A touch taken
  // on touch-down starts unarmed and the panel ignores its movement until it
  // has; one taken over from a pressed button mid-drag arrives armed.
  const armedRef = useRef(false);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!visible) return;
    // A Modal remounts its list at the top; the hook outlives it, so it has to
    // forget the old offset too or the content drag stays off until a scroll.
    scrollOffsetRef.current = 0;
  }, [visible]);

  useEffect(() => () => {
    mountedRef.current = false;
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
  }, []);

  const responders = useMemo(() => {
    if (!panResponderApi) return null;

    const isDownwardDrag = (gesture: GestureState) => (
      enabledRef.current
      && gesture.dy > SHEET_DRAG_CLAIM_DISTANCE
      && Math.abs(gesture.dy) > Math.abs(gesture.dx)
    );
    // The panel only takes a pull the list has nothing to do with: at the top,
    // the list is done scrolling and the sheet is what moves next.
    const isContentDrag = (gesture: GestureState) => isDownwardDrag(gesture) && scrollOffsetRef.current <= 0;

    const move = (_event: ReactNative.GestureResponderEvent, gesture: GestureState) => {
      dragY?.setValue(Math.max(0, gesture.dy - grantOffsetRef.current));
    };
    const release = (_event: ReactNative.GestureResponderEvent, gesture: GestureState) => {
      const travelled = gesture.dy - grantOffsetRef.current;
      if (gesture.vy > SHEET_DISMISS_VELOCITY || travelled > SHEET_DISMISS_DISTANCE) {
        onDismissRef.current();
        // A host may answer a dismissal with a question instead of closing —
        // the resource editor asks about unsaved changes. If the sheet is
        // still showing once the host has had its turn, put it back.
        settleTimerRef.current = setTimeout(() => {
          settleTimerRef.current = null;
          if (mountedRef.current && visibleRef.current) springBack(dragY);
        }, 0);
        return;
      }
      springBack(dragY);
    };
    const terminate = () => {
      springBack(dragY);
    };

    // The panel arms when the touch it holds becomes an unambiguous pull, and
    // only then starts to move. Until that moment its movement is ignored, so
    // a scroll that starts on a gap in a list scrolls, and a tap on a title
    // is a tap.
    const armContent = (gesture: GestureState) => {
      armedRef.current = true;
      grantOffsetRef.current = gesture.dy;
    };
    const contentGrant = (_event: ReactNative.GestureResponderEvent, gesture: GestureState) => {
      armedRef.current = false;
      if (isContentDrag(gesture)) armContent(gesture);
    };
    const contentMove = (event: ReactNative.GestureResponderEvent, gesture: GestureState) => {
      if (!armedRef.current) {
        if (!isContentDrag(gesture)) return;
        armContent(gesture);
      }
      move(event, gesture);
    };
    const contentRelease = (event: ReactNative.GestureResponderEvent, gesture: GestureState) => {
      if (armedRef.current) release(event, gesture);
    };
    const contentTerminate = () => {
      if (armedRef.current) terminate();
    };

    return {
      grabber: panResponderApi.create({
        // Claimed on touch-down, not on the first qualifying move.
        //
        // The grabber is a dedicated strip above the sheet's content, so
        // taking the touch at once costs nothing: a touch that turns out not
        // to be a drag simply springs back.
        onStartShouldSetPanResponder: () => enabledRef.current,
        onMoveShouldSetPanResponder: (_event, gesture) => isDownwardDrag(gesture),
        onPanResponderGrant: (_event, gesture) => {
          grantOffsetRef.current = gesture.dy;
        },
        onPanResponderMove: move,
        onPanResponderRelease: release,
        onPanResponderTerminate: terminate,
      }),
      content: panResponderApi.create({
        // Two ways in. A touch nothing below wanted — a title, a gap — is
        // taken on touch-down, because inside a React Native `Modal` on
        // Android a view that declines the start phase is never offered the
        // move phase at all (verified on the emulator: a pull that began on
        // the create menu's subtitle went nowhere until this). It arrives
        // unarmed, so taking it costs the tap nothing. Buttons, fields and
        // lists are deeper and take their own touches first. A native view
        // with controls of its own, a player, is deeper too, and nothing may
        // hold its touch for JS: held, Android cancels the player's buttons
        // at the finger's first movement, and a touch on its seek bar is
        // never let go. So its view stops the question before the panel is
        // asked (see leaveTouchToNativeView), and the panel leaves that touch
        // whenever it is asked about it.
        onStartShouldSetPanResponder: (event) => enabledRef.current && takesTouchDownRef.current && !touchBelongsToNativeView(event),
        // The other way in: a touch a child already holds. Asked in the
        // capture phase, so the panel comes before the pressed child;
        // `Pressable` yields (its `cancelable` defaults to true) and receives
        // a terminate instead of a press. This one arrives armed.
        //
        // A player's touch is held by nothing, so the panel is asked about it
        // at every move, and a finger that slides down on the play button as
        // it presses reads as a pull. That touch is the player's still.
        onMoveShouldSetPanResponderCapture: (event, gesture) => isContentDrag(gesture) && !touchBelongsToNativeView(event),
        onMoveShouldSetPanResponder: (event, gesture) => isContentDrag(gesture) && !touchBelongsToNativeView(event),
        onPanResponderGrant: contentGrant,
        onPanResponderMove: contentMove,
        onPanResponderRelease: contentRelease,
        onPanResponderTerminate: contentTerminate,
        // Once the sheet is following the finger nothing inside it gets to
        // take the touch back.
        onPanResponderTerminationRequest: () => armedRef.current === false,
      }),
    };
  }, [dragY]);

  const scrollProps = useMemo<SheetScrollProps>(() => ({
    bounces: false,
    overScrollMode: 'never',
    scrollEventThrottle: 16,
    onScroll: (event) => {
      scrollOffsetRef.current = event.nativeEvent.contentOffset.y;
    },
  }), []);

  const backdropOpacity = useMemo(() => (
    dragY && typeof dragY.interpolate === 'function'
      ? dragY.interpolate({
          inputRange: [0, SHEET_BACKDROP_FADE_DISTANCE],
          outputRange: [1, 0],
          extrapolate: 'clamp',
        })
      : null
  ), [dragY]);

  return {
    panHandlers: responders?.grabber.panHandlers ?? {},
    contentPanHandlers: responders?.content.panHandlers ?? {},
    scrollProps,
    dragStyle: dragY ? ({ transform: [{ translateY: dragY }] } as AnimatedViewStyle) : undefined,
    backdropStyle: backdropOpacity ? ({ opacity: backdropOpacity } as AnimatedViewStyle) : undefined,
    translateY: dragY,
    backdropOpacity,
    onDismiss,
  };
}

function createOffset() {
  const Value = animatedApi?.Value;
  return Value ? new Value(0) : null;
}

function springBack(dragY: ReactNative.Animated.Value | null) {
  if (!dragY || !animatedApi?.spring) {
    dragY?.setValue(0);
    return;
  }
  // These were the literals 190/13 — numerically the theme's tension/friction,
  // copied by hand. At a damping ratio near 0.47 they also overshot, which on a
  // bottom-anchored sheet lifts it off the screen edge on the way back.
  animatedApi.spring(dragY, {
    toValue: 0,
    useNativeDriver: true,
    ...appTheme.motion.spring.panel,
  }).start();
}

/**
 * The entrance and exit of a sheet that is not hosted by a `Modal`.
 *
 * A Modal animates its own arrival. A sheet rendered through `OverlayHost` gets
 * nothing for free and used to pop into place — the action sheet did — which
 * is the one thing a sheet must not do: Sheets exist to "help people perform a
 * scoped task" without losing their place, and a surface that appears with no
 * travel reads as a page change. The panel slides its own measured height, and
 * the caller keeps rendering until `rendered` is false so the exit can play.
 *
 * Every opening waits for the panel to be laid out before it starts. The slide
 * is drawn on the main thread, which is also where the sheet's views are
 * built, and a slide begun while they were still being built lost its first
 * frames to them: the model picker's sixteen rows took 49 to 133 ms out of a
 * 300 ms entrance, where the same sheet with no rows was drawn from 15 ms in
 * (Pixel 9a emulator films, 2026-10-05). Waiting spends that time before the
 * sheet moves instead, which is what a Modal did: its window is built, then
 * slid in by the system. It also means the height is this opening's own, for
 * a sheet that is not always as tall as it was last time.
 *
 * How far the closed panel sits below its place is an animated value of its
 * own, not a number rendered into the transform. Until the panel has been
 * measured the value is far below the screen, and it is set from the layout
 * event itself, which puts it on the native side in the same queue as the
 * slide's start and ahead of it. It used to be an interpolation rebuilt by the
 * render that followed the measurement, whose first range was the slop alone:
 * the slide's start could reach the native side a frame or two before the new
 * interpolation did, and for those frames the whole sheet was drawn at its
 * resting place, then jumped below the screen and slid in.
 */
export function useSheetPresentation({
  visible,
  reducedMotion,
  onEntered,
  onExited,
}: {
  visible: boolean;
  reducedMotion: boolean;
  /**
   * The entrance has played and the sheet is at rest. For what must not be
   * built while it travels: the slide is drawn on the main thread, and work
   * done there in the same moment is taken out of its first frames.
   */
  onEntered?: () => void;
  onExited?: () => void;
}) {
  const [rendered, setRendered] = useState(visible);
  // Whether the panel now on screen has been laid out. Asked again at every opening.
  const [measured, setMeasured] = useState(false);
  const progress = useRef(animatedApi?.Value ? new animatedApi.Value(visible ? 1 : 0) : null).current;
  const hiddenOffset = useRef(animatedApi?.Value ? new animatedApi.Value(SHEET_UNMEASURED_OFFSET) : null).current;
  const onEnteredRef = useRef(onEntered);
  onEnteredRef.current = onEntered;
  const onExitedRef = useRef(onExited);
  onExitedRef.current = onExited;

  useEffect(() => {
    if (visible) setRendered(true);
  }, [visible]);

  useEffect(() => {
    if (!rendered) return;
    if (visible && !measured) return;

    const finish = () => {
      if (visible) {
        onEnteredRef.current?.();
        return;
      }
      setRendered(false);
      // The panel is unmounted with this: the next one waits out of sight for its own layout.
      setMeasured(false);
      hiddenOffset?.setValue(SHEET_UNMEASURED_OFFSET);
      onExitedRef.current?.();
    };

    if (!progress || !animatedApi?.timing || reducedMotion) {
      progress?.setValue(visible ? 1 : 0);
      finish();
      return;
    }

    const animation = animatedApi.timing(progress, {
      toValue: visible ? 1 : 0,
      duration: visible ? SHEET_ENTER_DURATION : SHEET_EXIT_DURATION,
      easing: easingApi
        ? (visible ? easingApi.out(easingApi.cubic) : easingApi.in(easingApi.cubic))
        : undefined,
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (finished) finish();
    });

    return () => animation.stop();
  }, [hiddenOffset, measured, progress, reducedMotion, rendered, visible]);

  const onPanelLayout = useCallback((event: ReactNative.LayoutChangeEvent) => {
    // Every layout, not the first alone: the keyboard shortens a panel and a
    // step can change what it holds, and the exit travels the height it has then.
    hiddenOffset?.setValue(event.nativeEvent.layout.height + SHEET_HIDDEN_SLOP);
    setMeasured(true);
  }, [hiddenOffset]);

  // One node each for as long as the sheet lives: a node made again by a render
  // has to be connected again on the native side, and the slide does not wait for that.
  const entryTranslateY = useMemo(() => (
    progress && hiddenOffset && animatedApi?.multiply
      ? animatedApi.multiply(progress.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }), hiddenOffset)
      : 0
  ), [hiddenOffset, progress]);
  // The scrim reaches full strength by the time the panel is 60% of the way
  // in, so the sheet settles onto an already-dimmed screen rather than
  // darkening the world as it arrives.
  const backdropProgress = useMemo(() => (
    progress
      ? progress.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0, 1, 1] })
      : 1
  ), [progress]);

  return {
    /** Keep the sheet in the tree while this is true; it turns false once the exit has played. */
    rendered,
    /** Fold into the panel's transform, added to the drag offset. No cross-fade: the travel carries the entrance on its own. */
    entryTranslateY,
    backdropProgress,
    onPanelLayout,
  };
}

/**
 * A hosted sheet's entrance and its drag as the one transform a panel can take
 * and the one opacity a scrim can: a JS-driven value beside a native-driven one
 * on the same view does not compose, so the two are added and multiplied
 * instead. `panel` goes on the `SheetPanel`, `backdrop` on the `SheetBackdrop`.
 */
export function sheetMotion(drag: SheetDismissDrag, presentation: ReturnType<typeof useSheetPresentation>) {
  const translateY = drag.translateY && animatedApi?.add && typeof presentation.entryTranslateY !== 'number'
    ? animatedApi.add(presentation.entryTranslateY, drag.translateY)
    : presentation.entryTranslateY;
  const backdropOpacity = drag.backdropOpacity && animatedApi?.multiply && typeof presentation.backdropProgress !== 'number'
    ? animatedApi.multiply(presentation.backdropProgress, drag.backdropOpacity)
    : presentation.backdropProgress;

  return {
    panel: { transform: [{ translateY }] } as AnimatedViewStyle,
    backdrop: { opacity: backdropOpacity } as AnimatedViewStyle,
  };
}

/**
 * The pill at the top of a sheet, and the area you actually grab.
 *
 * The target is the full width and much taller than the 4pt pill — a 4pt target
 * would be unusable, and the whole strip reads as draggable to anyone who has
 * used a sheet before.
 *
 * A plain `View`, and that is load-bearing: `Pressable` renders
 * `{...restProps}` and then `{...eventHandlers}` from its own Pressability, so
 * spread pan handlers are overwritten by its responder and never fire. The
 * creator sheets' `SheetDragHandle` was built that way and its swipe-to-dismiss
 * had never worked — a `Pressable` with a dead `panHandlers` spread, which no
 * unit test can see. Dragging is the only gesture here: tapping a grabber
 * cycles detents on iOS, it does not dismiss, and every sheet already offers a
 * Close button or a labelled backdrop.
 *
 * Deliberately not an accessibility element, for the same reason: Gestures asks
 * that a shortcut gesture never be the only way to perform an action, and each
 * of those labelled controls already answers it. A second focus stop reading
 * "Close model picker" next to the button that says so is noise, not access.
 */
export function SheetGrabber({ drag }: { drag: SheetDismissDrag }) {
  const theme = useAppTheme();
  return (
    <ReactNative.View
      {...drag.panHandlers}
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      collapsable={false}
      style={{ paddingVertical: GRABBER_TARGET_PADDING, alignItems: 'center' }}
    >
      <ReactNative.View
        style={{
          width: GRABBER_WIDTH,
          height: GRABBER_HEIGHT,
          borderRadius: GRABBER_HEIGHT / 2,
          backgroundColor: theme.colors.borderStrong,
        }}
      />
    </ReactNative.View>
  );
}

/**
 * The panel view a sheet draws its content in, so the drag can move it.
 *
 * Resolved here rather than imported from `lib/motion` so a focused test that
 * mocks that module cannot leave it undefined: the fallback chain is the same
 * one `MotionView` uses.
 */
const AnimatedView = (
  optionalNativeExport(() => ReactNative.Animated.View)
  ?? optionalNativeExport(() => ReactNative.View)
  ?? (({ children }: { children?: React.ReactNode }) => children ?? null)
) as typeof ReactNative.Animated.View;

export const SheetPanel = AnimatedView;

/**
 * The shape every sheet panel shares: the rounded top, the hairline that lifts
 * it off the scrim, the panel colour. A function rather than a constant so the
 * theme is read when a sheet renders, not when this module loads under a test
 * that mocks the theme down to a few colours.
 */
export function sheetPanelStyle(colors: ThemeColors): ReactNative.ViewStyle {
  return {
    borderTopLeftRadius: appTheme.radii.xl,
    borderTopRightRadius: appTheme.radii.xl,
    borderCurve: 'continuous',
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: colors.borderStrong,
    backgroundColor: colors.panel,
  };
}

/**
 * The scrim behind a sheet, and the tap-outside that dismisses it.
 *
 * It fades as the sheet is pulled down, so the drag reads as one motion —
 * surface leaving, world returning — instead of a panel sliding over a
 * scrim that stays put until it vanishes. Without `label` the tap is a plain
 * shortcut and not a focus stop: use that only where the panel already carries
 * a labelled Close button, so VoiceOver still has an obvious way out.
 */
export function SheetBackdrop({
  drag,
  onPress,
  label,
  color,
  style,
}: {
  drag: SheetDismissDrag;
  onPress: () => void;
  label?: string;
  /** Defaults to the scheme's scrim; a sheet over darker media may pass its own. */
  color?: string;
  /** In place of the drag's own fade: a hosted sheet passes `sheetMotion(…).backdrop`, its entrance and the drag as one. */
  style?: AnimatedViewStyle;
}) {
  const theme = useAppTheme();
  return (
    <AnimatedView
      style={[{ position: 'absolute', inset: 0, backgroundColor: color ?? theme.colors.scrim }, style ?? drag.backdropStyle]}
    >
      {NativePressable ? (
        label ? (
          <NativePressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={{ flex: 1 }} />
        ) : (
          <NativePressable accessible={false} onPress={onPress} style={{ flex: 1 }} />
        )
      ) : null}
    </AnimatedView>
  );
}
