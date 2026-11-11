-- Invite codes a person can say (owner, 2026-11-11: "suppose we can give a unique code
-- instead of the link"). Every invite keeps its link code (`code`, twelve hex characters)
-- and gains a six-character code from an alphabet without look-alikes (no 0/O, no 1/I),
-- which the Invite & Earn screens show and the sign-up pages accept. A visit recorded
-- from a typed code has kind 'code' and replaces any invite the browser or phone held
-- before, unless it is the same invite: typing a code is a choice the person made.

-- 1. The short code ---------------------------------------------------------------------

CREATE FUNCTION public.new_referral_short_code()
RETURNS text
LANGUAGE plpgsql
VOLATILE
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  -- 32 characters, so each random byte maps evenly (256 = 8 x 32).
  v_alphabet constant text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  v_bytes bytea := gen_random_bytes(6);
  v_code text := '';
  v_index integer;
BEGIN
  FOR v_index IN 0..5 LOOP
    v_code := v_code || substr(v_alphabet, (get_byte(v_bytes, v_index) % 32) + 1, 1);
  END LOOP;
  RETURN v_code;
END;
$$;

REVOKE ALL ON FUNCTION public.new_referral_short_code() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.new_referral_short_code() TO service_role;

ALTER TABLE public.referral_codes
  ADD COLUMN short_code text
    CONSTRAINT referral_codes_short_code_check
    CHECK (short_code ~ '^[2-9A-HJ-NP-Z]{6}$');

CREATE UNIQUE INDEX referral_codes_short_code_key
  ON public.referral_codes (short_code);

COMMENT ON COLUMN public.referral_codes.short_code IS
  'Six-character invite code a person can type (no 0/O or 1/I); the link code stays in code.';

-- Every invite made so far gets one; a rare collision draws again.
DO $$
DECLARE
  v_row record;
  v_attempt integer;
BEGIN
  FOR v_row IN
    SELECT id FROM public.referral_codes WHERE short_code IS NULL ORDER BY created_at, id
  LOOP
    FOR v_attempt IN 1..20 LOOP
      BEGIN
        UPDATE public.referral_codes
        SET short_code = public.new_referral_short_code()
        WHERE id = v_row.id;
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        IF v_attempt = 20 THEN
          RAISE;
        END IF;
      END;
    END LOOP;
  END LOOP;
END;
$$;

-- New invites draw theirs as they are made; ensure_referral_code already retries a
-- unique violation, which now covers this column too.
ALTER TABLE public.referral_codes
  ALTER COLUMN short_code SET DEFAULT public.new_referral_short_code(),
  ALTER COLUMN short_code SET NOT NULL;

-- 2. A visit can come from a typed code --------------------------------------------------

ALTER TABLE public.referral_visits
  DROP CONSTRAINT referral_visits_kind_check,
  ADD CONSTRAINT referral_visits_kind_check
    CHECK (kind IN ('invite', 'shared_link', 'code'));

-- 3. The invite's code, short code included --------------------------------------------

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
      'short_code', v_code.short_code,
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
        'short_code', v_code.short_code,
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
          'short_code', v_code.short_code,
          'enabled', v_code.is_enabled
        );
      END IF;
    END;
  END LOOP;

  RAISE EXCEPTION 'could not allocate a unique referral code';
END;
$$;

-- 4. The Invite & Earn dashboard names the short code -----------------------------------

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
      'shortCode', v_code ->> 'short_code',
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

-- 5. Recording a visit: a link code or a typed code ------------------------------------

