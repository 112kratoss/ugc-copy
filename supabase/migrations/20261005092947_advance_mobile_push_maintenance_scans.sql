-- Scan positions survive failed rows and worker death. Each finite sweep has an
-- upper bound, so arrivals cannot indefinitely postpone revisiting older work.
CREATE TABLE public.mobile_push_maintenance_scans (
  phase text PRIMARY KEY CHECK (phase IN ('recorded', 'receipts', 'retries')),
  after_created_at timestamptz,
  after_id uuid,
  through_created_at timestamptz,
  through_id uuid,
  CHECK ((after_created_at IS NULL) = (after_id IS NULL)),
  CHECK ((through_created_at IS NULL) = (through_id IS NULL)),
  CHECK (after_id IS NULL OR (after_created_at, after_id) <= (through_created_at, through_id))
);
ALTER TABLE public.mobile_push_maintenance_scans ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.mobile_push_maintenance_scans FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.mobile_push_maintenance_scans TO service_role;

CREATE INDEX mobile_push_deliveries_recorded_scan_idx ON public.mobile_push_deliveries (created_at, id)
  WHERE retry_outcome IS NOT NULL;
CREATE INDEX mobile_push_deliveries_receipt_scan_idx ON public.mobile_push_deliveries (created_at, id)
  WHERE receipt_status = 'pending';
CREATE INDEX mobile_push_deliveries_retry_scan_idx ON public.mobile_push_deliveries (created_at, id)
  WHERE send_status = 'error' AND receipt_status = 'error' AND push_ticket_id IS NULL
    AND retry_outcome IS NULL AND attempt_count < 3;

CREATE FUNCTION public.scan_mobile_push_maintenance(p_phase text, p_limit integer, p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_scan public.mobile_push_maintenance_scans%ROWTYPE;
  v_predicate text;
  v_page jsonb;
  v_last jsonb;
  v_pass integer;
BEGIN
  IF p_phase IS NULL OR p_phase NOT IN ('recorded','receipts','retries') OR p_now IS NULL
     OR p_limit IS NULL OR p_limit < 1 OR p_limit > (CASE WHEN p_phase='receipts' THEN 1000 ELSE 100 END) THEN
    RAISE EXCEPTION 'Invalid push maintenance scan' USING ERRCODE='22023';
  END IF;
  v_predicate := CASE p_phase
    WHEN 'recorded' THEN 'd.retry_outcome IS NOT NULL'
    WHEN 'receipts' THEN 'd.receipt_status = ''pending'' AND d.sent_at <= $1 - interval ''15 minutes'''
    ELSE 'd.send_status = ''error'' AND d.receipt_status = ''error'' AND d.push_ticket_id IS NULL AND d.retry_outcome IS NULL AND d.attempt_count < 3'
  END;
  INSERT INTO public.mobile_push_maintenance_scans(phase) VALUES(p_phase) ON CONFLICT DO NOTHING;
  SELECT * INTO v_scan FROM public.mobile_push_maintenance_scans WHERE phase=p_phase FOR UPDATE;
  -- At most one wrap per call; selection stays bounded even when no row is due.
  FOR v_pass IN 1..2 LOOP
    IF v_scan.through_id IS NULL OR v_pass=2 THEN
      v_scan.after_created_at := NULL; v_scan.after_id := NULL;
      EXECUTE 'SELECT d.created_at,d.id FROM public.mobile_push_deliveries d WHERE ' || v_predicate || ' ORDER BY d.created_at DESC,d.id DESC LIMIT 1'
        INTO v_scan.through_created_at,v_scan.through_id USING p_now;
    END IF;
    IF v_scan.through_id IS NULL THEN v_page := '[]'; EXIT; END IF;
    EXECUTE 'SELECT coalesce(jsonb_agg(to_jsonb(page) ORDER BY page.created_at,page.id),''[]''::jsonb) FROM (
      SELECT d.id,d.created_at,d.notification_id,d.user_id,d.token_id,d.expo_push_token,
        d.push_ticket_id,d.receipt_status,d.sent_at,d.attempt_count,d.retry_claim_id
      FROM public.mobile_push_deliveries d WHERE ' || v_predicate || '
        AND ($2::timestamptz IS NULL OR (d.created_at,d.id)>($2,$3))
        AND (d.created_at,d.id)<=($4,$5)
      ORDER BY d.created_at,d.id LIMIT $6) page'
      INTO v_page USING p_now,v_scan.after_created_at,v_scan.after_id,v_scan.through_created_at,v_scan.through_id,p_limit;
    IF jsonb_array_length(v_page)>0 THEN
      v_last := v_page->(jsonb_array_length(v_page)-1);
      v_scan.after_created_at := (v_last->>'created_at')::timestamptz;
      v_scan.after_id := (v_last->>'id')::uuid;
      EXIT;
    END IF;
  END LOOP;
  UPDATE public.mobile_push_maintenance_scans
    SET after_created_at=v_scan.after_created_at,after_id=v_scan.after_id,
        through_created_at=v_scan.through_created_at,through_id=v_scan.through_id
    WHERE phase=p_phase;
  RETURN v_page;
END;
$$;
REVOKE ALL ON FUNCTION public.scan_mobile_push_maintenance(text, integer, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.scan_mobile_push_maintenance(text, integer, timestamptz) TO service_role;
