-- Reserve each retry before sending and fence finalization by its claim identity.
ALTER TABLE public.mobile_push_deliveries
  ADD COLUMN retry_claim_id uuid,
  ADD COLUMN retry_claim_until timestamptz,
  ADD COLUMN retry_outcome jsonb;

CREATE INDEX mobile_push_deliveries_recorded_retry_idx
  ON public.mobile_push_deliveries (last_attempt_at)
  WHERE retry_outcome IS NOT NULL;

CREATE FUNCTION public.claim_mobile_push_retry(p_delivery_id uuid, p_expected_attempt_count integer)
RETURNS uuid
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE v_claim uuid := gen_random_uuid();
BEGIN
  IF p_expected_attempt_count IS NULL OR p_expected_attempt_count < 0 OR p_expected_attempt_count >= 3 THEN
    RAISE EXCEPTION 'Invalid push retry attempt count' USING ERRCODE = '22023';
  END IF;
  UPDATE public.mobile_push_deliveries AS delivery
  SET token_id = (SELECT token.id FROM public.mobile_push_tokens AS token
        WHERE token.user_id = delivery.user_id AND token.expo_push_token = delivery.expo_push_token
          AND token.is_active = true LIMIT 1),
      retry_claim_id = v_claim, retry_claim_until = clock_timestamp() + interval '60 seconds',
      attempt_count = attempt_count + 1, last_attempt_at = clock_timestamp(),
      receipt_error_code = 'PushRetryOutcomeUnknown',
      receipt_message = 'Retry attempt reserved; provider outcome has not been recorded.'
  WHERE id = p_delivery_id AND send_status = 'error' AND receipt_status = 'error'
    AND push_ticket_id IS NULL AND retry_outcome IS NULL AND attempt_count = p_expected_attempt_count
    AND (retry_claim_until IS NULL OR retry_claim_until <= clock_timestamp());
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN v_claim;
END;
$$;

CREATE FUNCTION public.record_mobile_push_retry_outcome(
  p_delivery_id uuid, p_claim_id uuid, p_outcome jsonb
) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE v_status text := p_outcome->>'status'; v_error text := p_outcome->>'error_code';
BEGIN
  IF p_claim_id IS NULL OR p_outcome IS NULL OR jsonb_typeof(p_outcome) <> 'object'
     OR v_status IS NULL OR v_status NOT IN ('sent','retryable','refused')
     OR (v_status = 'sent' AND nullif(btrim(p_outcome->>'ticket_id'),'') IS NULL)
     OR (v_error = 'DeviceNotRegistered' AND v_status <> 'refused') THEN
    RAISE EXCEPTION 'Invalid push retry outcome' USING ERRCODE = '22023';
  END IF;
  UPDATE public.mobile_push_deliveries SET retry_outcome = p_outcome
  WHERE id = p_delivery_id AND retry_claim_id = p_claim_id
    AND send_status = 'error' AND receipt_status = 'error'
    AND (retry_outcome IS NULL OR retry_outcome = p_outcome);
  RETURN FOUND;
END;
$$;

CREATE FUNCTION public.finish_mobile_push_retry(p_delivery_id uuid, p_claim_id uuid)
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
  IF v_error = 'DeviceNotRegistered' THEN
    UPDATE public.mobile_push_tokens SET is_active = false, disabled_at = v_now
    WHERE id = v_row.token_id AND user_id = v_row.user_id
      AND expo_push_token = v_row.expo_push_token AND is_active = true;
    GET DIAGNOSTICS v_disabled = ROW_COUNT;
  END IF;
  UPDATE public.mobile_push_deliveries
  SET send_status = CASE WHEN v_status = 'sent' THEN 'sent' ELSE 'error' END,
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
REVOKE ALL ON FUNCTION public.claim_mobile_push_retry(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_mobile_push_retry(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_mobile_push_retry(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_mobile_push_retry(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.record_mobile_push_retry_outcome(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_mobile_push_retry_outcome(uuid, uuid, jsonb) TO service_role;
