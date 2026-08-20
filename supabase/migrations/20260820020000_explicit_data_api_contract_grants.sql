-- Reconcile Data API grants that historically came from Supabase platform
-- defaults. Clean projects no longer receive those defaults, while established
-- projects can retain them indefinitely. Pinning the contract here makes both
-- paths converge before the application deployment is promoted.

-- Clear relation- and column-level privileges first. A table-level REVOKE does
-- not remove a separately granted column privilege.
REVOKE ALL PRIVILEGES ON TABLE
  public.contact_messages,
  public.workflow_canvas_runs,
  public.workflow_canvas_run_steps
FROM PUBLIC, anon, authenticated, service_role;

DO $$
DECLARE
  v_table_name text;
  v_column_list text;
BEGIN
  FOREACH v_table_name IN ARRAY ARRAY[
    'contact_messages',
    'workflow_canvas_runs',
    'workflow_canvas_run_steps'
  ]
  LOOP
    SELECT string_agg(quote_ident(columns.column_name), ', ' ORDER BY columns.ordinal_position)
    INTO v_column_list
    FROM information_schema.columns
    WHERE columns.table_schema = 'public'
      AND columns.table_name = v_table_name;

    EXECUTE format(
      'REVOKE ALL PRIVILEGES (%s) ON TABLE public.%I FROM PUBLIC, anon, authenticated, service_role',
      v_column_list,
      v_table_name
    );
  END LOOP;
END;
$$;

-- Contact submissions and console reads both use the server-owned client.
-- Handling changes remain constrained to the service-only audited RPC.
GRANT SELECT, INSERT ON TABLE public.contact_messages TO service_role;

-- No authenticated grant remains, and the only permissive policy is scoped to
-- service_role, so the historical lifecycle policy is redundant. Dropping it
-- also makes established projects match clean migration replays exactly.
DROP POLICY IF EXISTS authenticated_identity_active
  ON public.contact_messages;

-- Compatibility window: the previously deployed app still reads and writes
-- its owner-scoped workflow rows directly. The stage-3 contract migration
-- removes authenticated mutation only after legacy callers have aged out.
GRANT SELECT, INSERT, UPDATE
  ON TABLE public.workflow_canvas_runs
  TO authenticated;
GRANT SELECT, INSERT, UPDATE
  ON TABLE public.workflow_canvas_run_steps
  TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.workflow_canvas_runs
  TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.workflow_canvas_run_steps
  TO service_role;

-- Owner policies remain the permissive tenant boundary. The restrictive
-- lifecycle policy additionally closes every allowed operation when the JWT's
-- identity has been merged or is being deleted.
DROP POLICY IF EXISTS authenticated_identity_active
  ON public.workflow_canvas_runs;
CREATE POLICY authenticated_identity_active
  ON public.workflow_canvas_runs
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING ((SELECT public.current_identity_is_active()))
  WITH CHECK ((SELECT public.current_identity_is_active()));

DROP POLICY IF EXISTS authenticated_identity_active
  ON public.workflow_canvas_run_steps;
CREATE POLICY authenticated_identity_active
  ON public.workflow_canvas_run_steps
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING ((SELECT public.current_identity_is_active()))
  WITH CHECK ((SELECT public.current_identity_is_active()));
