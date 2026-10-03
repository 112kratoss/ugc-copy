/**
 * How a failed job is recorded in its `last_error` column.
 *
 * A worker's catch block does not only see `Error`s. supabase-js answers a
 * failed query with a plain object, never an `Error`, unless `throwOnError`
 * is set, and nothing here sets it: `{ message, code, details, hint }` as
 * PostgREST sent it, or `{ message: body }` when the answer was not JSON. The
 * database helpers throw that object as it is (`if (error) throw error`), and
 * `String()` of it is "[object Object]". A worker stores the reason and does
 * not log it, so that left a failed tick with no reason anywhere.
 *
 * So read the message and keep the code beside it: the code is the half that
 * stays the same between releases (`57014`, `PGRST204`) and the one to search
 * for. An object with no message to read is stored as JSON, which still shows
 * whatever it does carry.
 */
export function jobErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (!error || typeof error !== 'object') return String(error);

  const { message, code } = error as { message?: unknown; code?: unknown };
  if (typeof message === 'string' && message.trim()) {
    return typeof code === 'string' && code.trim() ? `${message} (code ${code})` : message;
  }

  try {
    return JSON.stringify(error) || String(error);
  } catch {
    return String(error);
  }
}
