/**
 * The bookkeeping behind the OTA update gate, kept free of expo-updates and
 * react-native so it can be tested directly.
 *
 * `use-ota-update-gate` holds the native bindings and the effects; everything
 * here is the part that is easy to get subtly wrong — how long the app was
 * away, and whether the publisher actually flagged this update critical.
 */

/** Mirrors react-native's AppStateStatus without importing it. */
export type AppLifecycleState = 'active' | 'background' | 'inactive' | 'extension' | 'unknown';

/**
 * How the app marks an update as urgent: `extra.critical` in the manifest, set
 * at publish time. Anything other than a literal `true` is routine — a typo in
 * a publish command must not earn the right to interrupt someone.
 */
export function readCriticalFlag(update: unknown): boolean {
  if (!update || typeof update !== 'object') return false;
  const manifest = (update as { manifest?: unknown }).manifest;
  if (!manifest || typeof manifest !== 'object') return false;
  const extra = (manifest as { extra?: unknown }).extra;
  if (!extra || typeof extra !== 'object') return false;
  return (extra as { critical?: unknown }).critical === true;
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
