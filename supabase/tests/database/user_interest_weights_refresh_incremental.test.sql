-- refresh_user_interest_weights updates the rows that changed and deletes only the dimensions that
-- disappeared (database audit, 2026-11-27).
--
-- Before, it deleted every row of each user in the batch and inserted them again (production:
-- 632,105 inserts and 631,314 deletes for 804 live rows). The resulting rows must be identical;
-- the oracle is the old function, kept below as pg_temp.legacy_refresh_user_interest_weights.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(17);

-- The function as it was before this change (pg_get_functiondef on a clean replay), the oracle.
CREATE FUNCTION pg_temp.legacy_refresh_user_interest_weights(p_as_of timestamp with time zone DEFAULT timezone('utc'::text, now()), p_lookback_days integer DEFAULT 90, p_half_life_days integer DEFAULT 30, p_limit integer DEFAULT 1000)
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

  DELETE FROM public.user_interest_weights
  WHERE user_id = ANY(v_user_ids);

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
$function$;

select ok(not (select prosecdef from pg_proc where oid = 'public.refresh_user_interest_weights(timestamptz,integer,integer,integer)'::regprocedure), 'still invoker');
select is((select proconfig from pg_proc where oid = 'public.refresh_user_interest_weights(timestamptz,integer,integer,integer)'::regprocedure), array['search_path=public, pg_temp'], 'same search path');
select ok(has_function_privilege('service_role', 'public.refresh_user_interest_weights(timestamptz,integer,integer,integer)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.refresh_user_interest_weights(timestamptz,integer,integer,integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.refresh_user_interest_weights(timestamptz,integer,integer,integer)', 'EXECUTE'), 'same grants');
select is(pg_get_function_result('public.refresh_user_interest_weights(timestamptz,integer,integer,integer)'::regprocedure), 'integer', 'same return type');

-- Runs the old function from the current rows and keeps what it wrote, puts both tables back,
-- runs the new one, and answers how many rows differ in any column (0 = identical).
create function pg_temp.diff_against_legacy(p_as_of timestamptz) returns bigint language plpgsql as $$
declare v_diff bigint;
begin
  drop table if exists pg_temp.before_weights, pg_temp.before_progress, pg_temp.legacy_state;
  create temp table before_weights as select * from public.user_interest_weights;
  create temp table before_progress as select * from public.user_interest_refresh_state;
  perform pg_temp.legacy_refresh_user_interest_weights(p_as_of, 90, 30, 5000);
  create temp table legacy_state as select to_jsonb(w) as v from public.user_interest_weights w;
  delete from public.user_interest_weights;
  insert into public.user_interest_weights select * from before_weights;
  -- Progress rows cannot be deleted by service_role, but this runs as the owner.
  delete from public.user_interest_refresh_state;
  insert into public.user_interest_refresh_state select * from before_progress;
  perform public.refresh_user_interest_weights(p_as_of, 90, 30, 5000);
  select count(*) into v_diff from (
    (select v from legacy_state except all select to_jsonb(w) from public.user_interest_weights w)
    union all
    (select to_jsonb(w) from public.user_interest_weights w except all select v from legacy_state)
  ) d;
  return v_diff;
end $$;

create function pg_temp.weights_writes() returns bigint[] language sql as $$
  select array[n_tup_ins, n_tup_upd, n_tup_del] from pg_stat_xact_user_tables where relid = 'public.user_interest_weights'::regclass $$;

insert into auth.users (id, email, aud, role, created_at) values
  ('5e100000-0000-4000-8000-000000000001', 'interest-viewer@example.invalid', 'authenticated', 'authenticated', '1900-01-01'),
  ('5e100000-0000-4000-8000-000000000002', 'interest-maker@example.invalid', 'authenticated', 'authenticated', '1900-01-01'),
  ('5e100000-0000-4000-8000-000000000003', 'interest-creator-c@example.invalid', 'authenticated', 'authenticated', '1900-01-01'),
  ('5e100000-0000-4000-8000-000000000004', 'interest-creator-d@example.invalid', 'authenticated', 'authenticated', '1900-01-01'),
  ('5e100000-0000-4000-8000-000000000005', 'interest-creator-e@example.invalid', 'authenticated', 'authenticated', '1900-01-01');

create temp table clock as select timestamptz '2030-03-01 00:00:00+00' as t;

-- P1 an image and P2 a video by C (a tool on P1), P3 a text post by D, P4 an image by E.
insert into public.posts (id, user_id, visibility, category, source_kind, post_format, review_status, body, output_url, source_tool_slug, created_at) values
  ('5e000000-0000-4000-8000-000000000001', '5e100000-0000-4000-8000-000000000003', 'public', 'image', 'external', 'media', 'visible', null, 'https://example.invalid/1', 'tool-x', '2029-01-01'),
  ('5e000000-0000-4000-8000-000000000002', '5e100000-0000-4000-8000-000000000003', 'public', 'video', 'external', 'media', 'visible', null, 'https://example.invalid/2', null, '2029-01-01'),
  ('5e000000-0000-4000-8000-000000000003', '5e100000-0000-4000-8000-000000000004', 'public', 'text', 'external', 'text', 'visible', 'a note', null, null, '2029-01-01'),
  ('5e000000-0000-4000-8000-000000000004', '5e100000-0000-4000-8000-000000000005', 'public', 'image', 'external', 'media', 'visible', null, 'https://example.invalid/4', null, '2029-01-01');

