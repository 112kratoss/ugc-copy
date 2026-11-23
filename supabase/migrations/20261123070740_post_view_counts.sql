-- Post view counts, step 1 of docs/plans/post-view-counts-2026-11-23.md
-- (owner, 2026-11-23: everyone sees a post's views; a view is the post shown
-- large, half of it on screen for a second, on Home, in the reel or on the
-- post page; one per person per post per UTC day; guests count, the post's
-- creator never does).
--
-- This file records views; the next one (20261123070741_post_view_count_totals)
-- adds the post's total and the rollup that writes it. Two files, so each
-- holds its locks briefly and apart (below).
--
-- 1. post_view_marks: one row per post, viewer and UTC day of the server's
--    clock, so a second view the same day adds nothing. A viewer is a user id
--    (cascading with the account) or the feed's hashed guest key, as
--    feed_events keys them; a guest's mark also holds the hashed network it
--    came from. A mark is counted by the rollup and deleted two days after its
--    day; it is the only record of who viewed what.
--
-- 2. post_view_days: each post's views per UTC day, kept 400 days, for "views
--    this week" and charts later. It cannot be rebuilt once the marks are
--    pruned, so it is written from the start.
--
-- 3. Two ways a view is recorded, both through record_post_view:
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
--    record_post_view first reads whether the view is marked (a plain read,
--    which waits on nothing, not even the rollup stamping that mark). An
--    account's view then takes a transaction advisory lock on the view with
--    pg_try_advisory_xact_lock and skips it when another transaction holds
--    it, since that one is marking it: a feed event batch, the only caller
--    that marks accounts' views from a trigger, never waits on another batch
--    or on the rollup, so two batches of one viewer cannot deadlock. A
--    guest's view (only the route sends them) waits its turn for a lock on
--    the post's network for the day, and the cap is counted and written under
--    it, so a burst from one network neither passes the cap nor loses views
--    below it; the route takes a batch's posts in id order, so two requests
--    never wait on each other in a cycle.
--
-- 4. The backfill: the feed and feed-reel impressions the feed still holds
--    (30 days) become marks, one per post, viewer and UTC day, the creator's
--    own left out, all uncounted, for the first rollups to count. Guests are
--    included, since nobody had a reason to forge views before counts were
--    public, but held to 20 per post per day, as one network's would be: the
--    events keep no network, and a client that sent no cookie had a new id
--    minted for every request. It reads feed_events after the trigger exists,
--    under the trigger's lock, so no impression is missed and a day both see is
--    still one mark.
--
-- Deployment: this file applies before the code that reads it. The app live
-- during the release reads none of it; its feed events start making marks at
-- once, and they wait uncounted until the next file's rollup runs.
--
-- Locks, each held to this file's commit and never ACCESS EXCLUSIVE:
-- SHARE ROW EXCLUSIVE on posts and on auth.users (the marks' and days'
-- foreign keys), so post writes, sign-ups and sign-ins wait while it runs, but
-- every read goes on; and SHARE ROW EXCLUSIVE on feed_events from the trigger,
-- so feed event writes wait for the backfill's read too. lock_timeout bounds
-- the waits for each.

SET LOCAL lock_timeout = '5s';

-- ─── 1. One mark per post, viewer and day ───────────────────────────────────

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
  -- Set when the rollup could not write the post (its own checks refused
  -- it): the mark sits out the batches until then, and is pruned with the
  -- counted ones.
  retry_after timestamptz,
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

-- Whole, not partial: a post's deletion cascades through it, and the
-- per-network cap counts with it.
CREATE INDEX post_view_marks_post_day_network_idx
  ON public.post_view_marks (post_id, view_date, network_key_hash);

-- The rollup's batch, in arrival order.
CREATE INDEX post_view_marks_uncounted_idx
  ON public.post_view_marks (id)
  WHERE counted_at IS NULL;

-- The prune.
CREATE INDEX post_view_marks_prunable_day_idx
  ON public.post_view_marks (view_date, id)
  WHERE counted_at IS NOT NULL OR retry_after IS NOT NULL;

-- An account's deletion cascades here.
CREATE INDEX post_view_marks_viewer_user_idx
  ON public.post_view_marks (viewer_user_id)
  WHERE viewer_user_id IS NOT NULL;

ALTER TABLE public.post_view_marks ENABLE ROW LEVEL SECURITY;

-- No policy: the Data API roles see and write nothing. The functions write as
-- their owner.
REVOKE ALL ON TABLE public.post_view_marks FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.post_view_marks TO service_role;

