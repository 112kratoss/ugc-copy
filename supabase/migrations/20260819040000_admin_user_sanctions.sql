-- Operator sanctions against a user account.
--
-- The console could resolve a report *about* a user, but that only ever wrote
-- to the report row: `resolve_subject_report_for_ops` removes a reported
-- comment, and does nothing at all for a `user` or `generation` target. So a
-- harassment report could be marked handled while the account carried on
-- untouched. The queue looked healthy; nothing had been enforced.
--
-- Enforcement here is `auth.users.banned_until`, which is GoTrue's own gate:
-- it refuses sign-in and rejects the account's tokens without any application
-- code participating. An app-level `profiles.is_banned` flag would have needed
-- every read path to remember to honour it, and the first one that forgot
-- would silently un-ban the user.
--
-- SCOPE: a sanction governs account ACCESS only. It deliberately does not hide
-- the user's posts. Content removal is a separate, individually audited
-- decision -- bundling them would mean one click silently destroyed published
-- work, with the sanction record giving no hint that it had happened.

CREATE TABLE public.admin_user_sanctions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- The operator who authorised it. A real auth user, so the trail survives a
  -- move to per-person admin accounts.
  reviewer_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('suspend', 'reinstate')),
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 1000),
  -- Null on a suspend means indefinite; always null on a reinstate.
  suspended_until timestamptz,
  -- Supplied by the caller so a double-submitted form cannot double-apply.
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT admin_user_sanctions_reinstate_has_no_expiry CHECK (
    action = 'suspend' OR suspended_until IS NULL
  )
);

CREATE UNIQUE INDEX admin_user_sanctions_idempotency_key_idx
  ON public.admin_user_sanctions (idempotency_key);

CREATE INDEX admin_user_sanctions_user_created_idx
  ON public.admin_user_sanctions (user_id, created_at DESC);

CREATE INDEX admin_user_sanctions_created_idx
  ON public.admin_user_sanctions (created_at DESC);

ALTER TABLE public.admin_user_sanctions ENABLE ROW LEVEL SECURITY;

-- Operator-only: it names the reviewer and describes internal decisions.
REVOKE ALL ON TABLE public.admin_user_sanctions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.admin_user_sanctions TO service_role;

COMMENT ON TABLE public.admin_user_sanctions IS
  'Audit log of operator suspensions and reinstatements applied from /admin.';

CREATE OR REPLACE FUNCTION public.apply_admin_user_sanction(
  p_user_id uuid,
  p_reviewer_id uuid,
  p_action text,
  p_reason text,
  p_duration_hours integer,
  p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_existing public.admin_user_sanctions%ROWTYPE;
  v_now timestamptz := timezone('utc'::text, now());
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_suspended_until timestamptz;
  v_sanction_id uuid;
BEGIN
  IF p_user_id IS NULL OR p_reviewer_id IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid', 'error', 'user and reviewer are required');
  END IF;

  IF p_action IS NULL OR p_action NOT IN ('suspend', 'reinstate') THEN
    RETURN jsonb_build_object('status', 'invalid', 'error', 'unsupported sanction action');
  END IF;

  -- A rationale is mandatory: the audit record is the only durable answer to an
  -- appeal, and a status change alone cannot explain itself.
  IF v_reason IS NULL OR char_length(v_reason) < 3 THEN
    RETURN jsonb_build_object('status', 'invalid', 'error', 'reason is required');
  END IF;

  IF v_key IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid', 'error', 'idempotency key is required');
  END IF;

  -- Suspending the operator's own account would be an own goal, and is far more
  -- likely a misclick on their own profile than an intended action.
  IF p_user_id = p_reviewer_id THEN
    RETURN jsonb_build_object('status', 'invalid', 'error', 'an operator cannot sanction their own account');
  END IF;

  -- Replaying a key returns the original outcome rather than applying again.
  SELECT * INTO v_existing
  FROM public.admin_user_sanctions
  WHERE idempotency_key = v_key;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'status', 'already_applied',
      'sanction_id', v_existing.id,
      'action', v_existing.action,
      'suspended_until', v_existing.suspended_until
    );
  END IF;

  -- Lock the account row so two concurrent operators cannot interleave a
  -- suspend and a reinstate and leave the audit log disagreeing with GoTrue.
  PERFORM 1 FROM auth.users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF p_action = 'suspend' THEN
    -- A null or non-positive duration means indefinite. GoTrue compares
    -- `banned_until` against now(), so "indefinite" is expressed as a date far
    -- enough out that it will not lapse on its own.
    v_suspended_until := CASE
      WHEN p_duration_hours IS NULL OR p_duration_hours <= 0
        THEN v_now + interval '100 years'
      ELSE v_now + make_interval(hours => p_duration_hours)
    END;

    UPDATE auth.users SET banned_until = v_suspended_until WHERE id = p_user_id;
  ELSE
    UPDATE auth.users SET banned_until = NULL WHERE id = p_user_id;
    v_suspended_until := NULL;
  END IF;

  INSERT INTO public.admin_user_sanctions (
    user_id, reviewer_id, action, reason, suspended_until, idempotency_key
  ) VALUES (
    p_user_id,
    p_reviewer_id,
    p_action,
    v_reason,
    CASE WHEN p_action = 'suspend' THEN v_suspended_until ELSE NULL END,
    v_key
  )
  RETURNING id INTO v_sanction_id;

  RETURN jsonb_build_object(
    'status', 'applied',
    'sanction_id', v_sanction_id,
    'action', p_action,
    'suspended_until', v_suspended_until
  );
END;
$$;

REVOKE ALL ON FUNCTION public.apply_admin_user_sanction(uuid, uuid, text, text, integer, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_admin_user_sanction(uuid, uuid, text, text, integer, text)
  TO service_role;

COMMENT ON FUNCTION public.apply_admin_user_sanction(uuid, uuid, text, text, integer, text) IS
  'Service-role-only atomic account suspension/reinstatement with an operator audit record.';

-- Authoritative read of who is currently suspended.
--
-- Deliberately reads `auth.users.banned_until` rather than the newest row in
-- `admin_user_sanctions`: GoTrue is what actually enforces the ban, and a ban
-- applied from the Supabase dashboard (or lapsing on its own expiry) would
-- never appear in the audit table. Reporting the audit log as if it were the
-- live state would then show "active" for an account that can still sign in.
--
-- A view rather than a function so the users list can resolve many accounts in
-- one round trip. It runs with the owner's rights, which is what lets it read
-- the auth schema, so it is granted to service_role only.
CREATE OR REPLACE VIEW public.admin_user_account_state AS
SELECT
  users.id AS user_id,
  users.banned_until,
  (users.banned_until IS NOT NULL AND users.banned_until > timezone('utc'::text, now())) AS is_suspended
FROM auth.users;

REVOKE ALL ON public.admin_user_account_state FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.admin_user_account_state TO service_role;

COMMENT ON VIEW public.admin_user_account_state IS
  'Live account-access state from GoTrue, for the /admin console. service_role only.';
