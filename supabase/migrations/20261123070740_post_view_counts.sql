-- Post view counts, step 1 of docs/plans/post-view-counts-2026-11-23.md
-- (owner, 2026-11-23: everyone sees a post's views; a view is the post shown
-- large, half of it on screen for a second, on Home, in the reel or on the
-- post page; one per person per post per UTC day; guests count, the post's
-- creator never does).
--
-- 1. posts.view_count: the lifetime total, beside save_count, so every read
--    that selects the counters gets it with one more column.
--
-- 2. post_view_marks: one row per post, viewer and UTC day of the server's
--    clock, so a second view the same day adds nothing. A viewer is a user id
--    (cascading with the account) or the feed's hashed guest key, exactly as
--    feed_events keys them. A mark is counted by the rollup (5) and deleted
--    two days after its day; it is the only record of who viewed what.
--
-- 3. post_view_days: each post's views per UTC day, kept 400 days, for "views
--    this week" and charts later. It cannot be rebuilt once the marks are
--    pruned, so it is written from the start.
--
-- 4. Two ways a view is recorded, both through record_post_view:
--    * a trigger on feed_events counts each qualified impression from Home
--      (`feed`) and from a reel opened on the feed (`showcase-reel`) by a
--      viewer with an account, an app guest's anonymous one included. Both
--      clients already send these, so installed apps count with no update.
--      Explore's impressions (`showcase`) are grid tiles and never count;
--    * record_post_views, behind POST /api/showcase/views, for the post page,
--      a reel opened outside the feed, and every view of a web guest
--      (src/lib/post-views-service.ts).
--    A view reported both ways meets the same mark and counts once. Views are
--    kept out of feed_events itself: the ranker's per-post stats count every
--    impression there, and post-page or profile-reel views would change them.
--
--    A web guest is known only by the feed cookie, which a script can mint
--    afresh for every request. So a guest's impression in feed_events is not
--    counted (the event has no network to hold it to), and a guest's view
--    through the route carries the hashed network it came from: at most 20
--    guests of one network count for one post in one day. Accounts cost a
--    sign-in each, which Supabase Auth rate-limits.
--
-- 5. rollup_post_views, run every ten minutes by the post-view-counts job
--    (src/lib/post-view-counts.ts), adds the uncounted marks to view_count and
--    post_view_days, then prunes. A post's row is written once per run however
--    many people saw it: posts carries a deferred NSFW media check that runs
--    on every update of a row, so a write per view would run it per view. The
--    check is made immediate inside the rollup, and a batch it refuses is
--    counted again post by post, so one post can hold back only its own views.
--
-- 6. The backfill: the impressions the feed still holds (30 days) become
--    marks, one per post, viewer and UTC day, the creator's own left out, all
--    uncounted, for the first rollups to count. It reads feed_events after the
--    trigger exists, under the trigger's lock, so no impression is missed and
--    a day both see is still one mark.
--
-- 7. get_creator_profile_stats gains totalViews; the growth accounting gains
--    the two tables.
--
-- Deployment: this file applies before the code that reads it. The app live
-- during the release reads none of it; its feed events start making marks at
-- once, and they wait uncounted until the new code's job runs.
--
-- Locks, each held to the commit: ACCESS EXCLUSIVE on posts from the column
-- (no rewrite: a constant default; its check reads every post), taken first,
-- so every read of posts waits for the rest of the file, the backfill's read
-- of the feed's 30 days included; then SHARE ROW EXCLUSIVE on feed_events
-- from the trigger, so feed event writes wait too. A feed event already
-- inserting when posts is locked waits on posts while this file waits on it:
-- Postgres ends one of the two after a second, usually the event's, which
-- waited first and whose client sends it again; if it is this file, the
-- release fails and is run again. lock_timeout bounds every other wait.

SET LOCAL lock_timeout = '5s';

-- ─── 1. The lifetime total ──────────────────────────────────────────────────

ALTER TABLE public.posts
  ADD COLUMN view_count bigint NOT NULL DEFAULT 0
  CONSTRAINT posts_view_count_check CHECK (view_count >= 0);

COMMENT ON COLUMN public.posts.view_count IS
  'Lifetime views: one per viewer per UTC day while the post was public, the creator''s own never counted. Written only by rollup_post_views from post_view_marks.';

-- ─── 2. One mark per post, viewer and day ───────────────────────────────────

