CREATE OR REPLACE FUNCTION public.attach_generation_provider_task(
  p_generation_id uuid,
  p_prediction_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_generation public.generations%ROWTYPE;
  v_prediction_id text := btrim(coalesce(p_prediction_id, ''));
BEGIN
  IF p_generation_id IS NULL OR v_prediction_id = '' THEN
    RETURN jsonb_build_object('status', 'invalid_request');
  END IF;

  SELECT *
  INTO v_generation
  FROM public.generations
  WHERE id = p_generation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'missing');
  END IF;

  IF v_generation.status IN ('failed', 'succeeded')
     OR coalesce(v_generation.refunded, false) THEN
    RETURN jsonb_build_object(
      'status', 'already_settled',
      'generation_id', v_generation.id,
      'prediction_id', v_generation.prediction_id,
      'generation_status', v_generation.status,
      'refunded', coalesce(v_generation.refunded, false)
    );
  END IF;

  IF v_generation.prediction_id IS NOT NULL THEN
    IF v_generation.prediction_id = v_prediction_id THEN
      RETURN jsonb_build_object(
        'status', 'already_attached',
        'generation_id', v_generation.id,
        'prediction_id', v_generation.prediction_id,
        'generation_status', v_generation.status,
        'refunded', coalesce(v_generation.refunded, false)
      );
    END IF;

    RETURN jsonb_build_object(
      'status', 'prediction_conflict',
      'generation_id', v_generation.id,
      'prediction_id', v_generation.prediction_id,
      'generation_status', v_generation.status,
      'refunded', coalesce(v_generation.refunded, false)
    );
  END IF;

  UPDATE public.generations
  SET prediction_id = btrim(p_prediction_id),
      status = 'processing'
  WHERE id = v_generation.id;

  RETURN jsonb_build_object(
    'status', 'attached',
    'generation_id', v_generation.id,
    'prediction_id', v_prediction_id,
    'generation_status', 'processing',
    'refunded', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.attach_generation_provider_task(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.attach_generation_provider_task(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.attach_generation_provider_task(uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.attach_generation_provider_task(uuid, text) TO service_role;
