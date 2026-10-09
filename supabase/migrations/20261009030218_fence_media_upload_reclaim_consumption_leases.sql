-- Close admission before deleting staging bytes. A read-only lease check would
-- still allow a consumer to acquire a lease between that check and Storage IO.
CREATE FUNCTION public.claim_media_upload_intents_for_reclaim(p_intent_ids uuid[])
RETURNS TABLE(intent_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_intent public.media_upload_intents%ROWTYPE;
  v_reservation public.upload_byte_reservations%ROWTYPE;
BEGIN
  IF p_intent_ids IS NULL OR cardinality(p_intent_ids) > 500
    OR array_position(p_intent_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'At most 500 exact upload intents are required'
      USING ERRCODE = '22023';
  END IF;

  FOR v_intent IN
    SELECT i.* FROM public.media_upload_intents i
    WHERE i.id = ANY(p_intent_ids)
      AND i.storage_cleared_at IS NULL
      AND i.created_at < now() - interval '48 hours'
    ORDER BY i.user_id, i.id
  LOOP
    -- Consumption and reservation admission acquire this same owner lock.
    PERFORM public.lock_upload_owner(v_intent.user_id);
    PERFORM public.lock_upload_storage_path('uploads', v_intent.storage_path);
    SELECT r.* INTO v_reservation FROM public.upload_byte_reservations r
    WHERE r.bucket_id = 'uploads' AND r.storage_path = v_intent.storage_path
      AND r.user_id = v_intent.user_id
    FOR UPDATE;

    IF FOUND THEN
      -- Expired readers and lost completion acknowledgements also require
      -- reconciliation. Expiry alone never proves their bytes are disposable.
      IF v_reservation.finalization_status NOT IN ('finalized', 'consumed', 'deleted', 'reclaiming')
        OR v_reservation.consumption_lease_id IS NOT NULL
        OR v_reservation.consumption_outcome_unknown_at IS NOT NULL
        OR v_reservation.consumption_disposition = 'preserve' THEN
        CONTINUE;
      END IF;
      IF v_reservation.finalization_status IN ('finalized', 'consumed') THEN
        UPDATE public.upload_byte_reservations
        SET finalization_status = 'deleted', reclaim_after = NULL,
            status_updated_at = now()
        WHERE id = v_reservation.id;
      END IF;
      -- The reservation remains charged. Its existing two-observation worker
      -- releases capacity only after authoritative proof of object absence.
    END IF;

    -- Legacy objects without a v2 reservation keep their compatibility path;
    -- callers still enforce rollout, age and legacy-reference protection.
    intent_id := v_intent.id;
    RETURN NEXT;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_media_upload_intents_for_reclaim(uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_media_upload_intents_for_reclaim(uuid[])
  TO service_role;
COMMENT ON FUNCTION public.claim_media_upload_intents_for_reclaim(uuid[]) IS
  'Atomically closes upload consumption admission before staged reclaim, withholding leased and uncertain uploads without releasing their byte charge.';