CREATE TABLE public.post_view_marks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  view_date date NOT NULL,
  viewer_user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  anonymous_key_hash text,
  -- A guest's hashed network (the feed's own hash of it), which caps how
  -- many guests of one network count for a post in a day. NULL for an
  -- account, and for the backfill's guests, whose events never stored one.
  network_key_hash text CHECK (
    network_key_hash IS NULL OR char_length(network_key_hash) BETWEEN 32 AND 128
  ),
  surface text NOT NULL CHECK (surface IN ('feed', 'post-page', 'reel')),
  viewed_at timestamptz NOT NULL,
  counted_at timestamptz,
  CONSTRAINT post_view_marks_viewer_check CHECK (
    (viewer_user_id IS NOT NULL AND anonymous_key_hash IS NULL AND network_key_hash IS NULL)
    OR (
      viewer_user_id IS NULL
      AND char_length(anonymous_key_hash) BETWEEN 32 AND 128
    )
  )
);

COMMENT ON TABLE public.post_view_marks IS
  'One row per post, viewer and UTC day the post was viewed: the dedupe behind posts.view_count. A viewer is a user id or the feed''s hashed guest key; a guest''s mark also holds its hashed network, for the per-network cap. Written by record_post_view, counted and pruned (two days after its day) by rollup_post_views. Service role reads only.';

CREATE UNIQUE INDEX post_view_marks_user_day_idx
  ON public.post_view_marks (post_id, view_date, viewer_user_id)
  WHERE viewer_user_id IS NOT NULL;

CREATE UNIQUE INDEX post_view_marks_guest_day_idx
  ON public.post_view_marks (post_id, view_date, anonymous_key_hash)
  WHERE anonymous_key_hash IS NOT NULL;

-- The per-network cap's count.
CREATE INDEX post_view_marks_guest_network_idx
  ON public.post_view_marks (post_id, view_date, network_key_hash)
  WHERE network_key_hash IS NOT NULL;

-- The rollup's batch, in arrival order.
CREATE INDEX post_view_marks_uncounted_idx
  ON public.post_view_marks (id)
  WHERE counted_at IS NULL;

-- The prune.
CREATE INDEX post_view_marks_counted_day_idx
  ON public.post_view_marks (view_date, id)
  WHERE counted_at IS NOT NULL;

-- An account's deletion cascades here.
CREATE INDEX post_view_marks_viewer_user_idx
  ON public.post_view_marks (viewer_user_id)
  WHERE viewer_user_id IS NOT NULL;

ALTER TABLE public.post_view_marks ENABLE ROW LEVEL SECURITY;

-- No policy: the Data API roles see and write nothing. The functions below
-- write as their owner.
REVOKE ALL ON TABLE public.post_view_marks FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.post_view_marks TO service_role;

-- ─── 3. Views per post per day ──────────────────────────────────────────────

CREATE TABLE public.post_view_days (
  post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  view_date date NOT NULL,
  views bigint NOT NULL CHECK (views >= 0),
  PRIMARY KEY (post_id, view_date)
);

COMMENT ON TABLE public.post_view_days IS
  'Each post''s counted views per UTC day of the view, kept 400 days. Written and pruned by rollup_post_views. Service role reads only.';

CREATE INDEX post_view_days_view_date_idx
  ON public.post_view_days (view_date);

ALTER TABLE public.post_view_days ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.post_view_days FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.post_view_days TO service_role;

-- ─── 4. Recording a view ────────────────────────────────────────────────────

