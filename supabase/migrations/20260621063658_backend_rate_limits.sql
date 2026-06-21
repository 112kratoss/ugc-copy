CREATE TABLE IF NOT EXISTS public.backend_rate_limits (
  scope text NOT NULL,
  subject_key text NOT NULL,
  window_start timestamptz NOT NULL,
  request_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, subject_key, window_start),
  CONSTRAINT backend_rate_limits_scope_not_blank CHECK (btrim(scope) <> ''),
  CONSTRAINT backend_rate_limits_subject_key_not_blank CHECK (btrim(subject_key) <> ''),
  CONSTRAINT backend_rate_limits_request_count_nonnegative CHECK (request_count >= 0)
);

ALTER TABLE public.backend_rate_limits ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.backend_rate_limits FROM PUBLIC;
REVOKE ALL ON public.backend_rate_limits FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.backend_rate_limits TO service_role;

CREATE OR REPLACE FUNCTION public.check_backend_rate_limit(
  p_scope text,
  p_subject_key text,
  p_limit integer,
  p_window_seconds integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_scope text := btrim(coalesce(p_scope, ''));
  v_subject_key text := btrim(coalesce(p_subject_key, ''));
  v_limit integer := p_limit;
  v_window_seconds integer := p_window_seconds;
  v_window_start timestamptz;
  v_reset_at timestamptz;
  v_request_count integer;
  v_allowed boolean;
  v_retry_after_seconds integer;
BEGIN
  IF v_scope = '' THEN
    RAISE EXCEPTION 'Rate limit scope is required';
  END IF;

  IF v_subject_key = '' THEN
    RAISE EXCEPTION 'Rate limit subject key is required';
  END IF;

  IF v_limit IS NULL OR v_limit < 1 OR v_limit > 10000 THEN
    RAISE EXCEPTION 'Rate limit must be between 1 and 10000';
  END IF;

  IF v_window_seconds IS NULL OR v_window_seconds < 1 OR v_window_seconds > 86400 THEN
    RAISE EXCEPTION 'Rate limit window must be between 1 and 86400 seconds';
  END IF;

  v_window_start := to_timestamp(
    floor(extract(epoch from now()) / v_window_seconds) * v_window_seconds
  );
  v_reset_at := v_window_start + make_interval(secs => v_window_seconds);

  DELETE FROM public.backend_rate_limits
  WHERE scope = v_scope
    AND subject_key = v_subject_key
    AND window_start < v_window_start - interval '1 day';

  INSERT INTO public.backend_rate_limits (scope, subject_key, window_start, request_count, updated_at)
  VALUES (v_scope, v_subject_key, v_window_start, 1, now())
  ON CONFLICT (scope, subject_key, window_start) DO UPDATE
    SET request_count = public.backend_rate_limits.request_count + 1,
        updated_at = now()
  RETURNING request_count INTO v_request_count;

  v_allowed := v_request_count <= v_limit;
  v_retry_after_seconds := CASE
    WHEN v_allowed THEN 0
    ELSE greatest(1, ceil(extract(epoch from (v_reset_at - now())))::integer)
  END;

  RETURN jsonb_build_object(
    'allowed', v_allowed,
    'limit', v_limit,
    'remaining', greatest(v_limit - v_request_count, 0),
    'retryAfterSeconds', v_retry_after_seconds,
    'resetAt', to_char(v_reset_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
END;
$$;

REVOKE ALL ON FUNCTION public.check_backend_rate_limit(text, text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_backend_rate_limit(text, text, integer, integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_backend_rate_limit(text, text, integer, integer) TO service_role;
