-- Notification routes are registered-only. Anonymous Supabase identities also
-- use the authenticated role, so owner checks alone do not enforce that rule.
-- Preserve registered client operations and trusted service maintenance.
BEGIN;
SET LOCAL lock_timeout = '5s';

DROP POLICY IF EXISTS registered_identity_only ON public.mobile_notifications;
CREATE POLICY registered_identity_only
ON public.mobile_notifications AS RESTRICTIVE FOR ALL TO authenticated
USING ((SELECT public.current_identity_is_registered()))
WITH CHECK ((SELECT public.current_identity_is_registered()));

-- State explicitly for fresh databases as well as long-lived projects.
DROP POLICY IF EXISTS authenticated_identity_active ON public.mobile_notifications;
CREATE POLICY authenticated_identity_active
ON public.mobile_notifications AS RESTRICTIVE FOR ALL TO authenticated
USING ((SELECT public.current_identity_is_active()))
WITH CHECK ((SELECT public.current_identity_is_active()));

DROP POLICY IF EXISTS registered_identity_only ON public.mobile_notification_preferences;
CREATE POLICY registered_identity_only
ON public.mobile_notification_preferences AS RESTRICTIVE FOR ALL TO authenticated
USING ((SELECT public.current_identity_is_registered()))
WITH CHECK ((SELECT public.current_identity_is_registered()));

-- State explicitly for fresh databases as well as long-lived projects.
DROP POLICY IF EXISTS authenticated_identity_active ON public.mobile_notification_preferences;
CREATE POLICY authenticated_identity_active
ON public.mobile_notification_preferences AS RESTRICTIVE FOR ALL TO authenticated
USING ((SELECT public.current_identity_is_active()))
WITH CHECK ((SELECT public.current_identity_is_active()));

DROP POLICY IF EXISTS registered_identity_only ON public.mobile_push_tokens;
CREATE POLICY registered_identity_only
ON public.mobile_push_tokens AS RESTRICTIVE FOR ALL TO authenticated
USING ((SELECT public.current_identity_is_registered()))
WITH CHECK ((SELECT public.current_identity_is_registered()));

-- State explicitly for fresh databases as well as long-lived projects.
DROP POLICY IF EXISTS authenticated_identity_active ON public.mobile_push_tokens;
CREATE POLICY authenticated_identity_active
ON public.mobile_push_tokens AS RESTRICTIVE FOR ALL TO authenticated
USING ((SELECT public.current_identity_is_active()))
WITH CHECK ((SELECT public.current_identity_is_active()));
COMMIT;