-- Never raises for a view that does not count: the trigger below runs inside
-- every feed event's insert, and a feed event must never fail because of it.
CREATE OR REPLACE FUNCTION public.record_post_view(
  p_post_id uuid,
  p_viewer_user_id uuid,
  p_anonymous_key_hash text,
  p_network_key_hash text,
  p_surface text,
  p_viewed_at timestamptz DEFAULT now()
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_viewed_at timestamptz := coalesce(p_viewed_at, now());
  v_view_date date := (coalesce(p_viewed_at, now()) AT TIME ZONE 'UTC')::date;
  v_network_guests integer := 0;
  v_inserted integer := 0;
BEGIN
  IF p_post_id IS NULL OR p_surface IS NULL OR p_surface NOT IN ('feed', 'post-page', 'reel') THEN
    RETURN false;
  END IF;

  -- Exactly one viewer key, shaped as the table holds it. A guest counts
  -- only with the network it came from, for the cap below.
  IF (p_viewer_user_id IS NULL) = (p_anonymous_key_hash IS NULL) THEN
    RETURN false;
  END IF;
  IF p_anonymous_key_hash IS NOT NULL AND (
    char_length(p_anonymous_key_hash) NOT BETWEEN 32 AND 128
    OR p_network_key_hash IS NULL
    OR char_length(p_network_key_hash) NOT BETWEEN 32 AND 128
  ) THEN
    RETURN false;
  END IF;

  -- Only a post everyone can see counts, and never its creator's own view.
  PERFORM 1
  FROM public.posts AS post
  WHERE post.id = p_post_id
    AND post.visibility = 'public'
    AND post.archived_at IS NULL
    AND post.tombstoned_at IS NULL
    AND post.review_status = 'visible'
    AND post.user_id IS DISTINCT FROM p_viewer_user_id;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF p_viewer_user_id IS NOT NULL THEN
    INSERT INTO public.post_view_marks (post_id, view_date, viewer_user_id, surface, viewed_at)
    VALUES (p_post_id, v_view_date, p_viewer_user_id, p_surface, v_viewed_at)
    ON CONFLICT (post_id, view_date, viewer_user_id) WHERE viewer_user_id IS NOT NULL
    DO NOTHING;
  ELSE
    -- At most 20 guests of one network count for a post in a day: a script
    -- that mints a fresh feed cookie per request is held to its network's
    -- share, while a household or an office behind one address still counts.
    SELECT count(*)
    INTO v_network_guests
    FROM (
      SELECT 1
      FROM public.post_view_marks AS marks
      WHERE marks.post_id = p_post_id
        AND marks.view_date = v_view_date
        AND marks.network_key_hash = p_network_key_hash
      LIMIT 20
    ) AS network_guests;

    IF v_network_guests >= 20 THEN
      RETURN false;
    END IF;

    INSERT INTO public.post_view_marks (
      post_id, view_date, anonymous_key_hash, network_key_hash, surface, viewed_at
    )
    VALUES (p_post_id, v_view_date, p_anonymous_key_hash, p_network_key_hash, p_surface, v_viewed_at)
    ON CONFLICT (post_id, view_date, anonymous_key_hash) WHERE anonymous_key_hash IS NOT NULL
    DO NOTHING;
  END IF;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted > 0;
END;
$$;

COMMENT ON FUNCTION public.record_post_view(uuid, uuid, text, text, text, timestamptz) IS
  'Marks one view of a post by one viewer (a user id, or a hashed guest key with its hashed network) for the UTC day of p_viewed_at. True when the mark is new; false for a repeat that day, the creator''s own view, a post that is not public and visible, a guest past its network''s 20 for the post that day, or a malformed call. Never raises for those. Called by the feed_events trigger and record_post_views.';

REVOKE ALL ON FUNCTION public.record_post_view(uuid, uuid, text, text, text, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;

-- The route's batch: the post page, reels opened outside the feed and every
-- view of a web guest. Up to 25 views from one viewer, at the server's time;
-- an entry that is not an object, names no uuid or no known surface is
-- skipped, never refused, so the answer says nothing about which posts exist
-- or count.
CREATE OR REPLACE FUNCTION public.record_post_views(
  p_viewer_user_id uuid,
  p_anonymous_key_hash text,
  p_network_key_hash text,
  p_views jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_view jsonb;
  v_post_id text;
  v_surface text;
  v_counted integer := 0;
  v_now timestamptz := now();
BEGIN
  IF (p_viewer_user_id IS NULL) = (p_anonymous_key_hash IS NULL) THEN
    RAISE EXCEPTION 'A post view needs exactly one viewer key'
      USING ERRCODE = '22023';
  END IF;

  IF p_anonymous_key_hash IS NOT NULL AND p_network_key_hash IS NULL THEN
    RAISE EXCEPTION 'A guest''s post view needs its network key'
      USING ERRCODE = '22023';
  END IF;

  IF p_views IS NULL OR jsonb_typeof(p_views) <> 'array' THEN
    RAISE EXCEPTION 'Post views must be an array'
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_array_length(p_views) > 25 THEN
    RAISE EXCEPTION 'At most 25 post views per call'
      USING ERRCODE = '22023';
  END IF;

  FOR v_view IN SELECT value FROM jsonb_array_elements(p_views) LOOP
    IF jsonb_typeof(v_view) <> 'object' THEN
      CONTINUE;
    END IF;

    v_post_id := v_view->>'postId';
    v_surface := v_view->>'surface';

    IF v_post_id IS NULL
      OR v_post_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR v_surface IS NULL
      OR v_surface NOT IN ('feed', 'post-page', 'reel')
    THEN
      CONTINUE;
    END IF;

    IF public.record_post_view(
      v_post_id::uuid,
      p_viewer_user_id,
      p_anonymous_key_hash,
      CASE WHEN p_viewer_user_id IS NULL THEN p_network_key_hash END,
      v_surface,
      v_now
    ) THEN
      v_counted := v_counted + 1;
    END IF;
  END LOOP;

  RETURN v_counted;
END;
$$;

COMMENT ON FUNCTION public.record_post_views(uuid, text, text, jsonb) IS
  'POST /api/showcase/views: up to 25 {postId, surface} views (surface feed, post-page or reel) from one viewer, a user id or a hashed guest key with its hashed network, at the server''s time. Returns how many were new marks; malformed entries are skipped. Service role only.';

REVOKE ALL ON FUNCTION public.record_post_views(uuid, text, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_post_views(uuid, text, text, jsonb) TO service_role;

-- Home's and the feed reel's qualified impressions by a viewer with an
-- account: half the card on screen for a second (web IntersectionObserver at
-- 0.5 and 1 s, the app's SHOWCASE_QUALIFIED_IMPRESSION_VIEWABILITY). The day
-- is the server's received_at, never the client's occurred_at.
CREATE OR REPLACE FUNCTION public.count_feed_impression_as_post_view()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.record_post_view(
    NEW.post_id,
    NEW.viewer_user_id,
    NULL,
    NULL,
    CASE NEW.source_surface WHEN 'feed' THEN 'feed' ELSE 'reel' END,
    NEW.received_at
  );
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.count_feed_impression_as_post_view()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER feed_events_count_post_view
AFTER INSERT ON public.feed_events
FOR EACH ROW
WHEN (
  NEW.event_type = 'impression'
  AND NEW.source_surface IN ('feed', 'showcase-reel')
  AND NEW.viewer_user_id IS NOT NULL
)
EXECUTE FUNCTION public.count_feed_impression_as_post_view();

-- ─── 5. Counting ────────────────────────────────────────────────────────────

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

  SELECT array_agg(batch.id ORDER BY batch.id)
  INTO v_mark_ids
  FROM (
    SELECT marks.id
    FROM public.post_view_marks AS marks
    WHERE marks.counted_at IS NULL
    ORDER BY marks.id
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ) AS batch;

  IF v_mark_ids IS NOT NULL THEN
    BEGIN
      SELECT * INTO v_applied FROM public.apply_post_view_marks(v_mark_ids, v_as_of);
      v_views := v_applied.views;
      v_posts := v_applied.posts;
    EXCEPTION WHEN OTHERS THEN
      -- A post refused the batch: count post by post, so it holds back only
      -- its own views (left uncounted, retried by the next run).
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
          RAISE WARNING 'rollup_post_views: post % not counted: %', v_post.post_id, SQLERRM;
        END;
      END LOOP;
    END;
  END IF;

  -- A mark is kept two days after its day, then only the totals remain.
  WITH doomed AS (
    SELECT marks.id
    FROM public.post_view_marks AS marks
    WHERE marks.counted_at IS NOT NULL
      AND marks.view_date < v_today - 2
    ORDER BY marks.view_date, marks.id
    LIMIT p_limit
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
    'more', coalesce(cardinality(v_mark_ids), 0) >= p_limit
  );
END;
$$;

COMMENT ON FUNCTION public.rollup_post_views(timestamptz, integer) IS
  'Counts up to p_limit uncounted post_view_marks into posts.view_count and post_view_days (a post whose own check refuses the write is left uncounted, reported in posts_failed), prunes counted marks two days after their day and days older than 400 days. more is true when the batch was full. Run by the post-view-counts job. Service role only.';

REVOKE ALL ON FUNCTION public.rollup_post_views(timestamptz, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rollup_post_views(timestamptz, integer) TO service_role;

-- ─── 6. The backfill ────────────────────────────────────────────────────────

INSERT INTO public.post_view_marks (
  post_id,
  view_date,
  viewer_user_id,
  anonymous_key_hash,
  surface,
  viewed_at
)
SELECT DISTINCT ON (
  events.post_id,
  (events.received_at AT TIME ZONE 'UTC')::date,
  coalesce(events.viewer_user_id::text, events.anonymous_key_hash)
)
  events.post_id,
  (events.received_at AT TIME ZONE 'UTC')::date,
  events.viewer_user_id,
  CASE WHEN events.viewer_user_id IS NULL THEN events.anonymous_key_hash END,
  CASE events.source_surface WHEN 'feed' THEN 'feed' ELSE 'reel' END,
  events.received_at
FROM public.feed_events AS events
JOIN public.posts AS post
  ON post.id = events.post_id
WHERE events.event_type = 'impression'
  AND events.source_surface IN ('feed', 'showcase-reel')
  AND post.visibility = 'public'
  AND post.archived_at IS NULL
  AND post.tombstoned_at IS NULL
  AND post.review_status = 'visible'
  AND post.user_id IS DISTINCT FROM events.viewer_user_id
ORDER BY
  events.post_id,
  (events.received_at AT TIME ZONE 'UTC')::date,
  coalesce(events.viewer_user_id::text, events.anonymous_key_hash),
  events.received_at
ON CONFLICT DO NOTHING;

-- ─── 7. The creator page's total ────────────────────────────────────────────

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

-- ─── 8. Growth accounting ───────────────────────────────────────────────────

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
