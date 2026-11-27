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

  it('no longer keeps every post that has a row', () => {
    expect(body).not.toContain('existing.post_id IS NOT NULL');
    expect(body).toContain("recent_event.occurred_at >= p_as_of - interval '31 days'");
    expect(body).toContain('IS DISTINCT FROM (');
    expect(body).toContain('HAVING count(*) < 3');
  });

  it('rotates on the 24h row, which every refresh writes, and guards the others', () => {
    expect(body).toContain("AND marker.window_key = '24h'");
    expect(body).toContain('ORDER BY marker.updated_at ASC NULLS FIRST, changing.post_id');
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
