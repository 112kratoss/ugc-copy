import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { BACKEND_JOBS_BY_NAME } from '@/lib/backend-jobs';
import { OPERATIONAL_TABLE_ROW_BUDGETS } from '@/lib/operational-table-growth';
import { POST_VIEW_ROLLUP_LIMIT } from '@/lib/post-view-counts';
import { POST_VIEWS_MAX_BATCH, POST_VIEW_SURFACES } from '@/lib/post-views-service';
import { ORPHAN_SKIPPED_TABLES } from '@/lib/storage-orphans';

const MIGRATIONS = path.join(process.cwd(), 'supabase/migrations');
const files = readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort();
const strip = (text: string) => text.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
const marksFile = files.find((name) => name.endsWith('_post_view_counts.sql'));
const totalsFile = files.find((name) => name.endsWith('_post_view_count_totals.sql'));
const read = (name: string | undefined) => (name ? strip(readFileSync(path.join(MIGRATIONS, name), 'utf8')) : '');
const marks = read(marksFile);
const totals = read(totalsFile);

/** The newest migration that defines a function, by its CREATE line. */
function newestDefinition(signature: string): string {
  const defining = files.filter((name) => strip(readFileSync(path.join(MIGRATIONS, name), 'utf8')).includes(signature));
  return read(defining.at(-1));
}

/** One function's definition, from its CREATE line to the end of its body. */
function definition(code: string, signature: string): string {
  const start = code.indexOf(signature);
  if (start < 0) return '';
  const end = code.indexOf('$$;', start);
  return code.slice(start, end < 0 ? undefined : end);
}

/**
 * pgTAP (post_view_counts.test.sql) runs the counting, the cap, the rollup, the hold and the prune;
 * the concurrency rules were checked with parallel sessions (PR #902). This pins what a review
 * reads: where a view may come from, the locks each file takes, who may call what, the backfill's
 * rules, and that the numbers the server code uses are the ones the database holds to.
 */
