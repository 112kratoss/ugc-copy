-- Preserve the mobile grant repair and serialize duplicate store callbacks.
DO $migration$
DECLARE
  definition text;
  old_lookup text := $old$  SELECT * INTO v_existing_ledger
  FROM public.mobile_store_transactions
  WHERE provider = p_provider$old$;
  new_lookup text := $new$  -- Serialize before the first lookup. Without this, a competing commit can
  -- appear between the initial miss and the external-order existence check,
  -- incorrectly classifying an identical replay as a transaction conflict.
  -- Store IDs are globally unique in this ledger, regardless of provider.
  PERFORM pg_advisory_xact_lock(hashtextextended('mobile-store-transaction:' || p_store_transaction_id, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('mobile-external-order:' || p_external_order_id, 0));

  SELECT * INTO v_existing_ledger
  FROM public.mobile_store_transactions
  WHERE provider = p_provider$new$;
BEGIN
  SELECT pg_get_functiondef('public.complete_mobile_purchase(uuid, uuid, text, text, text, text, text, numeric, text)'::regprocedure) INTO definition;
  IF (length(definition) - length(replace(definition, old_lookup, ''))) / length(old_lookup) <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one mobile identity lookup block';
  END IF;
  EXECUTE replace(definition, old_lookup, new_lookup);
END;
$migration$;
REVOKE ALL ON FUNCTION public.complete_mobile_purchase(uuid, uuid, text, text, text, text, text, numeric, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_mobile_purchase(uuid, uuid, text, text, text, text, text, numeric, text) TO service_role;
