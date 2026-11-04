import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { OPERATIONAL_TABLE_ROW_BUDGETS } from '@/lib/operational-table-growth';

const MIGRATION_PATH = path.join(
  process.cwd(),
  'supabase/migrations/20261104140642_operational_growth_covers_blind_spots.sql',
);
const PREVIOUS_PATH = path.join(
  process.cwd(),
  'supabase/migrations/20260822121000_complete_operational_growth_accounting.sql',
);

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
/** Drops `--` comments. */
const code = (text: string) => normalize(text.replace(/--[^\n]*/g, ''));

function watchedTables(sql: string) {
  const list = sql.slice(sql.indexOf('stats.relname = ANY (ARRAY['), sql.indexOf('])', sql.indexOf('stats.relname = ANY (ARRAY[')));
  return [...list.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
}

/**
 * pgTAP (operational_growth_blind_spots.test.sql) asserts the rows the report
 * returns and the exact guest count. This pins the list against the one it
 * replaces, and that every reported name has a budget.
 */
describe('the operational growth blind-spots migration', () => {
  const sql = code(readFileSync(MIGRATION_PATH, 'utf8'));
  const previous = code(readFileSync(PREVIOUS_PATH, 'utf8'));

  it('keeps every table the report watched and adds the audit\'s blind spots', () => {
    const before = watchedTables(previous);
    const after = watchedTables(sql);
    expect(before.length).toBe(18);
    for (const table of before) expect(after, table).toContain(table);
    for (const table of [
      'ai_usage_events', 'backend_job_locks', 'feed_viewer_daily', 'mobile_notifications',
      'mobile_push_deliveries', 'onboarding_events', 'playback_metrics', 'playback_metrics_daily_rollup',
    ]) {
      expect(after, table).toContain(table);
    }
    expect([...after].sort()).toEqual(after);
  });

  it('reports auth.users as a table and counts live guests without double-counting bytes', () => {
    expect(sql).toContain("SELECT 'auth.users', stats.n_live_tup, pg_catalog.pg_total_relation_size(stats.relid) FROM pg_catalog.pg_stat_user_tables AS stats WHERE stats.schemaname = 'auth' AND stats.relname = 'users'");
    expect(sql).toContain("SELECT 'guest_identities', ( SELECT count(*) FROM auth.users AS guest WHERE guest.is_anonymous AND guest.deleted_at IS NULL ), 0::bigint");
  });

  it('keeps the same columns and stays service-role only', () => {
    expect(sql).toContain('RETURNS TABLE ( table_name text, live_rows bigint, total_bytes bigint )');
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.get_operational_table_growth() FROM PUBLIC, anon, authenticated;');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.get_operational_table_growth() TO service_role;');
  });

  it('gives every new row an explicit budget rather than the default', () => {
    for (const table of [
      'ai_usage_events', 'backend_job_locks', 'feed_viewer_daily', 'mobile_notifications',
      'mobile_push_deliveries', 'onboarding_events', 'playback_metrics', 'auth.users', 'guest_identities',
    ]) {
      expect(OPERATIONAL_TABLE_ROW_BUDGETS[table], table).toBeDefined();
    }
  });
});
