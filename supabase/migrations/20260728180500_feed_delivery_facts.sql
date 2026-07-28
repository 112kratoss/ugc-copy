-- Feed delivery facts: the durable measurement contract for feed ranking.
--
-- feed_session_items carry explainable score components, but the session graph
-- is pruned after ~2 days and retained feed_events are detached
-- (session_id/session_item_id are nulled), so exposure features and outcomes
-- become unjoinable. This migration adds:
--
-- 1. public.feed_delivery_facts — one row per ranked delivery, written at serve
--    time. Exposure columns are immutable; outcome columns update monotonically
--    (write-once timestamps, GREATEST progress/dwell) from event triggers, so
--    the row remains a complete (features → outcome) record after the session
--    graph and even the raw events are pruned.
-- 2. feed_events.delivery_fact_id — an immutable snapshot of the delivery id,
--    stamped by the validation trigger. Session pruning nulls session_item_id
--    but never this column, so the fact→outcome join survives retention.
-- 3. A media-progress upsert path (GREATEST semantics) so milestone/background/
--    exit flushes can report max playback progress idempotently.
-- 4. Seen-history partial indexes on feed_events (viewer/anonymous + post_id)
--    to support repeat-exposure metrics and later unseen-first retrieval.
-- 5. prune_feed_personalization_data gains fact retention with its own longer
--    window; facts deliberately have no FK to feed_sessions/feed_session_items.

CREATE TABLE IF NOT EXISTS public.feed_delivery_facts (
  delivery_id bigint PRIMARY KEY,
  session_id uuid NOT NULL,
  algorithm_version_id uuid NOT NULL
    REFERENCES public.feed_algorithm_versions(id) ON DELETE RESTRICT,
  experiment_assignment_id bigint,
  -- Immutable experiment dimensions are copied onto the fact because
  -- assignments expire sooner than facts. Deliberately no FK: historical
  -- attribution must survive assignment pruning.
  experiment_id uuid,
  experiment_variant_id uuid,
  viewer_user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  anonymous_key_hash text,
  post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  creator_user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 0),
  candidate_source text NOT NULL,
  is_exploration boolean NOT NULL DEFAULT false,
  exploration_propensity double precision
    CHECK (
      exploration_propensity IS NULL
      OR (
        exploration_propensity >= 0
        AND exploration_propensity <= 1
        AND exploration_propensity <> 'NaN'::double precision
      )
    ),
  final_score double precision NOT NULL CHECK (
    final_score > '-Infinity'::double precision
    AND final_score < 'Infinity'::double precision
    AND final_score <> 'NaN'::double precision
  ),
  score_components jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(score_components) = 'object'),
  surface text NOT NULL,
  mode text NOT NULL,
  ranked_at timestamptz NOT NULL,
  served_at timestamptz,
  -- Outcome columns: written only by apply_feed_delivery_outcome(), each is
  -- write-once (first occurrence) or monotone (GREATEST). "Rendered" means any
  -- delivery-attributed event arrived; a fact with rendered_at IS NULL was
  -- ranked (and possibly page-served) but never observed on screen, and is
  -- excluded — not counted as failure — in exploration reward stats.
  rendered_at timestamptz,
  qualified_impression_at timestamptz,
  opened_at timestamptz,
  quick_skipped_at timestamptz,
  dwell_ms_max bigint NOT NULL DEFAULT 0 CHECK (dwell_ms_max >= 0),
  media_progress_max double precision NOT NULL DEFAULT 0
    CHECK (
      media_progress_max >= 0
      AND media_progress_max <= 1
      AND media_progress_max <> 'NaN'::double precision
    ),
  media_duration_ms integer CHECK (media_duration_ms IS NULL OR media_duration_ms >= 0),
  saved_at timestamptz,
  shared_at timestamptz,
  followed_at timestamptz,
  remix_started_at timestamptz,
  remix_completed_at timestamptz,
  resource_opened_at timestamptz,
  purchased_at timestamptz,
  not_interested_at timestamptz,
  hid_creator_at timestamptz,
  reported_at timestamptz,
  last_event_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT feed_delivery_facts_viewer_check
    CHECK (
      (viewer_user_id IS NOT NULL AND anonymous_key_hash IS NULL)
      OR (
        viewer_user_id IS NULL
        AND char_length(anonymous_key_hash) BETWEEN 32 AND 128
      )
    ),
  CONSTRAINT feed_delivery_facts_experiment_attribution_check
    CHECK (
      (
        experiment_assignment_id IS NULL
        AND experiment_id IS NULL
        AND experiment_variant_id IS NULL
      )
      OR (
        experiment_assignment_id IS NOT NULL
        AND experiment_id IS NOT NULL
        AND experiment_variant_id IS NOT NULL
      )
    ),
  CONSTRAINT feed_delivery_facts_candidate_source_length_check
    CHECK (char_length(candidate_source) BETWEEN 1 AND 80),
  CONSTRAINT feed_delivery_facts_surface_length_check
    CHECK (char_length(surface) BETWEEN 1 AND 80),
  CONSTRAINT feed_delivery_facts_mode_length_check
    CHECK (char_length(mode) BETWEEN 1 AND 40)
);

