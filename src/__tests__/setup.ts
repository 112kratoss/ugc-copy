import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';
import { vi } from 'vitest';

// The async queries' default wait is one second. A loaded runner (main's
// Quality job, which shares capacity with the PR runs) took longer than that to
// draw the reel and a sixty-comment thread, and each miss skipped a production
// release (2026-10-13/14) while the same trees passed as PRs. Five seconds is
// the cap, not the cost: a found element returns at once.
configure({ asyncUtilTimeout: 5000 });

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
