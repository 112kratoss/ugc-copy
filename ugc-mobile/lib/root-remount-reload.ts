/**
 * A fresh JS runtime when Android rebuilds the app's activity inside a live
 * process.
 *
 * Android can replace MainActivity without ending the process: a launcher-style
 * start with `--activity-clear-task` builds the new activity first and destroys
 * the old one half a second later, and a configuration change (font size, and
 * anything else the manifest does not handle) destroys the old one first. Either
 * way React Native runs the app's root again in the same JS runtime
 * (`Running "main"` a second time), with every module's state, and the UI
 * runtime's, carried over from the first root.
 *
 * On the store app (0.1.9 with that day's OTA, signed in) that left the next
 * post opened from a tile stuck: the reel was pushed, but the flight that grows
 * it out of the tile never took a step (`components/media-zoom.tsx`), so an
 * invisible reel sat on top of Explore and took every touch, and no later tile
 * opened anything, until the process was killed. Reproduced 3 of 3 on the
 * owner's S24 with a fresh-process control that passed (2026-11-07 twice and
 * 2026-11-24). What inside the store app goes wrong is NOT known: a release
 * lab build of the same code, with updates off and no account, did not freeze,
 * on the Pixel 9a emulator or on the S24. The record is
 * `archive/perf-loop-2026-11-24/activity-recreate-freeze/`.
 *
 * A fresh process is known to work, so a second root mount in one runtime
 * reloads the JS (a new JS runtime and new worklet runtimes) once. What the
 * person sees (a clear-task rebuild on the Pixel 9a emulator, filmed at 10 fps):
 * the splash icon of the new activity for about 0.4 s, the new root's Home for
 * about 0.3 s, then the bare window background for about 0.4 s while the host
 * reloads (a host reload builds no activity, so expo-splash-screen's native
 * splash, which registers in `Activity.onCreate`, does not come back), then the
 * app's own launch splash (`components/launch-splash.tsx`, the icon and its
 * animated sting) for about 1 s, and Home again about 2.6 s after the rebuild.
 * Guarded on disk, because the count of mounts does not survive the reload it
 * causes; a storage error means no reload, never a loop.
 *
 * What it costs: a reload drops any JS work in flight in the old tree (an
 * upload, a run's start request) that a plain remount kept. The realistic
 * triggers today are a font-size, display-size or language change while such
 * work is under way.
 *
 * This file has no React Native in it; `lib/root-remount-reload-native.ts`
 * supplies the platform, the storage and the reload.
 */
import { claimAppReload, releaseAppReload } from './app-reload-claim';

/**
 * No second reload by this rule within this long of the last one. A reload is a
 * cold JS start, about 1–3 s on the phones measured, so a root mounted again
 * inside the window is the reload's own doing or a burst of rebuilds (a font
 * size changed and changed back): reloading again would only loop. Long past a
 * reload on a slow phone, short enough that a later, separate rebuild is healed.
 */
export const ROOT_REMOUNT_RELOAD_GUARD_MS = 15_000;

export const ROOT_REMOUNT_RELOAD_STORAGE_KEY = 'magicbooklet.rootRemountReloadAt.v1';

export interface RootRemountReloadDeps {
  platform: string;
  dev: boolean;
  now: () => number;
  /** The time of the last reload by this rule, or null for none; throws when storage cannot be read. */
  readLastReloadAt: () => Promise<number | null>;
  /** Stores that time; null removes it. */
  writeLastReloadAt: (at: number | null) => Promise<void>;
  reload: (reason: string) => Promise<void>;
  /** Runs `run` after `ms`, if this runtime is still alive then. */
  later: (run: () => void, ms: number) => void;
}

/**
 * A reload call that returned and left this runtime running past this long did
 * not reload (no React activity, no delegate, no `globalThis.expo`): the claim
 * is given back, so the OTA gate and a later rebuild can still reload. A real
 * reload ends the runtime within a few hundred milliseconds.
 */
export const ROOT_REMOUNT_RELOAD_GIVE_UP_MS = 10_000;

