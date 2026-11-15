import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { OPERATIONAL_TABLE_ROW_BUDGETS } from '@/lib/operational-table-growth';
import { ORPHAN_SKIPPED_TABLES } from '@/lib/storage-orphans';
import {
  SEARCH_ENTRIES,
  SEARCH_OPEN_KINDS,
  SEARCH_OPEN_MAX_POSITION,
} from '../../ugc-mobile/lib/public-search-policy/search-open-log';

const MIGRATIONS = path.join(process.cwd(), 'supabase/migrations');
const files = readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort();
const strip = (text: string) => text.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
const file = files.find((name) => name.endsWith('_search_open_log.sql'));
const sql = file ? readFileSync(path.join(MIGRATIONS, file), 'utf8') : '';
const code = strip(sql);

/** The newest migration that defines a function, by its CREATE line. */
function newestDefinition(signature: string): string {
  const defining = files.filter((name) => strip(readFileSync(path.join(MIGRATIONS, name), 'utf8')).includes(signature));
  const newest = defining.at(-1);
  return newest ? strip(readFileSync(path.join(MIGRATIONS, newest), 'utf8')) : '';
}

const list = (values: readonly string[]) => values.map((value) => `'${value}'`).join(', ');

/**
 * pgTAP (search_open_log.test.sql) runs the table, the sweep and the report. This pins the shape a
 * review reads: what a row may hold, who may touch it, where it is registered, and that the names
 * the clients send are the names the database takes.
 */
