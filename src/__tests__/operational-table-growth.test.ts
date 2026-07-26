import { describe, expect, it } from 'vitest';

import {
  collectOperationalTableGrowth,
  evaluateOperationalTableGrowth,
  normalizeOperationalTableGrowthRows,
  OPERATIONAL_TABLE_ROW_BUDGETS,
} from '@/lib/operational-table-growth';

function row(tableName: string, liveRows: number, totalBytes = 1024) {
  return { tableName, liveRows, totalBytes };
}

describe('operational table growth', () => {
  it('normalizes bigint columns that arrive as strings', () => {
    const rows = normalizeOperationalTableGrowthRows([
      { table_name: 'backend_job_runs', live_rows: '15660', total_bytes: '10256384' },
    ]);

    expect(rows).toEqual([
      { tableName: 'backend_job_runs', liveRows: 15660, totalBytes: 10256384 },
    ]);
  });

  it('drops malformed rows rather than reporting a phantom table', () => {
    const rows = normalizeOperationalTableGrowthRows([
      { live_rows: 10 },
      null,
      'nonsense',
      { table_name: 'feed_events', live_rows: 5, total_bytes: 100 },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].tableName).toBe('feed_events');
  });

  it('returns an empty list when the RPC yields no array', () => {
    expect(normalizeOperationalTableGrowthRows(null)).toEqual([]);
    expect(normalizeOperationalTableGrowthRows({})).toEqual([]);
  });

  it('reports ok when every table is inside its budget', () => {
    const report = evaluateOperationalTableGrowth([
      row('backend_job_runs', 15_660),
      row('feed_events', 2_661),
    ]);

    expect(report.status).toBe('ok');
    expect(report.issues).toEqual([]);
  });

  it('warns when a table reaches its warning budget', () => {
    const budget = OPERATIONAL_TABLE_ROW_BUDGETS.backend_job_runs;
    const report = evaluateOperationalTableGrowth([row('backend_job_runs', budget.warning)]);

    expect(report.status).toBe('warning');
    expect(report.issues[0].code).toBe('OPERATIONAL_TABLE_GROWTH_ELEVATED');
    expect(report.issues[0].tableName).toBe('backend_job_runs');
  });

  it('degrades when a table reaches its degraded budget', () => {
    const budget = OPERATIONAL_TABLE_ROW_BUDGETS.backend_job_runs;
    const report = evaluateOperationalTableGrowth([row('backend_job_runs', budget.degraded)]);

    expect(report.status).toBe('degraded');
    expect(report.issues[0].code).toBe('OPERATIONAL_TABLE_GROWTH_SPIKE');
    expect(report.issues[0].message).toContain('Retention is not keeping up');
  });

  it('reports one issue per table and escalates to the worst severity', () => {
    const report = evaluateOperationalTableGrowth([
      row('backend_job_runs', OPERATIONAL_TABLE_ROW_BUDGETS.backend_job_runs.degraded),
      row('feed_events', OPERATIONAL_TABLE_ROW_BUDGETS.feed_events.warning),
      row('feed_sessions', 10),
    ]);

    expect(report.status).toBe('degraded');
    expect(report.issues).toHaveLength(2);
    expect(report.issues.map((issue) => issue.tableName).sort()).toEqual([
      'backend_job_runs',
      'feed_events',
    ]);
  });

  it('applies a default budget to a table with no explicit one', () => {
    const report = evaluateOperationalTableGrowth([row('some_new_table', 600_000)]);

    expect(report.status).toBe('degraded');
    expect(report.issues[0].tableName).toBe('some_new_table');
  });

  it('sums total bytes across tables', () => {
    const report = evaluateOperationalTableGrowth([
      row('backend_job_runs', 10, 1_000),
      row('feed_events', 10, 2_500),
    ]);

    expect(report.totalBytes).toBe(3_500);
  });

  it('collects through the narrow service-role RPC', async () => {
    const calls: string[] = [];
    const client = {
      rpc: async (fn: string) => {
        calls.push(fn);
        return {
          data: [{ table_name: 'backend_job_runs', live_rows: '15660', total_bytes: '10256384' }],
          error: null,
        };
      },
    };

    const report = await collectOperationalTableGrowth(
      client as unknown as Parameters<typeof collectOperationalTableGrowth>[0]
    );

    expect(calls).toEqual(['get_operational_table_growth']);
    expect(report.status).toBe('ok');
    expect(report.tables[0].liveRows).toBe(15660);
  });

  it('throws when the RPC fails so the dashboard reports rather than hides it', async () => {
    const client = {
      rpc: async () => ({ data: null, error: new Error('permission denied') }),
    };

    await expect(collectOperationalTableGrowth(
      client as unknown as Parameters<typeof collectOperationalTableGrowth>[0]
    )).rejects.toThrow('permission denied');
  });
});
