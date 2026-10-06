/** Read a bounded admin report across PostgREST's per-request row ceiling. */
type CountedResponse = {
  data: Array<Record<string, unknown>> | null;
  error: unknown;
  count: number | null;
};

export async function readBoundedAdminRows(
  build: (from: number, to: number) => PromiseLike<CountedResponse>,
  limit: number,
): Promise<{ rows: Array<Record<string, unknown>>; truncated: boolean }> {
  const rows: Array<Record<string, unknown>> = [];
  while (rows.length < limit) {
    const response = await build(rows.length, Math.min(rows.length + 1000, limit) - 1);
    if (response.error) throw response.error;
    if (response.count === null || !Number.isInteger(response.count) || response.count < 0) {
      throw new Error('Admin report query omitted its exact row count.');
    }
    const page = response.data ?? [];
    rows.push(...page);
    if (rows.length >= Math.min(response.count, limit)) {
      return { rows, truncated: response.count > rows.length };
    }
    if (!page.length) throw new Error('Admin report query made no paging progress.');
  }
  throw new Error('Admin report row budget must be positive.');
}
