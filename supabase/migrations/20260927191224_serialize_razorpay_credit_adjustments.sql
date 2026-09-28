-- Track provider sources separately: refunds are monotonic, and a won dispute
-- cannot be reopened by delayed delivery. The transaction lock serializes the
-- combined target and the existing immutable balance-adjustment ledger.
CREATE TABLE public.razorpay_credit_adjustment_sources (
  source_kind text NOT NULL CHECK (source_kind IN ('refund', 'dispute')),
  source_id text NOT NULL CHECK (btrim(source_id) <> ''),
  transaction_id uuid NOT NULL REFERENCES public.transactions(id) ON DELETE CASCADE,
  payment_id text NOT NULL CHECK (btrim(payment_id) <> ''),
  refunded_amount_subunits bigint NOT NULL CHECK (refunded_amount_subunits >= 0),
  dispute_amount_subunits bigint NOT NULL CHECK (dispute_amount_subunits >= 0),
  dispute_won boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_kind, source_id),
  CHECK ((source_kind = 'refund' AND dispute_amount_subunits = 0 AND NOT dispute_won)
      OR (source_kind = 'dispute' AND dispute_amount_subunits > 0))
);
CREATE INDEX razorpay_credit_adjustment_sources_transaction_idx
  ON public.razorpay_credit_adjustment_sources(transaction_id);
ALTER TABLE public.razorpay_credit_adjustment_sources ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.razorpay_credit_adjustment_sources FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.razorpay_credit_adjustment_sources TO service_role;

