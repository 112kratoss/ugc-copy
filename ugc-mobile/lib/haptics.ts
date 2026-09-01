import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

/**
 * Touch feedback vocabulary. Every entry is fire-and-forget and swallows
 * platform errors, so call sites never await or guard them: the simulator,
 * the web target and focused tests all lack the native module.
 *
 * Fire these from `onPress` (a confirmed tap), never from `onPressIn` —
 * inside a scrolling list press-in fires on every touch-down, including the
 * ones that turn into scrolls, and a tick on each of those reads as noise.
 *
 * The split mirrors what the feedback means, not how strong it is:
 * - `select`  a discrete choice changed: tabs, chips, toggles, segments.
 * - `light`   something opened or arrived: cards, tiles, pull-to-refresh.
 * - `soft`    a page snapped into place while browsing; quiet enough to repeat.
 * - `medium`  a primary commitment: the create button, publish, send.
 * - `success` / `error`  the outcome of something the user waited for.
 */
export type HapticKind = 'select' | 'light' | 'soft' | 'medium' | 'success' | 'error';

function fire(run: () => Promise<void>) {
  try {
    void run().catch(() => undefined);
  } catch {
    // Module or enum missing (tests, web): feedback is optional by design.
  }
}

/** iOS: UIKit's feedback generators, which are the Taptic Engine's own transients. */
const FEEDBACK_GENERATORS: Record<HapticKind, () => Promise<void>> = {
  select: () => Haptics.selectionAsync(),
  light: () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light),
  soft: () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft),
  medium: () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium),
  success: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
  error: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error),
};

type AndroidEffect = keyof typeof Haptics.AndroidHaptics;

type AndroidPick =
  | { effect: AndroidEffect }
  /** `effect` arrived with API level `since`; below it the module rejects, so play `fallback`. */
  | { effect: AndroidEffect; since: number; fallback: AndroidEffect };

/**
 * Android does not get the generators above. expo-haptics plays them there as
 * raw vibrator waveforms (a selection is 50 ms at 30/255 amplitude) and on a
 * phone's actuator that is a hum that ramps up and down, not a transient: the
 * same taps read as long and plain next to the iPhone. The OS haptic constants
 * resolve instead to the effects the OEM tuned for that actuator, the system
 * keyboard's tap and a toggle's tick, so Android routes through those.
 *
 * On stock Android: Segment_Tick and Context_Click play EFFECT_TICK, Clock_Tick
 * the lighter EFFECT_TEXTURE_TICK (fine to repeat), Confirm and Virtual_Key
 * EFFECT_CLICK, Reject EFFECT_DOUBLE_CLICK, Long_Press EFFECT_HEAVY_CLICK. This
 * route also honours the phone's touch-feedback setting, which the waveforms
 * ignored.
 *
 * Constants arrive with the OS (Confirm and Reject on Android 11, API 30;
 * Segment_Tick on Android 14, API 34) and expo-haptics resolves them by
 * reflection, rejecting on a phone that lacks one. `fire` swallows that
 * rejection, so an ungated pick would fail *silently* on older phones: every
 * gated entry names a fallback the module resolves on every API level, and
 * haptics.test.ts holds it to the module's own always-available list.
 */
export const ANDROID_EFFECTS: Record<HapticKind, AndroidPick> = {
  select: { effect: 'Segment_Tick', since: 34, fallback: 'Context_Click' },
  light: { effect: 'Context_Click' },
  soft: { effect: 'Clock_Tick' },
  medium: { effect: 'Confirm', since: 30, fallback: 'Virtual_Key' },
  success: { effect: 'Confirm', since: 30, fallback: 'Virtual_Key' },
  error: { effect: 'Reject', since: 30, fallback: 'Long_Press' },
};

function androidEffect(kind: HapticKind) {
  const pick = ANDROID_EFFECTS[kind];
  // Platform.Version is the API level on Android and a string elsewhere.
  const apiLevel = typeof Platform.Version === 'number' ? Platform.Version : 0;
  const name = 'since' in pick && apiLevel < pick.since ? pick.fallback : pick.effect;
  // Read per call, not at module scope: focused suites mock expo-haptics
  // without the enum, and `fire` is what turns that into a no-op.
  return Haptics.AndroidHaptics[name];
}

function play(kind: HapticKind) {
  if (Platform.OS === 'android') {
    return Haptics.performAndroidHapticsAsync(androidEffect(kind));
  }
  return FEEDBACK_GENERATORS[kind]();
}

export const haptic: Record<HapticKind, () => void> = {
  select: () => fire(() => play('select')),
  light: () => fire(() => play('light')),
  soft: () => fire(() => play('soft')),
  medium: () => fire(() => play('medium')),
  success: () => fire(() => play('success')),
  error: () => fire(() => play('error')),
};
