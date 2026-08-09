-- F7b: daily aggregates, so a 30-day raw window stops being a data-loss clock.
--
-- Decision #2 cut raw fact retention from 400 days to 30, on the explicit
-- reasoning that "raw facts are not the lookback mechanism -- daily aggregates
-- are". Those aggregates did not exist, which left a dated obligation: the
-- 30-day window begins discarding history on 2026-08-27 (the oldest fact is
-- 2026-07-28). This closes it.
--
-- Grain is the experiment-analysis grain, not the row: one bucket per day per
-- (algorithm version, experiment, variant, candidate source, surface). That is
-- what a lookback actually asks -- "did variant B convert better than A on the
-- trending lane last month" -- and it survives the raw rows by design.
--
-- `UNIQUE NULLS NOT DISTINCT` is load-bearing. Four of the six grain columns
-- are nullable (there is often no experiment, no variant, no algorithm
-- version), and under the default NULLS DISTINCT rule every such row is unique,
-- so `ON CONFLICT` would never fire and each refresh would append duplicates
-- instead of updating. Postgres 15+ only; production and local are both 17.

CREATE TABLE IF NOT EXISTS public.feed_delivery_fact_daily (
  fact_date date NOT NULL,
  algorithm_version_id uuid,
  experiment_id uuid,
  experiment_variant_id uuid,
  candidate_source text,
  surface text,

  deliveries bigint NOT NULL DEFAULT 0,
  exploration_deliveries bigint NOT NULL DEFAULT 0,
  served bigint NOT NULL DEFAULT 0,
  rendered bigint NOT NULL DEFAULT 0,
  qualified_impressions bigint NOT NULL DEFAULT 0,
  opens bigint NOT NULL DEFAULT 0,
  quick_skips bigint NOT NULL DEFAULT 0,
  saves bigint NOT NULL DEFAULT 0,
  shares bigint NOT NULL DEFAULT 0,
  follows bigint NOT NULL DEFAULT 0,
  remix_starts bigint NOT NULL DEFAULT 0,
  remix_completes bigint NOT NULL DEFAULT 0,
  resource_opens bigint NOT NULL DEFAULT 0,
  purchases bigint NOT NULL DEFAULT 0,
  not_interested bigint NOT NULL DEFAULT 0,
  hid_creator bigint NOT NULL DEFAULT 0,
  reports bigint NOT NULL DEFAULT 0,

  -- Sums plus counts rather than pre-computed averages: an average cannot be
  -- re-aggregated across buckets, and every question at this grain is asked by
  -- summing several of them.
  dwell_ms_sum bigint NOT NULL DEFAULT 0,
  dwell_ms_count bigint NOT NULL DEFAULT 0,
  media_progress_sum double precision NOT NULL DEFAULT 0,
  media_progress_count bigint NOT NULL DEFAULT 0,
  final_score_sum double precision NOT NULL DEFAULT 0,
  final_score_count bigint NOT NULL DEFAULT 0,

  refreshed_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT feed_delivery_fact_daily_grain
    UNIQUE NULLS NOT DISTINCT
    (fact_date, algorithm_version_id, experiment_id, experiment_variant_id, candidate_source, surface)
);

CREATE INDEX IF NOT EXISTS feed_delivery_fact_daily_date_idx
  ON public.feed_delivery_fact_daily (fact_date DESC);

CREATE INDEX IF NOT EXISTS feed_delivery_fact_daily_experiment_idx
  ON public.feed_delivery_fact_daily (experiment_id, experiment_variant_id, fact_date DESC)
  WHERE experiment_id IS NOT NULL;

ALTER TABLE public.feed_delivery_fact_daily ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.feed_delivery_fact_daily FROM PUBLIC;
REVOKE ALL ON public.feed_delivery_fact_daily FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.feed_delivery_fact_daily TO service_role;

COMMENT ON TABLE public.feed_delivery_fact_daily IS
  'Daily rollup of feed_delivery_facts at the experiment-analysis grain (F7b). Outlives the 30-day raw fact window so experiment lookback survives retention.';