describe('search open log migration', () => {
  it('is one migration, stamped after the search log it extends', () => {
    expect(file).toBeDefined();
    expect(file! > '20261114215420').toBe(true);
  });

  it('adds a nullable entry to the search row, so the app live during the release still inserts', () => {
    expect(code).toContain(
      `ALTER TABLE public.search_query_events ADD COLUMN entry text CHECK (entry IS NULL OR entry IN (${list(SEARCH_ENTRIES)}))`,
    );
    expect(code).not.toMatch(/ADD COLUMN entry text NOT NULL/iu);
  });

  it('holds the query, tab, order, entry, visitor code and what was opened, bounded by checks', () => {
    expect(code).toContain('CREATE TABLE public.search_result_opens');
    expect(code).toContain('id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY');
    expect(code).toContain('created_at timestamptz NOT NULL DEFAULT now()');
    expect(code).toContain('query text NOT NULL CHECK (char_length(query) BETWEEN 1 AND 100)');
    expect(code).toContain("search_type text NOT NULL CHECK (search_type IN ('top', 'creators', 'posts', 'recipes'))");
    expect(code).toContain("sort text CHECK (sort IS NULL OR sort IN ('top', 'latest'))");
    expect(code).toContain(`entry text CHECK (entry IS NULL OR entry IN (${list(SEARCH_ENTRIES)}))`);
    expect(code).toContain("visitor_day text NOT NULL CHECK (visitor_day ~ '^[0-9a-f]{64}$')");
    expect(code).toContain(`result_kind text NOT NULL CHECK (result_kind IN (${list(SEARCH_OPEN_KINDS)}))`);
    expect(code).toContain(`result_position integer NOT NULL CHECK (result_position BETWEEN 1 AND ${SEARCH_OPEN_MAX_POSITION})`);
    // An id is a uuid or an entity id: no handle, title or URL fits.
    expect(code).toContain("WHEN result_kind = 'entity' THEN result_id ~ '^(model|tool):");
    expect(code).toContain("ELSE result_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'");
    // No user, network, device or signed-in column: nothing that identifies a person.
    const table = code.slice(code.indexOf('CREATE TABLE public.search_result_opens'), code.indexOf('COMMENT ON TABLE public.search_result_opens'));
    expect(table).not.toMatch(/user_id|signed_in|ip_address|network|user_agent|device|references auth\.users/iu);
  });

  it('is backend-owned and append-only: RLS on, no policy, service role select and insert', () => {
    expect(code).toContain('ALTER TABLE public.search_result_opens ENABLE ROW LEVEL SECURITY');
    expect(code).not.toMatch(/CREATE POLICY/iu);
    expect(code).toContain('REVOKE ALL ON TABLE public.search_result_opens FROM PUBLIC, anon, authenticated, service_role');
    expect(code).toContain('GRANT SELECT, INSERT ON TABLE public.search_result_opens TO service_role');
    expect(code).not.toMatch(/GRANT [^;]*(UPDATE|DELETE|TRUNCATE)[^;]*search_result_opens/iu);
    expect(code).not.toMatch(/GRANT [^;]*search_result_opens[^;]*TO[^;]*(anon|authenticated)/iu);
  });

  it('replaces the report with one SECURITY DEFINER function on an empty search_path, service-role only', () => {
    expect(code).toContain('DROP FUNCTION public.search_query_report(integer, integer)');
    const report = code.slice(
      code.indexOf('CREATE FUNCTION public.search_query_report('),
      code.indexOf('REVOKE ALL ON FUNCTION public.search_query_report'),
    );
    expect(report).toContain("p_days integer DEFAULT 7, p_limit integer DEFAULT 50, p_order text DEFAULT 'zero_result'");
    expect(report).toContain("SECURITY DEFINER SET search_path = ''");
    // The first five columns are the ones an older checkout's CLI reads.
    expect(report).toContain('RETURNS TABLE ( query text, searches bigint, zero_result_searches bigint, total_searches bigint, total_zero_result_searches bigint,');
    expect(code).toContain('REVOKE ALL ON FUNCTION public.search_query_report(integer, integer, text) FROM PUBLIC, anon, authenticated');
    expect(code).toContain('GRANT EXECUTE ON FUNCTION public.search_query_report(integer, integer, text) TO service_role');
    // With an empty search_path every relation is named with its schema.
    for (const relation of [
      'search_result_opens', 'search_query_events', 'post_search_documents', 'posts',
      'creator_search_documents', 'marketplace_bundle_listings', 'post_search_entities',
    ]) {
      expect(report, relation).toContain(`public.${relation} AS`);
      expect(report, relation).not.toMatch(new RegExp(`(FROM|JOIN) ${relation}\\b`, 'u'));
    }
  });

  it('counts an open only while its id is something search shows the public', () => {
    const report = code.slice(code.indexOf('CREATE FUNCTION public.search_query_report('), code.indexOf('REVOKE ALL ON FUNCTION public.search_query_report'));
    expect(report).toContain("WHEN 'post' THEN EXISTS ( SELECT 1 FROM public.post_search_documents AS documents JOIN public.posts AS posts ON posts.id = documents.post_id WHERE documents.post_id = t.result_id::uuid AND posts.is_nsfw = false )");
    expect(report).toContain("WHEN 'creator' THEN EXISTS ( SELECT 1 FROM public.creator_search_documents AS documents WHERE documents.creator_user_id = t.result_id::uuid )");
    expect(report).toContain("WHEN 'recipe' THEN EXISTS ( SELECT 1 FROM public.marketplace_bundle_listings AS listings WHERE listings.bundle_id = t.result_id::uuid AND listings.listable )");
    expect(report).toContain("WHEN 'entity' THEN EXISTS (");
    expect(report).toContain('ELSE false');
  });

  // Only a client that sends an entry also reports opens (review of #826, S1): a search with none
  // is a search, and neither opened nor unopened.
  it('counts opened and unopened only over the searches whose client could report an open', () => {
    const report = code.slice(code.indexOf('CREATE FUNCTION public.search_query_report('), code.indexOf('REVOKE ALL ON FUNCTION public.search_query_report'));
    expect(report).toContain("count(*) FILTER (WHERE p.entry <> 'unknown') AS reporting_searches");
    expect(report).toContain("count(*) FILTER (WHERE p.entry <> 'unknown' AND p.opens IS NOT NULL) AS opened_searches");
    expect(report).toContain("count(*) FILTER (WHERE p.entry <> 'unknown' AND p.opens IS NULL AND NOT p.is_zero) AS unopened_searches");
    expect(report).toContain("coalesce(sum(p.position_sum) FILTER (WHERE p.entry <> 'unknown'), 0) AS position_sum");
    // Added at the end, so the columns an older reader names keep their places.
    expect(report).toContain('total_entry_mix jsonb, reporting_searches bigint, total_reporting_searches bigint )');
  });

  it('has no entry for "search instead for": no search row could hold it', () => {
    expect(code).not.toContain("'correction'");
    expect(SEARCH_ENTRIES).toHaveLength(7);
  });

  it('keeps the report a sort: each row compared with the next only, each opened id looked up once', () => {
    const report = code.slice(code.indexOf('CREATE FUNCTION public.search_query_report('), code.indexOf('REVOKE ALL ON FUNCTION public.search_query_report'));
    expect(report).toContain('lead(w.created_at) OVER visitor');
    expect(report).toContain('SELECT DISTINCT r.result_kind, r.result_id FROM open_rows AS r');
    expect(report).not.toMatch(/NOT EXISTS/iu);
  });

  it('prunes the opens at the search log’s 90 days inside the existing sweep, its signature unchanged', () => {
    expect(code).toContain('CREATE OR REPLACE FUNCTION public.prune_operational_backend_data(');
    expect(code).toContain('p_expired_job_lock_retention_days integer DEFAULT 1 )');
    expect(code).toContain('v_search_query_retention_days CONSTANT integer := 90');
    expect(code).toContain('FROM public.search_result_opens WHERE created_at < v_now - make_interval(days => v_search_query_retention_days)');
    expect(code).toContain("'search_result_opens_deleted', v_search_result_opens_deleted");
    expect(code).toContain('OR v_search_result_opens_deleted >= v_max_deletes');
    // And still everything the sweep pruned before it.
    expect(code).toContain("'search_query_events_deleted', v_search_query_events_deleted");
    expect(code).toContain("'search_visitor_day_keys_deleted', v_search_visitor_day_keys_deleted");
    expect(code).toContain("'expired_job_locks_deleted', v_expired_job_locks_deleted");
  });

  it('is counted by the growth accounting and registered in code', () => {
    expect(code).toContain("'search_result_opens',");
    expect(OPERATIONAL_TABLE_ROW_BUDGETS.search_result_opens).toBeDefined();
    expect(ORPHAN_SKIPPED_TABLES.search_result_opens).toBeDefined();
  });

  // Two migrations that each replace a whole function do not conflict in git: the later stamp
  // silently drops the other's part. These fail on a tree where a newer migration re-creates the
  // sweep or the growth function from a copy that predates this one.
  it('is still in the newest definition of the sweep and of the growth accounting', () => {
    const sweep = newestDefinition('CREATE OR REPLACE FUNCTION public.prune_operational_backend_data(');
    expect(sweep).toContain('DELETE FROM public.search_result_opens AS opens');
    expect(sweep).toContain("'search_result_opens_deleted', v_search_result_opens_deleted");
    expect(sweep).toContain('DELETE FROM public.search_query_events AS events');
    const growth = newestDefinition('CREATE OR REPLACE FUNCTION public.get_operational_table_growth()');
    expect(growth).toContain("'search_result_opens',");
    expect(growth).toContain("'search_query_events',");
  });
});
