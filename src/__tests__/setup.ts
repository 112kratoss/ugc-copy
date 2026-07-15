import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

// Next's cache APIs require an active request store. Unit tests exercise the
// mutation boundaries directly, so provide request-free test doubles here.
vi.mock('next/cache', () => ({
  revalidateTag: vi.fn(),
  unstable_cache: (callback: (...args: unknown[]) => unknown) => callback,
}));
