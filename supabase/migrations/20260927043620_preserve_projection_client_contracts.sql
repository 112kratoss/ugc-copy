-- Preserve the long-lived production ACL/RLS contract on clean databases.
-- These pre-convention tables inherited authenticated CRUD grants, but their
-- only permissive policies are SELECT: client mutations remain denied by RLS.
-- The historical identity-policy installer discovered tables from their ACLs,
-- so a fresh database also missed these three restrictive policies.
BEGIN;
SET LOCAL lock_timeout = '5s';
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ai_usage_events,
  public.source_tools, public.source_tool_models TO authenticated;

DROP POLICY IF EXISTS authenticated_identity_active ON public.ai_usage_events;
CREATE POLICY authenticated_identity_active
ON public.ai_usage_events AS RESTRICTIVE FOR ALL TO authenticated
USING ((SELECT public.current_identity_is_active()))
WITH CHECK ((SELECT public.current_identity_is_active()));

DROP POLICY IF EXISTS authenticated_identity_active ON public.source_tools;
CREATE POLICY authenticated_identity_active
ON public.source_tools AS RESTRICTIVE FOR ALL TO authenticated
USING ((SELECT public.current_identity_is_active()))
WITH CHECK ((SELECT public.current_identity_is_active()));

DROP POLICY IF EXISTS authenticated_identity_active ON public.source_tool_models;
CREATE POLICY authenticated_identity_active
ON public.source_tool_models AS RESTRICTIVE FOR ALL TO authenticated
USING ((SELECT public.current_identity_is_active()))
WITH CHECK ((SELECT public.current_identity_is_active()));
COMMIT;