-- The migration is normally applied once to an empty schema. These additive
-- guards also make it safe for a smoke-test database that created the first
-- draft of the table before experiment dimensions were copied onto facts.
ALTER TABLE public.feed_delivery_facts
  ADD COLUMN IF NOT EXISTS experiment_id uuid,
  ADD COLUMN IF NOT EXISTS experiment_variant_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'feed_delivery_facts_experiment_attribution_check'
      AND conrelid = 'public.feed_delivery_facts'::regclass
  ) THEN
    ALTER TABLE public.feed_delivery_facts
      ADD CONSTRAINT feed_delivery_facts_experiment_attribution_check
      CHECK (
        (
          experiment_assignment_id IS NULL
          AND experiment_id IS NULL
          AND experiment_variant_id IS NULL
        )
        OR (
          experiment_assignment_id IS NOT NULL
          AND experiment_id IS NOT NULL
          AND experiment_variant_id IS NOT NULL
        )
      );
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS feed_delivery_facts_algorithm_ranked_idx
  ON public.feed_delivery_facts (algorithm_version_id, ranked_at DESC);

CREATE INDEX IF NOT EXISTS feed_delivery_facts_experiment_ranked_idx
  ON public.feed_delivery_facts (
    experiment_id,
    experiment_variant_id,
    ranked_at DESC
  )
  WHERE experiment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS feed_delivery_facts_viewer_ranked_idx
  ON public.feed_delivery_facts (viewer_user_id, ranked_at DESC)
  WHERE viewer_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS feed_delivery_facts_post_ranked_idx
  ON public.feed_delivery_facts (post_id, ranked_at DESC);

CREATE INDEX IF NOT EXISTS feed_delivery_facts_ranked_idx
  ON public.feed_delivery_facts (ranked_at);

CREATE INDEX IF NOT EXISTS feed_delivery_facts_served_idx
  ON public.feed_delivery_facts (served_at)
  WHERE served_at IS NOT NULL;

DROP TRIGGER IF EXISTS feed_delivery_facts_set_updated_at
  ON public.feed_delivery_facts;
CREATE TRIGGER feed_delivery_facts_set_updated_at
BEFORE UPDATE ON public.feed_delivery_facts
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at_column();

ALTER TABLE public.feed_delivery_facts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.feed_delivery_facts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.feed_delivery_facts TO service_role;

CREATE POLICY "No client access to feed_delivery_facts"
  ON public.feed_delivery_facts FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

-- Immutable delivery snapshot on events. Session pruning nulls
-- session_item_id; this column is stamped once by the validation trigger and
-- never cleared, so outcomes stay joinable to feed_delivery_facts. No FK on
-- purpose: facts and events have independent retention windows.
ALTER TABLE public.feed_events
  ADD COLUMN IF NOT EXISTS delivery_fact_id bigint;

CREATE INDEX IF NOT EXISTS feed_events_delivery_fact_idx
  ON public.feed_events (delivery_fact_id)
  WHERE delivery_fact_id IS NOT NULL;

-- Seen-history lookups: unseen-first retrieval and the repeat-exposure metric
-- anti-join on (viewer, post). Both identity paths are covered.
CREATE INDEX IF NOT EXISTS feed_events_viewer_post_impression_idx
  ON public.feed_events (viewer_user_id, post_id, occurred_at DESC)
  WHERE event_type = 'impression' AND viewer_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS feed_events_anonymous_post_impression_idx
  ON public.feed_events (anonymous_key_hash, post_id, occurred_at DESC)
  WHERE event_type = 'impression' AND anonymous_key_hash IS NOT NULL;