CREATE OR REPLACE FUNCTION public.create_referral_visit(
  p_code text,
  p_channel text,
  p_destination_path text DEFAULT NULL,
  p_existing_visit_token uuid DEFAULT NULL,
  p_ip_hash text DEFAULT NULL,
  p_user_agent_hash text DEFAULT NULL,
  p_device_hash text DEFAULT NULL,
  p_kind text DEFAULT 'invite'
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
  v_kind text := coalesce(nullif(btrim(p_kind), ''), 'invite');
  v_requested text := btrim(coalesce(p_code, ''));
  v_requested_code_id uuid;
  v_keep boolean := false;
BEGIN
  IF lower(btrim(coalesce(p_channel, ''))) NOT IN ('web', 'native')
     OR nullif(lower(btrim(coalesce(p_code, ''))), '') IS NULL
     OR v_kind NOT IN ('invite', 'shared_link', 'code')
     OR (p_ip_hash IS NOT NULL AND p_ip_hash !~ '^[a-f0-9]{64}$')
     OR (p_user_agent_hash IS NOT NULL AND p_user_agent_hash !~ '^[a-f0-9]{64}$')
     OR (p_device_hash IS NOT NULL AND p_device_hash !~ '^[a-f0-9]{64}$') THEN
    RETURN jsonb_build_object('status', 'invalid_request');
  END IF;

  -- The invite asked for: its link code, or the six-character code a person
  -- types (case does not matter). Null when neither names an enabled invite.
  SELECT id INTO v_requested_code_id
  FROM public.referral_codes
  WHERE (code = lower(v_requested) OR short_code = upper(v_requested))
    AND is_enabled = true;

  -- A code someone typed is a choice they made: a wrong one is said at once,
  -- never answered by an invite kept from before.
  IF v_kind = 'code' AND v_requested_code_id IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid_code');
  END IF;

  IF p_existing_visit_token IS NOT NULL THEN
    SELECT visits.*, codes.code AS referral_code, codes.short_code AS referral_short_code INTO v_existing
    FROM public.referral_visits AS visits
    JOIN public.referral_codes AS codes ON codes.id = visits.referral_code_id
    WHERE visits.public_token = p_existing_visit_token
      AND visits.claimed_at IS NULL
      AND visits.expires_at > timezone('utc'::text, now())
      AND codes.is_enabled = true;

    v_keep := FOUND;

    -- Someone who followed a shared post and then opens a friend's invite link
    -- chose that friend: the invite replaces the shared link's visit. A code
    -- typed in replaces any other invite, since typing it is a choice. Two
    -- invite links, or a shared link after anything, keep the first.
    IF v_keep
       AND v_existing.referral_code_id IS DISTINCT FROM v_requested_code_id
       AND (v_kind = 'code' OR (v_kind = 'invite' AND v_existing.kind = 'shared_link')) THEN
      v_keep := false;
    END IF;

    IF v_keep THEN
      -- A visit kept from before the device digest existed learns it now.
      IF p_device_hash IS NOT NULL AND v_existing.device_hash IS NULL THEN
        UPDATE public.referral_visits
        SET device_hash = p_device_hash
        WHERE id = v_existing.id;
      END IF;

      RETURN jsonb_build_object(
        'status', 'preserved',
        'code', v_existing.referral_code,
        'short_code', v_existing.referral_short_code,
        'visit_token', v_existing.public_token,
        'expires_at', v_existing.expires_at,
        'destination_path', v_existing.destination_path
      );
    END IF;
  END IF;

  SELECT * INTO v_code
  FROM public.referral_codes
  WHERE id = v_requested_code_id;

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
    device_hash,
    kind,
    expires_at
  ) VALUES (
    v_code.id,
    v_program.id,
    v_code.user_id,
    lower(btrim(p_channel)),
    nullif(left(btrim(coalesce(p_destination_path, '')), 2048), ''),
    p_ip_hash,
    p_user_agent_hash,
    p_device_hash,
    v_kind,
    timezone('utc'::text, now()) + make_interval(days => v_program.attribution_window_days)
  )
  RETURNING * INTO v_visit;

  RETURN jsonb_build_object(
    'status', 'created',
    'code', v_code.code,
    'short_code', v_code.short_code,
    'visit_token', v_visit.public_token,
    'expires_at', v_visit.expires_at,
    'destination_path', v_visit.destination_path
  );
END;
$$;

REVOKE ALL ON FUNCTION public.ensure_referral_code(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_referral_code(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.get_referral_dashboard(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_referral_dashboard(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.create_referral_visit(text, text, text, uuid, text, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_referral_visit(text, text, text, uuid, text, text, text, text)
  TO service_role;
