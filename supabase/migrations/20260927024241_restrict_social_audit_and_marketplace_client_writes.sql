-- Save state and audit events are authoritative service writes. Owner reads
-- remain for installed clients; all save mutations use existing API/RPC paths.
BEGIN;
SET LOCAL lock_timeout = '5s';
REVOKE ALL PRIVILEGES ON TABLE
  public.post_saves, public.showcase_saves, public.post_save_events,
  public.post_deletion_audits, public.marketplace_asset_content
FROM PUBLIC, anon, authenticated;

-- Revoke separate column ACLs too; table-level REVOKE does not remove them.
DO $$
DECLARE target text; columns text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'post_saves','showcase_saves','post_save_events',
    'post_deletion_audits','marketplace_asset_content'
  ] LOOP
    SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum)
    INTO columns FROM pg_attribute
    WHERE attrelid = format('public.%I', target)::regclass
      AND attnum > 0 AND NOT attisdropped;
    EXECUTE format('REVOKE ALL PRIVILEGES (%s) ON TABLE public.%I FROM PUBLIC, anon, authenticated', columns, target);
  END LOOP;
END;
$$;

GRANT SELECT ON TABLE public.post_saves, public.showcase_saves,
  public.post_save_events, public.post_deletion_audits TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.post_saves,
  public.showcase_saves, public.post_save_events, public.post_deletion_audits,
  public.marketplace_asset_content TO service_role;

DROP POLICY IF EXISTS "Users can insert their own post saves" ON public.post_saves;
DROP POLICY IF EXISTS "Users can delete their own post saves" ON public.post_saves;
-- Explicit on new databases as well as historically granted projects.
DROP POLICY IF EXISTS authenticated_identity_active ON public.post_saves;
CREATE POLICY authenticated_identity_active
ON public.post_saves AS RESTRICTIVE FOR ALL TO authenticated
USING ((SELECT public.current_identity_is_active()))
WITH CHECK ((SELECT public.current_identity_is_active()));

DROP POLICY IF EXISTS "Users can insert their own saves" ON public.showcase_saves;
DROP POLICY IF EXISTS "Users can delete their own saves" ON public.showcase_saves;
-- Explicit on new databases as well as historically granted projects.
DROP POLICY IF EXISTS authenticated_identity_active ON public.showcase_saves;
CREATE POLICY authenticated_identity_active
ON public.showcase_saves AS RESTRICTIVE FOR ALL TO authenticated
USING ((SELECT public.current_identity_is_active()))
WITH CHECK ((SELECT public.current_identity_is_active()));

DROP POLICY IF EXISTS "Users can insert their own post save events" ON public.post_save_events;
-- Explicit on new databases as well as historically granted projects.
DROP POLICY IF EXISTS authenticated_identity_active ON public.post_save_events;
CREATE POLICY authenticated_identity_active
ON public.post_save_events AS RESTRICTIVE FOR ALL TO authenticated
USING ((SELECT public.current_identity_is_active()))
WITH CHECK ((SELECT public.current_identity_is_active()));

DROP POLICY IF EXISTS "Owners can insert their own post deletion audits" ON public.post_deletion_audits;
-- Explicit on new databases as well as historically granted projects.
DROP POLICY IF EXISTS authenticated_identity_active ON public.post_deletion_audits;
CREATE POLICY authenticated_identity_active
ON public.post_deletion_audits AS RESTRICTIVE FOR ALL TO authenticated
USING ((SELECT public.current_identity_is_active()))
WITH CHECK ((SELECT public.current_identity_is_active()));

-- Content entitlement is checked by the service layer before reading content.
-- These policies referenced parent tables without client SELECT privileges.
DO $$
DECLARE policy record;
BEGIN
  FOR policy IN SELECT polname FROM pg_policy
    WHERE polrelid='public.marketplace_asset_content'::regclass
      AND polpermissive
  LOOP
    EXECUTE format('DROP POLICY %I ON public.marketplace_asset_content', policy.polname);
  END LOOP;
END;
$$;
COMMIT;
