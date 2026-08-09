-- F15a: move the cost report's arithmetic into the database.
--
-- The report currently downloads up to 5 x 5,001 raw rows per collection and
-- groups them in JS. That is bounded, and truncation is flagged rather than
-- silent (the first half of F15a), but the cap still turns every figure into a
-- lower bound once a source passes 5,000 rows in the window. Re-measured
-- 2026-08-09 the busiest source runs 47 rows/24h -- 0.94% of the cap -- so this
-- is a certification prerequisite, not a live problem.
--
-- WHAT THIS DELIBERATELY DOES NOT DO: it does not move policy into SQL. The
-- media-read scope set, the quote scope, and every budget threshold stay in
-- TypeScript, because they are product decisions that change often and are
-- unit-tested there. This function returns grouped arithmetic only -- counts,
-- sums, maxima, and per-key breakdowns -- and the caller derives policy from
-- `byScope`. The one exception is the storage bucket list, which has to be a
-- filter to avoid scanning every bucket, so it is passed in as a parameter
-- rather than hard-coded here.
--
-- FAITHFULNESS IS THE POINT. This replaces JS that is already unit-tested, so
-- every semantic below mirrors the builders in `backend-cost-report.ts`
-- exactly, including the parts that look like bugs:
--
--   * `coalesce(x, 'unknown')` matches JS `??` -- it catches null, NOT the
--     empty string. A row with `status = ''` groups under '' in both paths.
--   * Negative and non-numeric values clamp to 0, matching `numericValue()`.
--   * `output_url` counts only when non-null AND non-empty, matching JS string
--     truthiness. A single space IS truthy in JS, so it is not trimmed here.
--   * A null `outcome` becomes 'unknown', which is `<> 'success'`, so it counts
--     as a failure. That is what the JS does today.
--   * The failure/timeout breakdowns omit keys with a zero count entirely,
--     because the JS only ever calls `incrementCount` on an actual failure.
--     Emitting `{"kie": 0}` would be arithmetically nicer and would not match.
--
-- Every cost column involved (`generations.cost`, `ai_usage_events.cost`,
-- `backend_rate_limits.request_count`, `provider_dependency_events.duration_ms`)
-- is `integer`, so the JS habit of rounding after every addition and a single
-- SQL `sum()` cannot diverge. If any of them ever becomes numeric, that stops
-- being true and the differential test in
-- `src/__tests__/backend-cost-aggregates.test.ts` is what will catch it.

