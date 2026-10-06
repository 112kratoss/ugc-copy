-- Distinct Auth UUIDs can share their first eight hex digits. Keep the existing
-- placeholder format (web/mobile onboarding and welcome-credit eligibility use
-- it), but allocate a different placeholder if the case-insensitive index wins
-- for another profile. The index arbitrates concurrent signups atomically.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  candidate_username text := 'creator-' || left(new.id::text, 8);
  attempt integer;
BEGIN
  FOR attempt IN 1..32 LOOP
    INSERT INTO public.profiles (id, credits, username)
    VALUES (new.id, 0, candidate_username)
    ON CONFLICT (lower(username)) WHERE username IS NOT NULL DO NOTHING;

    IF FOUND THEN
      RETURN new;
    END IF;

    candidate_username := 'creator-' || left(pg_catalog.gen_random_uuid()::text, 8);
  END LOOP;

  RAISE EXCEPTION 'Could not allocate generated profile username'
    USING ERRCODE = '23505';
END;
$$;

REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO service_role;
