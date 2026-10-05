-- Keep bounded refreshes progressing when selected users have no interests.
CREATE TABLE public.user_interest_refresh_state (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  refreshed_at timestamptz NOT NULL
);
ALTER TABLE public.user_interest_refresh_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.user_interest_refresh_state FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.user_interest_refresh_state TO service_role;
COMMENT ON TABLE public.user_interest_refresh_state IS
  'Last successful interest rebuild, including empty results; one row per refreshed account, removed with the account.';

CREATE OR REPLACE FUNCTION public.refresh_user_interest_weights(
  p_as_of timestamptz DEFAULT timezone('utc'::text, now()),
  p_lookback_days integer DEFAULT 90,
  p_half_life_days integer DEFAULT 30,
  p_limit integer DEFAULT 1000
)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
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
        AND events.delivery_fact_id IS NOT NULL
        AND events.occurred_at >= p_as_of - make_interval(days => p_lookback_days)
        AND events.occurred_at <= p_as_of

      UNION

      -- Creators with recent successful generations are refreshed even with no
      -- feed activity at all, which is exactly the cold-start case.
      SELECT generations.user_id
      FROM public.generations AS generations
      WHERE generations.user_id IS NOT NULL
        AND generations.status = 'completed'
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

  DELETE FROM public.user_interest_weights
  WHERE user_id = ANY(v_user_ids);

  WITH weighted_events AS (
    SELECT
      events.viewer_user_id AS user_id,
      posts.user_id AS creator_user_id,
      posts.category,
      posts.post_format,
      posts.source_tool_slug,
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
    WHERE events.viewer_user_id = ANY(v_user_ids)
      AND events.delivery_fact_id IS NOT NULL
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
      AND generations.status = 'completed'
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
    dimensions.user_id,
    dimensions.dimension_type,
    dimensions.dimension_value,
    least(
      20.0::double precision,
      greatest(-20.0::double precision, sum(dimensions.signed_weight))
    ),
    sum(greatest(dimensions.signed_weight, 0.0::double precision)),
    sum(greatest(-dimensions.signed_weight, 0.0::double precision)),
    count(*) FILTER (WHERE dimensions.signed_weight > 0),
    count(*) FILTER (WHERE dimensions.signed_weight < 0),
    max(dimensions.occurred_at),
    max(dimensions.received_at),
    p_as_of
  FROM dimensions
  GROUP BY dimensions.user_id, dimensions.dimension_type, dimensions.dimension_value
  HAVING abs(sum(dimensions.signed_weight)) >= 0.01::double precision
  ON CONFLICT (user_id, dimension_type, dimension_value) DO UPDATE
  SET weight = EXCLUDED.weight,
      positive_score = EXCLUDED.positive_score,
      negative_score = EXCLUDED.negative_score,
      positive_event_count = EXCLUDED.positive_event_count,
      negative_event_count = EXCLUDED.negative_event_count,
      last_event_at = EXCLUDED.last_event_at,
      last_event_received_at = EXCLUDED.last_event_received_at,
      updated_at = EXCLUDED.updated_at;

  -- A successful refresh may legitimately produce no dimensions (audio-only,
  -- impressions-only, or cancelling weights). Record progress independently.
  -- Wall-clock completion advances even when a caller reuses the same p_as_of.
  INSERT INTO public.user_interest_refresh_state (user_id, refreshed_at)
  SELECT user_id, clock_timestamp() FROM unnest(v_user_ids) AS batch(user_id)
  ON CONFLICT (user_id) DO UPDATE SET refreshed_at = EXCLUDED.refreshed_at;

  RETURN cardinality(v_user_ids);
END;
$$;
