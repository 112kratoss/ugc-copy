import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';
import { vi } from 'vitest';

// The async queries' default wait is one second. A loaded runner (main's
// Quality job, which shares capacity with the PR runs) took longer than that to
// draw the reel and a sixty-comment thread, and each miss skipped a production
// release (2026-10-13/14) while the same trees passed as PRs. Five seconds is
// the cap, not the cost: a found element returns at once.
configure({ asyncUtilTimeout: 5000 });

// Each findBy* and waitFor returns after React has run the passive effects
// (useEffect, store subscriptions) of the commit it found. Testing Library's
// wrapper hands the test back one setTimeout(0) after the query passes, but
// outside act React commits on its scheduler (a setImmediate in Node) and runs
// the commit's effects in its next one; a millisecond of other work between
// them, as on main's loaded runner, let the timer win and the test act first.
// Four tests failed that way on main only (2026-10-13 to 10-22), each failure a
// skipped production release. So Testing Library's wrapper still runs whole,
// timer included (create-video-client's Kling rename test fails without it),
// and act stays off past it for one real setImmediate, which queues behind the
// scheduler's. It comes after the timer because a faked timer must be scheduled
// while the vi.advanceTimersByTimeAsync() that found the element is still
// running, or nothing fires it; and it is taken here, before any test can fake
// timers, because vi.useFakeTimers() fakes setImmediate too while React's
// scheduler keeps the real one it took at import. A render those effects start
// is waited for only when they beat the timer, so a test that needs that render
// can still pass here and fail on main. async-query-effect-drain.test.tsx pins
// the order, the timer, the capture and the advance.
const realSetImmediate = globalThis.setImmediate;
const reactGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
configure(({ asyncWrapper: testingLibraryAsyncWrapper }) => ({
  asyncWrapper: async (callback) => {
    const previousActEnvironment = reactGlobal.IS_REACT_ACT_ENVIRONMENT;
    reactGlobal.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      // Testing Library's wrapper turns act back to the false set here.
      const result = await testingLibraryAsyncWrapper(callback);
      await new Promise((resolve) => {
        realSetImmediate(resolve);
      });
      return result;
    } finally {
      reactGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    }
  },
}));

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