-- ─── 2. Views per post per day ──────────────────────────────────────────────

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

-- ─── 3. Recording a view ────────────────────────────────────────────────────

-- Never raises for a view that does not count. An account's view never waits
-- on another transaction: the trigger below runs inside every feed event's
-- insert, and a feed event must never fail or stall because of it. A guest's
-- view, which only the route sends, waits only for another guest view of the
-- same post, day and network to be written.
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
    -- Marked already today: a plain read, which waits on nothing (not even
    -- the rollup stamping that mark).
    PERFORM 1
    FROM public.post_view_marks AS marks
    WHERE marks.post_id = p_post_id
      AND marks.view_date = v_view_date
      AND marks.viewer_user_id = p_viewer_user_id;
    IF FOUND THEN
      RETURN false;
    END IF;

    -- Another transaction is marking this very view: it will count it.
    IF NOT pg_try_advisory_xact_lock(hashtextextended(
      'post_view:' || p_post_id::text || ':' || v_view_date::text || ':' || p_viewer_user_id::text, 0
    )) THEN
      RETURN false;
    END IF;

    INSERT INTO public.post_view_marks (post_id, view_date, viewer_user_id, surface, viewed_at)
    VALUES (p_post_id, v_view_date, p_viewer_user_id, p_surface, v_viewed_at)
    ON CONFLICT (post_id, view_date, viewer_user_id) WHERE viewer_user_id IS NOT NULL
    DO NOTHING;
  ELSE
    PERFORM 1
    FROM public.post_view_marks AS marks
    WHERE marks.post_id = p_post_id
      AND marks.view_date = v_view_date
      AND marks.anonymous_key_hash = p_anonymous_key_hash;
    IF FOUND THEN
      RETURN false;
    END IF;

    -- One transaction at a time counts a network's guests for a post and a
    -- day, the others waiting their turn, so the count and the insert below
    -- cannot interleave and the cap holds however many requests arrive
    -- together. record_post_views takes its posts in id order, so two
    -- requests never wait on each other's locks in a cycle.
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'post_view_network:' || p_post_id::text || ':' || v_view_date::text || ':' || p_network_key_hash, 0
    ));

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
  'Marks one view of a post by one viewer (a user id, or a hashed guest key with its hashed network) for the UTC day of p_viewed_at. True when the mark is new; false for a repeat that day, the creator''s own view, a post that is not public and visible, a guest past its network''s 20 for the post that day, an account''s view another transaction is marking at that moment, or a malformed call. Never raises for those; an account''s view never waits on a lock, a guest''s only on another guest view of the same post, day and network. Called by the feed_events trigger and record_post_views.';

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

  -- In post order: a guest's view locks its post's network for the day, and
  -- the same order in every request means no two wait on each other in a
  -- cycle.
  FOR v_view IN
    SELECT value
    FROM jsonb_array_elements(p_views)
    ORDER BY value->>'postId'
  LOOP
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

-- ─── 4. The backfill ────────────────────────────────────────────────────────

WITH impressions AS (
  SELECT DISTINCT ON (
    events.post_id,
    (events.received_at AT TIME ZONE 'UTC')::date,
    coalesce(events.viewer_user_id::text, events.anonymous_key_hash)
  )
    events.post_id,
    (events.received_at AT TIME ZONE 'UTC')::date AS view_date,
    events.viewer_user_id,
    CASE WHEN events.viewer_user_id IS NULL THEN events.anonymous_key_hash END AS anonymous_key_hash,
    CASE events.source_surface WHEN 'feed' THEN 'feed' ELSE 'reel' END AS surface,
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
), ranked AS (
  -- A post's guests of a day, first seen first: only the first 20 count.
  SELECT
    impressions.*,
    row_number() OVER (
      PARTITION BY impressions.post_id, impressions.view_date, impressions.viewer_user_id IS NULL
      ORDER BY impressions.received_at
    ) AS arrival
  FROM impressions
)
INSERT INTO public.post_view_marks (
  post_id,
  view_date,
  viewer_user_id,
  anonymous_key_hash,
  surface,
  viewed_at
)
SELECT
  ranked.post_id,
  ranked.view_date,
  ranked.viewer_user_id,
  ranked.anonymous_key_hash,
  ranked.surface,
  ranked.received_at
FROM ranked
WHERE ranked.viewer_user_id IS NOT NULL
   OR ranked.arrival <= 20
ON CONFLICT DO NOTHING;
