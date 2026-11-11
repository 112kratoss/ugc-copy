/**
 * The search log's report (`public.search_query_report`), read by the ops CLI
 * (`scripts/ops/search-report.ts`, loaded under plain tsx: nothing here may reach `server-only`).
 */

export type SearchQueryReportRow = {
  query: string;
  searches: number;
  zeroResultSearches: number;
  totalSearches: number;
  totalZeroResultSearches: number;
};

type ReportClient = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
};

function count(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function normalizeSearchQueryReportRows(data: unknown): SearchQueryReportRow[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((row) => {
    if (!row || typeof row !== 'object') return [];
    const record = row as Record<string, unknown>;
    if (typeof record.query !== 'string') return [];
    // bigint columns arrive as strings over PostgREST.
    return [{
      query: record.query,
      searches: count(record.searches),
      zeroResultSearches: count(record.zero_result_searches),
      totalSearches: count(record.total_searches),
      totalZeroResultSearches: count(record.total_zero_result_searches),
    }];
  });
}

export async function fetchSearchQueryReport(
  client: ReportClient,
  { days, limit }: { days: number; limit: number },
): Promise<SearchQueryReportRow[]> {
  const { data, error } = await client.rpc('search_query_report', { p_days: days, p_limit: limit });
  if (error) throw error instanceof Error ? error : new Error(JSON.stringify(error));
  return normalizeSearchQueryReportRows(data);
}

/** The table the CLI prints: a summary line, then one line per query, zero-result searches first. */
export function formatSearchQueryReport(rows: SearchQueryReportRow[], { days }: { days: number }): string {
  if (rows.length === 0) return `No searches logged in the last ${days} day(s).`;
  const { totalSearches, totalZeroResultSearches } = rows[0];
  const rate = totalSearches > 0 ? ((totalZeroResultSearches / totalSearches) * 100).toFixed(1) : '0.0';
  const lines = [
    `Last ${days} day(s): ${totalSearches} searches (a typed query counts once per visitor-day), `
      + `${totalZeroResultSearches} with no results in any kind (${rate}%).`,
    '',
    `${'zero'.padStart(6)} ${'searches'.padStart(9)}  query`,
    ...rows.map((row) => `${String(row.zeroResultSearches).padStart(6)} ${String(row.searches).padStart(9)}  ${row.query}`),
  ];
  return lines.join('\n');
}
