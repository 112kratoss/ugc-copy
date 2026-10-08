-- A failed settlement must remain recoverable without occupying every slot in
-- the next bounded scan. Financial rows and their timestamps are not queue state.
CREATE TABLE public.referral_purchase_reconciliation_retries (
  transaction_id uuid PRIMARY KEY REFERENCES public.transactions(id) ON DELETE CASCADE,
  attempts integer NOT NULL CHECK (attempts > 0),
  next_attempt_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.referral_purchase_reconciliation_retries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.referral_purchase_reconciliation_retries FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.referral_purchase_reconciliation_retries TO service_role;
CREATE INDEX referral_purchase_reconciliation_retries_due_idx
  ON public.referral_purchase_reconciliation_retries(next_attempt_at, transaction_id);

CREATE FUNCTION public.defer_referral_purchase_reconciliation(p_transaction_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  purchase public.transactions%ROWTYPE;
  attempt_count integer;
  retry_at timestamptz;
BEGIN
  -- Share the settlement lock so a lost acknowledgement cannot schedule an
  -- already committed purchase again, or race its completion cleanup.
  SELECT * INTO purchase FROM public.transactions WHERE id = p_transaction_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'transaction_not_found');
  END IF;
  IF EXISTS (SELECT 1 FROM public.referral_purchase_events WHERE transaction_id = p_transaction_id) THEN
    DELETE FROM public.referral_purchase_reconciliation_retries WHERE transaction_id = p_transaction_id;
    RETURN jsonb_build_object('status', 'already_settled');
  END IF;
  IF purchase.credit_purchase_succeeded_at IS NULL OR coalesce(purchase.credits, 0) <= 0 THEN
    DELETE FROM public.referral_purchase_reconciliation_retries WHERE transaction_id = p_transaction_id;
    RETURN jsonb_build_object('status', 'transaction_not_eligible');
  END IF;
  INSERT INTO public.referral_purchase_reconciliation_retries AS retries
    (transaction_id, attempts, next_attempt_at)
  VALUES (p_transaction_id, 1, now() + interval '1 minute')
  ON CONFLICT (transaction_id) DO UPDATE SET
    attempts = least(retries.attempts::bigint + 1, 2147483647)::integer,
    next_attempt_at = now() + make_interval(secs => least(3600, 60 * power(2, least(retries.attempts, 6)))::integer),
    updated_at = now()
  RETURNING attempts, next_attempt_at INTO attempt_count, retry_at;
  RETURN jsonb_build_object('status', 'deferred', 'attempts', attempt_count, 'next_attempt_at', retry_at);
END;
$$;
REVOKE ALL ON FUNCTION public.defer_referral_purchase_reconciliation(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.defer_referral_purchase_reconciliation(uuid) TO service_role;

CREATE FUNCTION public.clear_settled_referral_purchase_retry()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  DELETE FROM public.referral_purchase_reconciliation_retries WHERE transaction_id = NEW.transaction_id;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.clear_settled_referral_purchase_retry() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER clear_settled_referral_purchase_retry
AFTER INSERT ON public.referral_purchase_events
FOR EACH ROW EXECUTE FUNCTION public.clear_settled_referral_purchase_retry();

-- Preserve the previously audited detached-owner matching and existing ACLs.
DO $$
DECLARE
  definition text;
  old_join text := E'  LEFT JOIN public.referral_purchase_events AS events\n    ON events.transaction_id = transactions.id';
  new_join text := E'  LEFT JOIN public.referral_purchase_events AS events\n    ON events.transaction_id = transactions.id\n  LEFT JOIN public.referral_purchase_reconciliation_retries AS retries\n    ON retries.transaction_id = transactions.id';
  old_filter text := '    AND events.transaction_id IS NULL';
  new_filter text := E'    AND events.transaction_id IS NULL\n    AND (retries.next_attempt_at IS NULL OR retries.next_attempt_at <= now())';
  old_order text := '  ORDER BY transactions.updated_at ASC, transactions.id ASC';
  -- When the next hourly scan occurs after backoff expires, failures must still
  -- move behind work that has waited longer. Do not rewrite financial timestamps.
  new_order text := '  ORDER BY coalesce(retries.updated_at, transactions.updated_at) ASC, transactions.id ASC';
BEGIN
  SELECT pg_get_functiondef('public.list_unsettled_referral_purchase_transactions(integer)'::regprocedure) INTO definition;
  IF (length(definition) - length(replace(definition, old_join, ''))) / length(old_join) <> 1
    OR (length(definition) - length(replace(definition, old_filter, ''))) / length(old_filter) <> 1
    OR (length(definition) - length(replace(definition, old_order, ''))) / length(old_order) <> 1 THEN
    RAISE EXCEPTION 'Expected one settlement selection join and filter';
  END IF;
  EXECUTE replace(replace(replace(definition, old_join, new_join), old_filter, new_filter), old_order, new_order);
END;
$$;
