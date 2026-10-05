-- A busy model must not evict another model's most recent observation from a
-- release-wide history window. Each lookup uses the existing release/model/time
-- index; identity breaks timestamp ties deterministically.
CREATE FUNCTION public.latest_generation_model_provider_checks(p_release_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'model_id', entry.model_id,
    'status', latest.status,
    'consecutive_discrepancies', latest.consecutive_discrepancies
  ) ORDER BY entry.model_id), '[]'::jsonb)
  FROM public.generation_model_catalog_entries AS entry
  CROSS JOIN LATERAL (
    SELECT checks.status, checks.consecutive_discrepancies
    FROM public.generation_model_provider_checks AS checks
    WHERE checks.release_id = entry.release_id AND checks.model_id = entry.model_id
    ORDER BY checks.checked_at DESC, checks.id DESC
    LIMIT 1
  ) AS latest
  WHERE entry.release_id = p_release_id;
$$;
REVOKE ALL ON FUNCTION public.latest_generation_model_provider_checks(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.latest_generation_model_provider_checks(uuid)
  TO service_role;
COMMENT ON FUNCTION public.latest_generation_model_provider_checks(uuid) IS
  'Latest verification for each model in a release; service-only, deterministic timestamp ties and no shared history cutoff.';
