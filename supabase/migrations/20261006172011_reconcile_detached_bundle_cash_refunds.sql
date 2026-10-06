-- Purchases/orders survive creator deletion; their live bundle is set NULL.
-- Keep bundle -> order locking for live captures, but reconcile the retained
-- financial record after deletion (including deletion committed while waiting).
DO $migration$
DECLARE
  definition text;
  old_lock text := $old$  PERFORM 1 FROM public.post_resource_bundles
  WHERE id = v_order.bundle_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;$old$;
  new_lock text := $new$  IF v_order.bundle_id IS NOT NULL THEN
    -- Auth deletion locks this user before cascading through wallet/content.
    -- Join that order before bundle/order locks, so wallet reversal cannot
    -- deadlock against an erasure that already holds wallet rows.
    PERFORM 1 FROM auth.users
    WHERE id = (
      SELECT owner_user_id FROM public.post_resource_bundles
      WHERE id = v_order.bundle_id
    )
    FOR KEY SHARE;
    PERFORM 1 FROM public.post_resource_bundles
    WHERE id = v_order.bundle_id
    FOR UPDATE;
    -- A missing bundle can be a committed FK detachment while we waited.
    -- The order re-read below still requires that original bundle or NULL.
  END IF;$new$;
  old_binding text := '    AND orders.bundle_id = v_order.bundle_id';
  new_binding text := $new$    AND (
      orders.bundle_id IS NOT DISTINCT FROM v_order.bundle_id
      OR orders.bundle_id IS NULL
    )$new$;
BEGIN
  SELECT pg_get_functiondef('public.reconcile_post_resource_cash_adjustment(text,text,text,text,text)'::regprocedure)
    INTO definition;
  IF (length(definition) - length(replace(definition, old_lock, ''))) / length(old_lock) <> 1
     OR (length(definition) - length(replace(definition, old_binding, ''))) / length(old_binding) <> 1 THEN
    RAISE EXCEPTION 'Unexpected post-resource cash adjustment locking definition';
  END IF;
  EXECUTE replace(replace(definition, old_lock, new_lock), old_binding, new_binding);
END;
$migration$;

REVOKE ALL ON FUNCTION public.reconcile_post_resource_cash_adjustment(text,text,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_post_resource_cash_adjustment(text,text,text,text,text) TO service_role;
