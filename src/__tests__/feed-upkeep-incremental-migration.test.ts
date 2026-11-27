import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Database audit, 2026-11-27: the hourly feed upkeep rewrote every row it owned on every run.
 * The pgTAP files named in each block prove identical results against the old functions on a
 * database; this pins each migration's shape.
 */
const migrationsDir = path.resolve(process.cwd(), 'supabase/migrations');
function readMigration(suffix: string) {
  const file = fs.readdirSync(migrationsDir).find((name) => name.endsWith(suffix));
  const sql = file ? fs.readFileSync(path.join(migrationsDir, file), 'utf8') : '';
  return { file, body: sql.replace(/^\s*--.*$/gm, '') };
}

describe('refresh_post_feed_stats refreshes only posts whose rows can change', () => {
  // supabase/tests/database/post_feed_stats_refresh_incremental.test.sql
  const { file, body } = readMigration('_post_feed_stats_refresh_incremental.sql');

  it('replaces the function with the same signature, rights and search path', () => {
    expect(file).toBeTruthy();
    expect(body).toContain("CREATE OR REPLACE FUNCTION public.refresh_post_feed_stats(p_as_of timestamp with time zone DEFAULT timezone('utc'::text, now()), p_limit integer DEFAULT 1000)");
    expect(body).toContain(' RETURNS integer');
    expect(body).not.toContain('SECURITY DEFINER');
    expect(body).toContain("SET search_path TO 'public', 'pg_temp'");
    expect(body).toContain("SET LOCAL lock_timeout = '5s';");
    // CREATE OR REPLACE keeps the grants; nothing here may widen them.
    expect(body).not.toMatch(/\bGRANT\b/);
  });

  it('adds one rotation cursor per refresh, started from the old shared marker', () => {
    expect(body).toContain('ADD COLUMN stats_refreshed_at timestamp with time zone,');
    expect(body).toContain('ADD COLUMN engagement_refreshed_at timestamp with time zone;');
    expect(body).toMatch(/SET stats_refreshed_at = updated_at,\s+engagement_refreshed_at = updated_at;/);
  });

  it('no longer keeps every post that has a row', () => {
    expect(body).not.toContain('existing.post_id IS NOT NULL');
    expect(body).toContain("recent_event.occurred_at >= p_as_of - interval '31 days'");
    expect(body).toContain('IS DISTINCT FROM (');
    expect(body).toContain('HAVING count(*) < 3');
  });

  it('rotates on the 24h row, which every refresh writes, and guards the others', () => {
    expect(body).toContain("AND marker.window_key = '24h'");
    expect(body).toContain('ORDER BY marker.stats_refreshed_at ASC NULLS FIRST, changing.post_id');
    expect(body).toContain('stats_refreshed_at = EXCLUDED.stats_refreshed_at');
    expect(body).toContain("WHERE post_feed_stats.window_key = '24h'");
    expect(body).toContain('RETURN cardinality(v_post_ids);');
    expect(body).not.toContain('v_affected_rows / 3');
  });
});

describe('refresh_post_feed_engagement_stats reads the facts once and refreshes only posts whose rows can change', () => {
  // supabase/tests/database/post_feed_engagement_stats_refresh_incremental.test.sql
  const { file, body } = readMigration('_post_feed_engagement_stats_refresh_incremental.sql');

  it('replaces the function with the same signature, rights and search path', () => {
    expect(file).toBeTruthy();
    expect(body).toContain("CREATE OR REPLACE FUNCTION public.refresh_post_feed_engagement_stats(p_as_of timestamp with time zone DEFAULT timezone('utc'::text, now()), p_limit integer DEFAULT 1000)");
    expect(body).toContain(' RETURNS integer');
    expect(body).not.toContain('SECURITY DEFINER');
    expect(body).toContain("SET search_path TO 'public', 'pg_temp'");
    expect(body).toContain("SET LOCAL lock_timeout = '5s';");
    expect(body).not.toMatch(/\bGRANT\b/);
  });

  it('joins one window row for the marker and reads the 30-day facts once', () => {
    expect(body).toContain("AND marker.window_key = '24h'");
    expect(body).toContain('ORDER BY marker.engagement_refreshed_at ASC NULLS FIRST, changing.post_id');
    expect(body).toContain('engagement_refreshed_at = EXCLUDED.engagement_refreshed_at');
    expect(body).not.toContain('stats_refreshed_at');
    expect(body).not.toContain('min(existing.updated_at)');
    expect(body).toContain('WITH window_facts AS MATERIALIZED (');
    expect(body).toContain("facts.ranked_at >= p_as_of - interval '30 days'");
    expect(body).toContain('LEFT JOIN window_facts AS facts');
    expect(body.match(/FROM public\.feed_delivery_facts/g)).toHaveLength(2);
  });

  it('zeroes posts that still hold counts, and guards unchanged rows', () => {
    expect(body).toContain('counted.served_delivery_count > 0');
    expect(body).toContain("WHERE stats.window_key = '24h'");
    expect(body).toContain('IS DISTINCT FROM (');
    expect(body).toContain('RETURN cardinality(v_post_ids);');
  });
});

