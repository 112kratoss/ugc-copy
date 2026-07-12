-- Invite & Earn referral program, reward ledger, and promotional-credit isolation.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS promotional_credits integer NOT NULL DEFAULT 0;

ALTER TABLE public.generations
  ADD COLUMN IF NOT EXISTS promotional_credits_used integer NOT NULL DEFAULT 0;

ALTER TABLE public.generations
  DROP CONSTRAINT IF EXISTS generations_promotional_credits_used_check;
ALTER TABLE public.generations
  ADD CONSTRAINT generations_promotional_credits_used_check
  CHECK (
    promotional_credits_used >= 0
    AND promotional_credits_used <= greatest(0, coalesce(cost, 0))
  );

ALTER TABLE public.ai_usage_events
  ADD COLUMN IF NOT EXISTS promotional_credits_used integer NOT NULL DEFAULT 0;

ALTER TABLE public.ai_usage_events
  DROP CONSTRAINT IF EXISTS ai_usage_events_promotional_credits_used_check;
ALTER TABLE public.ai_usage_events
  ADD CONSTRAINT ai_usage_events_promotional_credits_used_check
  CHECK (
    promotional_credits_used >= 0
    AND promotional_credits_used <= greatest(0, coalesce(cost, 0))
  );

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS credit_purchase_succeeded_at timestamptz,
  ADD COLUMN IF NOT EXISTS credit_reversed_amount_subunits bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS credit_reversed_credits integer NOT NULL DEFAULT 0;

UPDATE public.transactions
SET credit_purchase_succeeded_at = coalesce(credit_purchase_succeeded_at, updated_at, created_at)
WHERE status IN ('success', 'refunded')
  AND credit_purchase_succeeded_at IS NULL;

UPDATE public.transactions
SET credit_reversed_amount_subunits = amount,
    credit_reversed_credits = credits
WHERE status = 'refunded'
  AND credit_reversed_credits = 0;

ALTER TABLE public.transactions
  DROP CONSTRAINT IF EXISTS transactions_credit_reversal_bounds_check;
ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_credit_reversal_bounds_check
  CHECK (
    credit_reversed_amount_subunits >= 0
    AND credit_reversed_amount_subunits <= amount
    AND credit_reversed_credits >= 0
    AND credit_reversed_credits <= credits
  );

CREATE OR REPLACE FUNCTION public.record_credit_purchase_success_timestamp()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status = 'success' AND OLD.status IS DISTINCT FROM 'success' THEN
    NEW.credit_purchase_succeeded_at := coalesce(
      NEW.credit_purchase_succeeded_at,
      timezone('utc'::text, now())
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS transactions_record_credit_purchase_success ON public.transactions;
CREATE TRIGGER transactions_record_credit_purchase_success
BEFORE UPDATE OF status ON public.transactions
FOR EACH ROW EXECUTE FUNCTION public.record_credit_purchase_success_timestamp();

REVOKE ALL ON FUNCTION public.record_credit_purchase_success_timestamp() FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.referral_programs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version integer NOT NULL UNIQUE CHECK (version > 0),
  name text NOT NULL CHECK (btrim(name) <> ''),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'retired')),
  inviter_reward_bps integer NOT NULL CHECK (inviter_reward_bps BETWEEN 1 AND 10000),
  invitee_reward_bps integer NOT NULL CHECK (invitee_reward_bps BETWEEN 1 AND 10000),
  attribution_window_days integer NOT NULL DEFAULT 30
    CHECK (attribution_window_days BETWEEN 1 AND 365),
  activated_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  deactivated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  CHECK (deactivated_at IS NULL OR deactivated_at >= activated_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS referral_programs_one_active_idx
  ON public.referral_programs ((status))
  WHERE status = 'active';

INSERT INTO public.referral_programs (
  version,
  name,
  status,
  inviter_reward_bps,
  invitee_reward_bps,
  attribution_window_days
)
VALUES (1, 'Invite & Earn', 'active', 500, 500, 30)
ON CONFLICT (version) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.referral_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9]{8,24}$'),
  is_enabled boolean NOT NULL DEFAULT true,
  disabled_reason text,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  CHECK (is_enabled OR nullif(btrim(coalesce(disabled_reason, '')), '') IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS public.referral_visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_token uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  referral_code_id uuid NOT NULL REFERENCES public.referral_codes(id) ON DELETE RESTRICT,
  program_id uuid NOT NULL REFERENCES public.referral_programs(id) ON DELETE RESTRICT,
  inviter_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('web', 'native')),
  destination_path text,
  ip_hash text CHECK (ip_hash IS NULL OR ip_hash ~ '^[a-f0-9]{64}$'),
  user_agent_hash text CHECK (user_agent_hash IS NULL OR user_agent_hash ~ '^[a-f0-9]{64}$'),
  visited_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  expires_at timestamptz NOT NULL,
  claimed_at timestamptz,
  CHECK (expires_at > visited_at),
  CHECK (claimed_at IS NULL OR claimed_at >= visited_at)
);

CREATE INDEX IF NOT EXISTS referral_visits_code_visited_idx
  ON public.referral_visits (referral_code_id, visited_at DESC);
CREATE INDEX IF NOT EXISTS referral_visits_expiry_unclaimed_idx
  ON public.referral_visits (expires_at)
  WHERE claimed_at IS NULL;

CREATE TABLE IF NOT EXISTS public.referral_attributions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id uuid NOT NULL REFERENCES public.referral_programs(id) ON DELETE RESTRICT,
  referral_visit_id uuid NOT NULL UNIQUE REFERENCES public.referral_visits(id) ON DELETE RESTRICT,
  inviter_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  invitee_user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  attributed_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  CHECK (inviter_user_id <> invitee_user_id)
);

CREATE INDEX IF NOT EXISTS referral_attributions_inviter_created_idx
  ON public.referral_attributions (inviter_user_id, attributed_at DESC);

CREATE TABLE IF NOT EXISTS public.referral_purchase_events (
  transaction_id uuid PRIMARY KEY REFERENCES public.transactions(id) ON DELETE RESTRICT,
  attribution_id uuid NOT NULL REFERENCES public.referral_attributions(id) ON DELETE RESTRICT,
  purchaser_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  purchased_credits integer NOT NULL CHECK (purchased_credits > 0),
  reversed_purchase_credits integer NOT NULL DEFAULT 0
    CHECK (reversed_purchase_credits >= 0 AND reversed_purchase_credits <= purchased_credits),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'partially_reversed', 'reversed')),
  settled_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX IF NOT EXISTS referral_purchase_events_attribution_created_idx
  ON public.referral_purchase_events (attribution_id, settled_at DESC);

CREATE TABLE IF NOT EXISTS public.referral_rewards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attribution_id uuid NOT NULL REFERENCES public.referral_attributions(id) ON DELETE RESTRICT,
  transaction_id uuid NOT NULL REFERENCES public.transactions(id) ON DELETE RESTRICT,
  beneficiary_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('inviter_purchase', 'invitee_first_purchase')),
  rate_bps integer NOT NULL CHECK (rate_bps BETWEEN 1 AND 10000),
  purchased_credits integer NOT NULL CHECK (purchased_credits > 0),
  original_credits integer NOT NULL CHECK (original_credits > 0),
  active_credits integer NOT NULL CHECK (active_credits >= 0),
  reversed_credits integer NOT NULL DEFAULT 0 CHECK (reversed_credits >= 0),
  status text NOT NULL DEFAULT 'granted'
    CHECK (status IN ('granted', 'partially_reversed', 'reversed')),
  granted_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  UNIQUE (transaction_id, beneficiary_user_id, kind),
  CHECK (active_credits + reversed_credits = original_credits)
);

CREATE UNIQUE INDEX IF NOT EXISTS referral_rewards_one_invitee_bonus_idx
  ON public.referral_rewards (attribution_id)
  WHERE kind = 'invitee_first_purchase';
CREATE INDEX IF NOT EXISTS referral_rewards_beneficiary_created_idx
  ON public.referral_rewards (beneficiary_user_id, granted_at DESC);

CREATE TABLE IF NOT EXISTS public.referral_reward_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid NOT NULL REFERENCES public.referral_purchase_events(transaction_id) ON DELETE RESTRICT,
  adjustment_key text NOT NULL CHECK (btrim(adjustment_key) <> ''),
  action text NOT NULL CHECK (action IN ('reverse', 'restore')),
  purchase_credits_delta integer NOT NULL CHECK (purchase_credits_delta > 0),
  reason text,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  UNIQUE (transaction_id, adjustment_key)
);

CREATE TABLE IF NOT EXISTS public.referral_credit_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reward_id uuid NOT NULL REFERENCES public.referral_rewards(id) ON DELETE RESTRICT,
  transaction_id uuid NOT NULL REFERENCES public.transactions(id) ON DELETE RESTRICT,
  entry_kind text NOT NULL CHECK (entry_kind IN ('reward_grant', 'reward_reversal', 'reward_restoration')),
  credit_delta integer NOT NULL CHECK (credit_delta <> 0),
  promotional_delta integer NOT NULL CHECK (promotional_delta = credit_delta),
  balance_after integer NOT NULL,
  promotional_balance_after integer NOT NULL,
  idempotency_key text NOT NULL UNIQUE CHECK (btrim(idempotency_key) <> ''),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX IF NOT EXISTS referral_credit_ledger_user_created_idx
  ON public.referral_credit_ledger (user_id, created_at DESC);