-- Re-create the event context validation trigger function with delivery fact
-- stamping. Body is otherwise identical to 20260711064036. The stamp happens
-- only when session_item_id is present, so the pruning detach UPDATE (which
-- nulls session references) passes through without clearing the snapshot.
CREATE OR REPLACE FUNCTION public.validate_feed_event_context()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_item_session_id uuid;
  v_item_post_id uuid;
  v_item_position integer;
  v_session_user_id uuid;
  v_session_anonymous_key_hash text;
  v_creator_user_id uuid;
BEGIN
  SELECT posts.user_id
  INTO v_creator_user_id
  FROM public.posts AS posts
  WHERE posts.id = NEW.post_id;

  IF NOT FOUND OR v_creator_user_id IS DISTINCT FROM NEW.creator_user_id THEN
    RAISE EXCEPTION 'Feed event creator does not match the post owner'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.session_item_id IS NOT NULL THEN
    SELECT item.session_id, item.post_id, item.position
    INTO v_item_session_id, v_item_post_id, v_item_position
    FROM public.feed_session_items AS item
    WHERE item.id = NEW.session_item_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Feed session item was not found'
        USING ERRCODE = '23503';
    END IF;

    IF v_item_post_id IS DISTINCT FROM NEW.post_id THEN
      RAISE EXCEPTION 'Feed event post does not match the session item'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.session_id IS NULL THEN
      NEW.session_id := v_item_session_id;
    ELSIF NEW.session_id IS DISTINCT FROM v_item_session_id THEN
      RAISE EXCEPTION 'Feed event session does not match the session item'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.position IS NULL THEN
      NEW.position := v_item_position;
    ELSIF NEW.position IS DISTINCT FROM v_item_position THEN
      RAISE EXCEPTION 'Feed event position does not match the session item'
        USING ERRCODE = '23514';
    END IF;

    NEW.delivery_fact_id := coalesce(NEW.delivery_fact_id, NEW.session_item_id);
  END IF;

  IF NEW.session_id IS NOT NULL THEN
    SELECT session.viewer_user_id, session.anonymous_key_hash
    INTO v_session_user_id, v_session_anonymous_key_hash
    FROM public.feed_sessions AS session
    WHERE session.id = NEW.session_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Feed session was not found'
        USING ERRCODE = '23503';
    END IF;

    IF v_session_user_id IS DISTINCT FROM NEW.viewer_user_id THEN
      RAISE EXCEPTION 'Feed event user does not match the session viewer'
        USING ERRCODE = '23514';
    END IF;

    IF v_session_user_id IS NULL
      AND v_session_anonymous_key_hash IS DISTINCT FROM NEW.anonymous_key_hash
    THEN
      RAISE EXCEPTION 'Feed event anonymous viewer does not match the session viewer'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Monotone outcome application. Every delivery-attributed event marks the fact