describe('post view counts migrations', () => {
  it('are two files, the totals after the marks', () => {
    expect(marksFile).toBeDefined();
    expect(totalsFile).toBeDefined();
    expect(totalsFile! > marksFile!).toBe(true);
  });

  it('record views without locking posts against reads: the marks file never alters posts', () => {
    expect(marks).not.toMatch(/ALTER TABLE public\.posts/u);
    expect(marks).not.toMatch(/LOCK TABLE/u);
    expect(totals).toContain(
      'ALTER TABLE public.posts ADD COLUMN view_count bigint NOT NULL DEFAULT 0 CONSTRAINT posts_view_count_check CHECK (view_count >= 0);',
    );
  });

  it('keys a mark by post, viewer and UTC day, an account or a guest with its network', () => {
    expect(marks).toContain('CREATE TABLE public.post_view_marks');
    expect(marks).toContain('viewer_user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE');
    expect(marks).toContain(
      'CREATE UNIQUE INDEX post_view_marks_user_day_idx ON public.post_view_marks (post_id, view_date, viewer_user_id) WHERE viewer_user_id IS NOT NULL;',
    );
    expect(marks).toContain(
      'CREATE UNIQUE INDEX post_view_marks_guest_day_idx ON public.post_view_marks (post_id, view_date, anonymous_key_hash) WHERE anonymous_key_hash IS NOT NULL;',
    );
    // Whole: a post's deletion cascades through it.
    expect(marks).toContain(
      'CREATE INDEX post_view_marks_post_day_network_idx ON public.post_view_marks (post_id, view_date, network_key_hash);',
    );
    expect(marks).toContain(
      '(viewer_user_id IS NOT NULL AND anonymous_key_hash IS NULL AND network_key_hash IS NULL)',
    );
    expect(marks).toContain(
      `surface text NOT NULL CHECK (surface IN (${POST_VIEW_SURFACES.map((surface) => `'${surface}'`).join(', ')}))`,
    );
  });

  it('gives the Data API roles nothing, and the service role reads only', () => {
    for (const table of ['post_view_marks', 'post_view_days']) {
      expect(marks).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`);
      expect(marks).toContain(`REVOKE ALL ON TABLE public.${table} FROM PUBLIC, anon, authenticated, service_role;`);
      expect(marks).toContain(`GRANT SELECT ON TABLE public.${table} TO service_role;`);
    }
    expect(`${marks} ${totals}`).not.toMatch(/CREATE POLICY [^;]* ON public\.post_view_(marks|days)/u);
  });

  it('lets the server call the batch and the rollup, and nothing beneath them', () => {
    expect(marks).toContain('GRANT EXECUTE ON FUNCTION public.record_post_views(uuid, text, text, jsonb) TO service_role;');
    expect(totals).toContain('GRANT EXECUTE ON FUNCTION public.rollup_post_views(timestamptz, integer) TO service_role;');
    expect(marks).toContain(
      'REVOKE ALL ON FUNCTION public.record_post_view(uuid, uuid, text, text, text, timestamptz) FROM PUBLIC, anon, authenticated, service_role;',
    );
    expect(totals).toContain(
      'REVOKE ALL ON FUNCTION public.apply_post_view_marks(bigint[], timestamptz) FROM PUBLIC, anon, authenticated, service_role;',
    );
    for (const [code, fn] of [
      [marks, 'record_post_view('],
      [marks, 'record_post_views('],
      [marks, 'count_feed_impression_as_post_view('],
      [totals, 'apply_post_view_marks('],
      [totals, 'rollup_post_views('],
    ] as const) {
      expect(definition(code, `CREATE OR REPLACE FUNCTION public.${fn}`)).toContain("SECURITY DEFINER SET search_path = ''");
    }
  });

  it('counts only a public, visible post, never its creator, a guest held to its network', () => {
    const record = definition(marks, 'CREATE OR REPLACE FUNCTION public.record_post_view(');
    expect(record).toContain("post.visibility = 'public'");
    expect(record).toContain('post.archived_at IS NULL');
    expect(record).toContain('post.tombstoned_at IS NULL');
    expect(record).toContain("post.review_status = 'visible'");
    expect(record).toContain('post.user_id IS DISTINCT FROM p_viewer_user_id');
    expect(record).toContain('OR p_network_key_hash IS NULL');
    expect(record).toContain('LIMIT 20');
    expect(record).toContain('IF v_network_guests >= 20 THEN RETURN false;');
    // The day is the server's: no caller picks it.
    expect(record).toContain("(coalesce(p_viewed_at, now()) AT TIME ZONE 'UTC')::date");
    expect(record).not.toContain('RAISE EXCEPTION');
  });

  it('never makes an account\'s view wait, and counts a network\'s guests one at a time', () => {
    const record = definition(marks, 'CREATE OR REPLACE FUNCTION public.record_post_view(');
    // An account: a plain read, then a lock it skips when it is taken.
    expect(record).toContain("IF NOT pg_try_advisory_xact_lock(hashtextextended( 'post_view:'");
    // A guest: the network's lock, waited for, around the count and the insert.
    expect(record).toContain("PERFORM pg_advisory_xact_lock(hashtextextended( 'post_view_network:'");
    const batch = definition(marks, 'CREATE OR REPLACE FUNCTION public.record_post_views(');
    // In post order, so two requests never wait on each other in a cycle.
    expect(batch).toContain("ORDER BY value->>'postId'");
    expect(batch).toContain(`IF jsonb_array_length(p_views) > ${POST_VIEWS_MAX_BATCH} THEN`);
    expect(batch).toContain("RAISE EXCEPTION 'A guest''s post view needs its network key'");
    expect(batch).toContain('v_now timestamptz := now();');
  });

  it('counts a feed impression only from Home or the feed reel, by an account', () => {
    expect(marks).toContain(
      "CREATE TRIGGER feed_events_count_post_view AFTER INSERT ON public.feed_events FOR EACH ROW WHEN ( NEW.event_type = 'impression' AND NEW.source_surface IN ('feed', 'showcase-reel') AND NEW.viewer_user_id IS NOT NULL ) EXECUTE FUNCTION public.count_feed_impression_as_post_view();",
    );
    const trigger = definition(marks, 'CREATE OR REPLACE FUNCTION public.count_feed_impression_as_post_view(');
    expect(trigger).toContain('NEW.received_at');
    expect(trigger).not.toContain('occurred_at');
  });

  it('backfills the impressions the feed holds as uncounted marks, a post\'s guests held to 20 a day', () => {
    const trigger = marks.indexOf('CREATE TRIGGER feed_events_count_post_view');
    const backfill = marks.indexOf('WITH impressions AS (');
    expect(trigger).toBeGreaterThan(0);
    expect(backfill).toBeGreaterThan(trigger);
    const statement = marks.slice(backfill, marks.indexOf('ON CONFLICT DO NOTHING;', backfill));
    expect(statement).toContain("events.event_type = 'impression'");
    expect(statement).toContain("events.source_surface IN ('feed', 'showcase-reel')");
    expect(statement).toContain('post.user_id IS DISTINCT FROM events.viewer_user_id');
    expect(statement).toContain("post.review_status = 'visible'");
    expect(statement).toContain('PARTITION BY impressions.post_id, impressions.view_date, impressions.viewer_user_id IS NULL');
    expect(statement).toContain('WHERE ranked.viewer_user_id IS NOT NULL OR ranked.arrival <= 20');
    expect(statement).not.toContain('counted_at');
  });

  it('never counts a view as an edit', () => {
    expect(totals).toContain(
      'DROP TRIGGER IF EXISTS posts_set_updated_at ON public.posts; CREATE TRIGGER posts_set_updated_at BEFORE UPDATE ON public.posts FOR EACH ROW WHEN (OLD.view_count IS NOT DISTINCT FROM NEW.view_count) EXECUTE FUNCTION public.touch_updated_at_column();',
    );
  });

  it('rolls up without waiting, holds back a refused post, and prunes what is counted or held', () => {
    const rollup = definition(totals, 'CREATE OR REPLACE FUNCTION public.rollup_post_views(');
    expect(rollup).toContain('SET CONSTRAINTS ALL IMMEDIATE;');
    expect(rollup).toContain("pg_try_advisory_xact_lock(hashtextextended('rollup_post_views', 0))");
    // Posts first, then marks, each SKIP LOCKED: a delete or an edit is never waited on.
    const postsLock = rollup.indexOf('FOR NO KEY UPDATE SKIP LOCKED');
    const marksLock = rollup.indexOf('FOR UPDATE SKIP LOCKED');
    expect(postsLock).toBeGreaterThan(0);
    expect(marksLock).toBeGreaterThan(postsLock);
    expect(rollup).toContain('(marks.retry_after IS NULL OR marks.retry_after <= v_as_of)');
    expect(rollup).toContain("SET retry_after = v_as_of + interval '1 hour'");
    expect(rollup).toContain('v_posts_failed := v_posts_failed + 1;');
    expect(rollup).toContain('(marks.counted_at IS NOT NULL OR marks.retry_after IS NOT NULL) AND marks.view_date < v_today - 2');
    expect(rollup).toContain('days.view_date < v_today - 400');
    expect(rollup).toContain('p_limit > 50000');
    expect(marks).toContain(
      'CREATE INDEX post_view_marks_prunable_day_idx ON public.post_view_marks (view_date, id) WHERE counted_at IS NOT NULL OR retry_after IS NOT NULL;',
    );
    expect(POST_VIEW_ROLLUP_LIMIT).toBeLessThanOrEqual(50_000);
  });

  it('is still in the newest definition of the creator totals and the growth accounting', () => {
    expect(newestDefinition('CREATE OR REPLACE FUNCTION public.get_creator_profile_stats(p_creator_id uuid)'))
      .toContain("'totalViews', post_stats.total_views");
    const growth = newestDefinition('CREATE OR REPLACE FUNCTION public.get_operational_table_growth()');
    expect(growth).toContain("'post_view_marks',");
    expect(growth).toContain("'post_view_days',");
    // Everything the accounting reported before is still there.
    expect(growth).toContain("'search_result_opens',");
    expect(growth).toContain("'feed_events',");
  });

  it('registers both tables where every new table must be', () => {
    expect(ORPHAN_SKIPPED_TABLES.post_view_marks).toBeDefined();
    expect(ORPHAN_SKIPPED_TABLES.post_view_days).toBeDefined();
    expect(OPERATIONAL_TABLE_ROW_BUDGETS.post_view_marks).toBeDefined();
    expect(OPERATIONAL_TABLE_ROW_BUDGETS.post_view_days).toBeDefined();
  });

  it('is counted by a job on the shared scheduler', () => {
    expect(BACKEND_JOBS_BY_NAME['post-view-counts']).toMatchObject({
      route: '/api/cron/post-view-counts',
      schedule: '*/10 * * * *',
      dispatch: 'scheduler',
    });
  });
});
