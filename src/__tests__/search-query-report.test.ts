import { describe, expect, it, vi } from 'vitest';

import {
  fetchSearchQueryReport,
  formatSearchQueryReport,
  normalizeSearchQueryReportRows,
} from '@/lib/search-query-report';
import { parseSearchReportArguments, runSearchReport } from '../../scripts/ops/search-report';

const rows = [
  { query: 'port', searches: '3', zero_result_searches: '2', total_searches: '9', total_zero_result_searches: '6' },
  { query: 'cat', searches: 2, zero_result_searches: 0, total_searches: 9, total_zero_result_searches: 6 },
];

describe('search report', () => {
  it('reads bigint strings and skips malformed rows', () => {
    expect(normalizeSearchQueryReportRows([...rows, null, { searches: 1 }])).toEqual([
      { query: 'port', searches: 3, zeroResultSearches: 2, totalSearches: 9, totalZeroResultSearches: 6 },
      { query: 'cat', searches: 2, zeroResultSearches: 0, totalSearches: 9, totalZeroResultSearches: 6 },
    ]);
    expect(normalizeSearchQueryReportRows(null)).toEqual([]);
  });

  it('asks the database function for the window and the limit, and surfaces an error', async () => {
    const rpc = vi.fn(async () => ({ data: rows, error: null }));
    await fetchSearchQueryReport({ rpc }, { days: 14, limit: 20 });
    expect(rpc).toHaveBeenCalledWith('search_query_report', { p_days: 14, p_limit: 20 });
    await expect(fetchSearchQueryReport({ rpc: async () => ({ data: null, error: { message: 'no' } }) }, { days: 7, limit: 50 }))
      .rejects.toThrow('no');
  });

  it('prints the totals and zero-result rate above the table', () => {
    const text = formatSearchQueryReport(normalizeSearchQueryReportRows(rows), { days: 7 });
    expect(text).toContain('9 searches');
    expect(text).toContain('6 with no results in any kind (66.7%)');
    expect(text.split('\n').at(-2)).toMatch(/2\s+3\s+port/u);
    expect(formatSearchQueryReport([], { days: 7 })).toBe('No searches logged in the last 7 day(s).');
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

  it('refuses to run without the service credentials and prints usage on --help', async () => {
    await expect(runSearchReport([], {} as NodeJS.ProcessEnv, () => {})).rejects.toThrow('Missing SUPABASE_URL');
    const print = vi.fn();
    await runSearchReport(['--help'], {} as NodeJS.ProcessEnv, print);
    expect(print.mock.calls[0][0]).toContain('npm run ops:search-report');
  });
});
