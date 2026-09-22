-- Persist a new ranked session, its candidates, and only the served exposures
-- in one transaction / Data API round trip. Invoker privileges stay unchanged.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

CREATE FUNCTION public.persist_ranked_feed_session(
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
      entry->'score_components', entry->>'candidate_source' = 'exploration',
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
      i.final_score, i.score_components, 'showcase', 'for-you',
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
  IS 'Atomically persists 1-60 ranked candidates and only the requested exposure slice; service-role only.';
