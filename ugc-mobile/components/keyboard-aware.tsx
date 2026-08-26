import { useEffect } from 'react';
import * as ReactNative from 'react-native';
import Animated, {
  useAnimatedKeyboard,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { getKeyboardLift } from '@/lib/keyboard';

/**
 * Keyboard avoidance that tracks the keyboard frame every frame.
 *
 * The pattern this replaces — `Keyboard.addListener('keyboardDidShow')` — only
 * fires once the keyboard has finished animating, so content snapped into place
 * after the fact. Apple's keyboard layout guide moves the interface *with* the
 * keyboard, and that difference is most of why a form feels native rather than
 * bolted on.
 *
 * `useAnimatedKeyboard` carries a deprecation notice pointing at
 * react-native-keyboard-controller. That library is a native module and would
 * force a dev-client rebuild; this hook is warning-free at runtime (the notice
 * is a JSDoc tag) and drives the same WindowInsetsAnimation on Android and
 * keyboard notifications on iOS. Revisit at the next native build.
 *
 * No Android translucency options are passed: this app renders edge-to-edge
 * (react-native-is-edge-to-edge is installed), and Reanimated ignores
 * `isStatusBarTranslucentAndroid` / `isNavigationBarTranslucentAndroid` in that
 * mode — it warns about them on every launch. Edge-to-edge already reports the
 * full inset, which is what the measurements on device confirmed.
 */

/** Matches the system keyboard closely enough that the two sources agree mid-flight. */
const FALLBACK_KEYBOARD_DURATION = 250;

/**
 * Focused component tests mock react-native down to the handful of exports they
 * render, and reading a missing one off the mock namespace throws rather than
 * yielding undefined — so these reads are guarded, same as `lib/motion`.
 */
function optionalNativeExport<T>(read: () => T) {
  try {
    return read();
  } catch {
    return undefined;
  }
}

const keyboardApi = optionalNativeExport(() => ReactNative.Keyboard);
const platformApi = optionalNativeExport(() => ReactNative.Platform);

/**
 * Back-stop for surfaces the animated tracker cannot see.
 *
 * `useAnimatedKeyboard` reads the activity window's insets, which a few hosts
 * do not share. Callers take the larger of the two sources, so wherever the
 * animated tracker works it wins outright and this contributes nothing.
 *
 * It does not rescue an Android `Modal`: that window receives neither the
 * insets nor these JS events — both were measured returning nothing from inside
 * one. See the note in comments-sheet for what actually fixes that case.
 *
 * Deliberately not gated on Reduce Motion, unlike every other animation in the
 * app. That preference governs the app's own motion, not the system keyboard,
 * which slides in regardless; snapping the content while the keys animate
 * underneath would read as a glitch rather than as calm.
 */
function useKeyboardFallbackHeight() {
  const fallback = useSharedValue(0);

  useEffect(() => {
    if (!keyboardApi?.addListener) return;

    // iOS reports `will` events ahead of the animation with a matching
    // duration; Android only offers `did`, after the fact.
    const isIos = platformApi?.OS === 'ios';
    const showEvent = isIos ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = isIos ? 'keyboardWillHide' : 'keyboardDidHide';

    const show = keyboardApi.addListener(showEvent, (event) => {
      fallback.value = withTiming(event.endCoordinates.height, {
        duration: event.duration || FALLBACK_KEYBOARD_DURATION,
      });
    });
    const hide = keyboardApi.addListener(hideEvent, (event) => {
      fallback.value = withTiming(0, {
        duration: event?.duration || FALLBACK_KEYBOARD_DURATION,
      });
    });

    return () => {
      show.remove();
      hide.remove();
    };
  }, [fallback]);

  return fallback;
}

export const KEYBOARD_AVOIDING_AREA_TEST_ID = 'keyboard-avoiding-area';

/**
 * Shrinks its own height by the keyboard, so whatever it wraps — usually a
 * ScrollView — ends above the keys rather than behind them.
 *
 * Shrinking the viewport rather than padding the content is the part that
 * matters. Extra bottom padding makes the covered region *reachable*, but
 * nothing *moves* the focused field, so a field near the end of a form stays
 * hidden while you type into it. A shorter viewport reproduces what
 * `android:windowSoftInputMode="adjustResize"` used to do for free: the
 * platform scrolls the focused input back into view. Android 15's forced
 * edge-to-edge stopped resizing the window, which is why forms began typing
 * blind, and iOS never resized the window in the first place.
 */
export function KeyboardAvoidingArea({
  children,
  reservedBottomInset = 0,
  iosScrollViewAdjustsInsets = false,
  style,
  testID = KEYBOARD_AVOIDING_AREA_TEST_ID,
}: {
  children: React.ReactNode;
  /** Bottom inset already excluded from this area, if it stops short of the screen edge. */
  reservedBottomInset?: number;
  /**
   * Set when the wrapped ScrollView carries `automaticallyAdjustKeyboardInsets`,
   * which is how iOS scrolls a focused field back into view.
   *
   * The two mechanisms cancel rather than combine: that prop measures the
   * keyboard's overlap with the scroll view's *frame*, so a frame already
   * shrunk clear of the keyboard reports no overlap and iOS does nothing —
   * leaving the focused field hidden. Android is the reverse and needs the
   * shrink, so the platforms take different halves.
   */
  iosScrollViewAdjustsInsets?: boolean;
  style?: React.ComponentProps<typeof Animated.View>['style'];
  /** Stable handle for tests asserting a surface gives way to the keyboard. */
  testID?: string;
}) {
  const keyboard = useAnimatedKeyboard();
  const fallback = useKeyboardFallbackHeight();
  const deferToNativeInsets = iosScrollViewAdjustsInsets && platformApi?.OS === 'ios';

  const areaStyle = useAnimatedStyle(() => ({
    paddingBottom: deferToNativeInsets
      ? 0
      : getKeyboardLift({
        keyboardHeight: Math.max(keyboard.height.value, fallback.value),
        reservedBottomInset,
      }),
  }));

  return (
    <Animated.View testID={testID} style={[{ flex: 1 }, style, areaStyle]}>
      {children}
    </Animated.View>
  );
}

type LiftOptions = {
  /** Inset the bar already clears when the keyboard is closed. */
  reservedBottomInset?: number;
};

export function useKeyboardLiftStyle({ reservedBottomInset = 0 }: LiftOptions = {}) {
  const keyboard = useAnimatedKeyboard();
  const fallback = useKeyboardFallbackHeight();

  return useAnimatedStyle(() => ({
    transform: [
      {
        translateY: -getKeyboardLift({
          keyboardHeight: Math.max(keyboard.height.value, fallback.value),
          reservedBottomInset,
        }),
      },
    ],
  }));
}

/**
 * Wraps a bottom-pinned bar — a composer, a sticky submit — so it rides on top
 * of the keyboard instead of being buried by it. Use this rather than
 * `KeyboardAvoidingArea` when the element is absolutely positioned and so has
 * no height of its own to give up.
 */
export function KeyboardLift({
  children,
  reservedBottomInset = 0,
  style,
}: LiftOptions & {
  children: React.ReactNode;
  style?: React.ComponentProps<typeof Animated.View>['style'];
}) {
  const liftStyle = useKeyboardLiftStyle({ reservedBottomInset });

  return <Animated.View style={[style, liftStyle]}>{children}</Animated.View>;
}
