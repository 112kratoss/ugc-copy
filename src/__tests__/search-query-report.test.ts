import { describe, expect, it, vi } from 'vitest';

import {
  fetchSearchQueryReport,
  formatSearchEntryMix,
  formatSearchQueryReport,
  normalizeSearchQueryReportRows,
} from '@/lib/search-query-report';
import { parseSearchReportArguments, runSearchReport } from '../../scripts/ops/search-report';

const rows = [
  {
    query: 'port', searches: '3', zero_result_searches: '2', total_searches: '9', total_zero_result_searches: '6',
    opened_searches: '1', unopened_searches: '0', mean_open_position: '2.50', entry_mix: { typed: 2, recent: 1 },
    total_opened_searches: '2', total_unopened_searches: '1', total_mean_open_position: '3.00',
    total_entry_mix: { typed: 5, recent: 2, suggestion: 1, unknown: 1 },
  },
  {
    query: 'cat', searches: 2, zero_result_searches: 0, total_searches: 9, total_zero_result_searches: 6,
    opened_searches: 1, unopened_searches: 1, mean_open_position: 4, entry_mix: { suggestion: 1, unknown: 1 },
    total_opened_searches: 2, total_unopened_searches: 1, total_mean_open_position: 3,
    total_entry_mix: { typed: 5, recent: 2, suggestion: 1, unknown: 1 },
  },
];
const totals = {
  totalSearches: 9,
  totalZeroResultSearches: 6,
  totalOpenedSearches: 2,
  totalUnopenedSearches: 1,
  totalMeanOpenPosition: 3,
  totalEntryMix: { typed: 5, recent: 2, suggestion: 1, unknown: 1 },
};

