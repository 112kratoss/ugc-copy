import { vi, type Mock } from 'vitest';

import type { withProviderFetchRequestId } from '@/lib/provider-fetch';

/**
 * A spy that satisfies the generic `withProviderFetchRequestId` signature.
 *
 * `withProviderFetchRequestId` is generic — `<T>(requestId: string, operation:
 * () => T) => T` — and vitest's `Mock<T>` wrapper cannot preserve genericity:
 * inside the wrapper the type parameter collapses to `unknown`, producing
 *
 *     Type 'unknown' is not assignable to type 'T'.
 *     'T' could be instantiated with an arbitrary type ...
 *
 * There is no spelling of `vi.fn()` that avoids this, including a generic
 * implementation — the limitation is in the wrapper, not the callback. So the
 * cast here is unavoidable rather than lazy, and it is done once in a named,
 * documented place instead of seventeen times across eleven test files.
 *
 * The intersection type keeps both halves usable: the value presents the real
 * generic signature to a dependency object, and still exposes the vitest spy
 * surface so `toHaveBeenCalledWith` continues to typecheck.
 */
export type RequestIdPassthroughMock =
  typeof withProviderFetchRequestId
  & Mock<(requestId: string, operation: () => unknown) => unknown>;

/**
 * Runs the operation immediately, recording the request id it was handed.
 * This mirrors production behaviour: the real helper establishes an ambient
 * trace and then invokes the operation synchronously.
 */
export function mockRequestIdPassthrough(): RequestIdPassthroughMock {
  return vi.fn(
    (_requestId: string, operation: () => unknown) => operation(),
  ) as RequestIdPassthroughMock;
}
