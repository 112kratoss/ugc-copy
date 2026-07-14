-- Mobile/web onboarding foundation and an inactive, idempotent welcome-credit program.
--
-- This migration deliberately leaves the existing 25-credit signup trigger unchanged.
-- Activate the program only after the compatible iOS and Android builds are available,
-- in the same transaction that changes handle_new_user() to start new profiles at zero.

CREATE TABLE IF NOT EXISTS public.credit_grant_programs (
  program_key text PRIMARY KEY CHECK (program_key ~ '^[a-z0-9_]{3,64}$'),
  display_name text NOT NULL CHECK (nullif(btrim(display_name), '') IS NOT NULL),
  amount integer NOT NULL CHECK (amount > 0),
  promotional_amount integer NOT NULL DEFAULT 0
    CHECK (promotional_amount >= 0 AND promotional_amount <= amount),
  enabled boolean NOT NULL DEFAULT false,
  activated_at timestamptz,
  deactivated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  CHECK (enabled = false OR activated_at IS NOT NULL),
  CHECK (deactivated_at IS NULL OR activated_at IS NOT NULL),
  CHECK (deactivated_at IS NULL OR deactivated_at >= activated_at)
);

INSERT INTO public.credit_grant_programs (
  program_key,
  display_name,
  amount,
  promotional_amount,
  enabled,
  activated_at
)
VALUES ('welcome_credits_v1', 'Creator Pack', 25, 25, false, NULL)
ON CONFLICT (program_key) DO UPDATE
SET display_name = EXCLUDED.display_name,
    amount = EXCLUDED.amount,
    promotional_amount = EXCLUDED.promotional_amount,
    updated_at = timezone('utc'::text, now())
WHERE public.credit_grant_programs.enabled = false;

CREATE TABLE IF NOT EXISTS public.credit_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  program_key text NOT NULL REFERENCES public.credit_grant_programs(program_key) ON DELETE RESTRICT,
  amount integer NOT NULL CHECK (amount > 0),
  promotional_amount integer NOT NULL DEFAULT 0
    CHECK (promotional_amount >= 0 AND promotional_amount <= amount),
  source_surface text NOT NULL CHECK (source_surface IN ('mobile', 'web', 'support', 'system')),
  credits_balance_after integer NOT NULL CHECK (credits_balance_after >= 0),
  promotional_credits_balance_after integer NOT NULL CHECK (promotional_credits_balance_after >= 0),
  claimed_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  UNIQUE (user_id, program_key)
);

CREATE INDEX IF NOT EXISTS credit_grants_program_claimed_idx
  ON public.credit_grants (program_key, claimed_at DESC);

CREATE TABLE IF NOT EXISTS public.mobile_onboarding_states (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  flow_version integer NOT NULL CHECK (flow_version > 0),
  status text NOT NULL DEFAULT 'not_started'
    CHECK (status IN ('not_started', 'in_progress', 'skipped', 'completed')),
  goal text CHECK (goal IS NULL OR goal IN ('image', 'video', 'motion')),
  username_completed_at timestamptz,
  reward_claimed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  PRIMARY KEY (user_id, flow_version),
  CHECK (status <> 'completed' OR completed_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS mobile_onboarding_states_status_updated_idx
  ON public.mobile_onboarding_states (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.onboarding_events (
  client_event_id uuid PRIMARY KEY,
  installation_id text NOT NULL CHECK (installation_id ~ '^fid_[a-f0-9]{64}$'),
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  flow_version integer NOT NULL CHECK (flow_version > 0),
  variant text NOT NULL DEFAULT 'creator_pack_v1'
    CHECK (variant ~ '^[a-z0-9_-]{1,64}$'),
  platform text NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
  event_name text NOT NULL CHECK (event_name IN (
    'started',
    'screen_viewed',
    'skipped',
    'auth_started',
    'auth_succeeded',
    'auth_canceled',
    'username_saved',
    'username_conflict',
    'reward_viewed',
    'reward_claimed',
    'reward_deferred',
    'reward_failed',
    'guided_creator_opened',
    'first_generation_started',
    'first_generation_succeeded'
  )),
  goal text CHECK (goal IS NULL OR goal IN ('image', 'video', 'motion')),
  step text CHECK (step IS NULL OR length(step) BETWEEN 1 AND 64),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX IF NOT EXISTS onboarding_events_created_idx
  ON public.onboarding_events (created_at DESC);
CREATE INDEX IF NOT EXISTS onboarding_events_user_created_idx
  ON public.onboarding_events (user_id, created_at DESC)
  WHERE user_id IS NOT NULL;

ALTER TABLE public.credit_grant_programs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mobile_onboarding_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.onboarding_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.credit_grant_programs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.credit_grants FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.mobile_onboarding_states FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.onboarding_events FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE public.credit_grant_programs TO service_role;
GRANT ALL ON TABLE public.credit_grants TO service_role;
GRANT ALL ON TABLE public.mobile_onboarding_states TO service_role;
GRANT ALL ON TABLE public.onboarding_events TO service_role;

DROP TRIGGER IF EXISTS credit_grant_programs_set_updated_at ON public.credit_grant_programs;
CREATE TRIGGER credit_grant_programs_set_updated_at
BEFORE UPDATE ON public.credit_grant_programs
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at_column();

DROP TRIGGER IF EXISTS mobile_onboarding_states_set_updated_at ON public.mobile_onboarding_states;
CREATE TRIGGER mobile_onboarding_states_set_updated_at
BEFORE UPDATE ON public.mobile_onboarding_states
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at_column();

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

  SELECT created_at INTO v_user_created_at
  FROM auth.users
  WHERE id = p_user_id;

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
