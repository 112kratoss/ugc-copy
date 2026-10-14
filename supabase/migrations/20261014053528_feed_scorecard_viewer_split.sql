-- The viewer scorecard splits its signed-in viewers into registered accounts
-- and the app's guests.
--
-- The app's guest holds a Supabase anonymous session, and the feed and events
-- routes take any verified user as a viewer, so the guest is ranked and logged
-- as a user: interest weights, Not interested and Hide kept on the guest's id,
-- and feed_viewer_daily rows under viewer_user_id. That stays -- the guest who
-- installed the app is a stable identity whose signals are worth keeping --
-- but feed_scorecard_viewers counted every viewer with a user id as signed in.
-- App guests sat among registered accounts while the web's guests, a cookie
-- hash with no user id, did not, and the mix behind every signed-in rate was
-- invisible.
--
-- The function gains three counts that partition its viewers:
--   registered_viewers  a user id whose auth.users row is not anonymous
--   anonymous_viewers   a user id whose auth.users row is anonymous: the
--                       app's guests (the app is the only client that signs
--                       in anonymously)
--   web_guest_viewers   no user id: a web visitor's feed cookie, or an app
--                       installation that has no session yet
-- registered_viewers + anonymous_viewers = signed_in_viewers, and
-- signed_in_viewers + web_guest_viewers = viewers. Every other column keeps
-- its name, position and meaning -- signed_in_viewers and the creation rate
-- over it included -- so the v3 and v4 scorecards read as before.
-- is_anonymous is read when the scorecard runs, not when the viewer was
-- served.
--
-- Two mechanics:
-- 1. CREATE OR REPLACE cannot change a function's OUT list, so the function
--    is dropped and created again, with the grants it had: the service role
--    only.
-- 2. The service role cannot read auth.users (20260901090000), and the
--    scorecard runs as its caller like every feed function. The anonymous
--    flag comes from feed_anonymous_viewer_ids, which runs as its owner with
--    an empty search path and answers only which of the ids it is given are
--    anonymous, as current_identity_is_registered and has_nsfw_reveal read
--    the same column.