CREATE OR REPLACE FUNCTION public.get_backend_cost_aggregates(
  p_since timestamptz,
  p_storage_buckets text[],
  p_slow_duration_ms integer DEFAULT 15000
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH generation_rows AS (
    SELECT
      coalesce(rows.status, 'unknown') AS status,
      coalesce(rows.model, 'unknown') AS model,
      greatest(coalesce(rows.cost, 0), 0)::numeric AS cost,
      (rows.output_url IS NOT NULL AND rows.output_url <> '') AS has_output
    FROM public.generations rows
    WHERE rows.created_at >= p_since
  ),
  ai_usage_rows AS (
    SELECT
      coalesce(rows.feature, 'unknown') AS feature,
      coalesce(rows.status, 'unknown') AS status,
      greatest(coalesce(rows.cost, 0), 0)::numeric AS cost
    FROM public.ai_usage_events rows
    WHERE rows.created_at >= p_since
  ),
  provider_rows AS (
    SELECT
      coalesce(rows.service_name, 'unknown') AS service_name,
      coalesce(rows.outcome, 'unknown') AS outcome,
      greatest(coalesce(rows.duration_ms, 0), 0)::bigint AS duration_ms,
      -- Unattributed rows are excluded from per-model counts rather than
      -- bucketed as 'unknown': a synthetic bucket would accumulate every
      -- payment, FX and push call and then trip the model alert thresholds.
      nullif(btrim(coalesce(rows.model_id, '')), '') AS model_id
    FROM public.provider_dependency_events rows
    WHERE rows.created_at >= p_since
  ),
  rate_limit_rows AS (
    SELECT
      coalesce(rows.scope, 'unknown') AS scope,
      round(greatest(coalesce(rows.request_count, 0), 0))::bigint AS request_count
    FROM public.backend_rate_limits rows
    WHERE rows.window_start >= p_since
  ),
  storage_rows AS (
    SELECT
      coalesce(rows.bucket_id, 'unknown') AS bucket_id,
      -- Mirrors getStorageObjectSize(): a non-object metadata payload, a
      -- missing size, or a size that is not a number contributes 0 rather than
      -- raising. JS accepts a numeric string here too, so this does.
      round(
        CASE
          WHEN jsonb_typeof(rows.metadata) <> 'object' THEN 0
          WHEN jsonb_typeof(rows.metadata -> 'size') = 'number'
            THEN greatest((rows.metadata ->> 'size')::numeric, 0)
          WHEN jsonb_typeof(rows.metadata -> 'size') = 'string'
            AND btrim(rows.metadata ->> 'size') ~ '^-?\d+(\.\d+)?$'
            THEN greatest((btrim(rows.metadata ->> 'size'))::numeric, 0)
          ELSE 0
        END
      )::bigint AS size_bytes
    FROM storage.objects rows
    WHERE rows.created_at >= p_since
      AND rows.bucket_id = ANY (coalesce(p_storage_buckets, ARRAY[]::text[]))
  )
  SELECT jsonb_build_object(
    'generations', jsonb_build_object(
      'rowCount', (SELECT count(*) FROM generation_rows),
      'recentCreditCost', (SELECT coalesce(sum(cost), 0) FROM generation_rows),
      'failedPaidCount', (SELECT count(*) FROM generation_rows WHERE status = 'failed' AND cost > 0),
      'failedPaidCreditCost', (SELECT coalesce(sum(cost), 0) FROM generation_rows WHERE status = 'failed' AND cost > 0),
      'completedOutputCount', (SELECT count(*) FROM generation_rows WHERE status IN ('succeeded', 'completed') AND has_output),
      'byStatus', (
        SELECT coalesce(jsonb_object_agg(grouped.status, grouped.cost), '{}'::jsonb)
        FROM (SELECT status, coalesce(sum(cost), 0) AS cost FROM generation_rows GROUP BY status) grouped
      ),
      'byModel', (
        SELECT coalesce(jsonb_object_agg(grouped.model, grouped.cost), '{}'::jsonb)
        FROM (SELECT model, coalesce(sum(cost), 0) AS cost FROM generation_rows GROUP BY model) grouped
      )
    ),
    'aiUsage', jsonb_build_object(
      'rowCount', (SELECT count(*) FROM ai_usage_rows),
      'recentCreditCost', (SELECT coalesce(sum(cost), 0) FROM ai_usage_rows),
      'failedCount', (SELECT count(*) FROM ai_usage_rows WHERE status = 'failed'),
      'byFeature', (
        SELECT coalesce(jsonb_object_agg(grouped.feature, grouped.cost), '{}'::jsonb)
        FROM (SELECT feature, coalesce(sum(cost), 0) AS cost FROM ai_usage_rows GROUP BY feature) grouped
      ),
      'byStatus', (
        SELECT coalesce(jsonb_object_agg(grouped.status, grouped.cost), '{}'::jsonb)
        FROM (SELECT status, coalesce(sum(cost), 0) AS cost FROM ai_usage_rows GROUP BY status) grouped
      )
    ),
    'providerDependencies', jsonb_build_object(
      'rowCount', (SELECT count(*) FROM provider_rows),
      'failedCount', (SELECT count(*) FROM provider_rows WHERE outcome <> 'success'),
      'slowCount', (SELECT count(*) FROM provider_rows WHERE duration_ms >= greatest(coalesce(p_slow_duration_ms, 0), 0)),
      'maxDurationMs', (SELECT coalesce(max(duration_ms), 0) FROM provider_rows),
      'byService', (
        SELECT coalesce(jsonb_object_agg(grouped.service_name, grouped.calls), '{}'::jsonb)
        FROM (SELECT service_name, count(*) AS calls FROM provider_rows GROUP BY service_name) grouped
      ),
      -- Filtered before grouping, not counted with FILTER: a service with no
      -- failures must be absent from this object, not present with 0.
      'failuresByService', (
        SELECT coalesce(jsonb_object_agg(grouped.service_name, grouped.calls), '{}'::jsonb)
        FROM (SELECT service_name, count(*) AS calls FROM provider_rows WHERE outcome <> 'success' GROUP BY service_name) grouped
      ),
      'timeoutsByService', (
        SELECT coalesce(jsonb_object_agg(grouped.service_name, grouped.calls), '{}'::jsonb)
        FROM (SELECT service_name, count(*) AS calls FROM provider_rows WHERE outcome = 'timeout' GROUP BY service_name) grouped
      ),
      'byModel', (
        SELECT coalesce(jsonb_object_agg(grouped.model_id, grouped.calls), '{}'::jsonb)
        FROM (SELECT model_id, count(*) AS calls FROM provider_rows WHERE model_id IS NOT NULL GROUP BY model_id) grouped
      ),
      'failuresByModel', (
        SELECT coalesce(jsonb_object_agg(grouped.model_id, grouped.calls), '{}'::jsonb)
        FROM (SELECT model_id, count(*) AS calls FROM provider_rows WHERE model_id IS NOT NULL AND outcome <> 'success' GROUP BY model_id) grouped
      ),
      'timeoutsByModel', (
        SELECT coalesce(jsonb_object_agg(grouped.model_id, grouped.calls), '{}'::jsonb)
        FROM (SELECT model_id, count(*) AS calls FROM provider_rows WHERE model_id IS NOT NULL AND outcome = 'timeout' GROUP BY model_id) grouped
      )
    ),
    'rateLimits', jsonb_build_object(
      'rowCount', (SELECT count(*) FROM rate_limit_rows),
      'totalRequests', (SELECT coalesce(sum(request_count), 0) FROM rate_limit_rows),
      'maxWindowRequestCount', (SELECT coalesce(max(request_count), 0) FROM rate_limit_rows),
      -- No quote/media-read split here on purpose: which scopes count as a
      -- media read is policy, it changes with the route surface, and it lives
      -- in `backend-cost-report.ts`. The caller sums these keys itself.
      'byScope', (
        SELECT coalesce(jsonb_object_agg(grouped.scope, grouped.requests), '{}'::jsonb)
        FROM (SELECT scope, coalesce(sum(request_count), 0) AS requests FROM rate_limit_rows GROUP BY scope) grouped
      )
    ),
    'storage', jsonb_build_object(
      'rowCount', (SELECT count(*) FROM storage_rows),
      'recentBytes', (SELECT coalesce(sum(size_bytes), 0) FROM storage_rows),
      'largestObjectBytes', (SELECT coalesce(max(size_bytes), 0) FROM storage_rows),
      'bytesByBucket', (
        SELECT coalesce(jsonb_object_agg(grouped.bucket_id, grouped.bytes), '{}'::jsonb)
        FROM (SELECT bucket_id, coalesce(sum(size_bytes), 0) AS bytes FROM storage_rows GROUP BY bucket_id) grouped
      ),
      'objectsByBucket', (
        SELECT coalesce(jsonb_object_agg(grouped.bucket_id, grouped.objects), '{}'::jsonb)
        FROM (SELECT bucket_id, count(*) AS objects FROM storage_rows GROUP BY bucket_id) grouped
      )
    )
  );
$function$;

COMMENT ON FUNCTION public.get_backend_cost_aggregates(timestamptz, text[], integer) IS
  'F15a: grouped cost/health arithmetic over the report window, computed in the database so the report stops sampling the first 5,000 rows per source. Arithmetic only -- budget thresholds and scope classification stay in backend-cost-report.ts.';

REVOKE ALL ON FUNCTION public.get_backend_cost_aggregates(timestamptz, text[], integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_backend_cost_aggregates(timestamptz, text[], integer) FROM anon;
REVOKE ALL ON FUNCTION public.get_backend_cost_aggregates(timestamptz, text[], integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_backend_cost_aggregates(timestamptz, text[], integer) TO service_role;
