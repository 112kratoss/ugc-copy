-- Invite & Earn: the abuse guard, the operator's controls and signal retention.
--
-- The program pays on a friend's paid top-up, so every abuse of it is one
-- person collecting both sides: a second account opened through their own link
-- (a standing 5% + 5% on their own purchases), or an account deleted and opened
-- again to count as new. Until now the only checks were "not the same account"
-- and "not an account older than the visit"; the IP and user-agent digests a
-- visit stored were read by nothing, no operator could see or stop a referral,
-- and nothing removed those digests although the Privacy Policy says visit
-- signals go after 90 days (audit of 2026-11-10).
--
-- What this adds:
--
--   * A device signal. A visit records a digest of the installation that opened
--     the link (the app's installation id, the browser's first-party feed id),
--     and public.referral_account_devices records the installations an account
--     used the program from.
--   * A reward state on every attribution. A claim from a device its inviter
--     uses, or one another friend of the same inviter already used, is recorded
--     as 'blocked': the attribution exists, so an operator can see and reverse
--     it, and it pays nothing. Settlement checks again at each purchase, with
--     whatever the accounts' devices show by then.
--   * A re-registration guard. A sign-in identity that had an account before
--     (its digest was recorded when that account was deleted, or when it claimed
--     welcome credits) is not a new account: the claim answers
--     'existing_account'.
--   * Operator controls with an append-only trail: block or unblock one
--     referral, disable or enable an inviter's link.
--   * Retention: prune_referral_risk_signals() clears the digests of visits
--     older than 90 days. The rows stay, so an inviter's visit count does not
--     move.
--
-- A blocked attribution writes no purchase event, so unblocking it lets the
-- hourly reconciliation settle the purchases it skipped.

-- 1. Signals ----------------------------------------------------------------

ALTER TABLE public.referral_visits
  ADD COLUMN device_hash text
    CONSTRAINT referral_visits_device_hash_check
    CHECK (device_hash IS NULL OR device_hash ~ '^[a-f0-9]{64}$');

COMMENT ON COLUMN public.referral_visits.device_hash IS
  'SHA-256 of the installation that opened the link (app installation id or the browser''s feed id). Cleared after 90 days.';

CREATE INDEX referral_visits_signal_retention_idx
  ON public.referral_visits (visited_at)
  WHERE ip_hash IS NOT NULL OR user_agent_hash IS NOT NULL OR device_hash IS NOT NULL;

CREATE TABLE public.referral_account_devices (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_hash text NOT NULL CHECK (device_hash ~ '^[a-f0-9]{64}$'),
  -- The network the device was last seen on, as the visit stores it. A hint for
  -- the operator only, cleared after 90 days without a sighting.
  ip_hash text CHECK (ip_hash IS NULL OR ip_hash ~ '^[a-f0-9]{64}$'),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, device_hash)
);

CREATE INDEX referral_account_devices_device_idx
  ON public.referral_account_devices (device_hash);

ALTER TABLE public.referral_account_devices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.referral_account_devices FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.referral_account_devices TO service_role;

COMMENT ON TABLE public.referral_account_devices IS
  'Installations an account used Invite & Earn from, as digests. Read by the referral abuse guard; goes with the account.';

-- 2. Reward state -----------------------------------------------------------

ALTER TABLE public.referral_attributions
  ADD COLUMN reward_state text NOT NULL DEFAULT 'eligible'
    CONSTRAINT referral_attributions_reward_state_check
    CHECK (reward_state IN ('eligible', 'blocked')),
  ADD COLUMN reward_state_reason text,
  ADD COLUMN reward_state_source text NOT NULL DEFAULT 'system'
    CONSTRAINT referral_attributions_reward_state_source_check
    CHECK (reward_state_source IN ('system', 'operator')),
  ADD COLUMN reward_state_changed_at timestamptz,
  ADD COLUMN risk_flags text[] NOT NULL DEFAULT '{}'::text[],
  ADD CONSTRAINT referral_attributions_blocked_has_reason CHECK (
    reward_state <> 'blocked'
    OR nullif(btrim(coalesce(reward_state_reason, '')), '') IS NOT NULL
  );

