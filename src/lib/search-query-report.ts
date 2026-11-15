/**
 * The search log's report (`public.search_query_report`), read by the ops CLI
 * (`scripts/ops/search-report.ts`, loaded under plain tsx: nothing here may reach `server-only`).
 */

/** How the report is ordered: the failing queries first, or the ones most often left without an open. */
export const SEARCH_QUERY_REPORT_ORDERS = ['zero_result', 'unopened'] as const;
export type SearchQueryReportOrder = (typeof SEARCH_QUERY_REPORT_ORDERS)[number];

export type SearchQueryReportRow = {
  query: string;
  searches: number;
  zeroResultSearches: number;
  /**
   * Searches from a client that reports what was opened: it said how the search was entered
   * (`entry`), which arrived with the open report. Opened and unopened are counted over these
   * alone: an app before its update or a tab loaded before the release cannot report an open,
   * and its searches would otherwise all read as left unopened.
   */
  reportingSearches: number;
  /** Reporting searches a result was opened from: one that search still shows the public. */
  openedSearches: number;
  /** Reporting searches that found something and had no result opened. */
  unopenedSearches: number;
  /** The mean 1-based place of the results opened; null without one. */
  meanOpenPosition: number | null;
  /** Searches by how they were entered, `unknown` for a client that said nothing. */
  entryMix: Record<string, number>;
  totalSearches: number;
  totalZeroResultSearches: number;
  totalOpenedSearches: number;
  totalUnopenedSearches: number;
  totalMeanOpenPosition: number | null;
  totalEntryMix: Record<string, number>;
  totalReportingSearches: number;
};

type ReportClient = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
};

function count(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** A mean, or null: a numeric column arrives as a number or a string, and NULL when nothing was opened. */
function mean(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mix(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([entry, searches]) => [entry, count(searches)] as const)
      .filter(([, searches]) => searches > 0),
  );
}

export function normalizeSearchQueryReportRows(data: unknown): SearchQueryReportRow[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((row) => {
    if (!row || typeof row !== 'object') return [];
    const record = row as Record<string, unknown>;
    if (typeof record.query !== 'string') return [];
    // bigint columns arrive as strings over PostgREST. A database from before the opens were
    // logged answers without their columns: they read as zero, no mean and an empty mix.
    return [{
      query: record.query,
      searches: count(record.searches),
      zeroResultSearches: count(record.zero_result_searches),
      reportingSearches: count(record.reporting_searches),
      openedSearches: count(record.opened_searches),
      unopenedSearches: count(record.unopened_searches),
      meanOpenPosition: mean(record.mean_open_position),
      entryMix: mix(record.entry_mix),
      totalSearches: count(record.total_searches),
      totalZeroResultSearches: count(record.total_zero_result_searches),
      totalOpenedSearches: count(record.total_opened_searches),
      totalUnopenedSearches: count(record.total_unopened_searches),
      totalMeanOpenPosition: mean(record.total_mean_open_position),
      totalEntryMix: mix(record.total_entry_mix),
      totalReportingSearches: count(record.total_reporting_searches),
    }];
  });
}

export async function fetchSearchQueryReport(
  client: ReportClient,
  { days, limit, order = 'zero_result' }: { days: number; limit: number; order?: SearchQueryReportOrder },
): Promise<SearchQueryReportRow[]> {
  const { data, error } = await client.rpc('search_query_report', { p_days: days, p_limit: limit, p_order: order });
  if (error) throw error instanceof Error ? error : new Error(JSON.stringify(error));
  return normalizeSearchQueryReportRows(data);
}

/** A query as printed: control characters (ESC, BEL...) shown as \xNN, so a logged one cannot drive an operator's terminal. */
export function escapeForTerminal(text: string): string {
  return text.replace(/\p{Cc}/gu, (char) => `\\x${char.codePointAt(0)!.toString(16).padStart(2, '0')}`);
}