-- ─── Refresh ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.refresh_feed_delivery_fact_daily(
  p_as_of timestamptz DEFAULT now(),
  p_lookback_days integer DEFAULT 3,
  p_retention_days integer DEFAULT 400
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_as_of timestamptz := coalesce(p_as_of, now());
  -- A rolling re-aggregation, not an append-once. Facts are mutated after
  -- insert -- `served_at`, `opened_at`, `saved_at` and the rest are stamped as
  -- outcomes arrive -- so a day's bucket is not final when the day ends.
  -- Recomputing the last few days each run lets late outcomes land.
  v_lookback integer := greatest(coalesce(p_lookback_days, 3), 1);
  v_retention integer := greatest(coalesce(p_retention_days, 400), 1);
  v_from date := (v_as_of - make_interval(days => v_lookback))::date;
  v_days integer;
  v_pruned integer;
BEGIN
  INSERT INTO public.feed_delivery_fact_daily AS target (
    fact_date, algorithm_version_id, experiment_id, experiment_variant_id,
    candidate_source, surface,
    deliveries, exploration_deliveries, served, rendered, qualified_impressions,
    opens, quick_skips, saves, shares, follows, remix_starts, remix_completes,
    resource_opens, purchases, not_interested, hid_creator, reports,
    dwell_ms_sum, dwell_ms_count, media_progress_sum, media_progress_count,
    final_score_sum, final_score_count, refreshed_at
  )
  SELECT
    facts.ranked_at::date,
    facts.algorithm_version_id,
    facts.experiment_id,
    facts.experiment_variant_id,
    facts.candidate_source,
    facts.surface,
    count(*),
    count(*) FILTER (WHERE facts.is_exploration),
    count(*) FILTER (WHERE facts.served_at IS NOT NULL),
    count(*) FILTER (WHERE facts.rendered_at IS NOT NULL),
    count(*) FILTER (WHERE facts.qualified_impression_at IS NOT NULL),
    count(*) FILTER (WHERE facts.opened_at IS NOT NULL),
    count(*) FILTER (WHERE facts.quick_skipped_at IS NOT NULL),
    count(*) FILTER (WHERE facts.saved_at IS NOT NULL),
    count(*) FILTER (WHERE facts.shared_at IS NOT NULL),
    count(*) FILTER (WHERE facts.followed_at IS NOT NULL),
    count(*) FILTER (WHERE facts.remix_started_at IS NOT NULL),
    count(*) FILTER (WHERE facts.remix_completed_at IS NOT NULL),
    count(*) FILTER (WHERE facts.resource_opened_at IS NOT NULL),
    count(*) FILTER (WHERE facts.purchased_at IS NOT NULL),
    count(*) FILTER (WHERE facts.not_interested_at IS NOT NULL),
    count(*) FILTER (WHERE facts.hid_creator_at IS NOT NULL),
    count(*) FILTER (WHERE facts.reported_at IS NOT NULL),
    -- Counted on `> 0`, not on `IS NOT NULL`. `dwell_ms_max` and
    -- `media_progress_max` are NOT NULL DEFAULT 0, so a null-check would count
    -- every delivery as an observation and quietly divide by the wrong
    -- denominator -- an average that stays plausible while being wrong.
    coalesce(sum(facts.dwell_ms_max), 0),
    count(*) FILTER (WHERE facts.dwell_ms_max > 0),
    coalesce(sum(facts.media_progress_max), 0),
    count(*) FILTER (WHERE facts.media_progress_max > 0),
    -- `final_score` is NOT NULL, so every delivery contributes one.
    coalesce(sum(facts.final_score), 0),
    count(*),
    now()
  FROM public.feed_delivery_facts AS facts
  WHERE facts.ranked_at >= v_from
    AND facts.ranked_at < (v_as_of + interval '1 day')::date
  GROUP BY 1, 2, 3, 4, 5, 6
  ON CONFLICT ON CONSTRAINT feed_delivery_fact_daily_grain DO UPDATE SET
    deliveries = excluded.deliveries,
    exploration_deliveries = excluded.exploration_deliveries,
    served = excluded.served,
    rendered = excluded.rendered,
    qualified_impressions = excluded.qualified_impressions,
    opens = excluded.opens,
    quick_skips = excluded.quick_skips,
    saves = excluded.saves,
    shares = excluded.shares,
    follows = excluded.follows,
    remix_starts = excluded.remix_starts,
    remix_completes = excluded.remix_completes,
    resource_opens = excluded.resource_opens,
    purchases = excluded.purchases,
    not_interested = excluded.not_interested,
    hid_creator = excluded.hid_creator,
    reports = excluded.reports,
    dwell_ms_sum = excluded.dwell_ms_sum,
    dwell_ms_count = excluded.dwell_ms_count,
    media_progress_sum = excluded.media_progress_sum,
    media_progress_count = excluded.media_progress_count,
    final_score_sum = excluded.final_score_sum,
    final_score_count = excluded.final_score_count,
    refreshed_at = now()
  -- Assignment, not accumulation: the source rows are re-read in full for the
  -- window, so adding would double-count every refresh.
  WHERE target.fact_date = excluded.fact_date;

  GET DIAGNOSTICS v_days = ROW_COUNT;

  DELETE FROM public.feed_delivery_fact_daily
  WHERE fact_date < (v_as_of - make_interval(days => v_retention))::date;

  GET DIAGNOSTICS v_pruned = ROW_COUNT;

  RETURN jsonb_build_object(
    'buckets_refreshed', v_days,
    'buckets_pruned', v_pruned,
    'from_date', v_from,
    'retention_days', v_retention
  );
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_feed_delivery_fact_daily(timestamptz, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refresh_feed_delivery_fact_daily(timestamptz, integer, integer) FROM anon;
REVOKE ALL ON FUNCTION public.refresh_feed_delivery_fact_daily(timestamptz, integer, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_feed_delivery_fact_daily(timestamptz, integer, integer) TO service_role;