-- Source-aware reservations cover legacy voice/sound generation paths until
-- they are migrated to the generation/AI-event lifecycle RPCs.
CREATE TABLE IF NOT EXISTS public.creation_credit_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reservation_key text NOT NULL CHECK (btrim(reservation_key) <> ''),
  credits integer NOT NULL CHECK (credits >= 0),
  promotional_credits_used integer NOT NULL CHECK (
    promotional_credits_used >= 0 AND promotional_credits_used <= credits
  ),
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'refunded')),
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  refunded_at timestamptz,
  UNIQUE (user_id, reservation_key)
);

CREATE TABLE IF NOT EXISTS public.credit_purchase_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid NOT NULL REFERENCES public.transactions(id) ON DELETE RESTRICT,
  provider text NOT NULL CHECK (provider IN ('razorpay', 'revenuecat')),
  provider_event_id text NOT NULL CHECK (btrim(provider_event_id) <> ''),
  reason text,
  previous_reversed_amount_subunits bigint NOT NULL CHECK (previous_reversed_amount_subunits >= 0),
  target_reversed_amount_subunits bigint NOT NULL CHECK (target_reversed_amount_subunits >= 0),
  previous_reversed_credits integer NOT NULL CHECK (previous_reversed_credits >= 0),
  target_reversed_credits integer NOT NULL CHECK (target_reversed_credits >= 0),
  base_credit_delta integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  UNIQUE (provider, provider_event_id)
);

CREATE INDEX IF NOT EXISTS credit_purchase_adjustments_transaction_created_idx
  ON public.credit_purchase_adjustments (transaction_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.prevent_referral_identity_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.code IS DISTINCT FROM OLD.code
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'referral code identity is immutable';
  END IF;
  NEW.updated_at := timezone('utc'::text, now());
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS referral_codes_prevent_identity_mutation ON public.referral_codes;
CREATE TRIGGER referral_codes_prevent_identity_mutation
BEFORE UPDATE ON public.referral_codes
FOR EACH ROW EXECUTE FUNCTION public.prevent_referral_identity_mutation();

CREATE OR REPLACE FUNCTION public.prevent_referral_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'referral audit rows are append-only';
END;
$$;

DROP TRIGGER IF EXISTS referral_credit_ledger_append_only ON public.referral_credit_ledger;
CREATE TRIGGER referral_credit_ledger_append_only
BEFORE UPDATE OR DELETE ON public.referral_credit_ledger
FOR EACH ROW EXECUTE FUNCTION public.prevent_referral_audit_mutation();

DROP TRIGGER IF EXISTS referral_reward_adjustments_append_only ON public.referral_reward_adjustments;
CREATE TRIGGER referral_reward_adjustments_append_only
BEFORE UPDATE OR DELETE ON public.referral_reward_adjustments
FOR EACH ROW EXECUTE FUNCTION public.prevent_referral_audit_mutation();

DROP TRIGGER IF EXISTS credit_purchase_adjustments_append_only ON public.credit_purchase_adjustments;
CREATE TRIGGER credit_purchase_adjustments_append_only
BEFORE UPDATE OR DELETE ON public.credit_purchase_adjustments
FOR EACH ROW EXECUTE FUNCTION public.prevent_referral_audit_mutation();

ALTER TABLE public.referral_programs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referral_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referral_visits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referral_attributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referral_purchase_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referral_rewards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referral_reward_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referral_credit_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.creation_credit_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_purchase_adjustments ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.referral_programs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.referral_codes FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.referral_visits FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.referral_attributions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.referral_purchase_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.referral_rewards FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.referral_reward_adjustments FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.referral_credit_ledger FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.creation_credit_reservations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.credit_purchase_adjustments FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.referral_programs TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.referral_codes TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.referral_visits TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.referral_attributions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.referral_purchase_events TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.referral_rewards TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.referral_reward_adjustments TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.referral_credit_ledger TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.creation_credit_reservations TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.credit_purchase_adjustments TO service_role;

CREATE OR REPLACE FUNCTION public.ensure_referral_code(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_code public.referral_codes%ROWTYPE;
  v_candidate text;
  v_attempt integer;
BEGIN
  IF p_user_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = p_user_id
  ) THEN
    RETURN jsonb_build_object('status', 'profile_not_found');
  END IF;

  SELECT * INTO v_code
  FROM public.referral_codes
  WHERE user_id = p_user_id;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'status', CASE WHEN v_code.is_enabled THEN 'ready' ELSE 'disabled' END,
      'code', v_code.code,
      'enabled', v_code.is_enabled
    );
  END IF;

  FOR v_attempt IN 1..8 LOOP
    v_candidate := lower(encode(gen_random_bytes(6), 'hex'));
    BEGIN
      INSERT INTO public.referral_codes (user_id, code)
      VALUES (p_user_id, v_candidate)
      RETURNING * INTO v_code;

      RETURN jsonb_build_object(
        'status', 'ready',
        'code', v_code.code,
        'enabled', true
      );
    EXCEPTION WHEN unique_violation THEN
      SELECT * INTO v_code
      FROM public.referral_codes
      WHERE user_id = p_user_id;

      IF FOUND THEN
        RETURN jsonb_build_object(
          'status', CASE WHEN v_code.is_enabled THEN 'ready' ELSE 'disabled' END,
          'code', v_code.code,
          'enabled', v_code.is_enabled
        );
      END IF;
    END;
  END LOOP;

  RAISE EXCEPTION 'could not allocate a unique referral code';
END;
$$;

CREATE OR REPLACE FUNCTION public.create_referral_visit(
  p_code text,
  p_channel text,
  p_destination_path text DEFAULT NULL,
  p_existing_visit_token uuid DEFAULT NULL,
  p_ip_hash text DEFAULT NULL,
  p_user_agent_hash text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing record;
  v_code public.referral_codes%ROWTYPE;
  v_program public.referral_programs%ROWTYPE;
  v_visit public.referral_visits%ROWTYPE;
BEGIN
  IF lower(btrim(coalesce(p_channel, ''))) NOT IN ('web', 'native')
     OR nullif(lower(btrim(coalesce(p_code, ''))), '') IS NULL
     OR (p_ip_hash IS NOT NULL AND p_ip_hash !~ '^[a-f0-9]{64}$')
     OR (p_user_agent_hash IS NOT NULL AND p_user_agent_hash !~ '^[a-f0-9]{64}$') THEN
    RETURN jsonb_build_object('status', 'invalid_request');
  END IF;

  IF p_existing_visit_token IS NOT NULL THEN
    SELECT visits.*, codes.code AS referral_code INTO v_existing
    FROM public.referral_visits AS visits
    JOIN public.referral_codes AS codes ON codes.id = visits.referral_code_id
    WHERE visits.public_token = p_existing_visit_token
      AND visits.claimed_at IS NULL
      AND visits.expires_at > timezone('utc'::text, now())
      AND codes.is_enabled = true;

    IF FOUND THEN
      RETURN jsonb_build_object(
        'status', 'preserved',
        'code', v_existing.referral_code,
        'visit_token', v_existing.public_token,
        'expires_at', v_existing.expires_at,
        'destination_path', v_existing.destination_path
      );
    END IF;
  END IF;

  SELECT * INTO v_code
  FROM public.referral_codes
  WHERE code = lower(btrim(p_code))
    AND is_enabled = true;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'invalid_code');
  END IF;

  SELECT * INTO v_program
  FROM public.referral_programs
  WHERE status = 'active'
  ORDER BY version DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'program_unavailable');
  END IF;

  INSERT INTO public.referral_visits (
    referral_code_id,
    program_id,
    inviter_user_id,
    channel,
    destination_path,
    ip_hash,
    user_agent_hash,
    expires_at
  ) VALUES (
    v_code.id,
    v_program.id,
    v_code.user_id,
    lower(btrim(p_channel)),
    nullif(left(btrim(coalesce(p_destination_path, '')), 2048), ''),
    p_ip_hash,
    p_user_agent_hash,
    timezone('utc'::text, now()) + make_interval(days => v_program.attribution_window_days)
  )
  RETURNING * INTO v_visit;

  RETURN jsonb_build_object(
    'status', 'created',
    'code', v_code.code,
    'visit_token', v_visit.public_token,
    'expires_at', v_visit.expires_at,
    'destination_path', v_visit.destination_path
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_referral_visit(
  p_invitee_user_id uuid,
  p_visit_token uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_auth_created_at timestamptz;
  v_existing public.referral_attributions%ROWTYPE;
  v_visit public.referral_visits%ROWTYPE;
  v_code_enabled boolean;
  v_program_version integer;
  v_attribution public.referral_attributions%ROWTYPE;
BEGIN
  IF p_invitee_user_id IS NULL OR p_visit_token IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid_request');
  END IF;

  SELECT users.created_at
  INTO v_auth_created_at
  FROM public.profiles AS profiles
  JOIN auth.users AS users ON users.id = profiles.id
  WHERE profiles.id = p_invitee_user_id
  FOR UPDATE OF profiles;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'profile_not_found');
  END IF;

  SELECT * INTO v_existing
  FROM public.referral_attributions
  WHERE invitee_user_id = p_invitee_user_id;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'status', 'already_attributed',
      'attribution_id', v_existing.id
    );
  END IF;

  SELECT visits.*
  INTO v_visit
  FROM public.referral_visits AS visits
  WHERE visits.public_token = p_visit_token
  FOR UPDATE OF visits;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'visit_unavailable');
  END IF;

  SELECT codes.is_enabled, programs.version
  INTO v_code_enabled, v_program_version
  FROM public.referral_codes AS codes
  JOIN public.referral_programs AS programs ON programs.id = v_visit.program_id
  WHERE codes.id = v_visit.referral_code_id;

  IF NOT FOUND OR NOT v_code_enabled THEN
    RETURN jsonb_build_object('status', 'visit_unavailable');
  END IF;

  IF v_visit.claimed_at IS NOT NULL
     OR v_visit.expires_at <= timezone('utc'::text, now()) THEN
    RETURN jsonb_build_object('status', 'visit_unavailable');
  END IF;

  IF v_visit.inviter_user_id = p_invitee_user_id THEN
    RETURN jsonb_build_object('status', 'self_referral');
  END IF;

  -- A pre-existing account cannot become referred by clicking a link later.
  -- auth.users is the authoritative account creation timestamp; no backwards
  -- skew window is allowed because it would permit post-signup referral claims.
  IF v_auth_created_at < v_visit.visited_at THEN
    RETURN jsonb_build_object('status', 'existing_account');
  END IF;

  INSERT INTO public.referral_attributions (
    program_id,
    referral_visit_id,
    inviter_user_id,
    invitee_user_id
  ) VALUES (
    v_visit.program_id,
    v_visit.id,
    v_visit.inviter_user_id,
    p_invitee_user_id
  )
  RETURNING * INTO v_attribution;

  UPDATE public.referral_visits
  SET claimed_at = v_attribution.attributed_at
  WHERE id = v_visit.id;

  RETURN jsonb_build_object(
    'status', 'claimed',
    'attribution_id', v_attribution.id,
    'program_version', v_program_version
  );
