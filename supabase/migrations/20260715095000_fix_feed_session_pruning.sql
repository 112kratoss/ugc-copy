-- Keep retained feed telemetry while removing expired ranking sessions.
--
-- Deleting a feed session cascades through feed_session_items while the
-- feed_events foreign keys independently set session_id/session_item_id to
-- NULL. PostgreSQL does not guarantee the order of those referential actions,
-- so the feed event validation trigger could observe a still-linked event
-- after its session item had already disappeared. Detach both references
-- explicitly before deleting the expired session graph.

CREATE OR REPLACE FUNCTION public.detach_feed_events_before_session_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.feed_events AS events
  SET session_id = NULL,
      session_item_id = NULL
  WHERE events.session_id = OLD.id
    OR events.session_item_id IN (
      SELECT items.id
      FROM public.feed_session_items AS items
      WHERE items.session_id = OLD.id
    );

  RETURN OLD;
END;
$$;

ALTER FUNCTION public.detach_feed_events_before_session_delete()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.detach_feed_events_before_session_delete()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS feed_sessions_detach_events_before_delete
  ON public.feed_sessions;
CREATE TRIGGER feed_sessions_detach_events_before_delete
BEFORE DELETE ON public.feed_sessions
FOR EACH ROW EXECUTE FUNCTION public.detach_feed_events_before_session_delete();

COMMENT ON FUNCTION public.detach_feed_events_before_session_delete() IS
  'Owner-executed trigger that detaches retained telemetry before independent feed-session FK actions run.';

