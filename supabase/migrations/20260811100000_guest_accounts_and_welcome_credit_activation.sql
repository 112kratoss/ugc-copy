-- Guest (anonymous) accounts, and the welcome credit move that has to land with them.
--
-- App Review rejected 0.0.5 (28) under guideline 5.1.1(v): the app required
-- registration before an In-App Purchase. The fix is to let a buyer hold a real
-- backend identity without registering, which means turning on Supabase
-- anonymous sign-ins.
--
-- That flips handle_new_user() from a harmless convenience into a credit
-- faucet. It grants 25 credits to every new auth.users row, and an anonymous
-- row costs an attacker one API call — reinstall, clear app data, repeat. The
-- 25-credit grant therefore has to leave the trigger in the same transaction
-- that makes anonymous rows cheap, which is exactly the sequencing
-- 20260713142640 reserved for this moment:
--
--   "Activate the program only after the compatible iOS and Android builds are
--    available, in the same transaction that changes handle_new_user() to start
--    new profiles at zero."
--
-- Nothing here enables anonymous sign-ins by itself. That is an auth-server
-- setting (supabase/config.toml locally, the Auth provider settings in
-- production), so this migration is safe to apply before the setting is flipped
-- and must be applied before it is.

-- 1. New profiles start empty.
--
-- The username stays the derived `creator-<8 hex>` placeholder, which is load
-- bearing beyond cosmetics: claim_credit_grant_program() treats that exact
-- pattern as "identity not claimed" and refuses the grant. A guest cannot reach
-- the welcome credits without first choosing a real username and display name,
-- which is only possible once they register.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
begin
  insert into public.profiles (id, credits, username)
  values (
    new.id,
    0,
    lower('creator-' || left(replace(new.id::text, '-', ''), 8))
  );
  return new;
end;
$$;

REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO service_role;

-- 2. The 25 credits move to welcome_credits_v1, claimed after registration.
--
-- activated_at is the cutover marker, not decoration: the RPC returns
-- 'legacy_ineligible' for any user whose auth.users.created_at predates it, so
-- everyone who already received 25 credits from the trigger cannot claim them a
-- second time. Setting it to now() inside this transaction is what makes the
-- handover exact — there is no instant at which both paths pay out, and none at
-- which neither does.
UPDATE public.credit_grant_programs
SET enabled = true,
    activated_at = coalesce(activated_at, timezone('utc'::text, now())),
    deactivated_at = NULL,
    updated_at = timezone('utc'::text, now())
WHERE program_key = 'welcome_credits_v1';