COMMENT ON COLUMN public.referral_attributions.reward_state IS
  'eligible: purchases settle rewards. blocked: they settle nothing until an operator unblocks.';
COMMENT ON COLUMN public.referral_attributions.reward_state_source IS
  'system until an operator decides; an operator''s decision is never overwritten by the guard.';
COMMENT ON COLUMN public.referral_attributions.risk_flags IS
  'Hints for the operator that block nothing: shared_device, same_network.';

CREATE INDEX referral_attributions_blocked_idx
  ON public.referral_attributions (attributed_at DESC)
  WHERE reward_state = 'blocked';

CREATE TABLE public.referral_review_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attribution_id uuid REFERENCES public.referral_attributions(id) ON DELETE RESTRICT,
  referral_code_id uuid REFERENCES public.referral_codes(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('block', 'unblock', 'disable_code', 'enable_code')),
  source text NOT NULL CHECK (source IN ('system', 'operator')),
  -- The operator who decided. A real auth user, as on the other admin trails.
  reviewer_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT referral_review_events_one_subject CHECK (
    (action IN ('block', 'unblock') AND attribution_id IS NOT NULL AND referral_code_id IS NULL)
    OR (action IN ('disable_code', 'enable_code') AND referral_code_id IS NOT NULL AND attribution_id IS NULL)
  ),
  CONSTRAINT referral_review_events_operator_has_reviewer CHECK (
    (source = 'operator') = (reviewer_id IS NOT NULL)
  )
);

CREATE INDEX referral_review_events_created_idx
  ON public.referral_review_events (created_at DESC);
CREATE INDEX referral_review_events_attribution_idx
  ON public.referral_review_events (attribution_id, created_at DESC)
  WHERE attribution_id IS NOT NULL;
CREATE INDEX referral_review_events_code_idx
  ON public.referral_review_events (referral_code_id, created_at DESC)
  WHERE referral_code_id IS NOT NULL;
CREATE INDEX referral_review_events_reviewer_idx
  ON public.referral_review_events (reviewer_id)
  WHERE reviewer_id IS NOT NULL;

ALTER TABLE public.referral_review_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.referral_review_events FROM PUBLIC, anon, authenticated;
-- Append-only, enforced twice: a new table is born with every privilege for
-- service_role, so UPDATE and DELETE are revoked, and the trigger refuses them
-- for any role.
REVOKE ALL ON public.referral_review_events FROM service_role;
GRANT SELECT, INSERT ON public.referral_review_events TO service_role;

CREATE TRIGGER referral_review_events_append_only
BEFORE UPDATE OR DELETE ON public.referral_review_events
FOR EACH ROW EXECUTE FUNCTION public.prevent_referral_audit_mutation();

COMMENT ON TABLE public.referral_review_events IS
  'Append-only trail of referral decisions: the guard''s blocks and an operator''s blocks, unblocks and link switches.';

-- 3. Identities that had an account before ----------------------------------

