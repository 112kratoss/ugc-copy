/**
 * Offset paging for the admin console.
 *
 * Deliberately NOT `server-only`: `moderation-ops.ts` imports this and is also
 * driven by `npm run ops:moderation`, a tsx CLI where the `server-only` guard
 * throws at import. Nothing here touches secrets, an env var, or a client
 * factory — it is pure response handling, so the guard buys nothing anyway.
 *
 * PostgREST answers a `.range()` whose start is past the last row with HTTP
 * 416 and no body, which supabase-js surfaces as an error with an unparseable
 * message and a null count — so a naive `if (error) throw` turns it into a 500.
 *
 * That is not only a hand-edited-URL problem. An operator sitting on page 2 of
 * the moderation history or the payout queue whose rows are resolved away
 * before they refresh lands on exactly this response. The console's answer is
 * to show them the first page with an accurate total rather than an error.
 */

const RANGE_NOT_SATISFIABLE = 416;

type PagedResponse<T> = {
  data: T[] | null;
  error: unknown;
  count: number | null;
  status: number;
};

export type PagedResult<T> = {
  rows: T[];
  /** Matching rows across the whole table, not just this page. */
  total: number;
  /**
   * Where the query actually landed. Differs from the requested offset when it
   * pointed past the end, so a pager renders the window it is really showing.
   */
  offset: number;
};

/**
 * `build` is called with an inclusive row range and must construct a fresh
 * query each time: PostgREST builders are single-use, and the fallback needs to
 * re-issue the same filters at a different offset without restating them.
 */
export async function runPagedQuery<T>(
  build: (from: number, to: number) => PromiseLike<PagedResponse<T>>,
  options: { offset: number; pageSize: number },
): Promise<PagedResult<T>> {
  const pageSize = Math.max(options.pageSize, 1);
  const offset = Math.max(options.offset, 0);

  const requested = await build(offset, offset + pageSize - 1);
  if (requested.status !== RANGE_NOT_SATISFIABLE) {
    if (requested.error) throw requested.error;
    const rows = requested.data ?? [];
    return { rows, total: requested.count ?? rows.length, offset };
  }

  // Past the last row: fall back to the first page, which also recovers the
  // count that the 416 response omits.
  const firstPage = await build(0, pageSize - 1);
  if (firstPage.error) throw firstPage.error;
  const rows = firstPage.data ?? [];
  return { rows, total: firstPage.count ?? rows.length, offset: 0 };
}
