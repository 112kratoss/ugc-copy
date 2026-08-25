-- Registered-vs-guest user counts for the admin Overview.
--
-- `profiles` has one row per auth identity, and since anonymous sign-in shipped
-- (20260811100000) most of those identities are guests: the app mints one on
-- first launch so a buyer can hold a credit balance without registering, and
-- both the session and the installation id live in AsyncStorage, so every
-- reinstall creates another. On production today that is 65 guests against 28
-- registered accounts — the Overview's `totalUsers`/`newUsers7d` counted all of
-- them and reported 93 users and 33 new this week against a true 28 and 2.
--
-- `is_anonymous` lives on `auth.users`, which PostgREST does not expose, so the
-- split has to come from a SECURITY DEFINER function. Same pattern as
-- `claim_credit_grant_program` (20260811120000), which reads the same column for
-- the same reason: it is the only non-forgeable signal for "registered".
--
-- Guests are returned rather than filtered away. They are real load and real
-- storage, and a counter that silently drops them would replace one misleading
-- number with a different one.

CREATE OR REPLACE FUNCTION public.admin_user_population_counts(p_since timestamptz DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT jsonb_build_object(
    'registered_total', count(*) FILTER (WHERE NOT coalesce(u.is_anonymous, false)),
    'registered_since', count(*) FILTER (
      WHERE NOT coalesce(u.is_anonymous, false)
        AND (p_since IS NULL OR p.created_at >= p_since)
    ),
    'guest_total', count(*) FILTER (WHERE coalesce(u.is_anonymous, false)),
    'guest_since', count(*) FILTER (
      WHERE coalesce(u.is_anonymous, false)
        AND (p_since IS NULL OR p.created_at >= p_since)
    )
  )
  FROM public.profiles p
  JOIN auth.users u ON u.id = p.id;
$function$;

-- Operator-only reporting over every account in the system. The admin console
-- runs service-role behind its own auth boundary (admin-auth.ts); no client
-- role has any business enumerating the guest/registered split.
REVOKE ALL ON FUNCTION public.admin_user_population_counts(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_user_population_counts(timestamptz) FROM anon;
REVOKE ALL ON FUNCTION public.admin_user_population_counts(timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.admin_user_population_counts(timestamptz) TO service_role;