-- ─── Which viewers are anonymous ─────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.feed_anonymous_viewer_ids(p_user_ids uuid[])
RETURNS TABLE (user_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT users.id
  FROM auth.users AS users
  WHERE users.id = ANY (p_user_ids)
    AND users.is_anonymous;
$$;

REVOKE ALL ON FUNCTION public.feed_anonymous_viewer_ids(uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.feed_anonymous_viewer_ids(uuid[])
  TO service_role;

COMMENT ON FUNCTION public.feed_anonymous_viewer_ids(uuid[]) IS
  'The ids among p_user_ids whose auth.users row is anonymous (the app''s guests), for feed_scorecard_viewers. Runs as its owner because the service role cannot read auth.users, and returns ids only; service role only.';

-- ─── The viewer scorecard ────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.feed_scorecard_viewers(integer);

-- Viewer-grain outcomes per algorithm version and experiment variant over the
-- last p_days UTC days of feed_viewer_daily (the current, partial day
-- included). A viewer counts once per version and variant.
--   d1_return_rate   viewers served on some day d and again on d + 1, over
--                    viewers served on a day d before the window's last two
--                    (so d + 1 is a whole day inside the window)
--   d7_return_rate   the same with d + 7
--   meaningful_creation_7d_rate
--                    signed-in viewers who started a generation within 7
--                    days of their first serve in the window that has
--                    since succeeded ('succeeded', or the older
--                    'completed'), over signed-in viewers served
-- A return counts whichever version served the return. The eligible and
-- returned counts behind each rate come back too, and so does the split of
-- the viewers by account: registered_viewers, anonymous_viewers and
-- web_guest_viewers.
CREATE FUNCTION public.feed_scorecard_viewers(p_days integer DEFAULT 7)
RETURNS TABLE (
  algorithm_version_id uuid,
  algorithm_label text,
  experiment_variant_id uuid,
  variant_key text,
  viewers bigint,
  sessions bigint,
  sessions_per_viewer double precision,
  d1_return_rate double precision,
  d7_return_rate double precision,
  meaningful_creation_7d_rate double precision,
  rendered_per_viewer double precision,
  meaningful_per_viewer double precision,
  d1_eligible_viewers bigint,
  d1_returned_viewers bigint,
  d7_eligible_viewers bigint,
  d7_returned_viewers bigint,
  signed_in_viewers bigint,
  meaningful_creators_7d bigint,
  registered_viewers bigint,
  anonymous_viewers bigint,
  web_guest_viewers bigint
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_window_end date;
  v_window_start date;
BEGIN
  IF p_days IS NULL OR p_days < 1 OR p_days > 90 THEN
    RAISE EXCEPTION 'Feed viewer scorecard days must be between 1 and 90';
  END IF;

  v_window_end := (now() AT TIME ZONE 'UTC')::date;
  v_window_start := v_window_end - (p_days - 1);

  RETURN QUERY
  WITH viewer_days AS (
    SELECT
      daily.algorithm_version_id AS version_id,
      daily.experiment_variant_id AS variant_id,
      daily.viewer_key AS day_viewer_key,
      daily.viewer_user_id AS day_viewer_user_id,
      daily.fact_date AS day_date,
      daily.sessions AS day_sessions,
      daily.rendered AS day_rendered,
      daily.meaningful AS day_meaningful,
      daily.first_served_at AS day_first_served_at
    FROM public.feed_viewer_daily AS daily
    WHERE daily.fact_date >= v_window_start
      AND daily.fact_date <= v_window_end
      AND daily.served > 0
  ),
  served_days AS (
    SELECT DISTINCT viewer_days.day_viewer_key, viewer_days.day_date
    FROM viewer_days
  ),
  day_returns AS (
    SELECT
      viewer_days.*,
      EXISTS (
        SELECT 1
        FROM served_days AS next_day
        WHERE next_day.day_viewer_key = viewer_days.day_viewer_key
          AND next_day.day_date = viewer_days.day_date + 1
      ) AS returned_next_day,
      EXISTS (
        SELECT 1
        FROM served_days AS week_later
        WHERE week_later.day_viewer_key = viewer_days.day_viewer_key
          AND week_later.day_date = viewer_days.day_date + 7
      ) AS returned_day_seven
    FROM viewer_days
  ),
  per_viewer AS (
    SELECT
      day_returns.version_id,
      day_returns.variant_id,
      day_returns.day_viewer_key AS viewer_key,
      day_returns.day_viewer_user_id AS viewer_user_id,
      sum(day_returns.day_sessions)::bigint AS viewer_sessions,
      sum(day_returns.day_rendered)::bigint AS viewer_rendered,
      sum(day_returns.day_meaningful)::bigint AS viewer_meaningful,
      min(day_returns.day_first_served_at) AS viewer_first_served_at,
      bool_or(day_returns.day_date < v_window_end - 1) AS d1_eligible,
      bool_or(day_returns.day_date < v_window_end - 1 AND day_returns.returned_next_day) AS d1_returned,
      bool_or(day_returns.day_date < v_window_end - 7) AS d7_eligible,
      bool_or(day_returns.day_date < v_window_end - 7 AND day_returns.returned_day_seven) AS d7_returned
    FROM day_returns
    GROUP BY
      day_returns.version_id,
      day_returns.variant_id,
      day_returns.day_viewer_key,
      day_returns.day_viewer_user_id
  ),
  anonymous_users AS (
    SELECT anonymous_ids.user_id
    FROM public.feed_anonymous_viewer_ids(ARRAY(
      SELECT DISTINCT viewer_days.day_viewer_user_id
      FROM viewer_days
      WHERE viewer_days.day_viewer_user_id IS NOT NULL
    )) AS anonymous_ids
  ),
  with_creations AS (
    SELECT
      per_viewer.*,
      (
        per_viewer.viewer_user_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM public.generations AS generations
          WHERE generations.user_id = per_viewer.viewer_user_id
            AND generations.status IN ('succeeded', 'completed')
            AND generations.created_at >= per_viewer.viewer_first_served_at
            AND generations.created_at < per_viewer.viewer_first_served_at + interval '7 days'
        )
      ) AS created_within_7d,
      EXISTS (
        SELECT 1
        FROM anonymous_users
        WHERE anonymous_users.user_id = per_viewer.viewer_user_id
      ) AS is_anonymous_user
    FROM per_viewer
  )
  SELECT
    with_creations.version_id,
    versions.algorithm_key || '-v' || versions.version::text,
    with_creations.variant_id,
    variants.variant_key,
    count(*)::bigint,
    sum(with_creations.viewer_sessions)::bigint,
    sum(with_creations.viewer_sessions)::double precision / count(*)::double precision,
    count(*) FILTER (WHERE with_creations.d1_returned)::double precision
      / nullif(count(*) FILTER (WHERE with_creations.d1_eligible), 0)::double precision,
    count(*) FILTER (WHERE with_creations.d7_returned)::double precision
      / nullif(count(*) FILTER (WHERE with_creations.d7_eligible), 0)::double precision,
    count(*) FILTER (WHERE with_creations.created_within_7d)::double precision
      / nullif(count(*) FILTER (WHERE with_creations.viewer_user_id IS NOT NULL), 0)::double precision,
    sum(with_creations.viewer_rendered)::double precision / count(*)::double precision,
    sum(with_creations.viewer_meaningful)::double precision / count(*)::double precision,
    count(*) FILTER (WHERE with_creations.d1_eligible)::bigint,
    count(*) FILTER (WHERE with_creations.d1_returned)::bigint,
    count(*) FILTER (WHERE with_creations.d7_eligible)::bigint,
    count(*) FILTER (WHERE with_creations.d7_returned)::bigint,
    count(*) FILTER (WHERE with_creations.viewer_user_id IS NOT NULL)::bigint,
    count(*) FILTER (WHERE with_creations.created_within_7d)::bigint,
    count(*) FILTER (
      WHERE with_creations.viewer_user_id IS NOT NULL AND NOT with_creations.is_anonymous_user
    )::bigint,
    count(*) FILTER (WHERE with_creations.is_anonymous_user)::bigint,
    count(*) FILTER (WHERE with_creations.viewer_user_id IS NULL)::bigint
  FROM with_creations
  JOIN public.feed_algorithm_versions AS versions ON versions.id = with_creations.version_id
  LEFT JOIN public.feed_experiment_variants AS variants ON variants.id = with_creations.variant_id
  GROUP BY
    with_creations.version_id,
    versions.algorithm_key,
    versions.version,
    with_creations.variant_id,
    variants.variant_key
  ORDER BY 2, 4 NULLS FIRST;
END;
$$;

REVOKE ALL ON FUNCTION public.feed_scorecard_viewers(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.feed_scorecard_viewers(integer)
  TO service_role;

COMMENT ON FUNCTION public.feed_scorecard_viewers(integer) IS
  'Per version and variant viewer-grain outcomes over the last 1 to 90 UTC days of feed_viewer_daily: viewers, sessions per viewer, D1 and D7 return, 7-day meaningful creation rate, rendered and meaningful per viewer, with the counts behind each rate, and the viewers split into registered accounts, anonymous accounts (the app''s guests) and web guests with no account; service role only.';
