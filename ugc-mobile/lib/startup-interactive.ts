import { AppMetrics } from 'expo-observe';

// Time to interactive, for EAS Observe. AppMetricsRoot (app/_layout.tsx) marks
// first render when the root layout mounts — before auth and onboarding are
// restored, and before any content — so without this module nothing measures
// the moment a person can actually use the app, and startup work that happens
// after that first mount is invisible to every chart.
//
// Screens report milestones as a cold start passes them. After each one, the
// policy looks at everything the launch has passed so far, so the order they
// arrive in does not matter; the first time it says yes is marked, once.

export type StartupMilestone =
  /** Auth and onboarding restored: StartupCoordinator lifted its cover. */
  | 'shell-ready'
  /** The home feed committed its first page of real posts — not a skeleton. */
  | 'home-content'
  /** The home feed settled with nothing to show: an error or an empty page. */
  | 'home-empty-or-error';

export type StartupSnapshot = {
  milestone: StartupMilestone;
  /** The route the app was on when the milestone passed. */
  pathname: string;
};

export type StartupProgress = {
  /** Every milestone passed so far, with the route it first passed on. */
  passed: ReadonlyMap<StartupMilestone, string>;
};

/**
 * A cold start is interactive once the screen it landed on can be used.
 *
 * Nothing is, before the session is restored: StartupCoordinator covers home
 * until then, and no screen can make an authenticated request. Home is a feed,
 * so it waits for the first page to settle — on posts, or on an empty or error
 * state the person can act on. Counting those keeps slow and failing networks
 * in the numbers rather than measuring only the launches that went well.
 *
 * A deep link or notification that cold-starts onto another screen has no
 * content milestone of its own, so its launch ends with the shell. A first run
 * redirected to onboarding lands on home and leaves before the feed settles, so
 * it is not measured: onboarding is a one-off path, not the startup to tune.
 */
export function isStartupInteractive({ passed }: StartupProgress): boolean {
  const landedOn = passed.get('shell-ready');
  if (landedOn === undefined) return false;
  if (landedOn !== '/') return true;
  return passed.has('home-content') || passed.has('home-empty-or-error');
}

let marked = false;
const passed = new Map<StartupMilestone, string>();

export function reportStartupMilestone(
  { milestone, pathname }: StartupSnapshot,
  isInteractive: (progress: StartupProgress) => boolean = isStartupInteractive,
) {
  if (marked || passed.has(milestone)) return;
  passed.set(milestone, pathname);
  if (!isInteractive({ passed })) return;

  marked = true;
  try {
    AppMetrics.markInteractive({
      routeName: passed.get('shell-ready') ?? pathname,
      params: { completedBy: milestone },
    });
  } catch (error) {
    // A metric must never take the launch down with it.
    console.warn('Could not mark startup interactive', error);
  }
}

/** Test-only: forget this launch's milestones. */
export function resetStartupMilestonesForTests() {
  marked = false;
  passed.clear();
}