export function shouldReloadOnRootMount({
  platform,
  dev,
  mountNumber,
  liveRoots,
  lastReloadAt,
  now,
}: {
  platform: string;
  dev: boolean;
  /** Root mounts in this runtime so far, this one included. */
  mountNumber: number;
  /** Roots mounted right now. */
  liveRoots: number;
  lastReloadAt: number | null;
  now: number;
}): boolean {
  if (platform !== 'android' || dev || mountNumber < 2) return false;
  // Not while the old activity's root is still up: a reload then restarts its
  // surface too, two roots run in the fresh runtime, and expo-router's store
  // was left with the one that went (on the Pixel 9a emulator the next push
  // threw "Attempted to navigate before mounting the Root Layout" and the app
  // went blank). A rebuild that creates first unmounts the old root half a
  // second later, once its activity is destroyed; the reload waits for that.
  if (liveRoots !== 1) return false;
  if (lastReloadAt === null) return true;
  const since = now - lastReloadAt;
  // A stored time ahead of the clock (the clock was set back) is stale, not
  // recent: counted as recent it would switch this off until real time passed
  // it. Every reload writes the current time, so this cannot loop.
  if (since < 0) return true;
  return since >= ROOT_REMOUNT_RELOAD_GUARD_MS;
}

/** Root mounts in this JS runtime, and roots mounted now. A reload starts a new runtime, and both counts with it. */
let rootMounts = 0;
let liveRoots = 0;
/**
 * A decision is being made (storage is being read), or a reload has started:
 * a mount or unmount meanwhile changes nothing. A decision that kept the root
 * (inside the guard window, or storage failing) is not remembered, so a later
 * rebuild in the same runtime is decided afresh.
 */
let busy = false;

export type RootMountOutcome =
  | 'first-mount'
  | 'waiting'
  | 'decided'
  | 'kept'
  | 'storage-failed'
  | 'reload-under-way'
  | 'reloaded'
  | 'reload-failed';

/** A mount of the app's root layout (from its effect). */
export function noteRootMount(deps: RootRemountReloadDeps): Promise<RootMountOutcome> {
  rootMounts += 1;
  liveRoots += 1;
  if (rootMounts < 2) return Promise.resolve('first-mount');
  return decide(deps);
}

/** That root layout unmounting (its effect's cleanup). */
export function noteRootUnmount(deps: RootRemountReloadDeps): Promise<RootMountOutcome> {
  liveRoots = Math.max(0, liveRoots - 1);
  if (rootMounts < 2) return Promise.resolve('first-mount');
  return decide(deps);
}

async function decide(deps: RootRemountReloadDeps): Promise<RootMountOutcome> {
  if (busy) return 'decided';
  const base = { platform: deps.platform, dev: deps.dev, mountNumber: rootMounts, lastReloadAt: null };
  // Never on this platform or build: nothing to wait for.
  if (!shouldReloadOnRootMount({ ...base, liveRoots: 1, now: deps.now() })) return 'kept';
  if (liveRoots !== 1) return 'waiting';
  busy = true;
  let lastReloadAt: number | null;
  try {
    lastReloadAt = await deps.readLastReloadAt();
  } catch {
    busy = false;
    return 'storage-failed';
  }
  const now = deps.now();
  if (!shouldReloadOnRootMount({ ...base, liveRoots, lastReloadAt, now })) {
    busy = false;
    return 'kept';
  }
  // An update the OTA gate is reloading into gives the fresh runtime already.
  // Should that reload fail, this runtime decides again at the next rebuild.
  if (!claimAppReload()) {
    busy = false;
    return 'reload-under-way';
  }
  // Written before the reload, so that the root the reload mounts — or any
  // rebuild right after it — finds it and stands down.
  try {
    await deps.writeLastReloadAt(now);
  } catch {
    releaseAppReload();
    busy = false;
    return 'storage-failed';
  }
  // Another activity may have been built while the time was written: a reload
  // now would restart two surfaces (see `shouldReloadOnRootMount`). Stand down,
  // put the stored time back as it was so the guard does not hold off the
  // reload that comes when that root unmounts, and decide again then.
  if (liveRoots !== 1) {
    releaseAppReload();
    try {
      await deps.writeLastReloadAt(lastReloadAt);
    } catch {
      // Left at `now`: the next reload by this rule waits out the window.
    }
    busy = false;
    return 'waiting';
  }
  try {
    await deps.reload('The app root mounted again in one JS runtime (Android activity rebuilt)');
    // The runtime is going, and nothing after this decides anything, unless
    // it is still here well after the call: then the call did nothing.
    deps.later(() => {
      releaseAppReload();
      busy = false;
    }, ROOT_REMOUNT_RELOAD_GIVE_UP_MS);
    return 'reloaded';
  } catch {
    releaseAppReload();
    busy = false;
    return 'reload-failed';
  }
}

/** Test seam. */
export function resetRootMountsForTest() {
  rootMounts = 0;
  liveRoots = 0;
  busy = false;
}
