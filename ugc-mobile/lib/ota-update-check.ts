/**
 * When the app asks the update server again after launch, kept free of expo-updates and
 * react-native so it can be tested directly (audit 2026-11-27, finding 2).
 *
 * expo-updates checks only at a cold start, so a shipped fix reached a phone that is never quit
 * only at its next cold start. `use-ota-update-gate` now asks again when the app returns from a
 * long absence and downloads what the server has. It never reloads for it: someone may have begun
 * typing since the return, and nothing but a purchase, a run or an upload holds a reload back. The
 * gate applies the download at the next long return or cold start (`app-update-policy.ts`).
 */

import { FOREGROUND_RELOAD_THRESHOLD_MS } from './app-update-policy';

/** At most one check in this long, however often the app comes back. */
export const OTA_CHECK_MIN_INTERVAL_MS = 15 * 60 * 1000;

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
 * keeps the whole absence (the gate's rule as it was); one that arrived after the return, which is
 * what the check downloads, reads as no absence, and waits for the next long return.
 */
export function effectiveBackgroundedForMs({
  backgroundedForMs,
  pendingAtReturn,
  returnedAtMs,
}: {
  backgroundedForMs: number;
  pendingAtReturn: boolean;
  returnedAtMs: number | null;
}): number {
  if (pendingAtReturn || returnedAtMs === null) return backgroundedForMs;
  return 0;
}
