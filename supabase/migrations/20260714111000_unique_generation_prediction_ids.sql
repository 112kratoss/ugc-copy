-- Provider task ids are external identities used by callbacks and settlement.
-- Refuse to install the constraint over ambiguous legacy data rather than
-- silently choosing a generation or deleting evidence.

DO $block$
DECLARE
  v_blank_generation_id uuid;
  v_duplicate_prediction_id text;
  v_duplicate_count bigint;
BEGIN
  LOCK TABLE public.generations IN SHARE ROW EXCLUSIVE MODE;

  SELECT id
  INTO v_blank_generation_id
  FROM public.generations
  WHERE prediction_id IS NOT NULL
    AND btrim(prediction_id) = ''
  ORDER BY created_at, id
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'Cannot enforce generation prediction id integrity: generation % has a blank prediction_id',
      v_blank_generation_id;
  END IF;

  SELECT normalized_prediction_id, duplicate_count
  INTO v_duplicate_prediction_id, v_duplicate_count
  FROM (
    SELECT btrim(prediction_id) AS normalized_prediction_id, count(*) AS duplicate_count
    FROM public.generations
    WHERE prediction_id IS NOT NULL
    GROUP BY btrim(prediction_id)
    HAVING count(*) > 1
    ORDER BY btrim(prediction_id)
    LIMIT 1
  ) duplicates;

  IF FOUND THEN
    RAISE EXCEPTION
      'Cannot enforce generation prediction id integrity: normalized prediction_id % is used by % generations',
      v_duplicate_prediction_id,
      v_duplicate_count;
  END IF;

  UPDATE public.generations
  SET prediction_id = btrim(prediction_id)
  WHERE prediction_id IS NOT NULL
    AND prediction_id IS DISTINCT FROM btrim(prediction_id);
END;
$block$;

ALTER TABLE public.generations
  DROP CONSTRAINT IF EXISTS generations_prediction_id_not_blank,
  ADD CONSTRAINT generations_prediction_id_not_blank
    CHECK (prediction_id IS NULL OR btrim(prediction_id) <> '') NOT VALID;

ALTER TABLE public.generations
  DROP CONSTRAINT IF EXISTS generations_prediction_id_normalized,
  ADD CONSTRAINT generations_prediction_id_normalized
    CHECK (prediction_id IS NULL OR prediction_id = btrim(prediction_id)) NOT VALID;

ALTER TABLE public.generations
  VALIDATE CONSTRAINT generations_prediction_id_not_blank,
  VALIDATE CONSTRAINT generations_prediction_id_normalized;

CREATE UNIQUE INDEX generations_prediction_id_unique_idx
  ON public.generations (prediction_id)
  WHERE prediction_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.attach_generation_provider_task(
  p_generation_id uuid,
  p_prediction_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_generation public.generations%ROWTYPE;
  v_prediction_id text := btrim(coalesce(p_prediction_id, ''));
  v_conflicting_generation_id uuid;
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

  SELECT id
  INTO v_conflicting_generation_id
  FROM public.generations
  WHERE prediction_id = v_prediction_id
    AND id <> v_generation.id
  LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'status', 'prediction_conflict',
      'generation_id', v_generation.id,
      'conflicting_generation_id', v_conflicting_generation_id,
      'prediction_id', v_prediction_id,
      'generation_status', v_generation.status,
      'refunded', coalesce(v_generation.refunded, false)
    );
  END IF;

  BEGIN
    UPDATE public.generations
    SET prediction_id = v_prediction_id,
        status = 'processing'
    WHERE id = v_generation.id;
  EXCEPTION
    WHEN unique_violation THEN
      RETURN jsonb_build_object(
        'status', 'prediction_conflict',
        'generation_id', v_generation.id,
        'prediction_id', v_prediction_id,
        'generation_status', v_generation.status,
        'refunded', coalesce(v_generation.refunded, false)
      );
  END;

  RETURN jsonb_build_object(
    'status', 'attached',
    'generation_id', v_generation.id,
    'prediction_id', v_prediction_id,
    'generation_status', 'processing',
    'refunded', false
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.attach_generation_provider_task(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.attach_generation_provider_task(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.attach_generation_provider_task(uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.attach_generation_provider_task(uuid, text) TO service_role;
