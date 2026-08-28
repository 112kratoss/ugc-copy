import { useEffect, useMemo, useRef } from 'react';
import * as ReactNative from 'react-native';

import { appTheme } from '@/lib/theme';

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

// The pill's own geometry, and the target around it. Not spacing tokens: this
// is the shape of one control, the way `hit-target` owns its own floor.
const GRABBER_WIDTH = 42;
const GRABBER_HEIGHT = 4;
const GRABBER_TARGET_PADDING = 8;

type AnimatedViewStyle = ReactNative.Animated.WithAnimatedValue<ReactNative.ViewStyle>;

export interface SheetDismissDrag {
  panHandlers: Partial<ReactNative.GestureResponderHandlers>;
  /** Spread onto the sheet panel — a `MotionView` — so it tracks the finger. */
  dragStyle: AnimatedViewStyle | undefined;
  /**
   * The raw offset, for a panel that already composes its own transform and
   * has to fold this into it (`Animated.add`) rather than append a second one.
   */
  translateY: ReactNative.Animated.Value | null;
  onDismiss: () => void;
}

export function useSheetDismissDrag({
  onDismiss,
  visible = true,
  enabled = true,
}: {
  onDismiss: () => void;
  /**
   * Pass it when the sheet stays mounted while closed. A sheet dismissed by
   * drag leaves the offset where the finger let go, which is right for the exit
   * and wrong for the next opening.
   */
  visible?: boolean;
  enabled?: boolean;
}): SheetDismissDrag {
  const Value = animatedApi?.Value;
  const dragY = useRef(Value ? new Value(0) : null).current;

  // Read through refs: the responder is created once and would otherwise
  // capture the first render's close handler forever.
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    if (visible) dragY?.setValue(0);
  }, [dragY, visible]);

  const responder = useMemo(() => panResponderApi?.create({
    // Claimed on touch-down, not on the first qualifying move.
    //
    // Inside a React Native `Modal` — which is a separate window — a view that
    // declines the touch at the start phase never receives the move phase at
    // all: verified on the emulator, where `onStartShouldSet*` fired on the
    // grabber and `onMoveShouldSet*` never did, while the same grabber hosted
    // through `OverlayHost` received both. Four of the app's sheets are Modals,
    // so waiting for the move means their swipe never runs.
    //
    // Claiming the start is safe here in a way it would not be on a general
    // surface: the grabber is a dedicated strip above the sheet's content, and
    // a touch that turns out not to be a drag simply springs back.
    onStartShouldSetPanResponder: () => enabledRef.current,
    onMoveShouldSetPanResponder: (_event, gesture) => (
      enabledRef.current
      && gesture.dy > SHEET_DRAG_CLAIM_DISTANCE
      && Math.abs(gesture.dy) > Math.abs(gesture.dx)
    ),
    onPanResponderMove: (_event, gesture) => {
      dragY?.setValue(Math.max(0, gesture.dy));
    },
    onPanResponderRelease: (_event, gesture) => {
      if (gesture.vy > SHEET_DISMISS_VELOCITY || gesture.dy > SHEET_DISMISS_DISTANCE) {
        onDismissRef.current();
        return;
      }
      springBack(dragY);
    },
    onPanResponderTerminate: () => {
      dragY?.setValue(0);
    },
  }), [dragY]);

  return {
    panHandlers: responder?.panHandlers ?? {},
    dragStyle: dragY ? ({ transform: [{ translateY: dragY }] } as AnimatedViewStyle) : undefined,
    translateY: dragY,
    onDismiss,
  };
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
          backgroundColor: appTheme.colors.borderStrong,
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
export const SheetPanel = (
  optionalNativeExport(() => ReactNative.Animated.View)
  ?? optionalNativeExport(() => ReactNative.View)
  ?? (({ children }: { children?: React.ReactNode }) => children ?? null)
) as typeof ReactNative.Animated.View;