describe('search report', () => {
  it('reads bigint and numeric strings, the entry mix, and skips malformed rows', () => {
    expect(normalizeSearchQueryReportRows([...rows, null, { searches: 1 }])).toEqual([
      {
        query: 'port', searches: 3, zeroResultSearches: 2, openedSearches: 1, unopenedSearches: 0,
        meanOpenPosition: 2.5, entryMix: { typed: 2, recent: 1 }, ...totals,
      },
      {
        query: 'cat', searches: 2, zeroResultSearches: 0, openedSearches: 1, unopenedSearches: 1,
        meanOpenPosition: 4, entryMix: { suggestion: 1, unknown: 1 }, ...totals,
      },
    ]);
    expect(normalizeSearchQueryReportRows(null)).toEqual([]);
  });

  it('reads a row with no open, and a database from before the opens were logged', () => {
    const [unopened] = normalizeSearchQueryReportRows([{ ...rows[0], opened_searches: 0, mean_open_position: null }]);
    expect(unopened).toMatchObject({ openedSearches: 0, meanOpenPosition: null });
    const [older] = normalizeSearchQueryReportRows([
      { query: 'port', searches: '3', zero_result_searches: '2', total_searches: '9', total_zero_result_searches: '6' },
    ]);
    expect(older).toMatchObject({
      query: 'port', searches: 3, openedSearches: 0, unopenedSearches: 0, meanOpenPosition: null, entryMix: {},
      totalOpenedSearches: 0, totalMeanOpenPosition: null, totalEntryMix: {},
    });
  });

  it('asks the database function for the window, the limit and the order, and surfaces an error', async () => {
    const rpc = vi.fn(async () => ({ data: rows, error: null }));
    await fetchSearchQueryReport({ rpc }, { days: 14, limit: 20 });
    expect(rpc).toHaveBeenCalledWith('search_query_report', { p_days: 14, p_limit: 20, p_order: 'zero_result' });
    await fetchSearchQueryReport({ rpc }, { days: 14, limit: 20, order: 'unopened' });
    expect(rpc).toHaveBeenLastCalledWith('search_query_report', { p_days: 14, p_limit: 20, p_order: 'unopened' });
    await expect(fetchSearchQueryReport({ rpc: async () => ({ data: null, error: { message: 'no' } }) }, { days: 7, limit: 50 }))
      .rejects.toThrow('no');
  });

  it('prints the totals above the table: zero-result rate, opens, the mean place and the entry mix', () => {
    const text = formatSearchQueryReport(normalizeSearchQueryReportRows(rows), { days: 7 });
    expect(text).toContain('9 searches');
    expect(text).toContain('6 with no results in any kind (66.7%)');
    expect(text).toContain('Opened a result: 2 searches (22.2%)');
    // Of the three searches that found something, one opened nothing.
    expect(text).toContain('found something and opened nothing: 1 (33.3% of the 3 that found something)');
    expect(text).toContain('mean place opened: 3.00');
    expect(text).toContain('Entered by: typed 55.6%, recent 22.2%, suggestion 11.1%, unknown 11.1%.');
    // zero, searches, opened, unopened, place, query, its entry mix.
    expect(text).toMatch(/\n\s+2\s+3\s+1\s+0\s+2\.50 {2}port {2}\[typed 66\.7%, recent 33\.3%\]/u);
    expect(text).toMatch(/\n\s+0\s+2\s+1\s+1\s+4\.00 {2}cat {2}\[suggestion 50\.0%, unknown 50\.0%\]$/u);
    expect(formatSearchQueryReport([], { days: 7 })).toBe('No searches logged in the last 7 day(s).');
  });

  it('prints the queries most often left without an open as a second table, leaving out those that never were', () => {
    const zeroResult = normalizeSearchQueryReportRows(rows);
    const unopened = normalizeSearchQueryReportRows([rows[1], rows[0]]);
    const text = formatSearchQueryReport(zeroResult, { days: 7, unopenedRows: unopened });
    const [, second] = text.split('Most often left without an open (found something, opened nothing):');
    expect(second).toMatch(/cat/u);
    // "port" was never left unopened: it is not in the second table.
    expect(second).not.toMatch(/port/u);
    expect(formatSearchQueryReport(zeroResult, { days: 7, unopenedRows: [zeroResult[0]] })).toMatch(/opened nothing\):\n {2}none$/u);
  });

  it('formats an entry mix by share, then by name, and says when there is none', () => {
    expect(formatSearchEntryMix({ recent: 1, typed: 3, link: 1 })).toBe('typed 60.0%, link 20.0%, recent 20.0%');
    expect(formatSearchEntryMix({})).toBe('none');
  });

  it('prints a logged control character as text, so a planted escape cannot drive the terminal', () => {
    const planted = normalizeSearchQueryReportRows([
      { query: 'x\u001b]0;pwned\u0007\u001b[2J', searches: 1, zero_result_searches: 1, total_searches: 1, total_zero_result_searches: 1 },
    ]);
    const text = formatSearchQueryReport(planted, { days: 7 });
    expect(text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f]/u);
    expect(text).toContain('x\\x1b]0;pwned\\x07\\x1b[2J');
  });

  it('parses and bounds the CLI flags', () => {
    expect(parseSearchReportArguments([])).toEqual({ days: 7, limit: 50, json: false, help: false });
    expect(parseSearchReportArguments(['--days', '30', '--limit', '5', '--json'])).toMatchObject({ days: 30, limit: 5, json: true });
    expect(() => parseSearchReportArguments(['--days', '0'])).toThrow('--days');
    expect(() => parseSearchReportArguments(['--days', '91'])).toThrow('--days');
    expect(() => parseSearchReportArguments(['--limit', '1001'])).toThrow('--limit');
    expect(() => parseSearchReportArguments(['--days'])).toThrow('whole number');
    expect(() => parseSearchReportArguments(['--wat'])).toThrow('Unexpected');
  });

  it('reads the report in both orders and prints both tables, or both as JSON', async () => {
    // The CLI builds its own client: this pins what it asks through the formatter's two inputs.
    const rpc = vi.fn(async (_fn: string, args: Record<string, unknown>) => ({
      data: args.p_order === 'unopened' ? [rows[1]] : rows,
      error: null,
    }));
    const [zeroResult, unopened] = await Promise.all([
      fetchSearchQueryReport({ rpc }, { days: 7, limit: 50, order: 'zero_result' }),
      fetchSearchQueryReport({ rpc }, { days: 7, limit: 50, order: 'unopened' }),
    ]);
    expect(rpc.mock.calls.map(([, args]) => args.p_order)).toEqual(['zero_result', 'unopened']);
    const text = formatSearchQueryReport(zeroResult, { days: 7, unopenedRows: unopened });
    expect(text.indexOf('Zero-result searches first:')).toBeLessThan(text.indexOf('Most often left without an open'));
  });

  it('refuses to run without the service credentials and prints usage on --help', async () => {
    await expect(runSearchReport([], {} as NodeJS.ProcessEnv, () => {})).rejects.toThrow('Missing SUPABASE_URL');
    const print = vi.fn();
    await runSearchReport(['--help'], {} as NodeJS.ProcessEnv, print);
    expect(print.mock.calls[0][0]).toContain('npm run ops:search-report');
  });
});