-- rendered and applies its primitive measurement: write-once timestamps for
-- discrete actions, GREATEST for dwell and playback progress. quick_skip also
-- contributes dwell time (it is a short dwell, not a separate scale).
CREATE OR REPLACE FUNCTION public.apply_feed_delivery_outcome()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.delivery_fact_id IS NULL THEN
    RETURN NEW;
  END IF;

  UPDATE public.feed_delivery_facts AS facts
  SET rendered_at = least(coalesce(facts.rendered_at, NEW.occurred_at), NEW.occurred_at),
      last_event_at = greatest(coalesce(facts.last_event_at, NEW.occurred_at), NEW.occurred_at),
      qualified_impression_at = CASE WHEN NEW.event_type = 'impression'
        THEN coalesce(facts.qualified_impression_at, NEW.occurred_at)
        ELSE facts.qualified_impression_at END,
      opened_at = CASE WHEN NEW.event_type = 'open'
        THEN coalesce(facts.opened_at, NEW.occurred_at)
        ELSE facts.opened_at END,
      quick_skipped_at = CASE WHEN NEW.event_type = 'quick_skip'
        THEN coalesce(facts.quick_skipped_at, NEW.occurred_at)
        ELSE facts.quick_skipped_at END,
      dwell_ms_max = CASE WHEN NEW.event_type IN ('dwell', 'quick_skip')
        THEN greatest(facts.dwell_ms_max, coalesce(NEW.duration_ms, 0)::bigint)
        ELSE facts.dwell_ms_max END,
      media_progress_max = CASE WHEN NEW.event_type = 'media_progress'
        THEN least(1.0::double precision, greatest(facts.media_progress_max, coalesce(NEW.progress, 0)))
        ELSE facts.media_progress_max END,
      media_duration_ms = CASE WHEN NEW.event_type = 'media_progress'
        THEN coalesce(facts.media_duration_ms, NEW.duration_ms)
        ELSE facts.media_duration_ms END,
      saved_at = CASE WHEN NEW.event_type = 'save'
        THEN coalesce(facts.saved_at, NEW.occurred_at)
        ELSE facts.saved_at END,
      shared_at = CASE WHEN NEW.event_type = 'share'
        THEN coalesce(facts.shared_at, NEW.occurred_at)
        ELSE facts.shared_at END,
      followed_at = CASE WHEN NEW.event_type = 'follow'
        THEN coalesce(facts.followed_at, NEW.occurred_at)
        ELSE facts.followed_at END,
      remix_started_at = CASE WHEN NEW.event_type = 'remix_start'
        THEN coalesce(facts.remix_started_at, NEW.occurred_at)
        ELSE facts.remix_started_at END,
      remix_completed_at = CASE WHEN NEW.event_type = 'remix_complete'
        THEN coalesce(facts.remix_completed_at, NEW.occurred_at)
        ELSE facts.remix_completed_at END,
      resource_opened_at = CASE WHEN NEW.event_type = 'resource_open'
        THEN coalesce(facts.resource_opened_at, NEW.occurred_at)
        ELSE facts.resource_opened_at END,
      purchased_at = CASE WHEN NEW.event_type = 'purchase'
        THEN coalesce(facts.purchased_at, NEW.occurred_at)
        ELSE facts.purchased_at END,
      not_interested_at = CASE WHEN NEW.event_type = 'not_interested'
        THEN coalesce(facts.not_interested_at, NEW.occurred_at)
        ELSE facts.not_interested_at END,
      hid_creator_at = CASE WHEN NEW.event_type = 'hide_creator'
        THEN coalesce(facts.hid_creator_at, NEW.occurred_at)
        ELSE facts.hid_creator_at END,
      reported_at = CASE WHEN NEW.event_type = 'report'
        THEN coalesce(facts.reported_at, NEW.occurred_at)
        ELSE facts.reported_at END
  WHERE facts.delivery_id = NEW.delivery_fact_id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS feed_events_apply_delivery_outcome ON public.feed_events;
CREATE TRIGGER feed_events_apply_delivery_outcome
AFTER INSERT OR UPDATE OF progress, duration_ms ON public.feed_events
FOR EACH ROW EXECUTE FUNCTION public.apply_feed_delivery_outcome();

