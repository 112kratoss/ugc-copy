CREATE OR REPLACE FUNCTION public.settle_generation_succeeded(
  p_prediction_id text,
  p_output_url text DEFAULT NULL,
  p_completed_at timestamp with time zone DEFAULT NULL,
  p_preview_url text DEFAULT NULL,
  p_preview_thumbhash text DEFAULT NULL,
  p_preview_status text DEFAULT NULL,
  p_preview_attempt_count integer DEFAULT NULL,
  p_preview_error text DEFAULT NULL,
  p_preview_generated_at timestamp with time zone DEFAULT NULL,
  p_workflow_settings jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_generation public.generations%ROWTYPE;
  v_completed_at timestamp with time zone := coalesce(p_completed_at, now());
BEGIN
  IF btrim(coalesce(p_prediction_id, '')) = '' THEN
    RETURN jsonb_build_object('status', 'invalid_request');
  END IF;

  IF p_preview_attempt_count IS NOT NULL AND p_preview_attempt_count < 0 THEN
    RETURN jsonb_build_object('status', 'invalid_request');
  END IF;

  SELECT *
  INTO v_generation
  FROM public.generations
  WHERE prediction_id = btrim(p_prediction_id)
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'missing');
  END IF;

  IF v_generation.status = 'failed' OR coalesce(v_generation.refunded, false) THEN
    RETURN jsonb_build_object(
      'status', 'already_failed',
      'generation_id', v_generation.id,
      'output_url', v_generation.output_url,
      'refunded', coalesce(v_generation.refunded, false)
    );
  END IF;

  IF v_generation.status = 'succeeded' THEN
    RETURN jsonb_build_object(
      'status', 'already_succeeded',
      'generation_id', v_generation.id,
      'output_url', v_generation.output_url,
      'refunded', coalesce(v_generation.refunded, false)
    );
  END IF;

  UPDATE public.generations
  SET status = 'succeeded',
      output_url = p_output_url,
      completed_at = coalesce(public.generations.completed_at, v_completed_at),
      preview_url = p_preview_url,
      preview_thumbhash = p_preview_thumbhash,
      preview_status = coalesce(p_preview_status, public.generations.preview_status),
      preview_attempt_count = coalesce(p_preview_attempt_count, public.generations.preview_attempt_count),
      preview_error = p_preview_error,
      preview_generated_at = p_preview_generated_at,
      workflow_settings = coalesce(p_workflow_settings, public.generations.workflow_settings)
  WHERE id = v_generation.id;

  RETURN jsonb_build_object(
    'status', 'succeeded',
    'generation_id', v_generation.id,
    'output_url', p_output_url,
    'refunded', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.settle_generation_succeeded(text, text, timestamp with time zone, text, text, text, integer, text, timestamp with time zone, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.settle_generation_succeeded(text, text, timestamp with time zone, text, text, text, integer, text, timestamp with time zone, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.settle_generation_succeeded(text, text, timestamp with time zone, text, text, text, integer, text, timestamp with time zone, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.settle_generation_succeeded(text, text, timestamp with time zone, text, text, text, integer, text, timestamp with time zone, jsonb) TO service_role;
