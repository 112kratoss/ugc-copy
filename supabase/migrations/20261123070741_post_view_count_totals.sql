-- Post view counts, part two (after 20261123070740_post_view_counts, which
-- records views): each post's lifetime total, and the rollup that writes it
-- (docs/plans/post-view-counts-2026-11-23.md).
--
-- 1. posts.view_count: the lifetime total, beside save_count, so every read
--    that selects the counters gets it with one more column.
--
-- 2. posts_set_updated_at no longer fires for an update that moves
--    view_count. Only the rollup writes the column, and nothing else in the
--    same update, so such an update is never an edit. Without this every
--    viewed post would look edited every ten minutes: updated_at is the date
--    an owner's Post Library and the sitemap show, and the feed-embeddings
--    job re-embeds a post whose updated_at passes its embedding's.
--
-- 3. rollup_post_views, run every ten minutes by the post-view-counts job
--    (src/lib/post-view-counts.ts), adds up to p_limit uncounted marks to
--    view_count and post_view_days, then prunes.
--    * It never waits. It reads the oldest uncounted marks, then locks their
--      posts FOR NO KEY UPDATE SKIP LOCKED, then those posts' marks FOR UPDATE
--      SKIP LOCKED: a post a writer holds (an edit, a save, a delete in
--      flight) waits for the next run. So the rollup cannot deadlock with a
--      post's deletion (post, then marks) or an account's (marks), and a
--      post's row is written once per call however many people saw it.
--    * posts carries a deferred NSFW media check and an account-deletion
--      freeze, either of which can refuse a post's update. The check is made
--      immediate inside the rollup, a batch it refuses is counted again post
--      by post, and the refused post's marks sit out the batches for an hour
--      (retry_after), so they never head every batch and stall everyone else.
--      They are tried again after the hour, and pruned with the counted ones.
--    * Pruned: a counted or held-back mark two days after its day (within
--      three days of the view), and a day's total after 400 days. An
--      uncounted mark never held back stays until counted: the backfill's
--      thirty days drain over the first calls.
--
-- 4. get_creator_profile_stats gains totalViews; the growth accounting gains
--    the two tables.
--
-- Deployment: applies before the code that reads it; the app live during the
-- release reads none of it.
--
-- Locks: ACCESS EXCLUSIVE on posts from the column to this file's commit (the
-- column needs no rewrite, its check reads every post, the trigger is
-- replaced; then only functions are created), a few milliseconds. No other
-- table is locked beyond what defining the functions reads.

SET LOCAL lock_timeout = '5s';

-- ─── 1. The lifetime total ──────────────────────────────────────────────────

ALTER TABLE public.posts
  ADD COLUMN view_count bigint NOT NULL DEFAULT 0
  CONSTRAINT posts_view_count_check CHECK (view_count >= 0);

COMMENT ON COLUMN public.posts.view_count IS
  'Lifetime views: one per viewer per UTC day while the post was public, the creator''s own never counted. Written only by rollup_post_views from post_view_marks; an update that moves it leaves updated_at alone.';

-- ─── 2. A view is not an edit ───────────────────────────────────────────────

DROP TRIGGER IF EXISTS posts_set_updated_at ON public.posts;
CREATE TRIGGER posts_set_updated_at
BEFORE UPDATE ON public.posts
FOR EACH ROW
WHEN (OLD.view_count IS NOT DISTINCT FROM NEW.view_count)
EXECUTE FUNCTION public.touch_updated_at_column();

-- ─── 3. Counting ────────────────────────────────────────────────────────────

