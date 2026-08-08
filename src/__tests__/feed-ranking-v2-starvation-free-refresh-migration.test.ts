import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260808130000_feed_ranking_v2_starvation_free_refresh.sql',
), 'utf8');

describe('feed ranking v2 starvation-free refresh migration', () => {
  it('replaces both uuid-ordered candidate scans', () => {
    // `ORDER BY <uuid> LIMIT p_limit` is a stable order over a growing set, so
    // past p_limit rows the same candidates are reprocessed forever and the
    // rest freeze. Neither function may order by its key alone any more.
    expect(migration).not.toMatch(/ORDER BY facts\.creator_user_id\s*\n\s*LIMIT p_limit/);
    expect(migration).not.toMatch(/ORDER BY facts\.post_id\s*\n\s*LIMIT p_limit/);
  });

  it('takes the least-recently-refreshed candidates first, unrefreshed ones ahead of all', () => {
    // NULLS FIRST is what guarantees a brand new creator or post is not stuck
    // behind every already-computed row.
    expect(migration).toContain(
      'ORDER BY min(existing.updated_at) ASC NULLS FIRST, facts.creator_user_id',
    );
    expect(migration).toContain(
      'ORDER BY min(existing.updated_at) ASC NULLS FIRST, facts.post_id',
    );
  });

  it('joins each function to the table it actually writes', () => {
    // The queue only advances if the joined updated_at is the one this function
    // stamps. refresh_post_feed_engagement_stats writes post_feed_stats, not a
    // table of its own name -- joining the wrong one would never drain.
    expect(migration).toContain('LEFT JOIN public.creator_feed_stats AS existing\n      ON existing.creator_user_id = facts.creator_user_id');
    expect(migration).toContain('LEFT JOIN public.post_feed_stats AS existing\n      ON existing.post_id = facts.post_id');
  });

  it('adds the missing index the creator refresh filters and groups on', () => {
    expect(migration).toContain(
      'CREATE INDEX IF NOT EXISTS feed_delivery_facts_creator_ranked_idx\n  ON public.feed_delivery_facts (creator_user_id, ranked_at)',
    );
  });

  it('keeps both refreshes advisory-locked and limit-validated', () => {
    // Reproduced verbatim from the v2 migration apart from the candidate CTEs;
    // losing either guard here would be silent.
    expect(migration).toContain("pg_try_advisory_xact_lock(hashtextextended('refresh_creator_feed_stats', 0))");
    expect(migration).toContain("pg_try_advisory_xact_lock(hashtextextended('refresh_post_feed_engagement_stats', 0))");
    // One per function, so a copy that dropped a guard shows up as a count.
    expect(migration.match(/RAISE EXCEPTION '[^']*refresh limit must be between 1 and 10000'/g) ?? []).toHaveLength(2);
    expect(migration).toContain('SET search_path = public, pg_temp');
  });

  it('replaces the functions rather than editing the applied v2 migration', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.refresh_creator_feed_stats(');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.refresh_post_feed_engagement_stats(');
  });
});
