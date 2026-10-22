import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';
import { vi } from 'vitest';

// The async queries' default wait is one second. A loaded runner (main's
// Quality job, which shares capacity with the PR runs) took longer than that to
// draw the reel and a sixty-comment thread, and each miss skipped a production
// release (2026-10-13/14) while the same trees passed as PRs. Five seconds is
// the cap, not the cost: a found element returns at once.
configure({ asyncUtilTimeout: 5000 });

// Testing Library's own async wrapper (@testing-library/react's pure.js: act
// off while a findBy* or waitFor waits, then one setTimeout(0)), plus one real
// setImmediate before act comes back on. Outside act, React renders on its
// scheduler, in a setImmediate in Node, and yields after every commit, so the
// commit's passive effects (useEffect, store subscriptions) run in the next
// setImmediate. A millisecond of other work in between, as on main's loaded
// runner, let the timer win and the test act before those effects had run:
// four tests failed that way on main only (2026-10-13 to 10-22), each failure
// a skipped production release. The setImmediate queues behind React's, so the
// effects run first. It comes after the timer, not before: a faked timer must
// still be scheduled while the vi.advanceTimersByTimeAsync() that found the
// element is running, or nothing fires it. And it is taken here, before any
// test can fake timers: vi.useFakeTimers() fakes setImmediate too, while
// React's scheduler keeps the real one it took at import.
// async-query-effect-drain.test.tsx pins all three.
const realSetImmediate = globalThis.setImmediate;
const reactGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
configure({
  asyncWrapper: async (callback) => {
    const previousActEnvironment = reactGlobal.IS_REACT_ACT_ENVIRONMENT;
    reactGlobal.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      const result = await callback();
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
      await new Promise((resolve) => {
        realSetImmediate(resolve);
      });
      return result;
    } finally {
      reactGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    }
  },
});

// Next's cache APIs require an active request store. Unit tests exercise the
// mutation boundaries directly, so provide request-free test doubles here.
vi.mock('next/cache', () => ({
  revalidateTag: vi.fn(),
  unstable_cache: (callback: (...args: unknown[]) => unknown) => callback,
}));

// jsdom does not implement scrollIntoView, and the composer scrolls section
// anchors inside requestAnimationFrame callbacks that can fire after a test
// completes -- an unstubbed call there fails the whole suite as an unhandled
// error even when every test passes.
if (typeof Element !== 'undefined') {
  Element.prototype.scrollIntoView ??= () => {};
}
