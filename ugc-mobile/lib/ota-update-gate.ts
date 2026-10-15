/**
 * The bookkeeping behind the OTA update gate, kept free of expo-updates and
 * react-native so it can be tested directly.
 *
 * `use-ota-update-gate` holds the native bindings and the effects; everything
 * here is the part that is easy to get subtly wrong — how long the app was
 * away, and whether this update was actually flagged critical.
 */

import type { MobileCriticalUpdate } from './types';

/** Mirrors react-native's AppStateStatus without importing it. */
export type AppLifecycleState = 'active' | 'background' | 'inactive' | 'extension' | 'unknown';

/**
 * The publisher's own mark: `extra.critical` in the manifest, set at publish
 * time. Kept as a second source beside the server's list below. Anything other
 * than a literal `true` is routine — a typo in a publish command must not earn
 * the right to interrupt someone.
 */
export function readCriticalFlag(update: unknown): boolean {
  if (!update || typeof update !== 'object') return false;
  const manifest = (update as { manifest?: unknown }).manifest;
  if (!manifest || typeof manifest !== 'object') return false;
  const extra = (manifest as { extra?: unknown }).extra;
  if (!extra || typeof extra !== 'object') return false;
  return (extra as { critical?: unknown }).critical === true;
}

/** When the update was published, from expo-updates' `createdAt` or the manifest's. */
function readUpdateCreatedAtMs(update: object): number | null {
  const manifest = (update as { manifest?: unknown }).manifest;
  const candidates = [
    (update as { createdAt?: unknown }).createdAt,
    manifest && typeof manifest === 'object' ? (manifest as { createdAt?: unknown }).createdAt : undefined,
  ];
  for (const candidate of candidates) {
    const ms = candidate instanceof Date
      ? candidate.getTime()
      : typeof candidate === 'string' ? Date.parse(candidate) : Number.NaN;
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

/**
 * The server's lever (`criticalUpdate` on `/api/app-version`, audit 04-9): an
 * update is critical when the runtime its manifest names is on the server's
 * list and it was published at or after `publishedAfter`. The one publish path
 * cannot set `extra.critical`, so this is the flag an operator can actually
 * raise. A rollback directive carries no manifest and never qualifies, and an
 * answer that cannot be read leaves the update routine.
 */
export function isFlaggedCriticalByServer(
  update: unknown,
  criticalUpdate: MobileCriticalUpdate | null | undefined,
): boolean {
  if (!criticalUpdate || !Array.isArray(criticalUpdate.runtimeVersions)) return false;
  if (!update || typeof update !== 'object') return false;
  const manifest = (update as { manifest?: unknown }).manifest;
  if (!manifest || typeof manifest !== 'object') return false;
  const runtimeVersion = (manifest as { runtimeVersion?: unknown }).runtimeVersion;
  if (typeof runtimeVersion !== 'string' || !criticalUpdate.runtimeVersions.includes(runtimeVersion)) return false;
  const publishedAfterMs = typeof criticalUpdate.publishedAfter === 'string'
    ? Date.parse(criticalUpdate.publishedAfter)
    : Number.NaN;
  const createdAtMs = readUpdateCreatedAtMs(update);
  return Number.isFinite(publishedAfterMs) && createdAtMs !== null && createdAtMs >= publishedAfterMs;
}

/** Critical by either lever: the server's list, or `extra.critical` in the manifest. */
export function isCriticalUpdate(
  update: unknown,
  criticalUpdate: MobileCriticalUpdate | null | undefined,
): boolean {
  return isFlaggedCriticalByServer(update, criticalUpdate) || readCriticalFlag(update);
}

export type BackgroundClock = {
  /** Timestamp the app went away, or null while it is foreground. */
  backgroundedAt: number | null;
  /** How long the app had been away when it last returned. */
  backgroundedForMs: number;
};

export const IDLE_CLOCK: BackgroundClock = { backgroundedAt: null, backgroundedForMs: 0 };

/**
 * Fold an app lifecycle transition into the background clock.
 *
 * Two asymmetries, both deliberate:
 *
 * `inactive` starts the clock but never stops it. iOS reports `inactive` for a
 * notification-centre pull, an incoming call banner, or the app switcher —
 * moments where the app is still visibly on screen. Treating those as a return
 * would let a reload fire under the user's eyes.
 *
 * Once the clock is running the earliest timestamp wins, so the `inactive` →
 * `background` pair every iOS backgrounding produces does not restart it and
 * silently discard the elapsed time.
 */
export function advanceBackgroundClock(
  clock: BackgroundClock,
  next: AppLifecycleState,
  now: number,
): BackgroundClock {
  if (next === 'active') {
    if (clock.backgroundedAt === null) return { ...clock, backgroundedForMs: 0 };
    return { backgroundedAt: null, backgroundedForMs: Math.max(0, now - clock.backgroundedAt) };
  }

  if (clock.backgroundedAt !== null) return clock;
  return { backgroundedAt: now, backgroundedForMs: clock.backgroundedForMs };
}

/** True when this transition is a genuine return from having been away. */
export function isReturnFromBackground(
  previous: BackgroundClock,
  next: AppLifecycleState,
): boolean {
  return next === 'active' && previous.backgroundedAt !== null;
}
