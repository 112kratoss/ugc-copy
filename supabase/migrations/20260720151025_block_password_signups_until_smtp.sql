-- Password sign-up is disabled until a production SMTP provider and CAPTCHA
-- credentials are configured. Existing password users can still sign in, and
-- verified Google/Apple sign-ups continue through their providers.
CREATE OR REPLACE FUNCTION public.hook_block_password_signups_until_smtp(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog
AS $$
DECLARE
  provider text;
BEGIN
  provider := event->'user'->'app_metadata'->>'provider';

  IF provider = 'email' THEN
    RETURN jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 403,
        'message', 'Email sign-up is temporarily unavailable. Continue with Google or Apple.'
      )
    );
  END IF;

  RETURN '{}'::jsonb;
END;
$$;

REVOKE ALL ON FUNCTION public.hook_block_password_signups_until_smtp(jsonb)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.hook_block_password_signups_until_smtp(jsonb)
TO supabase_auth_admin;