-- The viewer's signals. P3's save leaves the 90-day lookback first (D's creator, text category
-- and media type disappear), then P4's (only E's creator disappears: images stay through P1).
set local session_replication_role = replica;
insert into public.feed_events (client_event_id, post_id, creator_user_id, viewer_user_id, event_type, source_surface, occurred_at, received_at, duration_ms, delivery_fact_id)
select 'interest-' || row_number() over (), e.post::uuid, e.creator::uuid, '5e100000-0000-4000-8000-000000000001',
  e.kind, 'feed', clock.t - e.age, clock.t - e.age, e.duration, case when e.delivered then 1 end
from clock, (values
  ('5e000000-0000-4000-8000-000000000001', '5e100000-0000-4000-8000-000000000003', 'save', interval '1 day', null::int, true),
  ('5e000000-0000-4000-8000-000000000002', '5e100000-0000-4000-8000-000000000003', 'dwell', interval '2 days', 3500, true),
  ('5e000000-0000-4000-8000-000000000002', '5e100000-0000-4000-8000-000000000003', 'quick_skip', interval '3 days', null, true),
  ('5e000000-0000-4000-8000-000000000001', '5e100000-0000-4000-8000-000000000003', 'comment', interval '10 days', null, false),
  ('5e000000-0000-4000-8000-000000000002', '5e100000-0000-4000-8000-000000000003', 'not_interested', interval '20 days', null, true),
  ('5e000000-0000-4000-8000-000000000001', '5e100000-0000-4000-8000-000000000003', 'impression', interval '1 hour', null, true),
  ('5e000000-0000-4000-8000-000000000003', '5e100000-0000-4000-8000-000000000004', 'save', interval '89 days', null, true),
  ('5e000000-0000-4000-8000-000000000004', '5e100000-0000-4000-8000-000000000005', 'save', interval '87 days', null, true)
) as e(post, creator, kind, age, duration, delivered);
set local session_replication_role = origin;

-- The maker has only creations.
insert into public.generations (user_id, status, category, model, completed_at, created_at)
select '5e100000-0000-4000-8000-000000000002', 'completed', c.category, 'audit-local', clock.t - c.age, clock.t - c.age
from clock, (values ('image', interval '5 days'), ('video', interval '60 days')) as c(category, age);

select is(pg_temp.diff_against_legacy((select t from clock)), 0::bigint, 'identical to the old function at the clock');
select ok((select count(*) from public.user_interest_weights where user_id = '5e100000-0000-4000-8000-000000000001'
  and (dimension_type, dimension_value) in (('creator', '5e100000-0000-4000-8000-000000000004'), ('category', 'text'))) = 2,
  'fixture: the viewer has interests from P3');

-- The same clock again: nothing changed, so nothing is written.
create temp table before_rerun as select user_id, dimension_type, dimension_value, ctid::text as tid from public.user_interest_weights;
create temp table writes_before as select pg_temp.weights_writes() as w;
select is(public.refresh_user_interest_weights((select t from clock), 90, 30, 5000), 2, 'both users refreshed again');
select is((select pg_temp.weights_writes() from clock)::text, (select w from writes_before)::text, 'no row inserted, updated or deleted');
select ok(not exists (select 1 from public.user_interest_weights w join before_rerun b using (user_id, dimension_type, dimension_value) where w.ctid::text <> b.tid),
  'every row is where it was');

-- An hour later every weight has decayed: identical to the old function, written in place.
select is(pg_temp.diff_against_legacy((select t from clock) + interval '1 hour'), 0::bigint, 'identical an hour later');

-- Two days later P3's save has left the lookback: identical, and its dimensions are gone.
select is(pg_temp.diff_against_legacy((select t from clock) + interval '2 days'), 0::bigint, 'identical two days later');
select is((select count(*)::int from public.user_interest_weights where user_id = '5e100000-0000-4000-8000-000000000001'
  and (dimension_type, dimension_value) in (('creator', '5e100000-0000-4000-8000-000000000004'), ('category', 'text'), ('media_type', 'text'))), 0,
  'the dimensions P3 gave are gone');

-- Four days later P4's save leaves too: only E's creator row is deleted, the rest are updated in
-- place and nothing is inserted.
create temp table before_four as select pg_temp.weights_writes() as w, (select count(*) from public.user_interest_weights) as n;
select is(public.refresh_user_interest_weights((select t from clock) + interval '4 days', 90, 30, 5000), 2, 'both users refreshed');
select is((select (pg_temp.weights_writes())[3] - w[3] from before_four), 1::bigint, 'one row deleted: the dimension that disappeared');
select is((select (pg_temp.weights_writes())[1] - w[1] from before_four), 0::bigint, 'no row inserted');
select is((select (pg_temp.weights_writes())[2] - w[2] from before_four), (select n - 1 from before_four), 'every other row updated in place');
select is(pg_temp.diff_against_legacy((select t from clock) + interval '5 days'), 0::bigint, 'identical five days later');

select * from finish();
rollback;