CREATE TABLE public.deleted_account_identity_fingerprints (
  -- The digest alone, as in credit_grant_identity_fingerprints: this row must
  -- outlive the account and stay unlinkable to whoever deleted it.
  fingerprint text PRIMARY KEY CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  first_recorded_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.deleted_account_identity_fingerprints ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.deleted_account_identity_fingerprints FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.deleted_account_identity_fingerprints FROM service_role;
GRANT SELECT, INSERT ON public.deleted_account_identity_fingerprints TO service_role;

COMMENT ON TABLE public.deleted_account_identity_fingerprints IS
  'One-way digests of the sign-in identities of deleted accounts, kept so a re-registration is not treated as a new account by Invite & Earn.';

-- 4. Recording a visit ------------------------------------------------------
--
-- A parameter cannot be added with CREATE OR REPLACE, so the function is
-- dropped and recreated, and its ACL re-issued. The body is the one from
-- 20260712123000 plus the device digest; the server still running the old code
-- calls it with six named arguments, which this signature accepts.

DROP FUNCTION public.create_referral_visit(text, text, text, uuid, text, text);

CREATE FUNCTION public.create_referral_visit(
  p_code text,
  p_channel text,
  p_destination_path text DEFAULT NULL,
  p_existing_visit_token uuid DEFAULT NULL,
  p_ip_hash text DEFAULT NULL,
  p_user_agent_hash text DEFAULT NULL,
  p_device_hash text DEFAULT NULL
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
     OR (p_user_agent_hash IS NOT NULL AND p_user_agent_hash !~ '^[a-f0-9]{64}$')
     OR (p_device_hash IS NOT NULL AND p_device_hash !~ '^[a-f0-9]{64}$') THEN
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
      -- A visit kept from before the device digest existed learns it now.
      IF p_device_hash IS NOT NULL AND v_existing.device_hash IS NULL THEN
        UPDATE public.referral_visits
        SET device_hash = p_device_hash
        WHERE id = v_existing.id;
      END IF;

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
    device_hash,
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

REVOKE ALL ON FUNCTION public.create_referral_visit(text, text, text, uuid, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_referral_visit(text, text, text, uuid, text, text, text)
  TO service_role;

-- 5. An account's devices ---------------------------------------------------

CREATE FUNCTION public.record_referral_account_device(
  p_user_id uuid,
  p_device_hash text,
  p_ip_hash text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Registered accounts only: a guest can neither invite nor be invited.
  IF p_user_id IS NULL
     OR p_device_hash IS NULL
     OR p_device_hash !~ '^[a-f0-9]{64}$'
     OR (p_ip_hash IS NOT NULL AND p_ip_hash !~ '^[a-f0-9]{64}$')
     OR NOT EXISTS (
       SELECT 1 FROM auth.users AS users
       WHERE users.id = p_user_id
         AND NOT coalesce(users.is_anonymous, false)
     ) THEN
    RETURN;
  END IF;

  INSERT INTO public.referral_account_devices AS devices (user_id, device_hash, ip_hash)
  VALUES (p_user_id, p_device_hash, p_ip_hash)
  ON CONFLICT (user_id, device_hash) DO UPDATE
    SET last_seen_at = now(),
        ip_hash = coalesce(excluded.ip_hash, devices.ip_hash);

  -- An account keeps its twenty most recent devices, so the table is bounded
  -- by the number of accounts and not by how often a browser forgets its id.
  DELETE FROM public.referral_account_devices AS devices
  WHERE devices.user_id = p_user_id
    AND devices.device_hash IN (
      SELECT stale.device_hash
      FROM public.referral_account_devices AS stale
      WHERE stale.user_id = p_user_id
      ORDER BY stale.last_seen_at DESC, stale.device_hash ASC
      OFFSET 20
    );
END;
$$;

REVOKE ALL ON FUNCTION public.record_referral_account_device(uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_referral_account_device(uuid, text, text)
  TO service_role;

-- 6. The device digest, in SQL ----------------------------------------------
--
-- The server computes the same digest in src/lib/referral-device.ts; both sides
-- are pinned to one test vector. It is here so the guard can compare a visit
-- with the installations onboarding_events already holds for an account, which
-- covers the app before it sends its installation id with the program's own
-- requests.

CREATE FUNCTION public.referral_device_hash(p_installation_id text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT encode(
    sha256(convert_to('magicbooklet-referral-device-v1:' || p_installation_id, 'UTF8')),
    'hex'
  );
$$;

REVOKE ALL ON FUNCTION public.referral_device_hash(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.referral_device_hash(text) TO service_role;

-- 7. Claiming a visit -------------------------------------------------------
--
-- Dropped and recreated for the new parameter, as above. The body is the one
-- from 20260712123000 with three additions, each marked "Guard".

DROP FUNCTION public.claim_referral_visit(uuid, uuid);

CREATE FUNCTION public.claim_referral_visit(
  p_invitee_user_id uuid,
  p_visit_token uuid,
  p_identity_fingerprints text[] DEFAULT NULL
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
  v_fingerprints text[];
  v_block_reason text;
  v_risk_flags text[] := ARRAY[]::text[];
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

  -- Guard: an identity that had an account before this one is not new. Its
  -- digest was recorded when that account was deleted, or when it claimed a
  -- welcome grant; a digest this account recorded itself is later than its own
  -- creation and does not count. Digests are computed app-side and anything not
  -- shaped like one is discarded. NULL or empty skips the guard, which covers
  -- the server still running the code that passes none.
  v_fingerprints := ARRAY(
    SELECT DISTINCT f
    FROM unnest(coalesce(p_identity_fingerprints, ARRAY[]::text[])) AS f
    WHERE f ~ '^[a-f0-9]{64}$'
  );

  IF cardinality(v_fingerprints) > 0 AND (
    EXISTS (
      SELECT 1
      FROM public.deleted_account_identity_fingerprints AS deleted
      WHERE deleted.fingerprint = ANY (v_fingerprints)
        AND deleted.first_recorded_at < v_auth_created_at
    )
    OR EXISTS (
      SELECT 1
      FROM public.credit_grant_identity_fingerprints AS granted
      WHERE granted.fingerprint = ANY (v_fingerprints)
        AND granted.first_claimed_at < v_auth_created_at
    )
  ) THEN
    RETURN jsonb_build_object('status', 'existing_account');
  END IF;

  -- Guard: whose device is this? The inviter's own (seen using the program, or
  -- signed in to the app on that installation), or one another friend of the
  -- same inviter already used: the referral is recorded and pays nothing. Any
  -- other account on the device, or the inviter's network, is a hint only:
  -- friends share rooms.
  IF v_visit.device_hash IS NOT NULL THEN
    IF EXISTS (
      SELECT 1
      FROM public.referral_account_devices AS devices
      WHERE devices.user_id = v_visit.inviter_user_id
        AND devices.device_hash = v_visit.device_hash
    ) OR EXISTS (
      SELECT 1
      FROM public.onboarding_events AS events
      WHERE events.user_id = v_visit.inviter_user_id
        AND public.referral_device_hash(events.installation_id) = v_visit.device_hash
    ) THEN
      v_block_reason := 'same_device_as_inviter';
    ELSIF EXISTS (
      SELECT 1
      FROM public.referral_account_devices AS devices
      JOIN public.referral_attributions AS attributions
        ON attributions.invitee_user_id = devices.user_id
      WHERE devices.device_hash = v_visit.device_hash
        AND devices.user_id <> p_invitee_user_id
        AND attributions.inviter_user_id = v_visit.inviter_user_id
    ) THEN
      v_block_reason := 'device_reused_by_invitees';
    ELSIF EXISTS (
      SELECT 1
      FROM public.referral_account_devices AS devices
      WHERE devices.device_hash = v_visit.device_hash
        AND devices.user_id <> p_invitee_user_id
    ) THEN
      v_risk_flags := array_append(v_risk_flags, 'shared_device');
    END IF;
  END IF;

  IF v_visit.ip_hash IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.referral_account_devices AS devices
    WHERE devices.user_id = v_visit.inviter_user_id
      AND devices.ip_hash = v_visit.ip_hash
  ) THEN
    v_risk_flags := array_append(v_risk_flags, 'same_network');
  END IF;

  INSERT INTO public.referral_attributions (
    program_id,
    referral_visit_id,
    inviter_user_id,
    invitee_user_id,
    reward_state,
    reward_state_reason,
    reward_state_changed_at,
    risk_flags
  ) VALUES (
    v_visit.program_id,
    v_visit.id,
    v_visit.inviter_user_id,
    p_invitee_user_id,
    CASE WHEN v_block_reason IS NULL THEN 'eligible' ELSE 'blocked' END,
    v_block_reason,
    CASE WHEN v_block_reason IS NULL THEN NULL ELSE now() END,
    v_risk_flags
  )
  RETURNING * INTO v_attribution;

  UPDATE public.referral_visits
  SET claimed_at = v_attribution.attributed_at
  WHERE id = v_visit.id;

  IF v_block_reason IS NOT NULL THEN
    INSERT INTO public.referral_review_events (attribution_id, action, source, reason)
    VALUES (v_attribution.id, 'block', 'system', v_block_reason);
  END IF;

  -- Guard: the device now belongs to this account too, so the next friend who
  -- signs up on it, and settlement, can tell.
  IF v_visit.device_hash IS NOT NULL THEN
    PERFORM public.record_referral_account_device(
      p_invitee_user_id,
      v_visit.device_hash,
      v_visit.ip_hash
    );
  END IF;

  RETURN jsonb_build_object(
    'status', 'claimed',
    'attribution_id', v_attribution.id,
    'program_version', v_program_version,
    'reward_state', v_attribution.reward_state
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

REVOKE ALL ON FUNCTION public.claim_referral_visit(uuid, uuid, text[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_referral_visit(uuid, uuid, text[])
  TO service_role;

-- 8. Settlement -------------------------------------------------------------
--
-- Two statements go into settle_referral_purchase_rewards right after it finds
-- the attribution, and one predicate into the reconciliation's work list. Both
-- functions are patched in place, as 20260928083004 patched the mobile grant,
-- so every earlier change to them is kept and a diff shows these lines only.

DO $migration$
DECLARE
  definition text;
  anchor text := $anchor$  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'no_attribution', 'rewards', v_rewards);
  END IF;
$anchor$;
  guard text := $guard$
  -- A blocked referral pays nothing. No purchase event is written, so the
  -- reconciliation settles this purchase if an operator unblocks it.
  IF v_attribution.reward_state = 'blocked' THEN
    RETURN jsonb_build_object('status', 'attribution_blocked', 'rewards', v_rewards);
  END IF;

  -- The claim saw the devices known that day. By a purchase the two accounts
  -- may have shown one in common: the inviter opened Invite & Earn on the
  -- device the friend signed up on, or both signed in to the app on one
  -- installation. An operator's decision is left alone.
  IF v_attribution.reward_state_source = 'system'
     AND v_attribution.inviter_user_id IS NOT NULL
     AND v_attribution.invitee_user_id IS NOT NULL
     AND (
       EXISTS (
         SELECT 1
         FROM public.referral_account_devices AS inviter_devices
         JOIN public.referral_account_devices AS invitee_devices
           ON invitee_devices.device_hash = inviter_devices.device_hash
         WHERE inviter_devices.user_id = v_attribution.inviter_user_id
           AND invitee_devices.user_id = v_attribution.invitee_user_id
       )
       OR EXISTS (
         SELECT 1
         FROM public.onboarding_events AS inviter_events
         JOIN public.onboarding_events AS invitee_events
           ON invitee_events.installation_id = inviter_events.installation_id
         WHERE inviter_events.user_id = v_attribution.inviter_user_id
           AND invitee_events.user_id = v_attribution.invitee_user_id
       )
     ) THEN
    UPDATE public.referral_attributions
    SET reward_state = 'blocked',
        reward_state_reason = 'same_device_as_inviter',
        reward_state_changed_at = now()
    WHERE id = v_attribution.id;

    INSERT INTO public.referral_review_events (attribution_id, action, source, reason)
    VALUES (v_attribution.id, 'block', 'system', 'same_device_as_inviter');

    RETURN jsonb_build_object('status', 'attribution_blocked', 'rewards', v_rewards);
  END IF;
$guard$;
BEGIN
  SELECT pg_get_functiondef('public.settle_referral_purchase_rewards(uuid)'::regprocedure)
  INTO definition;
  IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one no_attribution return in settle_referral_purchase_rewards';
  END IF;
  EXECUTE replace(definition, anchor, anchor || guard);
END;
$migration$;

DO $migration$
DECLARE
  definition text;
  anchor text := $anchor$    AND events.transaction_id IS NULL
$anchor$;
  guard text := $guard$    AND attributions.reward_state = 'eligible'
$guard$;
BEGIN
  SELECT pg_get_functiondef('public.list_unsettled_referral_purchase_transactions(integer)'::regprocedure)
  INTO definition;
  IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one unsettled-event predicate in list_unsettled_referral_purchase_transactions';
  END IF;
  EXECUTE replace(definition, anchor, anchor || guard);
END;
$migration$;

-- 9. Operator decisions -----------------------------------------------------

CREATE FUNCTION public.set_referral_attribution_reward_state(
  p_attribution_id uuid,
  p_reward_state text,
  p_reason text,
  p_reviewer_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_attribution public.referral_attributions%ROWTYPE;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
BEGIN
  IF p_attribution_id IS NULL OR p_reviewer_id IS NULL
     OR p_reward_state IS NULL OR p_reward_state NOT IN ('eligible', 'blocked') THEN
    RETURN jsonb_build_object('status', 'invalid', 'error', 'referral, state and reviewer are required');
  END IF;

  -- The trail is the only durable answer to "why did my friend's top-up pay
  -- nothing", so a decision without a reason is refused.
  IF v_reason IS NULL OR char_length(v_reason) < 3 OR char_length(v_reason) > 1000 THEN
    RETURN jsonb_build_object('status', 'invalid', 'error', 'a reason of 3 to 1000 characters is required');
  END IF;

  SELECT * INTO v_attribution
  FROM public.referral_attributions
  WHERE id = p_attribution_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  -- A double-submitted form lands here the second time.
  IF v_attribution.reward_state = p_reward_state THEN
    RETURN jsonb_build_object('status', 'unchanged', 'reward_state', v_attribution.reward_state);
  END IF;

  UPDATE public.referral_attributions
  SET reward_state = p_reward_state,
      reward_state_reason = v_reason,
      reward_state_source = 'operator',
      reward_state_changed_at = now()
  WHERE id = p_attribution_id;

  INSERT INTO public.referral_review_events (attribution_id, action, source, reviewer_id, reason)
  VALUES (
    p_attribution_id,
    CASE WHEN p_reward_state = 'blocked' THEN 'block' ELSE 'unblock' END,
    'operator',
    p_reviewer_id,
    v_reason
  );

  RETURN jsonb_build_object('status', 'updated', 'reward_state', p_reward_state);
END;
$$;

REVOKE ALL ON FUNCTION public.set_referral_attribution_reward_state(uuid, text, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_referral_attribution_reward_state(uuid, text, text, uuid)
  TO service_role;

CREATE FUNCTION public.set_referral_code_enabled(
  p_referral_code_id uuid,
  p_enabled boolean,
  p_reason text,
  p_reviewer_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_code public.referral_codes%ROWTYPE;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
BEGIN
  IF p_referral_code_id IS NULL OR p_reviewer_id IS NULL OR p_enabled IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid', 'error', 'link, switch and reviewer are required');
  END IF;

  IF v_reason IS NULL OR char_length(v_reason) < 3 OR char_length(v_reason) > 1000 THEN
    RETURN jsonb_build_object('status', 'invalid', 'error', 'a reason of 3 to 1000 characters is required');
  END IF;

  SELECT * INTO v_code
  FROM public.referral_codes
  WHERE id = p_referral_code_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  -- A deleted account's link stays off: there is nobody left to pay.
  IF v_code.user_id IS NULL THEN
    RETURN jsonb_build_object('status', 'account_deleted');
  END IF;

  IF v_code.is_enabled = p_enabled THEN
    RETURN jsonb_build_object('status', 'unchanged', 'enabled', v_code.is_enabled);
  END IF;

  UPDATE public.referral_codes
  SET is_enabled = p_enabled,
      disabled_reason = CASE WHEN p_enabled THEN NULL ELSE left(v_reason, 200) END
  WHERE id = p_referral_code_id;

  INSERT INTO public.referral_review_events (referral_code_id, action, source, reviewer_id, reason)
  VALUES (
    p_referral_code_id,
    CASE WHEN p_enabled THEN 'enable_code' ELSE 'disable_code' END,
    'operator',
    p_reviewer_id,
    v_reason
  );

  RETURN jsonb_build_object('status', 'updated', 'enabled', p_enabled);
END;
$$;

REVOKE ALL ON FUNCTION public.set_referral_code_enabled(uuid, boolean, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_referral_code_enabled(uuid, boolean, text, uuid)
  TO service_role;

-- 10. Retention -------------------------------------------------------------
--
-- The Privacy Policy: "Short-lived visit signals are normally removed or
-- aggregated after 90 days". A claim can only use a visit for its 30-day
-- window, so nothing reads these digests after that. One bounded batch a call,
-- like the other supplementary prunes; the retention job calls again while a
-- batch comes back full.

CREATE FUNCTION public.prune_referral_risk_signals(p_limit integer DEFAULT 5000)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_limit integer := greatest(1, least(coalesce(p_limit, 5000), 5000));
  v_visits integer := 0;
  v_devices integer := 0;
BEGIN
  WITH due AS (
    SELECT visits.id
    FROM public.referral_visits AS visits
    WHERE visits.visited_at < now() - interval '90 days'
      AND (visits.ip_hash IS NOT NULL
        OR visits.user_agent_hash IS NOT NULL
        OR visits.device_hash IS NOT NULL)
    ORDER BY visits.visited_at ASC
    LIMIT v_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.referral_visits AS visits
  SET ip_hash = NULL,
      user_agent_hash = NULL,
      device_hash = NULL
  FROM due
  WHERE visits.id = due.id;
  GET DIAGNOSTICS v_visits = ROW_COUNT;

  -- The device stays known to its account; the network it was last seen on is
  -- the short-lived part.
  WITH due AS (
    SELECT devices.user_id, devices.device_hash
    FROM public.referral_account_devices AS devices
    WHERE devices.ip_hash IS NOT NULL
      AND devices.last_seen_at < now() - interval '90 days'
    ORDER BY devices.last_seen_at ASC
    LIMIT v_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.referral_account_devices AS devices
  SET ip_hash = NULL
  FROM due
  WHERE devices.user_id = due.user_id
    AND devices.device_hash = due.device_hash;
  GET DIAGNOSTICS v_devices = ROW_COUNT;

  RETURN v_visits + v_devices;
END;
$$;

REVOKE ALL ON FUNCTION public.prune_referral_risk_signals(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_referral_risk_signals(integer)
  TO service_role;

-- A deleted inviter's visits lose the new digest with the old ones.
CREATE OR REPLACE FUNCTION public.cancel_deleted_account_referrals()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE public.referral_codes SET is_enabled = false, disabled_reason = 'account_deleted'
    WHERE user_id = OLD.id;
  UPDATE public.referral_visits
    SET ip_hash = NULL, user_agent_hash = NULL, device_hash = NULL, destination_path = NULL
    WHERE inviter_user_id = OLD.id;
  -- A deleted beneficiary has no delivery destination. Completion is durable,
  -- so queued history cannot become an endless FK-error retry after detachment.
  UPDATE public.referral_reward_notification_outbox q
    SET completed_at = now(), last_error_code = NULL
    FROM public.referral_credit_ledger l
    WHERE q.ledger_id = l.id AND l.user_id = OLD.id AND q.completed_at IS NULL;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION public.cancel_deleted_account_referrals() FROM PUBLIC, anon, authenticated, service_role;
