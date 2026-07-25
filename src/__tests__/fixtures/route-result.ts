import { expect } from 'vitest';

/**
 * Assert a route-service result is the success branch, and narrow it.
 *
 * Route services return a discriminated union — `{ ok: true, body }` or
 * `{ ok: false, status, body: { error } }`. Tests routinely wrote:
 *
 *     expect(result.ok).toBe(true);
 *     expect(result.body.canvas).toMatchObject({ ... });
 *
 * which reads correctly but does not typecheck: `expect(...)` is a runtime
 * assertion and tells the compiler nothing, so `result` stays the full union
 * and every subsequent property access errors. Casting at each access point
 * would silence it while also silencing a genuine mistake — accessing a success
 * field on a result that is actually an error.
 *
 * This helper does both jobs at once: it fails the test loudly if the call did
 * not succeed (surfacing the real error rather than an opaque `undefined`
 * further down), and returns the value narrowed to the success branch so the
 * assertions that follow are typechecked against the real body.
 */
export function expectOk<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) {
    // Surface the failure payload — a bare `expect(false).toBe(true)` would
    // hide why the route rejected the request.
    expect.fail(`Expected a successful route result, received: ${JSON.stringify(result)}`);
  }

  return result as Extract<T, { ok: true }>;
}

/**
 * The mirror of {@link expectOk}, for tests asserting a rejection. Narrows to
 * the error branch so `status` and `body.error` are typed.
 */
export function expectFailure<T extends { ok: boolean }>(result: T): Extract<T, { ok: false }> {
  if (result.ok) {
    expect.fail(`Expected a failed route result, received: ${JSON.stringify(result)}`);
  }

  return result as Extract<T, { ok: false }>;
}
