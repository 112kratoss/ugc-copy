-- Central bearer admission in one database round trip.
--
-- The proxy used to establish a caller's identity with two network calls per
-- signed-in request: GoTrue's /user endpoint (signature check plus user,
-- session and ban lookups) and then current_identity_state(). GoTrue's call
-- was the slow, variable half — a ~450 ms median that stretched past 1.5 s at
-- P95 during busy hours — while the token itself can be verified locally
-- against the project's published ES256 signing key.
--
-- This function returns, for the verified JWT subject, everything that GoTrue
-- round trip used to establish and the proxy still needs: that the user row
-- exists and is not soft-deleted, that the token's session still exists, that
-- the account is not banned, the durable lifecycle state, and created_at —
-- the one field a JWT does not carry (welcome-credit eligibility compares
-- it with the program activation time).
--
-- It returns NULL when the subject no longer exists, so a token for a deleted
-- account is refused rather than admitted with an empty profile. As with
-- current_identity_state(), the zero-argument shape means a caller can only
-- ever ask about itself, and SECURITY DEFINER lets it read auth.users and
-- auth.sessions without granting the authenticated role any table access.
CREATE OR REPLACE FUNCTION public.current_identity_admission()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'state', profile.identity_state,
    'created_at', account.created_at,
    'banned', COALESCE(account.banned_until > now(), false),
    'session_valid', CASE
      WHEN (SELECT auth.jwt() ->> 'session_id') IS NULL THEN true
      WHEN (SELECT auth.jwt() ->> 'session_id')
        !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        THEN false
      ELSE EXISTS (
        SELECT 1
        FROM auth.sessions AS session
        WHERE session.id = (SELECT auth.jwt() ->> 'session_id')::uuid
          AND session.user_id = account.id
      )
    END
  )
  FROM auth.users AS account
  LEFT JOIN public.profiles AS profile ON profile.id = account.id
  WHERE account.id = (SELECT auth.uid())
    AND account.deleted_at IS NULL;
$$;

REVOKE ALL ON FUNCTION public.current_identity_admission()
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_identity_admission()
  TO authenticated, service_role;

COMMENT ON FUNCTION public.current_identity_admission() IS
  'Single-round-trip bearer admission for the current JWT subject: lifecycle state, created_at, ban and session validity; NULL when the account no longer exists.';
