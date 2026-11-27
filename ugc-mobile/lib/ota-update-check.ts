/**
 * When the app asks the update server again after launch, kept free of expo-updates and
 * react-native so it can be tested directly (audit 2026-11-27, finding 2).
 *
 * expo-updates checks only at a cold start, so a shipped fix reached a phone that is never quit
 * only at its next cold start. `use-ota-update-gate` now asks again when the app returns from a
 * long absence and fetches what the server has; the gate then applies it as it applies any
 * downloaded update (`app-update-policy.ts`).
 */

import { FOREGROUND_RELOAD_THRESHOLD_MS } from './app-update-policy';

/** At most one check in this long, however often the app comes back. */
export const OTA_CHECK_MIN_INTERVAL_MS = 15 * 60 * 1000;

/**
 * How long after a return a fetched update may still reload as if at the return. A download that
 * lands later is left for the next return or cold start: by then someone is using the app.
 */
export const FETCHED_UPDATE_APPLY_WINDOW_MS = 20 * 1000;

export type UpdateCheckContext = {
  /** `Updates.isEnabled`: false in Expo Go and the dev client, where expo-updates is inert. */
  enabled: boolean;
  isUpdatePending: boolean;
  checking: boolean;
  /** A generation, upload or purchase in flight (`app-activity.ts`). */
  hasActiveWork: boolean;
  backgroundedForMs: number;
  lastCheckAtMs: number | null;
  nowMs: number;
};

export function shouldCheckForUpdateOnReturn(context: UpdateCheckContext): boolean {
  if (!context.enabled || context.isUpdatePending || context.checking || context.hasActiveWork) return false;
  if (context.backgroundedForMs < FOREGROUND_RELOAD_THRESHOLD_MS) return false;
  return context.lastCheckAtMs === null || context.nowMs - context.lastCheckAtMs >= OTA_CHECK_MIN_INTERVAL_MS;
}

type UpdatesModule = {
  checkForUpdateAsync: () => Promise<{ isAvailable: boolean }> | { isAvailable: boolean };
  fetchUpdateAsync: () => Promise<unknown> | unknown;
};

/** Asks the server and downloads a new update. Never rejects: a failure leaves the cold start's. */
export async function checkAndFetchUpdate(updates: UpdatesModule): Promise<'fetched' | 'none' | 'failed'> {
  try {
    const check = await updates.checkForUpdateAsync();
    if (!check?.isAvailable) return 'none';
    await updates.fetchUpdateAsync();
    return 'fetched';
  } catch {
    return 'failed';
  }
}

/**
 * The absence the gate decides by. An update that was already waiting when the app came back
 * keeps the whole absence (the gate's rule as it was); one that arrived after the return keeps it
 * only within `FETCHED_UPDATE_APPLY_WINDOW_MS` of the return.
 */
export function effectiveBackgroundedForMs({
  backgroundedForMs,
  pendingAtReturn,
  returnedAtMs,
  nowMs,
}: {
  backgroundedForMs: number;
  pendingAtReturn: boolean;
  returnedAtMs: number | null;
  nowMs: number;
}): number {
  if (pendingAtReturn || returnedAtMs === null) return backgroundedForMs;
  return nowMs - returnedAtMs <= FETCHED_UPDATE_APPLY_WINDOW_MS ? backgroundedForMs : 0;
}
