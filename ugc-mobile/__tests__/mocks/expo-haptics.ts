/**
 * Test double for `expo-haptics`. The real package imports `expo-modules-core`
 * from a path vitest cannot resolve, and haptics are fire-and-forget anyway.
 * Aliased globally in vitest.config.ts; suites that need to observe calls still
 * `vi.mock('expo-haptics', factory)` as before.
 */
export const ImpactFeedbackStyle = {
  Light: 'light',
  Medium: 'medium',
  Heavy: 'heavy',
  Soft: 'soft',
  Rigid: 'rigid',
} as const;

export const NotificationFeedbackType = {
  Success: 'success',
  Warning: 'warning',
  Error: 'error',
} as const;

export async function selectionAsync() {}
export async function impactAsync() {}
export async function notificationAsync() {}

/** Mirrors the real enum; haptics.test.ts checks it against the package source. */
export const AndroidHaptics = {
  Confirm: 'confirm',
  Reject: 'reject',
  Gesture_Start: 'gesture-start',
  Gesture_End: 'gesture-end',
  Toggle_On: 'toggle-on',
  Toggle_Off: 'toggle-off',
  Clock_Tick: 'clock-tick',
  Context_Click: 'context-click',
  Drag_Start: 'drag-start',
  Keyboard_Tap: 'keyboard-tap',
  Keyboard_Press: 'keyboard-press',
  Keyboard_Release: 'keyboard-release',
  Long_Press: 'long-press',
  Virtual_Key: 'virtual-key',
  Virtual_Key_Release: 'virtual-key-release',
  No_Haptics: 'no-haptics',
  Segment_Tick: 'segment-tick',
  Segment_Frequent_Tick: 'segment-frequent-tick',
  Text_Handle_Move: 'text-handle-move',
} as const;

export async function performAndroidHapticsAsync() {}
