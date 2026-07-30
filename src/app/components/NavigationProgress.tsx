'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import {
  publishNavigationStart,
  readNavigationToken,
  readServerNavigationToken,
  subscribeToNavigationStart,
} from '@/app/components/navigation-progress-state';

/** How far the bar creeps while waiting; the last stretch is reserved for arrival. */
const CEILING = 90;
const TICK_MS = 120;
/** Held at 100% just long enough to read as "done" rather than as a glitch. */
const COMPLETE_HOLD_MS = 220;
/** If a navigation never resolves, stop pretending it is still loading. */
const FAILSAFE_MS = 12_000;

/**
 * True for a click that will actually take the viewer to another page. Anything
 * the browser handles itself — new tab, download, cross-origin, a bare hash on
 * the current page — must not raise the bar.
 */
function isNavigatingClick(event: MouseEvent): boolean {
  if (event.defaultPrevented || event.button !== 0) return false;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;

  const target = event.target;
  if (!(target instanceof Element)) return false;
  const anchor = target.closest('a[href]');
  if (!(anchor instanceof HTMLAnchorElement)) return false;
  if (anchor.hasAttribute('download')) return false;
  if (anchor.target && anchor.target !== '_self') return false;

  let url: URL;
  try {
    url = new URL(anchor.href, window.location.href);
  } catch {
    return false;
  }
  if (url.origin !== window.location.origin) return false;
  // Same path means a hash jump or a no-op, not a page change.
  return url.pathname !== window.location.pathname;
}

/**
 * The thin bar across the top that acknowledges a click while the next page is
 * being fetched. Without it a navigation reads as a frozen page: the shell and
 * the old content stay put for the length of the round trip, so nothing tells
 * the viewer their click landed.
 *
 * Mounted in the root layout rather than inside the app shell so it also covers
 * routes that render without the shell, and so the shell's hydration-sensitive
 * tree stays untouched.
 *
 * Width is driven from state instead of a CSS keyframe on purpose: the global
 * reduced-motion rule forces `animation-duration` and `transition-duration` to
 * near-zero with `!important`, which would collapse a keyframe animation into a
 * single invisible frame. Stepping the width still reads as progress there — it
 * just snaps between steps instead of gliding.
 */
export default function NavigationProgress() {
  const token = useSyncExternalStore(
    subscribeToNavigationStart,
    readNavigationToken,
    readServerNavigationToken
  );
  const pathname = usePathname();
  const [progress, setProgress] = useState<number | null>(null);
  // The path we were on when the navigation began; arrival is when it changes.
  const originRef = useRef<string | null>(null);
  // Only a token that moves *after* mount means a navigation started. The store
  // is module state, so a fresh mount can already see a nonzero count from
  // earlier navigations — reacting to that would flash the bar for no reason.
  const mountedTokenRef = useRef(token);

  // Link clicks anywhere in the app raise the bar. Imperative `router.push`
  // callers announce themselves through the store instead.
  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      if (isNavigatingClick(event)) {
        publishNavigationStart();
      }
    };
    // Capture phase, and this is load-bearing: `next/link` calls
    // preventDefault() on every internal click so it can navigate on the client.
    // Listening in the bubble phase means always arriving after that and seeing
    // `defaultPrevented` — which reads as "some handler cancelled this" and
    // silently suppressed the bar for every link in the app.
    document.addEventListener('click', handleClick, true);
    return () => document.removeEventListener('click', handleClick, true);
  }, []);

  // Start creeping when a navigation is announced.
  useEffect(() => {
    if (token === mountedTokenRef.current) return;

    originRef.current = window.location.pathname;
    setProgress(8);

    // Decelerating steps: quick to appear, then asymptotic, so the bar never
    // implies it is about to finish when it has no idea.
    const interval = window.setInterval(() => {
      setProgress((current) => {
        if (current === null) return current;
        return current + Math.max(1, (CEILING - current) * 0.18);
      });
    }, TICK_MS);
    const failsafe = window.setTimeout(() => setProgress(null), FAILSAFE_MS);

    return () => {
      window.clearInterval(interval);
      window.clearTimeout(failsafe);
    };
  }, [token]);

  // Arrival: the rendered path is no longer the one we left.
  useEffect(() => {
    if (progress === null) return;
    if (originRef.current === null || pathname === originRef.current) return;

    originRef.current = null;
    setProgress(100);
    const hide = window.setTimeout(() => setProgress(null), COMPLETE_HOLD_MS);
    return () => window.clearTimeout(hide);
    // `progress` is read but must not retrigger this on every creep tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  if (progress === null) return null;

  return (
    <div
      // Not a progressbar role: the value is invented, and announcing a
      // meaningless percentage to a screen reader is worse than staying quiet.
      // Route changes are already announced by Next's route announcer.
      aria-hidden="true"
      data-testid="navigation-progress"
      // 3px, not 2: the whole job is being noticed in peripheral vision the
      // instant a click lands, and 2px reads as a rendering artifact.
      className="pointer-events-none fixed inset-x-0 top-0 z-[130] h-[3px]"
    >
      <div
        className="h-full bg-[var(--ui-primary)] shadow-[0_0_8px_rgba(255,122,89,0.7)] transition-[width,opacity] duration-200 ease-out"
        style={{ width: `${Math.min(progress, 100)}%`, opacity: progress >= 100 ? 0 : 1 }}
      />
    </div>
  );
}
