/**
 * The body of an API answer, read without ever throwing.
 *
 * The platform answers a timed-out or crashed function with an HTML 502 or 504, and
 * `await response.json()` then throws "Unexpected token '<'…", which a caller that reads the body
 * before checking `response.ok` showed to the person as its error. This returns the parsed body,
 * or an empty object when the body is not JSON (or not an object or array, or already read), so the
 * caller's own `!response.ok` branch shows its own fallback message.
 *
 * The type is the caller's claim, as `response.json()`'s `any` was: read `response.ok` before
 * trusting a field, since a failed answer reads as `{}`.
 *
 * A success status whose body cannot be read is no empty answer: a caller that goes on to use the
 * body (a canvas, a share, a list) passes `unreadableSuccess`, the message it says then, and the
 * read throws it, as `response.json()` threw before, in the caller's own words.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- drop-in for response.json()'s any
export async function readJsonResponse<T = any>(
  response: Response,
  options: { unreadableSuccess?: string } = {},
): Promise<T> {
  try {
    const body: unknown = await response.json();
    if (body !== null && typeof body === 'object') return body as T;
  } catch {
    // Not JSON (an HTML error page, an empty body) or a body already read.
  }
  if (response.ok && options.unreadableSuccess) throw new Error(options.unreadableSuccess);
  return {} as T;
}

/**
 * Whether a failed answer to an action that spends credits or money leaves its outcome unknown:
 * no refusal (a 4xx says the server turned the request down) and no explanation of the server's
 * own (an `error` string), as with the platform's HTML 502 or 504 after the function may have run,
 * or a success status whose body could not be read. The caller then says the result is unknown and
 * to check before trying again, never that it failed.
 */
export function isUnconfirmedOutcome(response: Response, body: unknown): boolean {
  if (response.status >= 400 && response.status < 500) return false;
  const error = body !== null && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
  return !(typeof error === 'string' && error.trim().length > 0);
}
