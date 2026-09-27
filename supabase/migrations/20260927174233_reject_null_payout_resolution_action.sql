-- SQL NULL must fail closed before taking locks or releasing a payout hold.
-- Existing signatures, grants and valid-action accounting are preserved.
SET lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.resolve_creator_payout_request(
  p_request_id uuid,
  p_reviewer_id uuid,
  p_action text,
  p_resolution_note text DEFAULT NULL,
  p_external_reference text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_request public.creator_payout_requests%ROWTYPE;
  v_note text := nullif(btrim(coalesce(p_resolution_note, '')), '');
  v_now timestamptz := timezone('utc'::text, now());
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('mark_paid', 'reject') THEN
    RETURN jsonb_build_object('status', 'invalid_action');
  END IF;

  SELECT *
  INTO v_request
  FROM public.creator_payout_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF v_request.status <> 'requested' THEN
    RETURN jsonb_build_object('status', 'already_resolved', 'current_status', v_request.status);
  END IF;

  -- A rejection must say why: the creator sees this text.
  IF p_action = 'reject' AND v_note IS NULL THEN
    RETURN jsonb_build_object('status', 'reason_required');
  END IF;

  PERFORM 1
  FROM public.creator_resource_wallets
  WHERE user_id = v_request.user_id
  FOR UPDATE;

  IF p_action = 'mark_paid' THEN
    -- The hold is consumed: money left the platform.
    UPDATE public.creator_resource_wallets
    SET held_token_subunits = greatest(0, held_token_subunits - v_request.amount_token_subunits),
        lifetime_paid_out_token_subunits =
          lifetime_paid_out_token_subunits + v_request.amount_token_subunits,
        updated_at = v_now
    WHERE user_id = v_request.user_id;
  ELSE
    -- The hold is released: the creator can request again.
    UPDATE public.creator_resource_wallets
    SET held_token_subunits = greatest(0, held_token_subunits - v_request.amount_token_subunits),
        available_token_subunits = available_token_subunits + v_request.amount_token_subunits,
        updated_at = v_now
    WHERE user_id = v_request.user_id;
  END IF;

  UPDATE public.creator_payout_requests
  SET status = CASE WHEN p_action = 'mark_paid' THEN 'paid' ELSE 'rejected' END,
      resolved_at = v_now,
      resolved_by = p_reviewer_id,
      resolution_note = v_note,
      external_reference = nullif(btrim(coalesce(p_external_reference, '')), '')
  WHERE id = p_request_id;

  RETURN jsonb_build_object(
    'status', CASE WHEN p_action = 'mark_paid' THEN 'paid' ELSE 'rejected' END,
    'request_id', p_request_id,
    'amount_token_subunits', v_request.amount_token_subunits
  );
END;
$$;

RESET lock_timeout;
