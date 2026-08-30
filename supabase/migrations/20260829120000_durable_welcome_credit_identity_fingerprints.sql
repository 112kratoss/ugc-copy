-- A claim record that survives the account it belongs to.
--
-- The welcome-credit replay guard is UNIQUE (user_id, program_key) on
-- public.credit_grants — a table that cascades away with auth.users. Account
-- deletion is a hard admin.deleteUser, so the loop
--
--   sign up → claim 25 credits → delete account → sign up again → claim
--
-- pays out on every cycle. Every remaining check in
-- claim_credit_grant_program() is recycling-blind: is_anonymous is false for a
-- re-registered user, created_at is always after activated_at for a fresh
-- signup, and the username rule is re-satisfiable in seconds. auth.users.id is
-- a proxy for "a person", and it is leaky the same way the username proxy was
-- (20260811120000): the user can discard it on demand.
--
-- The durable identity is the sign-in itself. The app HMAC-hashes the
-- account's identifiers (email, OAuth provider subjects) and passes the
-- digests here; claims are recorded against those digests in a table with
-- deliberately no foreign key to auth.users (precedent: account_deletion_jobs,
-- 20260714112000), and a claim whose digest is already present is refused with
-- 'identity_already_claimed'. Raw identifiers never reach this table — only
-- one-way digests, retained for fraud prevention, which is the retention the
-- delete-account page already reserves.
--
-- The hashing secret stays app-side, so this migration cannot backfill the
-- three grants that predate it; scripts/backfill-welcome-credit-fingerprints.ts
-- records them after deploy. NULL/empty p_identity_fingerprints skips the
-- guard, which also covers the minutes between this migration applying and the
-- code that passes digests deploying.
--
-- The claim function is reproduced verbatim from 20260811120000 so a diff
-- shows the fingerprint guard and nothing else.

CREATE TABLE IF NOT EXISTS public.credit_grant_identity_fingerprints (
  program_key text NOT NULL REFERENCES public.credit_grant_programs(program_key) ON DELETE RESTRICT,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  first_claimed_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  recorded_via text NOT NULL CHECK (recorded_via IN ('claim', 'deletion', 'backfill')),
  -- Deliberately keyed on the digest alone: this row must outlive the account
  -- it came from, and must stay unlinkable to whoever deleted it.
  PRIMARY KEY (program_key, fingerprint)
);

ALTER TABLE public.credit_grant_identity_fingerprints ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.credit_grant_identity_fingerprints FROM PUBLIC;
REVOKE ALL ON public.credit_grant_identity_fingerprints FROM anon, authenticated;

DROP POLICY IF EXISTS "No client access to credit_grant_identity_fingerprints"
  ON public.credit_grant_identity_fingerprints;
CREATE POLICY "No client access to credit_grant_identity_fingerprints"
  ON public.credit_grant_identity_fingerprints FOR ALL TO anon, authenticated
  USING (false)
  WITH CHECK (false);

-- Append-only, enforced. New tables are born with full privileges for
-- service_role, so granting SELECT, INSERT alone changes nothing — the ledger
-- only forgets if UPDATE and DELETE are explicitly revoked.
REVOKE ALL ON public.credit_grant_identity_fingerprints FROM service_role;
GRANT SELECT, INSERT ON public.credit_grant_identity_fingerprints TO service_role;

-- CREATE OR REPLACE cannot change a parameter list, so the 3-argument function
-- is dropped and recreated with the fingerprint parameter. DROP discards the
-- ACLs, so the REVOKE/GRANT pair is re-issued below for the new signature.
DROP FUNCTION IF EXISTS public.claim_credit_grant_program(uuid, text, text);

