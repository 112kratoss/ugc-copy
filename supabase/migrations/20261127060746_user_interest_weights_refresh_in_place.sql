-- refresh_user_interest_weights updates in place: it upserts only rows that changed and deletes only
-- the dimensions that disappeared (database audit, 2026-11-27).
--
-- Production: 3,329 calls at 208 ms; user_interest_weights had 632,105 inserts and 631,314 deletes
-- for 804 live rows. Each run deleted every row of the batch's users (DELETE ... WHERE user_id =
-- ANY(v_user_ids)) and inserted them again, so its ON CONFLICT DO UPDATE could never fire.
--
-- Now the computed rows (unchanged aggregation, a MATERIALIZED CTE) are upserted with a guard
-- (IS DISTINCT FROM over the values, as rebuild_search_terms does), and a data-modifying CTE
-- deletes the batch's rows whose dimension is no longer computed. The resulting rows are
-- identical, values and updated_at alike, except that a row whose values did not change keeps
-- the updated_at of its last change instead of p_as_of; weights decay with p_as_of, so that
-- happens only when the clock does not move or a weight's every input is ahead of it.
-- updated_at is read only as this function's fallback ordering for a user with no progress row.
-- Progress (user_interest_refresh_state) and the return value are unchanged.
-- Name, arguments, return type, invoker rights, search_path and grants are unchanged; the body is
-- the live definition from a clean replay with the delete and the write changed.
-- supabase/tests/database/user_interest_weights_refresh_incremental.test.sql proves identical
-- rows against the old function and counts the writes.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.refresh_user_interest_weights(p_as_of timestamp with time zone DEFAULT timezone('utc'::text, now()), p_lookback_days integer DEFAULT 90, p_half_life_days integer DEFAULT 30, p_limit integer DEFAULT 1000)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_user_ids uuid[];
BEGIN
  IF p_as_of IS NULL THEN
    RAISE EXCEPTION 'Interest refresh timestamp is required';
  END IF;

  IF p_lookback_days IS NULL OR p_lookback_days < 1 OR p_lookback_days > 365 THEN
    RAISE EXCEPTION 'Interest lookback days must be between 1 and 365';
  END IF;

  IF p_half_life_days IS NULL OR p_half_life_days < 1 OR p_half_life_days > 365 THEN
    RAISE EXCEPTION 'Interest half-life days must be between 1 and 365';
  END IF;

  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 5000 THEN
    RAISE EXCEPTION 'Interest refresh limit must be between 1 and 5000';
  END IF;

  IF NOT pg_try_advisory_xact_lock(hashtextextended('refresh_user_interest_weights', 0)) THEN
    RETURN 0;
  END IF;

  SELECT array_agg(candidate.user_id ORDER BY candidate.last_refresh ASC NULLS FIRST, candidate.user_id)
  INTO v_user_ids
  FROM (
    SELECT
      active.user_id,
      coalesce(min(refresh.refreshed_at), min(interests.updated_at)) AS last_refresh
    FROM (
      SELECT events.viewer_user_id AS user_id
      FROM public.feed_events AS events
      WHERE events.viewer_user_id IS NOT NULL
        -- Session pruning clears session_item_id after two days; the immutable
        -- delivery_fact_id keeps the full configured interest window usable.
        AND (
          events.delivery_fact_id IS NOT NULL
          OR events.event_type IN ('comment', 'follow', 'remix_complete', 'purchase')
        )
        AND events.occurred_at >= p_as_of - make_interval(days => p_lookback_days)
        AND events.occurred_at <= p_as_of

      UNION

      -- Creators with recent successful generations are refreshed even with no
      -- feed activity at all, which is exactly the cold-start case.
      SELECT generations.user_id
      FROM public.generations AS generations
      WHERE generations.user_id IS NOT NULL
        AND generations.status IN ('succeeded', 'completed')
        AND generations.completed_at >= p_as_of - make_interval(days => p_lookback_days)
        AND generations.completed_at <= p_as_of
    ) AS active
    LEFT JOIN public.user_interest_weights AS interests
      ON interests.user_id = active.user_id
    LEFT JOIN public.user_interest_refresh_state AS refresh
      ON refresh.user_id = active.user_id
    GROUP BY active.user_id
    ORDER BY coalesce(min(refresh.refreshed_at), min(interests.updated_at)) ASC NULLS FIRST, active.user_id
    LIMIT p_limit
  ) AS candidate;

  IF coalesce(cardinality(v_user_ids), 0) = 0 THEN
    RETURN 0;
  END IF;

  WITH weighted_events AS (
    SELECT
      events.viewer_user_id AS user_id,
      posts.user_id AS creator_user_id,
      posts.category,
      posts.post_format,
      posts.source_tool_slug,
      embeddings.cluster_id AS semantic_cluster_id,
      events.occurred_at,
      events.received_at,
      (
        CASE events.event_type
          WHEN 'open' THEN 0.10::double precision
          WHEN 'dwell' THEN CASE
            WHEN coalesce(events.duration_ms::double precision, events.event_value, 0) >= 3000
              THEN 0.35::double precision
            ELSE 0.05::double precision
          END
          WHEN 'media_progress' THEN CASE
            WHEN coalesce(events.progress, events.event_value, 0) >= 0.75
              THEN 0.50::double precision
            ELSE 0.10::double precision
          END
          WHEN 'quick_skip' THEN -1.00::double precision
          WHEN 'save' THEN 3.00::double precision
          WHEN 'unsave' THEN -1.00::double precision
          WHEN 'share' THEN 2.00::double precision
          WHEN 'comment' THEN 3.00::double precision
          WHEN 'follow' THEN 4.00::double precision
          WHEN 'remix_start' THEN 4.00::double precision
          WHEN 'remix_complete' THEN 6.00::double precision
          WHEN 'resource_open' THEN 2.00::double precision
          WHEN 'purchase' THEN 8.00::double precision
          WHEN 'not_interested' THEN -6.00::double precision
          WHEN 'hide_creator' THEN -8.00::double precision
          WHEN 'report' THEN -10.00::double precision
          ELSE 0.00::double precision
        END
      ) * power(
        0.5::double precision,
        greatest(
          0.0::double precision,
          extract(epoch FROM (p_as_of - events.occurred_at))::double precision
        ) / (p_half_life_days::double precision * 86400.0::double precision)
      ) AS signed_weight
    FROM public.feed_events AS events
    JOIN public.posts AS posts ON posts.id = events.post_id
    LEFT JOIN public.post_content_embeddings AS embeddings
      ON embeddings.post_id = events.post_id
     AND embeddings.embedding_model = 'gte-small'
     AND embeddings.embedding IS NOT NULL
    WHERE events.viewer_user_id = ANY(v_user_ids)
      AND (
        events.delivery_fact_id IS NOT NULL
        OR events.event_type IN ('comment', 'follow', 'remix_complete', 'purchase')
      )
      AND events.occurred_at >= p_as_of - make_interval(days => p_lookback_days)
      AND events.occurred_at <= p_as_of
  ),
  weighted_creations AS (
    SELECT
      generations.user_id,
      public.normalize_feed_interest_category(generations.category) AS category,
      generations.completed_at AS occurred_at,
      (
        3.00::double precision
        + CASE WHEN generations.template_run_id IS NOT NULL THEN 1.00::double precision ELSE 0.00::double precision END
      ) * power(
        0.5::double precision,
        greatest(
          0.0::double precision,
          extract(epoch FROM (p_as_of - generations.completed_at))::double precision
        ) / (p_half_life_days::double precision * 86400.0::double precision)
      ) AS signed_weight
    FROM public.generations AS generations
    LEFT JOIN public.template_runs AS runs ON runs.id = generations.template_run_id
    WHERE generations.user_id = ANY(v_user_ids)
      AND generations.status IN ('succeeded', 'completed')
      AND generations.completed_at >= p_as_of - make_interval(days => p_lookback_days)
      AND generations.completed_at <= p_as_of
      AND public.normalize_feed_interest_category(generations.category) IS NOT NULL
  ),
  onboarding_seeds AS (
    SELECT
      states.user_id,
      public.normalize_feed_interest_category(states.goal) AS category,
      coalesce(states.updated_at, states.created_at) AS occurred_at,
      4.00::double precision * power(
        0.5::double precision,
        greatest(
          0.0::double precision,
          extract(epoch FROM (p_as_of - coalesce(states.updated_at, states.created_at)))::double precision
        ) / (p_half_life_days::double precision * 86400.0::double precision)
      ) AS signed_weight
    FROM public.mobile_onboarding_states AS states
    WHERE states.user_id = ANY(v_user_ids)
      AND public.normalize_feed_interest_category(states.goal) IS NOT NULL
  ),
  dimensions AS (
    SELECT
      weighted.user_id,
      'category'::text AS dimension_type,
      weighted.category AS dimension_value,
      weighted.signed_weight,
      weighted.occurred_at,
      weighted.received_at
    FROM weighted_events AS weighted
    WHERE weighted.category IS NOT NULL AND weighted.signed_weight <> 0

    UNION ALL

    SELECT
      weighted.user_id,
      'media_type'::text,
      coalesce(weighted.post_format, weighted.category),
      weighted.signed_weight,
      weighted.occurred_at,
      weighted.received_at
    FROM weighted_events AS weighted
    WHERE coalesce(weighted.post_format, weighted.category) IS NOT NULL
      AND weighted.signed_weight <> 0

    UNION ALL

    SELECT
      weighted.user_id,
      'source_tool'::text,
      weighted.source_tool_slug,
      weighted.signed_weight,
      weighted.occurred_at,
      weighted.received_at
    FROM weighted_events AS weighted
    WHERE weighted.source_tool_slug IS NOT NULL
      AND weighted.signed_weight <> 0

    UNION ALL

    SELECT
      weighted.user_id,
      'creator'::text,
      weighted.creator_user_id::text,
      weighted.signed_weight,
      weighted.occurred_at,
      weighted.received_at
    FROM weighted_events AS weighted
    WHERE weighted.signed_weight <> 0

    UNION ALL

    SELECT
      weighted.user_id,
      'semantic_cluster'::text,
      'c' || weighted.semantic_cluster_id::text,
      weighted.signed_weight,
      weighted.occurred_at,
      weighted.received_at
    FROM weighted_events AS weighted
    WHERE weighted.semantic_cluster_id IS NOT NULL
      AND weighted.signed_weight <> 0

    UNION ALL

    SELECT
      creations.user_id,
      'category'::text,
      creations.category,
      creations.signed_weight,
      creations.occurred_at,
      creations.occurred_at
    FROM weighted_creations AS creations
    WHERE creations.signed_weight <> 0

    UNION ALL

    SELECT
      creations.user_id,
      'media_type'::text,
      creations.category,
      creations.signed_weight,
      creations.occurred_at,
      creations.occurred_at
    FROM weighted_creations AS creations
    WHERE creations.signed_weight <> 0

    UNION ALL

    SELECT
      seeds.user_id,
      'category'::text,
      seeds.category,
      seeds.signed_weight,
      seeds.occurred_at,
      seeds.occurred_at
    FROM onboarding_seeds AS seeds
    WHERE seeds.signed_weight <> 0

    UNION ALL

    SELECT
      seeds.user_id,
      'media_type'::text,
      seeds.category,
      seeds.signed_weight,
      seeds.occurred_at,
      seeds.occurred_at
    FROM onboarding_seeds AS seeds
    WHERE seeds.signed_weight <> 0
  ),
  refreshed AS MATERIALIZED (
    SELECT
      dimensions.user_id AS user_id,
      dimensions.dimension_type AS dimension_type,
      dimensions.dimension_value AS dimension_value,
      least(
        20.0::double precision,
        greatest(-20.0::double precision, sum(dimensions.signed_weight))
      ) AS weight,
      sum(greatest(dimensions.signed_weight, 0.0::double precision)) AS positive_score,
      sum(greatest(-dimensions.signed_weight, 0.0::double precision)) AS negative_score,
      count(*) FILTER (WHERE dimensions.signed_weight > 0) AS positive_event_count,
      count(*) FILTER (WHERE dimensions.signed_weight < 0) AS negative_event_count,
      max(dimensions.occurred_at) AS last_event_at,
      max(dimensions.received_at) AS last_event_received_at,
      p_as_of AS updated_at
    FROM dimensions
    GROUP BY dimensions.user_id, dimensions.dimension_type, dimensions.dimension_value
    HAVING abs(sum(dimensions.signed_weight)) >= 0.01::double precision
  ),
  -- Only the dimensions the batch's users no longer have are deleted; the rest are updated in place.
  removed AS (
    DELETE FROM public.user_interest_weights AS interests
    WHERE interests.user_id = ANY(v_user_ids)
      AND NOT EXISTS (
        SELECT 1
        FROM refreshed
        WHERE refreshed.user_id = interests.user_id
          AND refreshed.dimension_type = interests.dimension_type
          AND refreshed.dimension_value = interests.dimension_value
      )
  )
  INSERT INTO public.user_interest_weights (
    user_id,
    dimension_type,
    dimension_value,
    weight,
    positive_score,
    negative_score,
    positive_event_count,
    negative_event_count,
    last_event_at,
    last_event_received_at,
    updated_at
  )
  SELECT
    refreshed.user_id, refreshed.dimension_type, refreshed.dimension_value,
    refreshed.weight, refreshed.positive_score, refreshed.negative_score,
    refreshed.positive_event_count, refreshed.negative_event_count,
    refreshed.last_event_at, refreshed.last_event_received_at, refreshed.updated_at
  FROM refreshed
  ON CONFLICT (user_id, dimension_type, dimension_value) DO UPDATE
  SET weight = EXCLUDED.weight,
      positive_score = EXCLUDED.positive_score,
      negative_score = EXCLUDED.negative_score,
      positive_event_count = EXCLUDED.positive_event_count,
      negative_event_count = EXCLUDED.negative_event_count,
      last_event_at = EXCLUDED.last_event_at,
      last_event_received_at = EXCLUDED.last_event_received_at,
      updated_at = EXCLUDED.updated_at
  -- A row whose values are what it holds is not written; it keeps the updated_at of its last change.
  WHERE (
    user_interest_weights.weight, user_interest_weights.positive_score,
    user_interest_weights.negative_score, user_interest_weights.positive_event_count,
    user_interest_weights.negative_event_count, user_interest_weights.last_event_at,
    user_interest_weights.last_event_received_at
  ) IS DISTINCT FROM (
    EXCLUDED.weight, EXCLUDED.positive_score, EXCLUDED.negative_score, EXCLUDED.positive_event_count,
    EXCLUDED.negative_event_count, EXCLUDED.last_event_at, EXCLUDED.last_event_received_at
  );

  -- A successful refresh may legitimately produce no dimensions (audio-only,
  -- impressions-only, or cancelling weights). Record progress independently.
  -- Wall-clock completion advances even when a caller reuses the same p_as_of.
  INSERT INTO public.user_interest_refresh_state (user_id, refreshed_at)
  SELECT user_id, clock_timestamp() FROM unnest(v_user_ids) AS batch(user_id)
  ON CONFLICT (user_id) DO UPDATE SET refreshed_at = EXCLUDED.refreshed_at;

  RETURN cardinality(v_user_ids);
END;
$function$;

COMMIT;