-- Adds the given uncounted marks to their posts' totals and days, and stamps
-- them counted. One statement, so a refusal (the posts NSFW check, made
-- immediate by the caller) undoes all of it.
CREATE OR REPLACE FUNCTION public.apply_post_view_marks(
  p_mark_ids bigint[],
  p_counted_at timestamptz,
  OUT views bigint,
  OUT posts integer
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH marks AS (
    UPDATE public.post_view_marks AS marks
    SET counted_at = p_counted_at
    WHERE marks.id = ANY (p_mark_ids)
      AND marks.counted_at IS NULL
    RETURNING marks.post_id, marks.view_date
  ), per_post AS (
    SELECT marks.post_id, count(*)::bigint AS views
    FROM marks
    GROUP BY marks.post_id
  ), days AS (
    INSERT INTO public.post_view_days AS days (post_id, view_date, views)
    SELECT marks.post_id, marks.view_date, count(*)::bigint
    FROM marks
    GROUP BY marks.post_id, marks.view_date
    ON CONFLICT (post_id, view_date) DO UPDATE
      SET views = days.views + EXCLUDED.views
    RETURNING 1
  ), counted AS (
    UPDATE public.posts AS post
    SET view_count = post.view_count + per_post.views
    FROM per_post
    WHERE post.id = per_post.post_id
    RETURNING per_post.views
  )
  SELECT coalesce(sum(counted.views), 0)::bigint, count(*)::integer
  FROM counted;
$$;

REVOKE ALL ON FUNCTION public.apply_post_view_marks(bigint[], timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.rollup_post_views(
  p_as_of timestamptz DEFAULT now(),
  p_limit integer DEFAULT 5000
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_as_of timestamptz := coalesce(p_as_of, now());
  v_today date := (coalesce(p_as_of, now()) AT TIME ZONE 'UTC')::date;
  v_candidate_ids bigint[];
  v_candidate_posts uuid[];
  v_locked_posts uuid[];
  v_mark_ids bigint[];
  v_post record;
  v_applied record;
  v_views bigint := 0;
  v_posts integer := 0;
  v_posts_failed integer := 0;
  v_marks_pruned integer := 0;
  v_days_pruned integer := 0;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 50000 THEN
    RAISE EXCEPTION 'Post view rollup limit must be between 1 and 50000'
      USING ERRCODE = '22023';
  END IF;

  IF NOT pg_try_advisory_xact_lock(hashtextextended('rollup_post_views', 0)) THEN
    RETURN jsonb_build_object('skipped', true, 'reason', 'already_running');
  END IF;

  -- posts_nsfw_private_media is deferred to commit; run at each statement it
  -- fails inside the blocks below instead of failing the whole call.
  SET CONSTRAINTS ALL IMMEDIATE;

  -- The oldest uncounted marks not sitting out: a plain read.
  SELECT array_agg(candidate.id ORDER BY candidate.id), array_agg(DISTINCT candidate.post_id)
  INTO v_candidate_ids, v_candidate_posts
  FROM (
    SELECT marks.id, marks.post_id
    FROM public.post_view_marks AS marks
    WHERE marks.counted_at IS NULL
      AND (marks.retry_after IS NULL OR marks.retry_after <= v_as_of)
    ORDER BY marks.id
    LIMIT p_limit
  ) AS candidate;

  IF v_candidate_ids IS NOT NULL THEN
    -- Their posts first, then their marks, never waiting for either.
    SELECT array_agg(locked.id)
    INTO v_locked_posts
    FROM (
      SELECT post.id
      FROM public.posts AS post
      WHERE post.id = ANY (v_candidate_posts)
      ORDER BY post.id
      FOR NO KEY UPDATE SKIP LOCKED
    ) AS locked;

    IF v_locked_posts IS NOT NULL THEN
      SELECT array_agg(locked.id ORDER BY locked.id)
      INTO v_mark_ids
      FROM (
        SELECT marks.id
        FROM public.post_view_marks AS marks
        WHERE marks.id = ANY (v_candidate_ids)
          AND marks.post_id = ANY (v_locked_posts)
          AND marks.counted_at IS NULL
        ORDER BY marks.id
        FOR UPDATE SKIP LOCKED
      ) AS locked;
    END IF;
  END IF;

  IF v_mark_ids IS NOT NULL THEN
    BEGIN
      SELECT * INTO v_applied FROM public.apply_post_view_marks(v_mark_ids, v_as_of);
      v_views := v_applied.views;
      v_posts := v_applied.posts;
    EXCEPTION WHEN OTHERS THEN
      -- A post refused the batch: count post by post, so it holds back only
      -- its own views, and sit its marks out for an hour so the next batches
      -- are not led by them.
      FOR v_post IN
        SELECT marks.post_id, array_agg(marks.id ORDER BY marks.id) AS mark_ids
        FROM public.post_view_marks AS marks
        WHERE marks.id = ANY (v_mark_ids)
        GROUP BY marks.post_id
      LOOP
        BEGIN
          SELECT * INTO v_applied FROM public.apply_post_view_marks(v_post.mark_ids, v_as_of);
          v_views := v_views + v_applied.views;
          v_posts := v_posts + v_applied.posts;
        EXCEPTION WHEN OTHERS THEN
          v_posts_failed := v_posts_failed + 1;
          UPDATE public.post_view_marks AS marks
          SET retry_after = v_as_of + interval '1 hour'
          WHERE marks.id = ANY (v_post.mark_ids);
          RAISE WARNING 'rollup_post_views: post % not counted, held an hour: %', v_post.post_id, SQLERRM;
        END;
      END LOOP;
    END;
  END IF;

  -- A counted or held-back mark goes two days after its day: the totals keep
  -- the count. Never waiting, as above.
  WITH doomed AS (
    SELECT marks.id
    FROM public.post_view_marks AS marks
    WHERE (marks.counted_at IS NOT NULL OR marks.retry_after IS NOT NULL)
      AND marks.view_date < v_today - 2
    ORDER BY marks.view_date, marks.id
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ), deleted AS (
    DELETE FROM public.post_view_marks AS marks
    USING doomed
    WHERE marks.id = doomed.id
    RETURNING 1
  )
  SELECT count(*) INTO v_marks_pruned FROM deleted;

  WITH doomed AS (
    SELECT days.post_id, days.view_date
    FROM public.post_view_days AS days
    WHERE days.view_date < v_today - 400
    ORDER BY days.view_date, days.post_id
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ), deleted AS (
    DELETE FROM public.post_view_days AS days
    USING doomed
    WHERE days.post_id = doomed.post_id
      AND days.view_date = doomed.view_date
    RETURNING 1
  )
  SELECT count(*) INTO v_days_pruned FROM deleted;

  RETURN jsonb_build_object(
    'skipped', false,
    'views_counted', v_views,
    'posts_counted', v_posts,
    'posts_failed', v_posts_failed,
    'marks_pruned', v_marks_pruned,
    'days_pruned', v_days_pruned,
    'more', coalesce(cardinality(v_candidate_ids), 0) >= p_limit
  );
END;
$$;

COMMENT ON FUNCTION public.rollup_post_views(timestamptz, integer) IS
  'Counts up to p_limit uncounted post_view_marks into posts.view_count and post_view_days, never waiting on a lock (a post a writer holds waits for the next call; a post whose own checks refuse the write sits out for an hour, reported in posts_failed), then prunes counted or held-back marks two days after their day and days older than 400 days. more is true when the batch was full. Run by the post-view-counts job. Service role only.';

REVOKE ALL ON FUNCTION public.rollup_post_views(timestamptz, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rollup_post_views(timestamptz, integer) TO service_role;

-- ─── 4. The creator page's total ────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_creator_profile_stats(p_creator_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH visible_posts AS MATERIALIZED (
    SELECT
      posts.id,
      posts.save_count,
      posts.remix_count,
      posts.view_count,
      posts.source_tool,
      coalesce(
        nullif(posts.source_tool_slug, ''),
        lower(regexp_replace(btrim(coalesce(posts.source_tool, '')), '[^a-z0-9]+', '-', 'g'))
      ) AS tool_slug
    FROM public.posts AS posts
    WHERE posts.user_id = p_creator_id
      AND posts.visibility = 'public'
      AND posts.archived_at IS NULL
      AND posts.review_status = 'visible'
  ), post_stats AS (
    SELECT
      count(*)::integer AS public_creations,
      coalesce(sum(visible_posts.save_count), 0)::bigint AS total_saves,
      coalesce(sum(visible_posts.remix_count), 0)::bigint AS total_remixes,
      coalesce(sum(visible_posts.view_count), 0)::bigint AS total_views,
      -- post_resource_bundles.post_id is unique, so the join adds no rows.
      count(*) FILTER (WHERE bundles.status = 'published')::integer AS unlocks,
      coalesce(sum(bundles.sales_count) FILTER (WHERE bundles.status = 'published'), 0)::bigint
        AS total_unlock_sales
    FROM visible_posts
    LEFT JOIN public.post_resource_bundles AS bundles
      ON bundles.post_id = visible_posts.id
  ), tool_counts AS (
    SELECT
      visible_posts.tool_slug AS slug,
      coalesce(
        max(nullif(btrim(visible_posts.source_tool), '')),
        visible_posts.tool_slug
      ) AS label,
      count(*)::integer AS count
    FROM visible_posts
    WHERE nullif(visible_posts.tool_slug, '') IS NOT NULL
    GROUP BY visible_posts.tool_slug
  ), tools AS (
    SELECT coalesce(
      jsonb_agg(
        jsonb_build_object('slug', slug, 'label', label, 'count', count)
        ORDER BY count DESC, label ASC
      ),
      '[]'::jsonb
    ) AS value
    FROM tool_counts
  )
  SELECT jsonb_build_object(
    'publicCreations', post_stats.public_creations,
    'totalSaves', post_stats.total_saves,
    'totalRemixes', post_stats.total_remixes,
    'totalViews', post_stats.total_views,
    'unlocks', post_stats.unlocks,
    'totalUnlockSales', post_stats.total_unlock_sales,
    'toolsUsed', tools.value
  )
  FROM post_stats
  CROSS JOIN tools;
$$;

REVOKE ALL ON FUNCTION public.get_creator_profile_stats(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_creator_profile_stats(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_creator_profile_stats(uuid) TO service_role;

COMMENT ON FUNCTION public.get_creator_profile_stats(uuid) IS
  'Backend-only creator page totals over the posts the creator grid shows (public, unarchived, review_status visible); totalViews sums their view_count; unlocks counts published recipe bundles only. Read by src/lib/creator-profile.ts for the first page.';

-- ─── 5. Growth accounting ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_operational_table_growth()
RETURNS TABLE (
  table_name text,
  live_rows bigint,
  total_bytes bigint
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog, pg_temp
AS $function$
  SELECT growth.table_name, growth.live_rows, growth.total_bytes
  FROM (
    SELECT
      stats.relname::text AS table_name,
      stats.n_live_tup AS live_rows,
      pg_catalog.pg_total_relation_size(stats.relid) AS total_bytes
    FROM pg_catalog.pg_stat_user_tables AS stats
    WHERE stats.schemaname = 'public'
      AND stats.relname = ANY (ARRAY[
        'account_merge_tickets',
        'ai_usage_events',
        'backend_job_locks',
        'backend_job_runs',
        'backend_rate_limits',
        'feed_delivery_facts',
        'feed_events',
        'feed_session_items',
        'feed_sessions',
        'feed_viewer_daily',
        'generation_completion_jobs',
        'generation_model_provider_checks',
        'mobile_notifications',
        'mobile_push_deliveries',
        'onboarding_events',
        'playback_metrics',
        'playback_metrics_daily_rollup',
        'post_search_embeddings',
        'post_view_days',
        'post_view_marks',
        'provider_dependency_events',
        'search_query_embeddings',
        'search_query_events',
        'search_result_opens',
        'template_run_steps',
        'template_runs',
        'upload_byte_reservations',
        'upload_byte_user_counters',
        'upload_path_tombstones',
        'workflow_canvas_run_steps',
        'workflow_canvas_runs',
        'workflow_run_step_jobs'
      ])

    UNION ALL

    SELECT
      'auth.users',
      stats.n_live_tup,
      pg_catalog.pg_total_relation_size(stats.relid)
    FROM pg_catalog.pg_stat_user_tables AS stats
    WHERE stats.schemaname = 'auth'
      AND stats.relname = 'users'

    UNION ALL

    SELECT
      'guest_identities',
      (
        SELECT count(*)
        FROM auth.users AS guest
        WHERE guest.is_anonymous
          AND guest.deleted_at IS NULL
      ),
      0::bigint
  ) AS growth
  ORDER BY growth.total_bytes DESC, growth.table_name;
$function$;

REVOKE ALL ON FUNCTION public.get_operational_table_growth()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_operational_table_growth()
  TO service_role;

COMMENT ON FUNCTION public.get_operational_table_growth() IS
  'Row counts and byte sizes for churn-prone operational state, append-only telemetry with retention, the vectors search keeps of posts and of queries, post view marks and daily view totals, permanent security ledgers, user-owned workflow history, auth.users and the exact count of live guest identities (bytes 0: part of auth.users). Service role only.';
