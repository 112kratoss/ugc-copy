-- score_components, an object of 25+ keys, was stored twice for every served
-- delivery: on its feed_session_items row and on its feed_delivery_facts row
-- (usage audit, 2026-11-04). Which copy is read, and by what:
--
-- * feed_delivery_facts.score_components is the training and analysis record:
--   scripts/ops/feed-ranker-train.ts reads the weight keys from it, and the
--   `ranking` explanation is kept there for analysis. Kept 30 days. Unchanged.
-- * feed_session_items.score_components is read only by the serving path, for
--   the two hours a session lives (showcase-feed-personalization.ts):
--   - a continuation page mints the facts of the positions it serves by
--     copying their session items' components; a cursor always points past
--     the positions already served, so only an unserved item is ever copied;
--   - every page, a reused first page included, reads negative_feedback_risk
--     and is_following from each item to apply the visibility stage again. The
--     recommendation context reads the candidate source from its own column.
--   Nothing else reads it: the event ingest reads id, session, post and
--   position.
--
-- So a served item needs only those two keys once its fact holds the rest.
-- persist_ranked_feed_session now writes the full object to the fact, from the
-- request, and only the two serving keys to a served session item; an unserved
-- item keeps the full object its fact will be copied from. Session items are
-- pruned two days after their session expires, so the rows already stored age
-- out on their own; rewriting them would cost more WAL than they hold.
--
-- Reproduced from 20260922054500_atomic_feed_session.sql with those two column
-- expressions changed and nothing else. Grants and comment restated. Replacing
-- a function takes no table lock; the timeout only bounds an unexpected wait
-- (a plain SET, reset at the end: see 20261104135153).
SET lock_timeout = '2s';

CREATE OR REPLACE FUNCTION public.persist_ranked_feed_session(
  p_session jsonb,
  p_items jsonb,
  p_experiment jsonb,
  p_offset integer,
  p_limit integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_session_id uuid;
  v_served_at timestamptz := (p_session->>'served_at')::timestamptz;
  v_deliveries jsonb;
BEGIN
  IF jsonb_typeof(p_session) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_items) IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_experiment) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Invalid feed session payload' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_items) NOT BETWEEN 1 AND 60
     OR p_offset IS NULL OR p_offset < 0
     OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 60
     OR v_served_at IS NULL
     OR (p_session->>'viewer_user_id' IS NULL
         AND p_session->>'anonymous_key_hash' IS NULL) THEN
    RAISE EXCEPTION 'Invalid feed session bounds or identity' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.feed_sessions (
    viewer_user_id, anonymous_key_hash, surface, mode, filters,
    algorithm_version_id, experiment_assignment_id, random_seed, expires_at
  ) VALUES (
    (p_session->>'viewer_user_id')::uuid,
    p_session->>'anonymous_key_hash', 'showcase', 'for-you',
    p_session->'filters', (p_session->>'algorithm_version_id')::uuid,
    (p_experiment->>'assignment_id')::bigint,
    (p_session->>'random_seed')::bigint,
    (p_session->>'expires_at')::timestamptz
  ) RETURNING id INTO v_session_id;

  WITH inserted AS (
    INSERT INTO public.feed_session_items (
      session_id, post_id, position, candidate_source, final_score,
      score_components, is_exploration, served_at
    )
    SELECT v_session_id, (entry->>'post_id')::uuid, (ordinality - 1)::integer,
      entry->>'candidate_source', (entry->>'final_score')::double precision,
      -- A served item keeps only what serving reads again; its fact below
      -- holds the whole object.
      CASE WHEN ordinality - 1 >= p_offset
                 AND ordinality - 1 < p_offset::bigint + p_limit
           THEN jsonb_strip_nulls(jsonb_build_object(
             'negative_feedback_risk', entry->'score_components'->'negative_feedback_risk',
             'is_following', entry->'score_components'->'is_following'
           ))
           ELSE entry->'score_components' END,
      entry->>'candidate_source' = 'exploration',
      CASE WHEN ordinality - 1 >= p_offset
                 AND ordinality - 1 < p_offset::bigint + p_limit
           THEN v_served_at ELSE NULL END
    FROM jsonb_array_elements(p_items) WITH ORDINALITY AS input(entry, ordinality)
    RETURNING id, post_id, position, candidate_source, final_score,
      score_components, is_exploration, served_at
  ), facts AS (
    INSERT INTO public.feed_delivery_facts (
      delivery_id, session_id, algorithm_version_id, experiment_assignment_id,
      experiment_id, experiment_variant_id, viewer_user_id, anonymous_key_hash,
      post_id, creator_user_id, position, candidate_source, is_exploration,
      exploration_propensity, final_score, score_components, surface, mode,
      ranked_at, served_at
    )
    SELECT i.id, v_session_id, (p_session->>'algorithm_version_id')::uuid,
      (p_experiment->>'assignment_id')::bigint,
      (p_experiment->>'experiment_id')::uuid, (p_experiment->>'variant_id')::uuid,
      (p_session->>'viewer_user_id')::uuid, p_session->>'anonymous_key_hash',
      i.post_id, (p_items->i.position->>'creator_user_id')::uuid,
      i.position, i.candidate_source, i.is_exploration,
      CASE WHEN i.is_exploration THEN 1 ELSE 0 END,
      i.final_score, p_items->i.position->'score_components', 'showcase', 'for-you',
      v_served_at, i.served_at
    FROM inserted i
    WHERE i.served_at IS NOT NULL
    RETURNING delivery_id
  )
  SELECT jsonb_agg(jsonb_build_object('id', id::text, 'position', position) ORDER BY position)
  INTO v_deliveries FROM inserted;

  -- A failure in any insert aborts this call, including the preceding session
  -- insert. Do not catch errors and leave a partial session visible to reuse.
  RETURN jsonb_build_object('session_id', v_session_id, 'deliveries', v_deliveries);
END;
$$;

REVOKE ALL ON FUNCTION public.persist_ranked_feed_session(jsonb, jsonb, jsonb, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.persist_ranked_feed_session(jsonb, jsonb, jsonb, integer, integer)
  TO service_role;

COMMENT ON FUNCTION public.persist_ranked_feed_session(jsonb, jsonb, jsonb, integer, integer)
  IS 'Atomically persists 1-60 ranked candidates and only the requested exposure slice; a served item keeps only the score keys serving reads again, and its fact the whole object. Service-role only.';

RESET lock_timeout;
