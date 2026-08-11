-- Guests cannot claim the welcome credit grant.
--
-- 20260811100000 took the 25-credit grant out of handle_new_user() and moved it
-- to welcome_credits_v1, on the reasoning that claim_credit_grant_program()
-- already refuses anyone whose username is still the derived
-- `creator-<8 hex>` placeholder — and a guest never picks a username in the app.
--
-- The app is not the boundary. `PATCH /api/profile` authenticates any caller
-- with a valid JWT, and an anonymous user has one, so the placeholder check is
-- bypassed by simply setting a username:
--
--   signInAnonymously            -- public anon key, no registration
--   PATCH /api/profile           -- username + display_name
--   POST /api/credits/welcome/claim
--   -> 25 credits, enough to generate
--   repeat with a fresh anonymous session, forever
--
-- Identity-was-claimed is a proxy for registered, and it turns out to be a
-- leaky one. This checks the thing actually meant: is_anonymous on the auth row,
-- which only the auth server can set and no client request can change.
--
-- Everything else in the function is reproduced verbatim so a diff against
-- 20260713142640 shows the guard and nothing else.

CREATE OR REPLACE FUNCTION public.claim_credit_grant_program(
  p_user_id uuid,
  p_program_key text,
  p_source_surface text
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

REVOKE ALL ON FUNCTION public.claim_credit_grant_program(uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_credit_grant_program(uuid, text, text)
  TO service_role;
