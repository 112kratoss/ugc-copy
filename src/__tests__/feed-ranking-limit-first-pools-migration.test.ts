import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

function readMigration(name: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), 'supabase/migrations', name), 'utf8');
}

const migration = readMigration('20260809140000_feed_ranking_limit_first_pools.sql');
const original = readMigration('20260711064036_feed_personalization_system.sql');

/**
 * The executable query, with the header commentary stripped.
 *
 * The header necessarily *names* the construct it removes, so asserting against
 * the whole file makes the explanation fail the test that checks the fix.
 */
const migrationBody = migration.slice(migration.indexOf('  RETURN QUERY'));

/** The scoring stage, from the components CTE to the end of the function. */
function scoringStage(sql: string): string {
  const start = sql.indexOf('  components AS (');
  const end = sql.indexOf('  LIMIT p_limit;', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe('feed ranking limit-first pools migration', () => {
  it('removes the unbounded eligible CTE that made cost linear in catalog size', () => {
    // The whole finding: `eligible AS MATERIALIZED` selected every public
    // visible post and the pools applied their LIMITs afterwards.
    expect(original).toContain('WITH eligible AS MATERIALIZED (');
    expect(migrationBody).not.toContain('eligible AS MATERIALIZED');
    expect(migrationBody).not.toContain('FROM eligible AS e');
  });

  it('gives every pool its own bounded row source against posts', () => {
    // Each pool must reach `posts` directly. Routing any of them back through a
    // shared CTE reintroduces the materialisation this migration removes,
    // because a CTE referenced more than once is never inlined.
    for (const pool of ['following_pool', 'interest_pool', 'trending_pool', 'recent_pool', 'exploration_pool']) {
      const body = migration.slice(migration.indexOf(`  ${pool} AS (`), migration.indexOf(`  ${pool} AS (`) + 2600);
      expect(body, `${pool} should select from a real table, not a shared CTE`).toMatch(/FROM public\.(posts|post_feed_stats|follows|user_interest_weights)/);
      expect(body, `${pool} must bound itself`).toContain('LIMIT LEAST(p_limit');
    }
  });

  it('materialises the viewer feedback lists rather than the catalog', () => {
    // The inversion that made the rewrite work. As correlated NOT EXISTS these
    // were 12,500 index probes inside one pool, evaluated before any LIMIT
    // could apply, and they forced a bitmap scan that could not stop early.
    // Their size is bounded by one viewer's behaviour, so materialising them is
    // safe where materialising posts was not.
    expect(migration).toContain('viewer_hidden_posts AS MATERIALIZED (');
    expect(migration).toContain('viewer_hidden_creators AS MATERIALIZED (');
    // And no pool may go back to probing the feedback tables per row.
    const pools = migration.slice(migration.indexOf('  following_pool AS ('), migration.indexOf('  pooled AS ('));
    expect(pools).not.toContain('public.feed_user_post_feedback');
    expect(pools).not.toContain('public.feed_user_creator_feedback');
  });

  it('bounds the exploration pool’s unrated branch instead of anti-joining the catalog', () => {
    // Unbounded this cost 151,808 buffers to return zero rows, because it
    // probed the stats index once per post in the catalog.
    const exploration = migration.slice(
      migration.indexOf('  exploration_pool AS ('),
      migration.indexOf('  pooled AS ('),
    );
    const antiJoin = exploration.indexOf('FROM public.post_feed_stats AS stats\n        WHERE stats.post_id = recent_unrated.id');
    expect(antiJoin, 'the unrated anti-join must run over a bounded subquery').toBeGreaterThan(-1);
    expect(exploration).toContain('recent_unrated');
  });

  it('adds the one index the following pool needs, with all three predicates', () => {
    // Every pre-existing owner-scoped index omits one of these: without
    // `visibility` or without `review_status` the planner leaves a filter the
    // index cannot satisfy, falls back to a bitmap scan, and loses the ordering
    // that lets it stop at the LIMIT.
    const index = migration.slice(migration.indexOf('CREATE INDEX IF NOT EXISTS posts_public_visible_owner_recent_idx'));
    expect(index).toContain('ON public.posts (user_id, created_at DESC, id DESC)');
    expect(index).toContain("WHERE visibility = 'public'");
    expect(index).toContain('AND archived_at IS NULL');
    expect(index).toContain("AND review_status = 'visible'");
  });

  it('reproduces the scoring stage verbatim, so ranking cannot drift through the rewrite', () => {
    // The only intended difference is the row source the scoring stage reads
    // from. Anything else would silently change what users are shown, which no
    // buffer measurement would catch.
    const before = scoringStage(original);
    const after = scoringStage(migration);
    expect(after).toBe(before.replace('JOIN eligible AS e ON e.id = d.post_id', 'JOIN candidate_posts AS e ON e.id = d.post_id'));
  });

  it('keeps the guard rails and the function contract', () => {
    expect(migration).toContain('Feed candidate limit must be between 1 and 500');
    expect(migration).toContain('Feed candidate timestamp is required');
    expect(migration).toContain('SECURITY INVOKER');
    expect(migration).toContain('SET search_path = public, pg_temp');
  });

  it('leaves the shadow v2 function alone and says so', () => {
    // v2 carries the same unbounded CTE but serves no traffic. Rewriting it
    // blind would be a second untested ranking change; leaving it silent would
    // let a later promotion reintroduce the finding, which is how F13's
    // starvation bug reached v2 in the first place.
    expect(migration).not.toContain('get_ranked_feed_candidates_v2(');
    expect(migration).toContain('gate before');
    expect(migration).toContain('promoting v2');
  });
});
