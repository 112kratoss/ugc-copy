-- Post deletion runs through the service-role Data API client. Both active
-- delete guards need to distinguish an ordinary delete from the auth.users
-- cascade used for account erasure, but service_role deliberately cannot read
-- auth.users. Run only these trigger functions with their trusted postgres
-- owner's privileges instead of widening auth schema access for the API role.

ALTER FUNCTION public.reject_sold_post_delete()
  OWNER TO postgres;
ALTER FUNCTION public.reject_sold_post_delete()
  SECURITY DEFINER;
ALTER FUNCTION public.reject_sold_post_delete()
  SET search_path = '';
REVOKE ALL ON FUNCTION public.reject_sold_post_delete()
  FROM PUBLIC, anon, authenticated, service_role;

ALTER FUNCTION public.protect_sold_post_resource_bundle_content()
  OWNER TO postgres;
ALTER FUNCTION public.protect_sold_post_resource_bundle_content()
  SECURITY DEFINER;
ALTER FUNCTION public.protect_sold_post_resource_bundle_content()
  SET search_path = '';
REVOKE ALL ON FUNCTION public.protect_sold_post_resource_bundle_content()
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.reject_sold_post_delete() IS
  'Trusted trigger guard that retains sold posts during ordinary deletion while allowing auth-user cascades.';

COMMENT ON FUNCTION public.protect_sold_post_resource_bundle_content() IS
  'Trusted trigger guard that freezes purchased resource bundles while allowing auth-user cascades.';
