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