CREATE FUNCTION public.reconcile_razorpay_credit_source(
  p_transaction_id uuid,
  p_payment_id text,
  p_source_id text,
  p_kind text,
  p_refunded_amount_subunits bigint,
  p_dispute_amount_subunits bigint
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  txn public.transactions%ROWTYPE;
  source public.razorpay_credit_adjustment_sources%ROWTYPE;
  v_source_kind text := CASE WHEN p_kind = 'refund' THEN 'refund' ELSE 'dispute' END;
  v_payment_id text := nullif(btrim(p_payment_id), '');
  v_source_id text := nullif(btrim(p_source_id), '');
  previous_target bigint;
  target bigint;
  source_count integer;
  result jsonb;
  event_key text;
BEGIN
  IF p_transaction_id IS NULL OR v_payment_id IS NULL OR v_source_id IS NULL
     OR p_kind IS NULL OR p_kind NOT IN ('refund', 'dispute_open', 'dispute_won')
     OR p_refunded_amount_subunits IS NULL OR p_refunded_amount_subunits < 0
     OR p_dispute_amount_subunits IS NULL
     OR (p_kind = 'refund' AND p_dispute_amount_subunits <> 0)
     OR (p_kind <> 'refund' AND p_dispute_amount_subunits <= 0) THEN
    RETURN jsonb_build_object('status', 'invalid_request', 'rewards', '[]'::jsonb);
  END IF;

  SELECT * INTO txn FROM public.transactions WHERE id = p_transaction_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'transaction_not_found', 'rewards', '[]'::jsonb);
  END IF;
  IF txn.mobile_product_id IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'provider_mismatch', 'rewards', '[]'::jsonb);
  END IF;
  IF txn.amount <= 0 OR p_refunded_amount_subunits > txn.amount OR p_dispute_amount_subunits > txn.amount THEN
    RETURN jsonb_build_object('status', 'invalid_amount', 'rewards', '[]'::jsonb);
  END IF;
  IF (txn.razorpay_payment_id IS NOT NULL AND txn.razorpay_payment_id <> v_payment_id)
     OR EXISTS (SELECT 1 FROM public.transactions t WHERE t.razorpay_payment_id = v_payment_id AND t.id <> txn.id) THEN
    RETURN jsonb_build_object('status', 'payment_conflict', 'rewards', '[]'::jsonb);
  END IF;

  SELECT count(*), least(txn.amount::numeric,
      coalesce(max(s.refunded_amount_subunits),0)::numeric
      + coalesce(sum(s.dispute_amount_subunits) FILTER (WHERE NOT s.dispute_won),0))::bigint
    INTO source_count, previous_target
    FROM public.razorpay_credit_adjustment_sources s WHERE s.transaction_id = txn.id;
  -- Never guess which part of a legacy aggregate was a refund or a dispute.
  -- Also detect an old deployment writing the legacy RPC during rollout.
  IF previous_target <> txn.credit_reversed_amount_subunits
     OR EXISTS (SELECT 1 FROM public.credit_purchase_adjustments a
         WHERE a.transaction_id = txn.id
           AND (source_count = 0 OR a.provider_event_id NOT LIKE 'razorpay_source:%')) THEN
    RETURN jsonb_build_object('status', 'legacy_adjustment_requires_review', 'rewards', '[]'::jsonb);
  END IF;

  SELECT * INTO source FROM public.razorpay_credit_adjustment_sources s
    WHERE s.source_kind = v_source_kind AND s.source_id = v_source_id FOR UPDATE;
  IF FOUND THEN
    IF source.transaction_id <> txn.id OR source.payment_id <> v_payment_id
       OR source.dispute_amount_subunits <> p_dispute_amount_subunits THEN
      RETURN jsonb_build_object('status', 'source_conflict', 'rewards', '[]'::jsonb);
    END IF;
    IF source.refunded_amount_subunits >= p_refunded_amount_subunits
       AND (p_kind <> 'dispute_won' OR source.dispute_won) THEN
      RETURN jsonb_build_object('status', 'duplicate_event', 'rewards', '[]'::jsonb);
    END IF;
    UPDATE public.razorpay_credit_adjustment_sources s
      SET refunded_amount_subunits = greatest(s.refunded_amount_subunits,p_refunded_amount_subunits),
          dispute_won = s.dispute_won OR p_kind = 'dispute_won', updated_at = now()
      WHERE s.source_kind = v_source_kind AND s.source_id = v_source_id;
  ELSE
    INSERT INTO public.razorpay_credit_adjustment_sources
      (source_kind,source_id,transaction_id,payment_id,refunded_amount_subunits,
       dispute_amount_subunits,dispute_won,updated_at)
      VALUES (v_source_kind,v_source_id,txn.id,v_payment_id,p_refunded_amount_subunits,
              p_dispute_amount_subunits,p_kind = 'dispute_won',now());
  END IF;

  SELECT least(txn.amount::numeric,
      max(s.refunded_amount_subunits)::numeric
      + coalesce(sum(s.dispute_amount_subunits) FILTER (WHERE NOT s.dispute_won),0))::bigint
    INTO target FROM public.razorpay_credit_adjustment_sources s WHERE s.transaction_id = txn.id;
  -- A distinct source snapshot gets one immutable ledger entry, even if its
  -- target is unchanged (for example a won event delivered before created).
  SELECT 'razorpay_source:' || md5(jsonb_build_array(s.source_kind,s.source_id,
      s.refunded_amount_subunits,s.dispute_amount_subunits,s.dispute_won)::text)
    INTO event_key FROM public.razorpay_credit_adjustment_sources s
    WHERE s.source_kind = v_source_kind AND s.source_id = v_source_id;
  result := public.reconcile_razorpay_credit_purchase_adjustment(txn.id,event_key,v_payment_id,target,
      CASE WHEN target < txn.credit_reversed_amount_subunits THEN 'restore' ELSE 'reverse' END,
      'razorpay_' || p_kind);
  IF result->>'status' NOT IN ('no_change','reversed','partially_reversed','restored','partially_restored')
     OR result->>'status' IS NULL THEN
    -- Roll back source state too: callers retry and record durable telemetry.
    RAISE EXCEPTION 'Razorpay source settlement unresolved: %',result->>'status';
  END IF;
  RETURN result;
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('status','source_conflict','rewards','[]'::jsonb);
END;
$function$;
REVOKE ALL ON FUNCTION public.reconcile_razorpay_credit_source(uuid,text,text,text,bigint,bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_razorpay_credit_source(uuid,text,text,text,bigint,bigint) TO service_role;
