-- Admin Users & credits lists accounts, not identities (owner question,
-- 2026-11-14: "why are there so many?").
--
-- The list read `profiles` wholesale, and most profiles are guests: the app
-- signs in a guest on every first launch, reinstall and sign-out, so production
-- held 540 guests against 80 registered accounts, each shown as an "Unnamed
-- @creator-xxxxxxxx" row that looked like a person who never set a name. 271 of
-- those guests are linked (profiles.merged_into_user_id): the device's guest
-- from before its owner signed in, now part of that account.
--
-- `is_anonymous` lives on auth.users, which PostgREST does not expose, so the
-- split comes from a SECURITY DEFINER function, as the Overview's counts do
-- (admin_user_population_counts, 20260826100000). It pages and counts in one
-- statement, so the console never pulls the population into memory.
--
--   p_kind  'registered' (is_anonymous false), 'guests' (true, linked or not)
--           or 'all'. Anything else is refused.
--   p_term  a user id (exact) or text matched against username and display
--           name. Its LIKE wildcards are escaped: '%' and '_' are letters here.
--   p_limit 1 to 100; p_offset 0 or more. total_count is the matching rows
--           across every page, carried on each row; a page past the end returns
--           no rows, and the caller asks again from the first page.
CREATE FUNCTION public.admin_search_users(
  p_term text DEFAULT NULL,
  p_kind text DEFAULT 'registered',
  p_limit integer DEFAULT 25,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  username text,
  display_name text,
  avatar_url text,
  credits integer,
  promotional_credits integer,
  created_at timestamp with time zone,
  is_guest boolean,
  merged_into_user_id uuid,
  total_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
#variable_conflict use_column
DECLARE
  v_term text := left(nullif(btrim(coalesce(p_term, '')), ''), 64);
  v_id uuid;
  v_pattern text;
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('registered', 'guests', 'all') THEN
    RAISE EXCEPTION 'admin_search_users kind must be registered, guests or all'
      USING ERRCODE = '22023';
  END IF;

  IF v_term IS NOT NULL THEN
    IF v_term ~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$' THEN
      v_id := v_term::uuid;
    ELSE
      v_pattern := '%' || replace(replace(replace(v_term, '\', '\\'), '%', '\%'), '_', '\_') || '%';
    END IF;
  END IF;

  RETURN QUERY
  SELECT
    profile.id,
    profile.username,
    profile.display_name,
    profile.avatar_url,
    profile.credits,
    profile.promotional_credits,
    profile.created_at,
    coalesce(account.is_anonymous, false) AS is_guest,
    profile.merged_into_user_id,
    count(*) OVER () AS total_count
  FROM public.profiles AS profile
  JOIN auth.users AS account ON account.id = profile.id
  WHERE (
      p_kind = 'all'
      OR (p_kind = 'registered' AND NOT coalesce(account.is_anonymous, false))
      OR (p_kind = 'guests' AND coalesce(account.is_anonymous, false))
    )
    AND (
      v_term IS NULL
      OR (v_id IS NOT NULL AND profile.id = v_id)
      OR (v_pattern IS NOT NULL AND (
        profile.username ILIKE v_pattern
        OR profile.display_name ILIKE v_pattern
      ))
    )
  ORDER BY profile.created_at DESC, profile.id DESC
  LIMIT v_limit
  OFFSET v_offset;
END;
$function$;

-- Operator-only: it lists every account and guest in the system. The admin
-- console calls it service-role behind its own sign-in (admin-auth.ts).
REVOKE ALL ON FUNCTION public.admin_search_users(text, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_search_users(text, text, integer, integer) TO service_role;