function percent(part: number, whole: number): string {
  return whole > 0 ? ((part / whole) * 100).toFixed(1) : '0.0';
}

/** "typed 62.5%, recent 25.0%, unknown 12.5%": the largest share first, then by name. */
export function formatSearchEntryMix(entryMix: Record<string, number>): string {
  const entries = Object.entries(entryMix).filter(([, searches]) => searches > 0);
  const total = entries.reduce((sum, [, searches]) => sum + searches, 0);
  if (total === 0) return 'none';
  return entries
    .sort(([leftEntry, left], [rightEntry, right]) => right - left || leftEntry.localeCompare(rightEntry))
    .map(([entry, searches]) => `${escapeForTerminal(entry)} ${percent(searches, total)}%`)
    .join(', ');
}

function position(value: number | null): string {
  return value === null ? '-' : value.toFixed(2);
}

/** The lines above either table: the window's totals. */
function formatSearchQueryReportSummary(rows: SearchQueryReportRow[], days: number): string[] {
  const totals = rows[0];
  const reporting = totals.totalReportingSearches;
  return [
    `Last ${days} day(s): ${totals.totalSearches} searches (a typed query counts once per visitor-day), `
      + `${totals.totalZeroResultSearches} with no results in any kind (${percent(totals.totalZeroResultSearches, totals.totalSearches)}%).`,
    // Only a client that says how a search was entered also reports what was opened from it.
    `Could report an open: ${reporting} searches; ${totals.totalSearches - reporting} could not `
      + '(their client says no entry: an app before its update, a tab from before the release) and are left out of the next line.',
    `Opened a result: ${totals.totalOpenedSearches} (${percent(totals.totalOpenedSearches, reporting)}% of the ${reporting}); `
      + `found something and opened nothing: ${totals.totalUnopenedSearches} (${percent(totals.totalUnopenedSearches, reporting)}%); `
      + `mean place opened: ${position(totals.totalMeanOpenPosition)}.`,
    `Entered by: ${formatSearchEntryMix(totals.totalEntryMix)}.`,
  ];
}

function formatSearchQueryReportTable(rows: SearchQueryReportRow[]): string[] {
  return [
    `${'zero'.padStart(6)} ${'searches'.padStart(9)} ${'reports'.padStart(8)} ${'opened'.padStart(7)} ${'unopened'.padStart(9)} ${'place'.padStart(6)}  query  [entered by]`,
    ...rows.map((row) => (
      `${String(row.zeroResultSearches).padStart(6)} ${String(row.searches).padStart(9)} ${String(row.reportingSearches).padStart(8)} `
        + `${String(row.openedSearches).padStart(7)} ${String(row.unopenedSearches).padStart(9)} `
        + `${position(row.meanOpenPosition).padStart(6)}  ${escapeForTerminal(row.query)}  [${formatSearchEntryMix(row.entryMix)}]`
    )),
  ];
}

/**
 * What the CLI prints: the window's totals, the queries with the most zero-result searches, and,
 * when `unopenedRows` is given (the same report in its other order), the queries most often left
 * without an open. An open counts only while the result opened is something search still shows,
 * and opened and unopened only over the searches whose client could report one (`reports`).
 */
export function formatSearchQueryReport(
  rows: SearchQueryReportRow[],
  { days, unopenedRows }: { days: number; unopenedRows?: SearchQueryReportRow[] },
): string {
  if (rows.length === 0) return `No searches logged in the last ${days} day(s).`;
  const lines = [
    ...formatSearchQueryReportSummary(rows, days),
    '',
    'Zero-result searches first:',
    ...formatSearchQueryReportTable(rows),
  ];
  const leftUnopened = (unopenedRows ?? []).filter((row) => row.unopenedSearches > 0);
  if (unopenedRows) {
    lines.push(
      '',
      'Most often left without an open (found something, opened nothing):',
      ...(leftUnopened.length > 0 ? formatSearchQueryReportTable(leftUnopened) : ['  none']),
    );
  }
  return lines.join('\n');
}