-- Media-progress flushes arrive repeatedly (milestones, app background, exit).
-- The (session_item_id, event_type) partial unique index caps storage at one
-- row per delivery; this function upserts against it with GREATEST semantics so
-- flushes are idempotent and order-independent. A client_event_id retry of the
-- first flush can still raise 23505 on the client-id unique constraint; callers
-- treat that as a duplicate, matching the existing capped-event behavior.
CREATE OR REPLACE FUNCTION public.record_feed_media_progress_event(
  p_client_event_id text,
  p_session_id uuid,
  p_session_item_id bigint,
  p_viewer_user_id uuid,
  p_anonymous_key_hash text,
  p_post_id uuid,
  p_creator_user_id uuid,
  p_source_surface text,
  p_position integer,
  p_duration_ms integer,
  p_progress double precision,
  p_metadata jsonb,
  p_occurred_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_session_item_id IS NULL THEN
    RAISE EXCEPTION 'Media progress events require a feed delivery';
  END IF;

  IF p_progress IS NULL OR p_progress < 0 OR p_progress > 1 THEN
    RAISE EXCEPTION 'Media progress must be between 0 and 1';
  END IF;

  INSERT INTO public.feed_events (
    client_event_id,
    session_id,
    session_item_id,
    viewer_user_id,
    anonymous_key_hash,
    post_id,
    creator_user_id,
    event_type,
    source_surface,
    position,
    duration_ms,
    progress,
    metadata,
    occurred_at
  )
  VALUES (
    p_client_event_id,
    p_session_id,
    p_session_item_id,
    p_viewer_user_id,
    p_anonymous_key_hash,
    p_post_id,
    p_creator_user_id,
    'media_progress',
    p_source_surface,
    p_position,
    p_duration_ms,
    p_progress,
    coalesce(p_metadata, '{}'::jsonb),
    p_occurred_at
  )
  ON CONFLICT (session_item_id, event_type) WHERE session_item_id IS NOT NULL
  DO UPDATE SET
    progress = greatest(coalesce(feed_events.progress, 0), coalesce(EXCLUDED.progress, 0)),
    duration_ms = greatest(coalesce(feed_events.duration_ms, 0), coalesce(EXCLUDED.duration_ms, 0)),
    occurred_at = greatest(feed_events.occurred_at, EXCLUDED.occurred_at),
    received_at = timezone('utc'::text, now());
END;
$$;

REVOKE ALL ON FUNCTION public.record_feed_media_progress_event(
  text, uuid, bigint, uuid, text, uuid, uuid, text, integer, integer,
  double precision, jsonb, timestamptz
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_feed_media_progress_event(
  text, uuid, bigint, uuid, text, uuid, uuid, text, integer, integer,
  double precision, jsonb, timestamptz
) TO service_role;

-- Replace the prune function with fact-aware retention. The old 4-parameter
-- signature must be dropped first: keeping both overloads would make PostgREST
-- rpc() calls ambiguous. Body is identical to 20260715095000 apart from the
-- p_fact_retention_days validation, the facts deletion batch, and the summary
-- key. Facts intentionally outlive events: they are the durable training and
-- attribution dataset.
DROP FUNCTION IF EXISTS public.prune_feed_personalization_data(
  timestamptz, integer, integer, integer
);

CREATE OR REPLACE FUNCTION public.prune_feed_personalization_data(
  p_as_of timestamptz DEFAULT timezone('utc'::text, now()),
  p_event_retention_days integer DEFAULT 90,
  p_session_retention_days integer DEFAULT 2,
  p_limit integer DEFAULT 5000,
  p_fact_retention_days integer DEFAULT 400
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
  v_facts_deleted integer := 0;
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

  IF p_fact_retention_days IS NULL
    OR p_fact_retention_days < p_event_retention_days
    OR p_fact_retention_days > 1460
  THEN
    RAISE EXCEPTION 'Feed fact retention days must be between event retention days and 1460';
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

  WITH doomed AS (
    SELECT facts.delivery_id
    FROM public.feed_delivery_facts AS facts
    WHERE facts.ranked_at < p_as_of - make_interval(days => p_fact_retention_days)
    ORDER BY facts.ranked_at ASC, facts.delivery_id
    LIMIT p_limit
  ), deleted AS (
    DELETE FROM public.feed_delivery_facts AS facts
    USING doomed
    WHERE facts.delivery_id = doomed.delivery_id
    RETURNING 1
  )
  SELECT count(*) INTO v_facts_deleted FROM deleted;

  RETURN jsonb_build_object(
    'skipped', false,
    'events_deleted', v_events_deleted,
    'sessions_deleted', v_sessions_deleted,
    'assignments_deleted', v_assignments_deleted,
    'interests_deleted', v_interests_deleted,
    'post_feedback_deleted', v_post_feedback_deleted,
    'creator_feedback_deleted', v_creator_feedback_deleted,
    'facts_deleted', v_facts_deleted
  );
END;
$$;

REVOKE ALL ON FUNCTION public.prune_feed_personalization_data(
  timestamptz, integer, integer, integer, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_feed_personalization_data(
  timestamptz, integer, integer, integer, integer
) TO service_role;

COMMENT ON TABLE public.feed_delivery_facts IS
  'Backend-owned durable per-delivery exposure facts with monotone outcome columns; survives session pruning.';
COMMENT ON FUNCTION public.apply_feed_delivery_outcome() IS
  'Applies each delivery-attributed feed event to its durable fact row with write-once/GREATEST semantics.';
COMMENT ON FUNCTION public.record_feed_media_progress_event(
  text, uuid, bigint, uuid, text, uuid, uuid, text, integer, integer,
  double precision, jsonb, timestamptz
) IS
  'Idempotently upserts the single max-progress media_progress event per delivery; service role only.';
COMMENT ON FUNCTION public.prune_feed_personalization_data(
  timestamptz, integer, integer, integer, integer
) IS
  'Deletes bounded expired feed data after detaching longer-lived events; facts have independent longer retention.';