CREATE OR REPLACE FUNCTION public.prune_feed_personalization_data(
  p_as_of timestamptz DEFAULT timezone('utc'::text, now()),
  p_event_retention_days integer DEFAULT 90,
  p_session_retention_days integer DEFAULT 2,
  p_limit integer DEFAULT 5000
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_events_deleted integer := 0;
  v_sessions_deleted integer := 0;
  v_assignments_deleted integer := 0;
  v_interests_deleted integer := 0;
  v_post_feedback_deleted integer := 0;
  v_creator_feedback_deleted integer := 0;
  v_session_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  IF p_as_of IS NULL THEN
    RAISE EXCEPTION 'Feed retention timestamp is required';
  END IF;

  IF p_event_retention_days IS NULL
    OR p_event_retention_days < 7
    OR p_event_retention_days > 730
  THEN
    RAISE EXCEPTION 'Feed event retention days must be between 7 and 730';
  END IF;

  IF p_session_retention_days IS NULL
    OR p_session_retention_days < 1
    OR p_session_retention_days > p_event_retention_days
  THEN
    RAISE EXCEPTION 'Feed session retention days must be between 1 and event retention days';
  END IF;

  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 50000 THEN
    RAISE EXCEPTION 'Feed retention limit must be between 1 and 50000';
  END IF;

  IF NOT pg_try_advisory_xact_lock(hashtextextended('prune_feed_personalization_data', 0)) THEN
    RETURN jsonb_build_object('skipped', true, 'reason', 'already_running');
  END IF;

  WITH doomed AS (
    SELECT events.id
    FROM public.feed_events AS events
    WHERE events.received_at < p_as_of - make_interval(days => p_event_retention_days)
    ORDER BY events.received_at ASC, events.id
    LIMIT p_limit
  ), deleted AS (
    DELETE FROM public.feed_events AS events
    USING doomed
    WHERE events.id = doomed.id
    RETURNING 1
  )
  SELECT count(*) INTO v_events_deleted FROM deleted;

  SELECT coalesce(
    array_agg(doomed.id ORDER BY doomed.expires_at ASC, doomed.id),
    ARRAY[]::uuid[]
  )
  INTO v_session_ids
  FROM (
    SELECT sessions.id, sessions.expires_at
    FROM public.feed_sessions AS sessions
    WHERE sessions.expires_at < p_as_of - make_interval(days => p_session_retention_days)
    ORDER BY sessions.expires_at ASC, sessions.id
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ) AS doomed;

  IF cardinality(v_session_ids) > 0 THEN
    -- Block new references to the doomed session items until the short cleanup
    -- transaction has detached retained events and deleted the session graph.
    PERFORM 1
    FROM public.feed_session_items AS items
    WHERE items.session_id = ANY (v_session_ids)
    FOR UPDATE;

    UPDATE public.feed_events AS events
    SET session_id = NULL,
        session_item_id = NULL
    WHERE events.session_id = ANY (v_session_ids)
      OR events.session_item_id IN (
        SELECT items.id
        FROM public.feed_session_items AS items
        WHERE items.session_id = ANY (v_session_ids)
      );

    DELETE FROM public.feed_sessions AS sessions
    WHERE sessions.id = ANY (v_session_ids);

    GET DIAGNOSTICS v_sessions_deleted = ROW_COUNT;
  END IF;

  WITH doomed AS (
    SELECT assignments.id
    FROM public.feed_experiment_assignments AS assignments
    WHERE assignments.expires_at IS NOT NULL
      AND assignments.expires_at < p_as_of
    ORDER BY assignments.expires_at ASC, assignments.id
    LIMIT p_limit
  ), deleted AS (
    DELETE FROM public.feed_experiment_assignments AS assignments
    USING doomed
    WHERE assignments.id = doomed.id
    RETURNING 1
  )
  SELECT count(*) INTO v_assignments_deleted FROM deleted;

  WITH doomed AS (
    SELECT interests.user_id, interests.dimension_type, interests.dimension_value
    FROM public.user_interest_weights AS interests
    WHERE interests.last_event_at < p_as_of - make_interval(days => p_event_retention_days)
      AND abs(interests.weight) < 0.05::double precision
    ORDER BY interests.last_event_at ASC,
      interests.user_id,
      interests.dimension_type,
      interests.dimension_value
    LIMIT p_limit
  ), deleted AS (
    DELETE FROM public.user_interest_weights AS interests
    USING doomed
    WHERE interests.user_id = doomed.user_id
      AND interests.dimension_type = doomed.dimension_type
      AND interests.dimension_value = doomed.dimension_value
    RETURNING 1
  )
  SELECT count(*) INTO v_interests_deleted FROM deleted;

  WITH doomed AS (
    SELECT feedback.user_id, feedback.post_id
    FROM public.feed_user_post_feedback AS feedback
    WHERE feedback.is_active = false
      AND feedback.updated_at < p_as_of - make_interval(days => p_event_retention_days)
    ORDER BY feedback.updated_at ASC, feedback.user_id, feedback.post_id
    LIMIT p_limit
  ), deleted AS (
    DELETE FROM public.feed_user_post_feedback AS feedback
    USING doomed
    WHERE feedback.user_id = doomed.user_id
      AND feedback.post_id = doomed.post_id
    RETURNING 1
  )
  SELECT count(*) INTO v_post_feedback_deleted FROM deleted;

  WITH doomed AS (
    SELECT feedback.user_id, feedback.creator_user_id
    FROM public.feed_user_creator_feedback AS feedback
    WHERE feedback.is_active = false
      AND feedback.updated_at < p_as_of - make_interval(days => p_event_retention_days)
    ORDER BY feedback.updated_at ASC, feedback.user_id, feedback.creator_user_id
    LIMIT p_limit
  ), deleted AS (
    DELETE FROM public.feed_user_creator_feedback AS feedback
    USING doomed
    WHERE feedback.user_id = doomed.user_id
      AND feedback.creator_user_id = doomed.creator_user_id
    RETURNING 1
  )
  SELECT count(*) INTO v_creator_feedback_deleted FROM deleted;

  RETURN jsonb_build_object(
    'skipped', false,
    'events_deleted', v_events_deleted,
    'sessions_deleted', v_sessions_deleted,
    'assignments_deleted', v_assignments_deleted,
    'interests_deleted', v_interests_deleted,
    'post_feedback_deleted', v_post_feedback_deleted,
    'creator_feedback_deleted', v_creator_feedback_deleted
  );
END;
$$;

COMMENT ON FUNCTION public.prune_feed_personalization_data(timestamptz, integer, integer, integer) IS
  'Deletes bounded expired feed data after detaching longer-lived events from expired session rows.';
