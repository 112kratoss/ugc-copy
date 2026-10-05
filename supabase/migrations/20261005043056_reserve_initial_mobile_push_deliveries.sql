-- Reserve the initial batch's maximum possible attempt budget before sending.
ALTER TABLE public.mobile_push_deliveries
  ADD COLUMN initial_attempt_reservation boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.finish_mobile_push_retry(p_delivery_id uuid, p_claim_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE v_row public.mobile_push_deliveries%ROWTYPE; v_disabled integer := 0;
  v_status text; v_error text; p_outcome jsonb;
  v_now timestamptz := clock_timestamp();
BEGIN
  SELECT * INTO v_row FROM public.mobile_push_deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND OR v_row.retry_claim_id IS DISTINCT FROM p_claim_id
     OR p_claim_id IS NULL OR v_row.retry_outcome IS NULL
     OR v_row.send_status <> 'error' OR v_row.receipt_status <> 'error' THEN
    RETURN jsonb_build_object('applied', false, 'disabledTokenCount', 0);
  END IF;
  p_outcome := v_row.retry_outcome;
  v_status := p_outcome->>'status'; v_error := p_outcome->>'error_code';
  IF v_row.initial_attempt_reservation AND (
    coalesce(p_outcome->>'attempt_count','') !~ '^[1-3]$'
  ) THEN RAISE EXCEPTION 'Invalid initial push attempt count' USING ERRCODE='22023'; END IF;
  IF v_error = 'DeviceNotRegistered' THEN
    UPDATE public.mobile_push_tokens SET is_active = false, disabled_at = v_now
    WHERE id = v_row.token_id AND user_id = v_row.user_id
      AND expo_push_token = v_row.expo_push_token AND is_active = true;
    GET DIAGNOSTICS v_disabled = ROW_COUNT;
  END IF;
  UPDATE public.mobile_push_deliveries
  SET attempt_count = CASE WHEN v_row.initial_attempt_reservation THEN (p_outcome->>'attempt_count')::integer ELSE attempt_count END,
      initial_attempt_reservation = false,
      send_status = CASE WHEN v_status = 'sent' THEN 'sent' ELSE 'error' END,
      receipt_status = CASE WHEN v_status = 'sent' THEN 'pending' WHEN v_status = 'refused' THEN 'stale' ELSE 'error' END,
      push_ticket_id = CASE WHEN v_status = 'sent' THEN p_outcome->>'ticket_id' ELSE NULL END,
      receipt_error_code = v_error,
      receipt_message = p_outcome->>'message', provider_message = p_outcome->>'message',
      provider_details = p_outcome->'details',
      receipt_checked_at = NULL,
      sent_at = CASE WHEN v_status = 'sent' THEN v_now ELSE sent_at END,
      retry_claim_id = NULL, retry_claim_until = NULL, retry_outcome = NULL
  WHERE id = p_delivery_id;
  RETURN jsonb_build_object('applied', true, 'disabledTokenCount', v_disabled);
END;
$$;

CREATE FUNCTION public.record_initial_mobile_push_outcomes(p_items jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE item jsonb; recorded integer := 0;
BEGIN
 IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) NOT BETWEEN 1 AND 100 THEN
   RAISE EXCEPTION 'Expected 1 to 100 push outcomes' USING ERRCODE='22023';
 END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(p_items) ORDER BY value->>'delivery_id' LOOP
   IF coalesce(item->'outcome'->>'attempt_count','') !~ '^[1-3]$' THEN
     RAISE EXCEPTION 'Invalid initial push attempt count' USING ERRCODE='22023';
   END IF;
   IF public.record_mobile_push_retry_outcome((item->>'delivery_id')::uuid,(item->>'claim_id')::uuid,item->'outcome') THEN recorded := recorded + 1; END IF;
 END LOOP;
 RETURN recorded;
END;
$$;

CREATE FUNCTION public.finish_initial_mobile_push_outcomes(p_items jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE item jsonb; finished integer := 0;
BEGIN
 IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) NOT BETWEEN 1 AND 100 THEN
   RAISE EXCEPTION 'Expected 1 to 100 push claims' USING ERRCODE='22023';
 END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(p_items) ORDER BY value->>'delivery_id' LOOP
   IF (public.finish_mobile_push_retry((item->>'delivery_id')::uuid,(item->>'claim_id')::uuid)->>'applied')::boolean THEN finished := finished + 1; END IF;
 END LOOP;
 RETURN finished;
END;
$$;
REVOKE ALL ON FUNCTION public.record_initial_mobile_push_outcomes(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_initial_mobile_push_outcomes(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_initial_mobile_push_outcomes(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_initial_mobile_push_outcomes(jsonb) TO service_role;