describe('refresh_user_interest_weights updates in place', () => {
  // supabase/tests/database/user_interest_weights_refresh_incremental.test.sql
  const { file, body } = readMigration('_user_interest_weights_refresh_in_place.sql');

  it('replaces the function with the same signature, rights and search path', () => {
    expect(file).toBeTruthy();
    expect(body).toContain("CREATE OR REPLACE FUNCTION public.refresh_user_interest_weights(p_as_of timestamp with time zone DEFAULT timezone('utc'::text, now()), p_lookback_days integer DEFAULT 90, p_half_life_days integer DEFAULT 30, p_limit integer DEFAULT 1000)");
    expect(body).toContain(' RETURNS integer');
    expect(body).not.toContain('SECURITY DEFINER');
    expect(body).toContain("SET search_path TO 'public', 'pg_temp'");
    expect(body).toContain("SET LOCAL lock_timeout = '5s';");
    expect(body).not.toMatch(/\bGRANT\b/);
  });

  it('no longer deletes every row of the batch, only the dimensions that disappeared', () => {
    expect(body).not.toMatch(/DELETE FROM public\.user_interest_weights\s+WHERE user_id = ANY\(v_user_ids\);/);
    expect(body).toContain('refreshed AS MATERIALIZED (');
    expect(body).toContain('DELETE FROM public.user_interest_weights AS interests');
    expect(body).toContain('AND NOT EXISTS (');
  });

  it('writes only rows whose values changed, and still records progress', () => {
    expect(body).toContain(') IS DISTINCT FROM (');
    expect(body).toContain('EXCLUDED.weight, EXCLUDED.positive_score');
    expect(body).toContain('INSERT INTO public.user_interest_refresh_state (user_id, refreshed_at)');
    expect(body).toContain('RETURN cardinality(v_user_ids);');
  });
});

/**
 * The write guards: a column a later change adds to an upsert's SET list but forgets in its
 * IS DISTINCT FROM tuple would never be written while the other values stand still. For each
 * upsert, every column the SET list assigns from EXCLUDED, except updated_at and the rotation
 * cursors (written whenever the row is), must be compared on both sides of the guard.
 */
const NOT_GUARDED = new Set(['updated_at', 'stats_refreshed_at', 'engagement_refreshed_at']);

function unguardedColumns(sql: string): string[] {
  // The first upsert in each file is the one that writes the refreshed rows.
  const upsert = sql.slice(sql.indexOf('ON CONFLICT ('));
  const setList = upsert.slice(upsert.indexOf(' SET '), upsert.search(/\n\s*(--[^\n]*\n\s*)*WHERE /));
  const assigned = [...setList.matchAll(/(\w+) = EXCLUDED\.(\w+)/g)]
    .filter(([, column, source]) => column === source)
    .map(([, column]) => column)
    .filter((column) => !NOT_GUARDED.has(column));
  const guardStart = upsert.search(/\n\s*WHERE /);
  const guard = upsert.slice(guardStart, upsert.indexOf(';', guardStart));
  const [stored, excluded] = guard.split('IS DISTINCT FROM');
  if (!excluded) return assigned;
  const storedColumns = new Set([...stored.matchAll(/\w+\.(\w+)/g)].map(([, column]) => column));
  const excludedColumns = new Set([...excluded.matchAll(/EXCLUDED\.(\w+)/g)].map(([, column]) => column));
  return assigned.filter((column) => !storedColumns.has(column) || !excludedColumns.has(column));
}

describe('every write guard compares every column its SET list writes', () => {
  it.each([
    '_post_feed_stats_refresh_incremental.sql',
    '_post_feed_engagement_stats_refresh_incremental.sql',
    '_user_interest_weights_refresh_in_place.sql',
  ])('%s', (suffix) => {
    const { file, body } = readMigration(suffix);
    expect(file).toBeTruthy();
    const assigned = [...body.slice(body.indexOf('ON CONFLICT (')).matchAll(/(\w+) = EXCLUDED\.\1/g)];
    expect(assigned.length).toBeGreaterThan(5);
    expect(unguardedColumns(body)).toEqual([]);
  });

  it('notices a column missing from the guard', () => {
    const sql = `INSERT INTO t AS t (a, b, c, updated_at) SELECT 1
  ON CONFLICT (a) DO UPDATE
  SET b = EXCLUDED.b,
      c = EXCLUDED.c,
      updated_at = EXCLUDED.updated_at
  -- only when changed
  WHERE (t.b) IS DISTINCT FROM (EXCLUDED.b);`;
    expect(unguardedColumns(sql)).toEqual(['c']);
    expect(unguardedColumns(sql.replace('(t.b) IS DISTINCT FROM (EXCLUDED.b)', '(t.b, t.c) IS DISTINCT FROM (EXCLUDED.b, EXCLUDED.c)'))).toEqual([]);
  });
});
