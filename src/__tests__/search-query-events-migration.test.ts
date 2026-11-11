import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { OPERATIONAL_TABLE_ROW_BUDGETS } from '@/lib/operational-table-growth';
import { ORPHAN_SKIPPED_TABLES } from '@/lib/storage-orphans';

const MIGRATIONS = path.join(process.cwd(), 'supabase/migrations');
const file = readdirSync(MIGRATIONS).find((name) => name.endsWith('_search_query_events.sql'));
const sql = file ? readFileSync(path.join(MIGRATIONS, file), 'utf8') : '';
const code = sql.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();

/**
 * pgTAP (search_query_events.test.sql) runs the table, the sweep and the report. This pins the
 * shape a review reads: what a row may hold, who may touch it, and where it is registered.
 */
describe('search_query_events migration', () => {
  it('is one migration, stamped after the search recall migration', () => {
    expect(file).toBeDefined();
    expect(file! > '20261111224010').toBe(true);
  });

  it('holds the normalized query, type, flag, visitor hash and counts, bounded by checks', () => {
    expect(code).toContain('CREATE TABLE public.search_query_events');
    expect(code).toContain('id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY');
    expect(code).toContain('created_at timestamptz NOT NULL DEFAULT now()');
    expect(code).toContain('query text NOT NULL CHECK (char_length(query) BETWEEN 1 AND 100)');
    expect(code).toContain("search_type text NOT NULL CHECK (search_type IN ('top', 'creators', 'posts', 'recipes'))");
    expect(code).toContain('signed_in boolean NOT NULL');
    expect(code).toContain("visitor_day text NOT NULL CHECK (visitor_day ~ '^[0-9a-f]{64}$')");
    for (const column of ['creator_count', 'post_count', 'recipe_count']) {
      expect(code).toContain(`${column} integer NOT NULL CHECK (${column} >= 0)`);
    }
    // No user, network or device column: nothing that identifies a person.
    const table = code.slice(code.indexOf('CREATE TABLE public.search_query_events'), code.indexOf('COMMENT ON TABLE public.search_query_events'));
    expect(table).not.toMatch(/user_id|ip_address|network|user_agent|references auth\.users/iu);
  });

  it('is backend-owned and append-only: RLS on, no policy, service role select and insert', () => {
    expect(code).toContain('ALTER TABLE public.search_query_events ENABLE ROW LEVEL SECURITY');
    expect(code).not.toMatch(/CREATE POLICY/iu);
    expect(code).toContain('REVOKE ALL ON TABLE public.search_query_events FROM PUBLIC, anon, authenticated, service_role');
    expect(code).toContain('GRANT SELECT, INSERT ON TABLE public.search_query_events TO service_role');
    expect(code).not.toMatch(/GRANT [^;]*(UPDATE|DELETE|TRUNCATE)[^;]*search_query_events/iu);
  });

  it('keeps the report service-role only', () => {
    expect(code).toContain('REVOKE ALL ON FUNCTION public.search_query_report(integer, integer) FROM PUBLIC, anon, authenticated');
    expect(code).toContain('GRANT EXECUTE ON FUNCTION public.search_query_report(integer, integer) TO service_role');
  });

  it('prunes at 90 days inside the existing sweep, with its signature unchanged', () => {
    expect(code).toContain('CREATE OR REPLACE FUNCTION public.prune_operational_backend_data(');
    expect(code).toContain('v_search_query_retention_days CONSTANT integer := 90');
    expect(code).toContain('FROM public.search_query_events WHERE created_at < v_now - make_interval(days => v_search_query_retention_days)');
    expect(code).toContain("'search_query_events_deleted', v_search_query_events_deleted");
    expect(code).toContain('p_expired_job_lock_retention_days integer DEFAULT 1 )');
  });

  it('is counted by the growth accounting and registered in code', () => {
    expect(code).toContain("'search_query_events',");
    expect(OPERATIONAL_TABLE_ROW_BUDGETS.search_query_events).toBeDefined();
    expect(ORPHAN_SKIPPED_TABLES.search_query_events).toBeDefined();
  });
});