CREATE OR REPLACE FUNCTION public.claim_credit_grant_program(
  p_user_id uuid,
  p_program_key text,
  p_source_surface text,
  p_identity_fingerprints text[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_program public.credit_grant_programs%ROWTYPE;
  v_existing public.credit_grants%ROWTYPE;
  v_profile public.profiles%ROWTYPE;
  v_user_created_at timestamptz;
  v_is_anonymous boolean;
  v_fingerprints text[];
  v_grant_id uuid;
  v_credits integer;
  v_promotional_credits integer;
BEGIN
  IF p_user_id IS NULL
     OR nullif(btrim(coalesce(p_program_key, '')), '') IS NULL
     OR p_source_surface NOT IN ('mobile', 'web', 'support', 'system') THEN
    RETURN jsonb_build_object('status', 'not_eligible');
  END IF;

  SELECT * INTO v_program
  FROM public.credit_grant_programs
  WHERE program_key = btrim(p_program_key)
  FOR UPDATE;

  IF NOT FOUND OR v_program.enabled = false OR v_program.activated_at IS NULL THEN
    RETURN jsonb_build_object('status', 'unavailable');
  END IF;

  SELECT created_at, coalesce(is_anonymous, false)
  INTO v_user_created_at, v_is_anonymous
  FROM auth.users
  WHERE id = p_user_id;

  -- The guard. A guest identity costs one unauthenticated API call and can be
  -- minted without limit, so any credit it can claim is a faucet regardless of
  -- what its profile row says.
  IF v_is_anonymous THEN
    RETURN jsonb_build_object('status', 'not_eligible');
  END IF;

  IF v_user_created_at IS NULL OR v_user_created_at < v_program.activated_at THEN
    RETURN jsonb_build_object('status', 'legacy_ineligible');
  END IF;

  SELECT * INTO v_profile
  FROM public.profiles
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND
     OR nullif(btrim(coalesce(v_profile.display_name, '')), '') IS NULL
     OR v_profile.username IS NULL
     OR v_profile.username !~ '^[a-z0-9-]{3,24}$'
     OR v_profile.username ~ '^creator-[a-f0-9]{8}$' THEN
    RETURN jsonb_build_object('status', 'not_eligible');
  END IF;

  SELECT * INTO v_existing
  FROM public.credit_grants
  WHERE user_id = p_user_id
    AND program_key = v_program.program_key;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'status', 'already_claimed',
      'amount', v_existing.amount,
      'promotional_amount', v_existing.promotional_amount,
      'credits', v_existing.credits_balance_after,
      'promotional_credits', v_existing.promotional_credits_balance_after,
      'claimed_at', v_existing.claimed_at
    );
  END IF;

  -- The fingerprint guard, deliberately after the existing-grant check so a
  -- live account re-claiming still reads its own 'already_claimed' record.
  -- Digests are computed app-side; anything not shaped like one is discarded
  -- rather than trusted. The FOR UPDATE on the program row above serializes
  -- every claim for this program, so check-then-insert cannot race.
  v_fingerprints := ARRAY(
    SELECT DISTINCT f
    FROM unnest(coalesce(p_identity_fingerprints, ARRAY[]::text[])) AS f
    WHERE f ~ '^[a-f0-9]{64}$'
  );

  IF cardinality(v_fingerprints) > 0 AND EXISTS (
    SELECT 1
    FROM public.credit_grant_identity_fingerprints
    WHERE program_key = v_program.program_key
      AND fingerprint = ANY (v_fingerprints)
  ) THEN
    RETURN jsonb_build_object(
      'status', 'identity_already_claimed',
      'amount', v_program.amount,
      'promotional_amount', v_program.promotional_amount
    );
  END IF;

  INSERT INTO public.credit_grants (
    user_id,
    program_key,
    amount,
    promotional_amount,
    source_surface,
    credits_balance_after,
    promotional_credits_balance_after
  ) VALUES (
    p_user_id,
    v_program.program_key,
    v_program.amount,
    v_program.promotional_amount,
    p_source_surface,
    greatest(coalesce(v_profile.credits, 0) + v_program.amount, 0),
    greatest(coalesce(v_profile.promotional_credits, 0) + v_program.promotional_amount, 0)
  )
  ON CONFLICT (user_id, program_key) DO NOTHING
  RETURNING id INTO v_grant_id;

  IF v_grant_id IS NULL THEN
    SELECT * INTO v_existing
    FROM public.credit_grants
    WHERE user_id = p_user_id
      AND program_key = v_program.program_key;

    RETURN jsonb_build_object(
      'status', 'already_claimed',
      'amount', v_existing.amount,
      'promotional_amount', v_existing.promotional_amount,
      'credits', v_existing.credits_balance_after,
      'promotional_credits', v_existing.promotional_credits_balance_after,
      'claimed_at', v_existing.claimed_at
    );
  END IF;

  UPDATE public.profiles
  SET credits = greatest(coalesce(credits, 0) + v_program.amount, 0),
      promotional_credits = greatest(coalesce(promotional_credits, 0) + v_program.promotional_amount, 0)
  WHERE id = p_user_id
  RETURNING credits, promotional_credits INTO v_credits, v_promotional_credits;

  UPDATE public.credit_grants
  SET credits_balance_after = v_credits,
      promotional_credits_balance_after = v_promotional_credits
  WHERE id = v_grant_id;

  UPDATE public.mobile_onboarding_states
  SET reward_claimed_at = coalesce(reward_claimed_at, timezone('utc'::text, now()))
  WHERE user_id = p_user_id;

  -- Record the claim against the identity, not just the account, so deleting
  -- the account cannot reset it.
  IF cardinality(v_fingerprints) > 0 THEN
    INSERT INTO public.credit_grant_identity_fingerprints (program_key, fingerprint, recorded_via)
    SELECT v_program.program_key, f, 'claim'
    FROM unnest(v_fingerprints) AS f
    ON CONFLICT (program_key, fingerprint) DO NOTHING;
  END IF;

  RETURN jsonb_build_object(
    'status', 'claimed',
    'amount', v_program.amount,
    'promotional_amount', v_program.promotional_amount,
    'credits', v_credits,
    'promotional_credits', v_promotional_credits,
    'claimed_at', timezone('utc'::text, now())
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_credit_grant_program(uuid, text, text, text[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_credit_grant_program(uuid, text, text, text[])
  TO service_role;
