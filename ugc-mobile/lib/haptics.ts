import * as Haptics from 'expo-haptics';

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
function fire(run: () => Promise<void>) {
  try {
    void run().catch(() => undefined);
  } catch {
    // Module or enum missing (tests, web): feedback is optional by design.
  }
}

export const haptic = {
  select: () => fire(() => Haptics.selectionAsync()),
  light: () => fire(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)),
  soft: () => fire(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft)),
  medium: () => fire(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)),
  success: () => fire(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),
  error: () => fire(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)),
} as const;

export type HapticKind = keyof typeof haptic;