EXCEPTION WHEN unique_violation THEN
  SELECT * INTO v_existing
  FROM public.referral_attributions
  WHERE invitee_user_id = p_invitee_user_id;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'status', 'already_attributed',
      'attribution_id', v_existing.id
    );
  END IF;

  RETURN jsonb_build_object('status', 'visit_unavailable');
END;
$$;

CREATE OR REPLACE FUNCTION public.get_referral_dashboard(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_code jsonb;
  v_program public.referral_programs%ROWTYPE;
  v_visits bigint := 0;
  v_signups bigint := 0;
  v_purchasers bigint := 0;
  v_earned bigint := 0;
  v_reversed bigint := 0;
  v_available bigint := 0;
  v_recent jsonb := '[]'::jsonb;
BEGIN
  IF p_user_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = p_user_id
  ) THEN
    RETURN jsonb_build_object('status', 'profile_not_found');
  END IF;

  v_code := public.ensure_referral_code(p_user_id);

  SELECT * INTO v_program
  FROM public.referral_programs
  WHERE status = 'active'
  ORDER BY version DESC
  LIMIT 1;

  SELECT count(*) INTO v_visits
  FROM public.referral_visits AS visits
  JOIN public.referral_codes AS codes ON codes.id = visits.referral_code_id
  WHERE codes.user_id = p_user_id;

  SELECT count(*) INTO v_signups
  FROM public.referral_attributions
  WHERE inviter_user_id = p_user_id;

  SELECT count(DISTINCT events.purchaser_user_id) INTO v_purchasers
  FROM public.referral_purchase_events AS events
  JOIN public.referral_attributions AS attributions
    ON attributions.id = events.attribution_id
  WHERE attributions.inviter_user_id = p_user_id;

  SELECT
    coalesce(sum(rewards.original_credits), 0),
    coalesce(sum(rewards.reversed_credits), 0),
    coalesce(sum(rewards.active_credits), 0)
  INTO v_earned, v_reversed, v_available
  FROM public.referral_rewards AS rewards
  WHERE rewards.beneficiary_user_id = p_user_id;

  SELECT coalesce(jsonb_agg(recent.activity ORDER BY recent.created_at DESC), '[]'::jsonb)
  INTO v_recent
  FROM (
    SELECT
      jsonb_build_object(
        'id', ledger.id,
        'rewardId', rewards.id,
        'kind', rewards.kind,
        'entryKind', ledger.entry_kind,
        'credits', abs(ledger.credit_delta),
        'creditDelta', ledger.credit_delta,
        'activeCredits', rewards.active_credits,
        'reversedCredits', rewards.reversed_credits,
        'status', rewards.status,
        'createdAt', ledger.created_at
      ) AS activity,
      ledger.created_at
    FROM public.referral_credit_ledger AS ledger
    JOIN public.referral_rewards AS rewards ON rewards.id = ledger.reward_id
    WHERE ledger.user_id = p_user_id
    ORDER BY ledger.created_at DESC
    LIMIT 20
  ) AS recent;

  RETURN jsonb_build_object(
    'status', 'ready',
    'offer', CASE WHEN v_program.id IS NULL THEN NULL ELSE jsonb_build_object(
      'name', v_program.name,
      'programVersion', v_program.version,
      'inviterRewardBps', v_program.inviter_reward_bps,
      'inviteeRewardBps', v_program.invitee_reward_bps,
      'attributionWindowDays', v_program.attribution_window_days,
      'active', true
    ) END,
    'referral', jsonb_build_object(
      'code', v_code ->> 'code',
      'enabled', coalesce((v_code ->> 'enabled')::boolean, false)
    ),
    'stats', jsonb_build_object(
      'visits', v_visits,
      'referredUsers', v_signups,
      'purchasers', v_purchasers,
      'earnedCredits', v_earned,
      'reversedCredits', v_reversed,
      'activeRewardCredits', v_available
    ),
    'recentRewards', v_recent
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.settle_referral_purchase_rewards(p_transaction_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_transaction public.transactions%ROWTYPE;
  v_attribution public.referral_attributions%ROWTYPE;
  v_program public.referral_programs%ROWTYPE;
  v_first_transaction_id uuid;
  v_reward_id uuid;
  v_original_reward_credits integer;
  v_active_reward_credits integer;
  v_reward_status text;
  v_balance integer;
  v_promotional_balance integer;
  v_rewards jsonb := '[]'::jsonb;
BEGIN
  IF p_transaction_id IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid_request', 'rewards', v_rewards);
  END IF;

  SELECT * INTO v_transaction
  FROM public.transactions
  WHERE id = p_transaction_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'transaction_not_found', 'rewards', v_rewards);
  END IF;

  IF v_transaction.credit_purchase_succeeded_at IS NULL
     OR coalesce(v_transaction.credits, 0) <= 0 THEN
    RETURN jsonb_build_object('status', 'transaction_not_eligible', 'rewards', v_rewards);
  END IF;

  SELECT * INTO v_attribution
  FROM public.referral_attributions
  WHERE invitee_user_id = v_transaction.user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'no_attribution', 'rewards', v_rewards);
  END IF;

  SELECT * INTO v_program
  FROM public.referral_programs
  WHERE id = v_attribution.program_id;

  INSERT INTO public.referral_purchase_events (
    transaction_id,
    attribution_id,
    purchaser_user_id,
    purchased_credits,
    reversed_purchase_credits,
    status
  ) VALUES (
    v_transaction.id,
    v_attribution.id,
    v_transaction.user_id,
    v_transaction.credits,
    v_transaction.credit_reversed_credits,
    CASE
      WHEN v_transaction.credit_reversed_credits = 0 THEN 'active'
      WHEN v_transaction.credit_reversed_credits = v_transaction.credits THEN 'reversed'
      ELSE 'partially_reversed'
    END
  )
  ON CONFLICT (transaction_id) DO NOTHING;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'already_settled', 'rewards', v_rewards);
  END IF;

  v_original_reward_credits := floor(
    v_transaction.credits::numeric * v_program.inviter_reward_bps::numeric / 10000::numeric
  )::integer;
  v_active_reward_credits := floor(
    (v_transaction.credits - v_transaction.credit_reversed_credits)::numeric
    * v_program.inviter_reward_bps::numeric / 10000::numeric
  )::integer;
  v_reward_status := CASE
    WHEN v_active_reward_credits = 0 THEN 'reversed'
    WHEN v_active_reward_credits = v_original_reward_credits THEN 'granted'
    ELSE 'partially_reversed'
  END;

  IF v_original_reward_credits > 0 THEN
    INSERT INTO public.referral_rewards (
      attribution_id,
      transaction_id,
      beneficiary_user_id,
      kind,
      rate_bps,
      purchased_credits,
      original_credits,
      active_credits,
      reversed_credits,
      status
    ) VALUES (
      v_attribution.id,
      v_transaction.id,
      v_attribution.inviter_user_id,
      'inviter_purchase',
      v_program.inviter_reward_bps,
      v_transaction.credits,
      v_original_reward_credits,
      v_active_reward_credits,
      v_original_reward_credits - v_active_reward_credits,
      v_reward_status
    )
    RETURNING id INTO v_reward_id;

    IF v_active_reward_credits > 0 THEN
      UPDATE public.profiles
      SET credits = credits + v_active_reward_credits,
          promotional_credits = promotional_credits + v_active_reward_credits
      WHERE id = v_attribution.inviter_user_id
      RETURNING credits, promotional_credits INTO v_balance, v_promotional_balance;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'inviter profile not found for referral reward';
      END IF;

      INSERT INTO public.referral_credit_ledger (
        user_id, reward_id, transaction_id, entry_kind, credit_delta,
        promotional_delta, balance_after, promotional_balance_after,
        idempotency_key, metadata
      ) VALUES (
        v_attribution.inviter_user_id,
        v_reward_id,
        v_transaction.id,
        'reward_grant',
        v_active_reward_credits,
        v_active_reward_credits,
        v_balance,
        v_promotional_balance,
        'referral:grant:' || v_reward_id::text,
        jsonb_build_object('kind', 'inviter_purchase')
      );

      v_rewards := v_rewards || jsonb_build_array(jsonb_build_object(
        'id', v_reward_id,
        'user_id', v_attribution.inviter_user_id,
        'credits', v_active_reward_credits,
        'active_credits', v_active_reward_credits,
        'status', v_reward_status,
        'kind', 'inviter_purchase',
        'event_key', 'referral:grant:' || v_reward_id::text
      ));
    END IF;
  END IF;

  SELECT transactions.id INTO v_first_transaction_id
  FROM public.transactions AS transactions
  WHERE transactions.user_id = v_transaction.user_id
    AND transactions.credit_purchase_succeeded_at IS NOT NULL
    AND transactions.credits > 0
  ORDER BY transactions.credit_purchase_succeeded_at ASC, transactions.id ASC
  LIMIT 1;

  IF v_first_transaction_id = v_transaction.id
     AND NOT EXISTS (
       SELECT 1
       FROM public.referral_rewards
       WHERE attribution_id = v_attribution.id
         AND kind = 'invitee_first_purchase'
     ) THEN
    v_original_reward_credits := floor(
      v_transaction.credits::numeric * v_program.invitee_reward_bps::numeric / 10000::numeric
    )::integer;
    v_active_reward_credits := floor(
      (v_transaction.credits - v_transaction.credit_reversed_credits)::numeric
      * v_program.invitee_reward_bps::numeric / 10000::numeric
    )::integer;
    v_reward_status := CASE
      WHEN v_active_reward_credits = 0 THEN 'reversed'
      WHEN v_active_reward_credits = v_original_reward_credits THEN 'granted'
      ELSE 'partially_reversed'
    END;

    IF v_original_reward_credits > 0 THEN
      INSERT INTO public.referral_rewards (
        attribution_id,
        transaction_id,
        beneficiary_user_id,
        kind,
        rate_bps,
        purchased_credits,
        original_credits,
        active_credits,
        reversed_credits,
        status
      ) VALUES (
        v_attribution.id,
        v_transaction.id,
        v_attribution.invitee_user_id,
        'invitee_first_purchase',
        v_program.invitee_reward_bps,
        v_transaction.credits,
        v_original_reward_credits,
        v_active_reward_credits,
        v_original_reward_credits - v_active_reward_credits,
        v_reward_status
      )
      RETURNING id INTO v_reward_id;

      IF v_active_reward_credits > 0 THEN
        UPDATE public.profiles
        SET credits = credits + v_active_reward_credits,
            promotional_credits = promotional_credits + v_active_reward_credits
        WHERE id = v_attribution.invitee_user_id
        RETURNING credits, promotional_credits INTO v_balance, v_promotional_balance;

        IF NOT FOUND THEN
          RAISE EXCEPTION 'invitee profile not found for referral reward';
        END IF;

        INSERT INTO public.referral_credit_ledger (
          user_id, reward_id, transaction_id, entry_kind, credit_delta,
          promotional_delta, balance_after, promotional_balance_after,
          idempotency_key, metadata
        ) VALUES (
          v_attribution.invitee_user_id,
          v_reward_id,
          v_transaction.id,
          'reward_grant',
          v_active_reward_credits,
          v_active_reward_credits,
          v_balance,
          v_promotional_balance,
          'referral:grant:' || v_reward_id::text,
          jsonb_build_object('kind', 'invitee_first_purchase')
        );

        v_rewards := v_rewards || jsonb_build_array(jsonb_build_object(
          'id', v_reward_id,
          'user_id', v_attribution.invitee_user_id,
          'credits', v_active_reward_credits,
          'active_credits', v_active_reward_credits,
          'status', v_reward_status,
          'kind', 'invitee_first_purchase',
          'event_key', 'referral:grant:' || v_reward_id::text
        ));
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'status', CASE WHEN jsonb_array_length(v_rewards) > 0 THEN 'settled' ELSE 'no_reward' END,
    'rewards', v_rewards
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.reconcile_referral_purchase_reward_adjustment(
  p_transaction_id uuid,
  p_action text,
  p_purchase_credits integer,
  p_adjustment_key text,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_event public.referral_purchase_events%ROWTYPE;
  v_action text := lower(btrim(coalesce(p_action, '')));
  v_effective_credits integer;
  v_new_reversed integer;
  v_reward public.referral_rewards%ROWTYPE;
  v_target_active integer;
  v_delta integer;
  v_balance integer;
  v_promotional_balance integer;
  v_status text;
  v_rewards jsonb := '[]'::jsonb;
BEGIN
  IF p_transaction_id IS NULL
     OR v_action NOT IN ('reverse', 'restore')
     OR p_purchase_credits IS NULL
     OR p_purchase_credits <= 0
     OR nullif(btrim(coalesce(p_adjustment_key, '')), '') IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid_request', 'rewards', v_rewards);
  END IF;

  SELECT * INTO v_event
  FROM public.referral_purchase_events
  WHERE transaction_id = p_transaction_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_settled', 'rewards', v_rewards);
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.referral_reward_adjustments
    WHERE transaction_id = p_transaction_id
      AND adjustment_key = btrim(p_adjustment_key)
  ) THEN
    RETURN jsonb_build_object('status', 'duplicate_adjustment', 'rewards', v_rewards);
  END IF;

  IF v_action = 'reverse' THEN
    v_effective_credits := least(
      p_purchase_credits,
      v_event.purchased_credits - v_event.reversed_purchase_credits
    );
    IF v_effective_credits <= 0 THEN
      RETURN jsonb_build_object('status', 'already_reversed', 'rewards', v_rewards);
    END IF;
    v_new_reversed := v_event.reversed_purchase_credits + v_effective_credits;
  ELSE
    v_effective_credits := least(p_purchase_credits, v_event.reversed_purchase_credits);
    IF v_effective_credits <= 0 THEN
      RETURN jsonb_build_object('status', 'already_active', 'rewards', v_rewards);
    END IF;
    v_new_reversed := v_event.reversed_purchase_credits - v_effective_credits;
  END IF;

  INSERT INTO public.referral_reward_adjustments (
    transaction_id,
    adjustment_key,
    action,
    purchase_credits_delta,
    reason
  ) VALUES (
    p_transaction_id,
    btrim(p_adjustment_key),
    v_action,
    v_effective_credits,
    nullif(left(btrim(coalesce(p_reason, '')), 200), '')
  );

  UPDATE public.referral_purchase_events
  SET reversed_purchase_credits = v_new_reversed,
      status = CASE
        WHEN v_new_reversed = 0 THEN 'active'
        WHEN v_new_reversed = purchased_credits THEN 'reversed'
        ELSE 'partially_reversed'
      END,
      updated_at = timezone('utc'::text, now())
  WHERE transaction_id = p_transaction_id;

  FOR v_reward IN
    SELECT *
    FROM public.referral_rewards
    WHERE transaction_id = p_transaction_id
    ORDER BY id
    FOR UPDATE
  LOOP
    v_target_active := floor(
      (v_reward.purchased_credits - v_new_reversed)::numeric
      * v_reward.rate_bps::numeric / 10000::numeric
    )::integer;
    v_target_active := greatest(0, least(v_reward.original_credits, v_target_active));
    v_delta := v_target_active - v_reward.active_credits;

    IF v_delta = 0 THEN
      CONTINUE;
    END IF;

    UPDATE public.profiles
    SET credits = credits + v_delta,
        promotional_credits = promotional_credits + v_delta
    WHERE id = v_reward.beneficiary_user_id
    RETURNING credits, promotional_credits INTO v_balance, v_promotional_balance;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'beneficiary profile not found for referral adjustment';
    END IF;

    v_status := CASE
      WHEN v_target_active = 0 THEN 'reversed'
      WHEN v_target_active = v_reward.original_credits THEN 'granted'
      ELSE 'partially_reversed'
    END;

    UPDATE public.referral_rewards
    SET active_credits = v_target_active,
        reversed_credits = original_credits - v_target_active,
        status = v_status,
        updated_at = timezone('utc'::text, now())
    WHERE id = v_reward.id;

    INSERT INTO public.referral_credit_ledger (
      user_id, reward_id, transaction_id, entry_kind, credit_delta,
      promotional_delta, balance_after, promotional_balance_after,
      idempotency_key, metadata
    ) VALUES (
      v_reward.beneficiary_user_id,
      v_reward.id,
      p_transaction_id,
      CASE WHEN v_action = 'reverse' THEN 'reward_reversal' ELSE 'reward_restoration' END,
      v_delta,
      v_delta,
      v_balance,
      v_promotional_balance,
      'referral:' || v_action || ':' || btrim(p_adjustment_key) || ':' || v_reward.id::text,
      jsonb_build_object(
        'reason', nullif(left(btrim(coalesce(p_reason, '')), 200), ''),
        'purchaseCreditsDelta', v_effective_credits
      )
    );

    v_rewards := v_rewards || jsonb_build_array(jsonb_build_object(
      'id', v_reward.id,
      'user_id', v_reward.beneficiary_user_id,
      'credits', abs(v_delta),
      'active_credits', v_target_active,
      'status', v_status,
      'kind', v_reward.kind,
      'event_key', 'referral:' || v_action || ':' || btrim(p_adjustment_key) || ':' || v_reward.id::text
    ));
  END LOOP;

  RETURN jsonb_build_object(
    'status', CASE WHEN v_action = 'reverse' THEN 'reversed' ELSE 'restored' END,
    'purchase_credits_delta', v_effective_credits,
    'rewards', v_rewards
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.reverse_referral_purchase_rewards(
  p_transaction_id uuid,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_event public.referral_purchase_events%ROWTYPE;
  v_sequence bigint;
BEGIN
  IF nullif(btrim(coalesce(p_reason, '')), '') IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid_request', 'rewards', '[]'::jsonb);
  END IF;

  SELECT * INTO v_event
  FROM public.referral_purchase_events
  WHERE transaction_id = p_transaction_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_settled', 'rewards', '[]'::jsonb);
  END IF;

  IF v_event.reversed_purchase_credits >= v_event.purchased_credits THEN
    RETURN jsonb_build_object('status', 'already_reversed', 'rewards', '[]'::jsonb);
  END IF;

  SELECT count(*) + 1 INTO v_sequence
  FROM public.referral_reward_adjustments
  WHERE transaction_id = p_transaction_id
    AND action = 'reverse';

  RETURN public.reconcile_referral_purchase_reward_adjustment(
    p_transaction_id,
    'reverse',
    v_event.purchased_credits - v_event.reversed_purchase_credits,
    'full-reverse:' || v_sequence::text,
    p_reason
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.restore_referral_purchase_rewards(p_transaction_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_event public.referral_purchase_events%ROWTYPE;
  v_sequence bigint;
BEGIN
  SELECT * INTO v_event
  FROM public.referral_purchase_events
  WHERE transaction_id = p_transaction_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_settled', 'rewards', '[]'::jsonb);
  END IF;

  IF v_event.reversed_purchase_credits <= 0 THEN
    RETURN jsonb_build_object('status', 'already_active', 'rewards', '[]'::jsonb);
  END IF;

  SELECT count(*) + 1 INTO v_sequence
  FROM public.referral_reward_adjustments
  WHERE transaction_id = p_transaction_id
    AND action = 'restore';

  RETURN public.reconcile_referral_purchase_reward_adjustment(
    p_transaction_id,
    'restore',
    v_event.reversed_purchase_credits,
    'full-restore:' || v_sequence::text,
    'purchase_restored'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.list_unsettled_referral_purchase_transactions(
  p_limit integer DEFAULT 100
)
RETURNS TABLE(transaction_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT transactions.id
  FROM public.transactions AS transactions
  JOIN public.referral_attributions AS attributions
    ON attributions.invitee_user_id = transactions.user_id
  LEFT JOIN public.referral_purchase_events AS events
    ON events.transaction_id = transactions.id
  WHERE transactions.credit_purchase_succeeded_at IS NOT NULL
    AND transactions.credits > 0
    AND events.transaction_id IS NULL
  ORDER BY transactions.updated_at ASC, transactions.id ASC
  LIMIT greatest(1, least(coalesce(p_limit, 100), 100));
$$;

REVOKE ALL ON FUNCTION public.ensure_referral_code(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_referral_visit(text, text, text, uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_referral_visit(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_referral_dashboard(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.settle_referral_purchase_rewards(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reconcile_referral_purchase_reward_adjustment(uuid, text, integer, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reverse_referral_purchase_rewards(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.restore_referral_purchase_rewards(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_unsettled_referral_purchase_transactions(integer) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.ensure_referral_code(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.create_referral_visit(text, text, text, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_referral_visit(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_referral_dashboard(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_referral_purchase_rewards(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_referral_purchase_reward_adjustment(uuid, text, integer, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.reverse_referral_purchase_rewards(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.restore_referral_purchase_rewards(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_unsettled_referral_purchase_transactions(integer) TO service_role;

-- Debit promotional credits alongside total credits whenever a creation row is
-- reserved. Existing start_generation/start_template_generation and
-- start_ai_usage_event signatures stay compatible and inherit this behavior.
CREATE OR REPLACE FUNCTION public.reserve_generation_promotional_credits()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_promotional_credits integer;
  v_promotional_used integer;
BEGIN
  IF coalesce(NEW.cost, 0) <= 0 OR coalesce(NEW.promotional_credits_used, 0) > 0 THEN
    RETURN NEW;
  END IF;

  SELECT promotional_credits INTO v_promotional_credits
  FROM public.profiles
  WHERE id = NEW.user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  v_promotional_used := least(NEW.cost, greatest(v_promotional_credits, 0));
  IF v_promotional_used > 0 THEN
    UPDATE public.profiles
    SET promotional_credits = promotional_credits - v_promotional_used
    WHERE id = NEW.user_id;
    NEW.promotional_credits_used := v_promotional_used;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS generations_reserve_promotional_credits ON public.generations;
CREATE TRIGGER generations_reserve_promotional_credits
BEFORE INSERT ON public.generations
FOR EACH ROW EXECUTE FUNCTION public.reserve_generation_promotional_credits();

CREATE OR REPLACE FUNCTION public.restore_generation_promotional_credits()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF coalesce(OLD.refunded, false) = false
     AND coalesce(NEW.refunded, false) = true
     AND coalesce(NEW.promotional_credits_used, 0) > 0 THEN
    UPDATE public.profiles
    SET promotional_credits = promotional_credits + NEW.promotional_credits_used
    WHERE id = NEW.user_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS generations_restore_promotional_credits ON public.generations;
CREATE TRIGGER generations_restore_promotional_credits
AFTER UPDATE OF refunded ON public.generations
FOR EACH ROW EXECUTE FUNCTION public.restore_generation_promotional_credits();

CREATE OR REPLACE FUNCTION public.reserve_ai_usage_promotional_credits()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_promotional_credits integer;
  v_promotional_used integer;
BEGIN
  IF coalesce(NEW.cost, 0) <= 0 OR coalesce(NEW.promotional_credits_used, 0) > 0 THEN
    RETURN NEW;
  END IF;

  SELECT promotional_credits INTO v_promotional_credits
  FROM public.profiles
  WHERE id = NEW.user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  v_promotional_used := least(NEW.cost, greatest(v_promotional_credits, 0));
  IF v_promotional_used > 0 THEN
    UPDATE public.profiles
    SET promotional_credits = promotional_credits - v_promotional_used
    WHERE id = NEW.user_id;
    NEW.promotional_credits_used := v_promotional_used;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ai_usage_events_reserve_promotional_credits ON public.ai_usage_events;
CREATE TRIGGER ai_usage_events_reserve_promotional_credits
BEFORE INSERT ON public.ai_usage_events
FOR EACH ROW EXECUTE FUNCTION public.reserve_ai_usage_promotional_credits();

CREATE OR REPLACE FUNCTION public.restore_ai_usage_promotional_credits()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF coalesce(OLD.refunded, false) = false
     AND coalesce(NEW.refunded, false) = true
     AND coalesce(NEW.promotional_credits_used, 0) > 0 THEN
    UPDATE public.profiles
    SET promotional_credits = promotional_credits + NEW.promotional_credits_used
    WHERE id = NEW.user_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ai_usage_events_restore_promotional_credits ON public.ai_usage_events;
CREATE TRIGGER ai_usage_events_restore_promotional_credits
AFTER UPDATE OF refunded ON public.ai_usage_events
FOR EACH ROW EXECUTE FUNCTION public.restore_ai_usage_promotional_credits();

REVOKE ALL ON FUNCTION public.reserve_generation_promotional_credits() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.restore_generation_promotional_credits() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reserve_ai_usage_promotional_credits() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.restore_ai_usage_promotional_credits() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.reserve_creation_credits(
  p_user_id uuid,
  p_cost integer,
  p_reservation_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing public.creation_credit_reservations%ROWTYPE;
  v_credits integer;
  v_promotional_credits integer;
  v_promotional_used integer;
BEGIN
  IF p_user_id IS NULL
     OR p_cost IS NULL
     OR p_cost < 0
     OR nullif(btrim(coalesce(p_reservation_key, '')), '') IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid_request');
  END IF;

  SELECT * INTO v_existing
  FROM public.creation_credit_reservations
  WHERE user_id = p_user_id
    AND reservation_key = btrim(p_reservation_key)
  FOR UPDATE;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'status', CASE WHEN v_existing.status = 'reserved' THEN 'already_reserved' ELSE 'key_already_used' END,
      'reservation_id', v_existing.id,
      'cost', v_existing.credits,
      'promotional_credits_used', v_existing.promotional_credits_used
    );
  END IF;

  SELECT credits, promotional_credits
  INTO v_credits, v_promotional_credits
  FROM public.profiles
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'profile_not_found');
  END IF;

  IF v_credits < p_cost THEN
    RETURN jsonb_build_object(
      'status', 'insufficient_credits',
      'remaining_credits', v_credits,
      'required_credits', p_cost
    );
  END IF;

  v_promotional_used := least(p_cost, greatest(v_promotional_credits, 0));

  UPDATE public.profiles
  SET credits = credits - p_cost,
      promotional_credits = promotional_credits - v_promotional_used
  WHERE id = p_user_id
  RETURNING credits, promotional_credits INTO v_credits, v_promotional_credits;

  INSERT INTO public.creation_credit_reservations (
    user_id,
    reservation_key,
    credits,
    promotional_credits_used
  ) VALUES (
    p_user_id,
    btrim(p_reservation_key),
    p_cost,
    v_promotional_used
  )
  RETURNING * INTO v_existing;

  RETURN jsonb_build_object(
    'status', 'reserved',
    'reservation_id', v_existing.id,
    'remaining_credits', v_credits,
    'promotional_credits', v_promotional_credits,
    'cost', p_cost,
    'promotional_credits_used', v_promotional_used
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.refund_creation_credit_reservation(
  p_user_id uuid,
  p_reservation_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_reservation public.creation_credit_reservations%ROWTYPE;
  v_credits integer;
  v_promotional_credits integer;
BEGIN
  SELECT * INTO v_reservation
  FROM public.creation_credit_reservations
  WHERE user_id = p_user_id
    AND reservation_key = btrim(coalesce(p_reservation_key, ''))
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF v_reservation.status = 'refunded' THEN
    RETURN jsonb_build_object(
      'status', 'already_refunded',
      'reservation_id', v_reservation.id
    );
  END IF;

  UPDATE public.profiles
  SET credits = credits + v_reservation.credits,
      promotional_credits = promotional_credits + v_reservation.promotional_credits_used
  WHERE id = p_user_id
  RETURNING credits, promotional_credits INTO v_credits, v_promotional_credits;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile not found for creation credit refund';
  END IF;

  UPDATE public.creation_credit_reservations
  SET status = 'refunded',
      refunded_at = timezone('utc'::text, now())
  WHERE id = v_reservation.id;

  RETURN jsonb_build_object(
    'status', 'refunded',
    'reservation_id', v_reservation.id,
    'remaining_credits', v_credits,
    'promotional_credits', v_promotional_credits,
    'refunded_credits', v_reservation.credits,
    'promotional_credits_restored', v_reservation.promotional_credits_used
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_creation_credits(uuid, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refund_creation_credit_reservation(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_creation_credits(uuid, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.refund_creation_credit_reservation(uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.unlock_marketplace_asset_with_credits(
  p_user_id uuid,
  p_asset_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_asset public.marketplace_assets%ROWTYPE;
  v_credits integer;
  v_promotional_credits integer;
  v_marketplace_credits integer;
  v_order_id uuid;
  v_order_reference text;
  v_payment_reference text;
BEGIN
  SELECT * INTO v_asset
  FROM public.marketplace_assets
  WHERE id = p_asset_id
  FOR UPDATE;

  IF NOT FOUND OR v_asset.status NOT IN ('active', 'unlisted') THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  SELECT credits, promotional_credits
  INTO v_credits, v_promotional_credits
  FROM public.profiles
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'profile_not_found');
  END IF;

  -- Negative promotional credits represent revoked rewards already consumed by
  -- creation. Cap marketplace funds by total credits so that debt never
  -- increases paid purchasing power.
  v_marketplace_credits := greatest(
    0,
    least(v_credits, v_credits - v_promotional_credits)
  );

  IF v_asset.seller_user_id = p_user_id THEN
    RETURN jsonb_build_object(
      'status', 'owned_by_user',
      'remaining_credits', v_credits,
      'marketplace_spendable_credits', v_marketplace_credits,
      'asset_id', v_asset.id,
      'seller_user_id', v_asset.seller_user_id,
      'credit_cost', v_asset.price_usd_cents
    );
  END IF;

  IF v_asset.price_usd_cents <= 0 THEN
    RETURN jsonb_build_object(
      'status', 'not_paid',
      'remaining_credits', v_credits,
      'marketplace_spendable_credits', v_marketplace_credits,
      'asset_id', v_asset.id,
      'seller_user_id', v_asset.seller_user_id,
      'credit_cost', v_asset.price_usd_cents
    );
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.marketplace_purchases
    WHERE asset_id = v_asset.id AND buyer_user_id = p_user_id
  ) THEN
    RETURN jsonb_build_object(
      'status', 'already_owned',
      'remaining_credits', v_credits,
      'marketplace_spendable_credits', v_marketplace_credits,
      'asset_id', v_asset.id,
      'seller_user_id', v_asset.seller_user_id,
      'credit_cost', v_asset.price_usd_cents
    );
  END IF;

  IF v_credits < v_asset.price_usd_cents
     OR v_marketplace_credits < v_asset.price_usd_cents THEN
    RETURN jsonb_build_object(
      'status', 'insufficient_credits',
      'remaining_credits', v_credits,
      'marketplace_spendable_credits', v_marketplace_credits,
      'asset_id', v_asset.id,
      'seller_user_id', v_asset.seller_user_id,
      'credit_cost', v_asset.price_usd_cents
    );
  END IF;

  v_order_reference := 'credits_asset_' || v_asset.id::text || '_' || p_user_id::text;
  v_payment_reference := 'credits_unlock_' || v_asset.id::text || '_' || p_user_id::text;

  INSERT INTO public.marketplace_orders (
    asset_id, buyer_user_id, razorpay_order_id, razorpay_payment_id,
    amount_subunits, currency, status
  ) VALUES (
    v_asset.id, p_user_id, v_order_reference, v_payment_reference,
    v_asset.price_usd_cents, 'USD', 'paid'
  )
  ON CONFLICT (razorpay_order_id) DO UPDATE
  SET razorpay_payment_id = EXCLUDED.razorpay_payment_id,
      amount_subunits = EXCLUDED.amount_subunits,
      currency = EXCLUDED.currency,
      status = 'paid',
      updated_at = timezone('utc'::text, now())
  RETURNING id INTO v_order_id;

  INSERT INTO public.marketplace_purchases (
    asset_id, buyer_user_id, order_id, price_usd_cents, amount_subunits, currency
  ) VALUES (
    v_asset.id, p_user_id, v_order_id,
    v_asset.price_usd_cents, v_asset.price_usd_cents, 'USD'
  );

  UPDATE public.profiles
  SET credits = credits - v_asset.price_usd_cents
  WHERE id = p_user_id;

  UPDATE public.marketplace_assets
  SET sales_count = sales_count + 1,
      earnings_usd_cents = earnings_usd_cents + v_asset.price_usd_cents,
      updated_at = timezone('utc'::text, now())
  WHERE id = v_asset.id;

  RETURN jsonb_build_object(
    'status', 'completed',
    'remaining_credits', v_credits - v_asset.price_usd_cents,
    'marketplace_spendable_credits', v_marketplace_credits - v_asset.price_usd_cents,
    'asset_id', v_asset.id,
    'seller_user_id', v_asset.seller_user_id,
    'credit_cost', v_asset.price_usd_cents
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.unlock_post_resource_bundle_with_credits(
  p_user_id uuid,
  p_post_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_bundle public.post_resource_bundles%ROWTYPE;
  v_credits integer;
  v_promotional_credits integer;
  v_marketplace_credits integer;
  v_order_id uuid;
  v_order_reference text;
  v_payment_reference text;
BEGIN
  SELECT * INTO v_bundle
  FROM public.post_resource_bundles
  WHERE post_id = p_post_id
  FOR UPDATE;

  IF NOT FOUND OR v_bundle.status <> 'published' THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  SELECT credits, promotional_credits
  INTO v_credits, v_promotional_credits
  FROM public.profiles
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'profile_not_found');
  END IF;

  v_marketplace_credits := greatest(
    0,
    least(v_credits, v_credits - v_promotional_credits)
  );

  IF v_bundle.owner_user_id = p_user_id THEN
    RETURN jsonb_build_object(
      'status', 'owned_by_user',
      'remaining_credits', v_credits,
      'marketplace_spendable_credits', v_marketplace_credits,
      'post_id', v_bundle.post_id,
      'bundle_id', v_bundle.id,
      'owner_user_id', v_bundle.owner_user_id,
      'credit_cost', v_bundle.price_usd_cents
    );
  END IF;

  IF v_bundle.access_mode <> 'paid' OR v_bundle.price_usd_cents <= 0 THEN
    RETURN jsonb_build_object(
      'status', 'not_paid',
      'remaining_credits', v_credits,
      'marketplace_spendable_credits', v_marketplace_credits,
      'post_id', v_bundle.post_id,
      'bundle_id', v_bundle.id,
      'owner_user_id', v_bundle.owner_user_id,
      'credit_cost', v_bundle.price_usd_cents
    );
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.post_resource_bundle_purchases
    WHERE bundle_id = v_bundle.id AND buyer_user_id = p_user_id
  ) THEN
    RETURN jsonb_build_object(
      'status', 'already_owned',
      'remaining_credits', v_credits,
      'marketplace_spendable_credits', v_marketplace_credits,
      'post_id', v_bundle.post_id,
      'bundle_id', v_bundle.id,
      'owner_user_id', v_bundle.owner_user_id,
      'credit_cost', v_bundle.price_usd_cents
    );
  END IF;

  IF v_credits < v_bundle.price_usd_cents
     OR v_marketplace_credits < v_bundle.price_usd_cents THEN
    RETURN jsonb_build_object(
      'status', 'insufficient_credits',
      'remaining_credits', v_credits,
      'marketplace_spendable_credits', v_marketplace_credits,
      'post_id', v_bundle.post_id,
      'bundle_id', v_bundle.id,
      'owner_user_id', v_bundle.owner_user_id,
      'credit_cost', v_bundle.price_usd_cents
    );
  END IF;

  v_order_reference := 'credits_bundle_' || v_bundle.id::text || '_' || p_user_id::text;
  v_payment_reference := 'credits_unlock_' || v_bundle.id::text || '_' || p_user_id::text;

  INSERT INTO public.post_resource_bundle_orders (
    bundle_id, buyer_user_id, razorpay_order_id, razorpay_payment_id,
    amount_subunits, currency, status
  ) VALUES (
    v_bundle.id, p_user_id, v_order_reference, v_payment_reference,
    v_bundle.price_usd_cents, 'USD', 'paid'
  )
  ON CONFLICT (razorpay_order_id) DO UPDATE
  SET razorpay_payment_id = EXCLUDED.razorpay_payment_id,
      amount_subunits = EXCLUDED.amount_subunits,
      currency = EXCLUDED.currency,
      status = 'paid',
      updated_at = timezone('utc'::text, now())
  RETURNING id INTO v_order_id;

  INSERT INTO public.post_resource_bundle_purchases (
    bundle_id, buyer_user_id, order_id, price_usd_cents, amount_subunits, currency
  ) VALUES (
    v_bundle.id, p_user_id, v_order_id,
    v_bundle.price_usd_cents, v_bundle.price_usd_cents, 'USD'
  );

  UPDATE public.profiles
  SET credits = credits - v_bundle.price_usd_cents
  WHERE id = p_user_id;

  UPDATE public.post_resource_bundles
  SET sales_count = sales_count + 1,
      earnings_usd_cents = earnings_usd_cents + v_bundle.price_usd_cents,
      updated_at = timezone('utc'::text, now())
  WHERE id = v_bundle.id;

  RETURN jsonb_build_object(
    'status', 'completed',
    'remaining_credits', v_credits - v_bundle.price_usd_cents,
    'marketplace_spendable_credits', v_marketplace_credits - v_bundle.price_usd_cents,
    'post_id', v_bundle.post_id,
    'bundle_id', v_bundle.id,
    'owner_user_id', v_bundle.owner_user_id,
    'credit_cost', v_bundle.price_usd_cents
  );
END;
$$;

REVOKE ALL ON FUNCTION public.unlock_marketplace_asset_with_credits(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.unlock_post_resource_bundle_with_credits(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.unlock_marketplace_asset_with_credits(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.unlock_post_resource_bundle_with_credits(uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.reconcile_credit_purchase_adjustment(
  p_transaction_id uuid,
  p_provider text,
  p_provider_event_id text,
  p_cumulative_reversed_subunits bigint,
  p_action text,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_transaction public.transactions%ROWTYPE;
  v_provider text := lower(btrim(coalesce(p_provider, '')));
  v_action text := lower(btrim(coalesce(p_action, '')));
  v_previous_reversed_credits integer;
  v_target_reversed_credits integer;
  v_credit_delta integer;
  v_balance integer;
  v_settlement jsonb;
  v_referral_adjustment jsonb := jsonb_build_object('status', 'not_settled', 'rewards', '[]'::jsonb);
  v_status text;
BEGIN
  IF p_transaction_id IS NULL
     OR v_provider NOT IN ('razorpay', 'revenuecat')
     OR nullif(btrim(coalesce(p_provider_event_id, '')), '') IS NULL
     OR p_cumulative_reversed_subunits IS NULL
     OR p_cumulative_reversed_subunits < 0
     OR v_action NOT IN ('reverse', 'restore')
     OR nullif(btrim(coalesce(p_reason, '')), '') IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid_request', 'rewards', '[]'::jsonb);
  END IF;

  SELECT * INTO v_transaction
  FROM public.transactions
  WHERE id = p_transaction_id
  FOR UPDATE;

  IF NOT FOUND OR v_transaction.amount <= 0 OR v_transaction.credits <= 0 THEN
    RETURN jsonb_build_object('status', 'transaction_not_found', 'rewards', '[]'::jsonb);
  END IF;

  IF p_cumulative_reversed_subunits > v_transaction.amount THEN
    RETURN jsonb_build_object('status', 'invalid_amount', 'rewards', '[]'::jsonb);
  END IF;

  -- Refund/dispute snapshots are monotonic. A delayed smaller snapshot cannot
  -- restore value; only an explicit provider-verified restore/won event may do
  -- that. Conversely a restore event may not increase the reversed target.
  IF (v_action = 'reverse'
      AND p_cumulative_reversed_subunits < v_transaction.credit_reversed_amount_subunits)
     OR (v_action = 'restore'
      AND p_cumulative_reversed_subunits > v_transaction.credit_reversed_amount_subunits) THEN
    RETURN jsonb_build_object('status', 'stale_event', 'rewards', '[]'::jsonb);
  END IF;

  IF (v_provider = 'razorpay' AND v_transaction.mobile_product_id IS NOT NULL)
     OR (v_provider = 'revenuecat' AND v_transaction.mobile_product_id IS NULL) THEN
    RETURN jsonb_build_object('status', 'provider_mismatch', 'rewards', '[]'::jsonb);
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.credit_purchase_adjustments
    WHERE provider = v_provider
      AND provider_event_id = btrim(p_provider_event_id)
  ) THEN
    RETURN jsonb_build_object('status', 'duplicate_event', 'rewards', '[]'::jsonb);
  END IF;

  -- Record/grant the verified purchase before changing its active state. This
  -- ensures an immediate refund still permanently consumes the invitee's one
  -- first-purchase bonus slot, then reverses that bonus in the same transaction.
  IF v_transaction.status = 'success'
     AND coalesce(v_transaction.credit_effect_applied, false) THEN
    v_settlement := public.settle_referral_purchase_rewards(p_transaction_id);
  END IF;

  v_previous_reversed_credits := v_transaction.credit_reversed_credits;
  v_target_reversed_credits := CASE
    WHEN p_cumulative_reversed_subunits = v_transaction.amount THEN v_transaction.credits
    ELSE floor(
      v_transaction.credits::numeric
      * p_cumulative_reversed_subunits::numeric
      / v_transaction.amount::numeric
    )::integer
  END;
  v_credit_delta := v_target_reversed_credits - v_previous_reversed_credits;

  IF v_credit_delta <> 0 THEN
    UPDATE public.profiles
    SET credits = credits - v_credit_delta
    WHERE id = v_transaction.user_id
    RETURNING credits INTO v_balance;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'profile not found for purchase adjustment';
    END IF;

    v_referral_adjustment := public.reconcile_referral_purchase_reward_adjustment(
      p_transaction_id,
      CASE WHEN v_credit_delta > 0 THEN 'reverse' ELSE 'restore' END,
      abs(v_credit_delta),
      v_provider || ':' || btrim(p_provider_event_id),
      p_reason
    );
    SELECT credits INTO v_balance
    FROM public.profiles
    WHERE id = v_transaction.user_id;
  ELSE
    SELECT credits INTO v_balance
    FROM public.profiles
    WHERE id = v_transaction.user_id;
  END IF;

  INSERT INTO public.credit_purchase_adjustments (
    transaction_id,
    provider,
    provider_event_id,
    reason,
    previous_reversed_amount_subunits,
    target_reversed_amount_subunits,
    previous_reversed_credits,
    target_reversed_credits,
    base_credit_delta
  ) VALUES (
    p_transaction_id,
    v_provider,
    btrim(p_provider_event_id),
    left(btrim(p_reason), 200),
    v_transaction.credit_reversed_amount_subunits,
    p_cumulative_reversed_subunits,
    v_previous_reversed_credits,
    v_target_reversed_credits,
    -v_credit_delta
  );

  v_status := CASE
    WHEN v_credit_delta = 0 THEN 'no_change'
    WHEN v_target_reversed_credits = 0 THEN 'restored'
    WHEN v_target_reversed_credits = v_transaction.credits THEN 'reversed'
    WHEN v_credit_delta > 0 THEN 'partially_reversed'
    ELSE 'partially_restored'
  END;

  UPDATE public.transactions
  SET credit_reversed_amount_subunits = p_cumulative_reversed_subunits,
      credit_reversed_credits = v_target_reversed_credits,
      status = CASE
        WHEN v_target_reversed_credits = credits THEN 'refunded'
        ELSE 'success'
      END,
      credit_effect_applied = v_target_reversed_credits < credits,
      refunded_at = CASE
        WHEN v_target_reversed_credits = credits THEN timezone('utc'::text, now())
        ELSE NULL
      END,
      updated_at = timezone('utc'::text, now())
  WHERE id = p_transaction_id;

  RETURN jsonb_build_object(
    'status', v_status,
    'transaction_id', p_transaction_id,
    'base_credit_delta', -v_credit_delta,
    'active_base_credits', v_transaction.credits - v_target_reversed_credits,
    'remaining_credits', v_balance,
    'rewards', coalesce(v_referral_adjustment -> 'rewards', '[]'::jsonb)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.reconcile_razorpay_credit_purchase_adjustment(
  p_transaction_id uuid,
  p_provider_event_id text,
  p_cumulative_reversed_subunits bigint,
  p_action text,
  p_reason text
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.reconcile_credit_purchase_adjustment(
    p_transaction_id,
    'razorpay',
    p_provider_event_id,
    p_cumulative_reversed_subunits,
    p_action,
    p_reason
  );
$$;

REVOKE ALL ON FUNCTION public.reconcile_credit_purchase_adjustment(uuid, text, text, bigint, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reconcile_razorpay_credit_purchase_adjustment(uuid, text, bigint, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_credit_purchase_adjustment(uuid, text, text, bigint, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_razorpay_credit_purchase_adjustment(uuid, text, bigint, text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.reconcile_mobile_credit_purchase_adjustment(
  p_external_order_id text,
  p_user_id uuid,
  p_product_id text,
  p_event_id text,
  p_event_timestamp_ms bigint,
  p_action text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_transaction public.transactions%ROWTYPE;
  v_event_time timestamptz;
  v_adjustment jsonb;
BEGIN
  IF p_action NOT IN ('refund', 'restore')
    OR p_external_order_id IS NULL
    OR p_external_order_id NOT LIKE 'mobile\_%' ESCAPE '\'
    OR p_product_id IS NULL
    OR p_product_id NOT LIKE 'magicbooklet.credits.%'
    OR nullif(btrim(coalesce(p_event_id, '')), '') IS NULL
    OR p_event_timestamp_ms IS NULL
    OR p_event_timestamp_ms <= 0
  THEN
    RAISE EXCEPTION 'invalid mobile credit refund event';
  END IF;

  SELECT * INTO v_transaction
  FROM public.transactions
  WHERE razorpay_order_id = p_external_order_id
    AND user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found', 'rewards', '[]'::jsonb);
  END IF;

  IF v_transaction.mobile_product_id IS NOT NULL
     AND v_transaction.mobile_product_id <> p_product_id THEN
    RETURN jsonb_build_object('status', 'identity_mismatch', 'rewards', '[]'::jsonb);
  END IF;

  IF v_transaction.revenuecat_event_timestamp_ms IS NOT NULL
     AND p_event_timestamp_ms < v_transaction.revenuecat_event_timestamp_ms THEN
    RETURN jsonb_build_object('status', 'stale_event', 'rewards', '[]'::jsonb);
  END IF;

  IF v_transaction.revenuecat_event_id = p_event_id THEN
    RETURN jsonb_build_object('status', 'duplicate_event', 'rewards', '[]'::jsonb);
  END IF;

  v_event_time := to_timestamp(p_event_timestamp_ms / 1000.0);
  v_adjustment := public.reconcile_credit_purchase_adjustment(
    v_transaction.id,
    'revenuecat',
    p_event_id,
    CASE WHEN p_action = 'refund' THEN v_transaction.amount ELSE 0 END,
    CASE WHEN p_action = 'refund' THEN 'reverse' ELSE 'restore' END,
    CASE WHEN p_action = 'refund' THEN 'mobile_refund' ELSE 'mobile_uncancellation' END
  );

  IF v_adjustment ->> 'status' IN ('invalid_request', 'transaction_not_found', 'provider_mismatch', 'invalid_amount') THEN
    RETURN v_adjustment;
  END IF;

  UPDATE public.transactions
  SET mobile_product_id = coalesce(mobile_product_id, p_product_id),
      revenuecat_event_id = p_event_id,
      revenuecat_event_timestamp_ms = p_event_timestamp_ms,
      refunded_at = CASE
        WHEN p_action = 'refund' THEN v_event_time
        ELSE refunded_at
      END,
      updated_at = timezone('utc'::text, now())
  WHERE id = v_transaction.id;

  IF p_action = 'refund' THEN
    RETURN jsonb_set(
      v_adjustment,
      '{status}',
      to_jsonb(CASE
        WHEN v_adjustment ->> 'status' IN ('no_change', 'duplicate_event') THEN 'already_refunded'
        ELSE 'refunded'
      END)
    );
  END IF;

  RETURN jsonb_set(
    v_adjustment,
    '{status}',
    to_jsonb(CASE
      WHEN v_adjustment ->> 'status' IN ('no_change', 'duplicate_event') THEN 'already_active'
      ELSE 'restored'
    END)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.reconcile_mobile_credit_refund(
  p_external_order_id text,
  p_user_id uuid,
  p_product_id text,
  p_event_id text,
  p_event_timestamp_ms bigint,
  p_action text
)
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.reconcile_mobile_credit_purchase_adjustment(
    p_external_order_id,
    p_user_id,
    p_product_id,
    p_event_id,
    p_event_timestamp_ms,
    p_action
  ) ->> 'status';
$$;

REVOKE ALL ON FUNCTION public.reconcile_mobile_credit_purchase_adjustment(text, uuid, text, text, bigint, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reconcile_mobile_credit_refund(text, uuid, text, text, bigint, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_mobile_credit_purchase_adjustment(text, uuid, text, text, bigint, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_mobile_credit_refund(text, uuid, text, text, bigint, text) TO service_role;

-- Ordinary (non-template) provider submissions can fail after start_generation
-- has atomically reserved credits but before a provider task id is attached.
-- Settle that state by generation id so total and promotional credits are
-- restored in the same transaction (the promotional-credit trigger above
-- restores the exact source amount when refunded flips to true).
CREATE OR REPLACE FUNCTION public.settle_generation_start_failed(
  p_generation_id uuid,
  p_error_message text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_generation public.generations%ROWTYPE;
  v_remaining_credits integer;
  v_refunded boolean := false;
BEGIN
  IF p_generation_id IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid_request');
  END IF;

  SELECT * INTO v_generation
  FROM public.generations
  WHERE id = p_generation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'missing');
  END IF;

  IF v_generation.prediction_id IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'provider_task_attached', 'generation_id', v_generation.id);
  END IF;

  IF v_generation.status = 'succeeded' THEN
    RETURN jsonb_build_object('status', 'already_succeeded', 'generation_id', v_generation.id);
  END IF;

  SELECT credits INTO v_remaining_credits
  FROM public.profiles
  WHERE id = v_generation.user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'profile_not_found');
  END IF;

  IF NOT coalesce(v_generation.refunded, false) THEN
    UPDATE public.profiles
    SET credits = credits + greatest(0, coalesce(v_generation.cost, 0))
    WHERE id = v_generation.user_id
    RETURNING credits INTO v_remaining_credits;
    v_refunded := true;
  END IF;

  UPDATE public.generations
  SET status = 'failed',
      error_message = left(coalesce(nullif(btrim(p_error_message), ''), 'The generation provider could not accept this request.'), 500),
      completed_at = coalesce(completed_at, timezone('utc'::text, now())),
      refunded = true,
      client_request_key_hash = NULL
  WHERE id = v_generation.id;

  RETURN jsonb_build_object(
    'status', CASE WHEN v_refunded THEN 'failed' ELSE 'already_failed' END,
    'generation_id', v_generation.id,
    'refunded', v_refunded OR coalesce(v_generation.refunded, false),
    'remaining_credits', v_remaining_credits
  );
END;
$$;

REVOKE ALL ON FUNCTION public.settle_generation_start_failed(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.settle_generation_start_failed(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.settle_generation_start_failed(uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.settle_generation_start_failed(uuid, text) TO service_role;

ALTER TABLE public.mobile_notifications
  DROP CONSTRAINT IF EXISTS mobile_notifications_type_check;
ALTER TABLE public.mobile_notifications
  ADD CONSTRAINT mobile_notifications_type_check
  CHECK (type IN (
    'generation_succeeded',
    'generation_failed',
    'credits_purchased',
    'purchases_restored',
    'marketplace_unlocked',
    'post_resource_unlocked',
    'creator_followed',
    'post_saved',
    'post_remixed',
    'post_shared',
    'referral_reward_earned',
    'referral_reward_reversed'
  ));
