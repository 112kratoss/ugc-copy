-- Link a guest identity to the account it just registered.
--
-- Why linking and not moving. The first cut of this migration reassigned
-- `user_id` on the guest's generations, transactions, store transactions and
-- purchase intents. Two of those tables refuse it:
--
--   protect_mobile_store_transaction_identity()
--   protect_mobile_purchase_intent_authority()
--
--     IF OLD.user_id IS DISTINCT FROM NEW.user_id
--        AND NOT (OLD.user_id IS NOT NULL AND NEW.user_id IS NULL) THEN
--       RAISE EXCEPTION '... user identity is immutable';
--
-- Only NULL-ing is allowed, and only so account deletion can anonymise a
-- financial row. Any other reassignment raises, which would have aborted the
-- whole merge transaction — rolling the credits back with it — the first time a
-- guest who had actually paid tried to register. The financial rows are
-- deliberately immutable: they are the record of who was charged, and rewriting
-- that is exactly what an audit trail exists to prevent.
--
-- So ownership is expressed as a link instead. Every guest-owned row keeps its
-- original guest UUID forever; `profiles.merged_into_user_id` says which
-- registered account may now act for that UUID, and reads union the linked ids.
-- Only the credit balance actually moves, because a balance is a running total
-- rather than a historical fact.
--
-- Why the guest row survives. Deleting it would cascade through every table
-- carrying `user_id ... ON DELETE CASCADE` — dozens, including tables added long
-- after this migration — so a merge that forgot one would silently destroy the
-- buyer's data. Keeping it is also what makes a replayed merge a no-op instead
-- of a second credit.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS merged_into_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS merged_at timestamptz;

-- Partial: only merged guests carry the pointer, so this stays small even as
-- profiles grows one row per install. It is also the index the canonical
-- resolver and every linked-owner read depend on.
CREATE INDEX IF NOT EXISTS profiles_merged_into_user_id_idx
  ON public.profiles (merged_into_user_id)
  WHERE merged_into_user_id IS NOT NULL;

COMMENT ON COLUMN public.profiles.merged_into_user_id IS
  'Set when this guest profile was linked to a registered account. Guest-owned rows keep their original user_id forever; this says who may now act for them.';

CREATE TABLE IF NOT EXISTS public.account_merges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  target_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  credits_moved integer NOT NULL CHECK (credits_moved >= 0),
  promotional_credits_moved integer NOT NULL CHECK (promotional_credits_moved >= 0),
  source_surface text NOT NULL CHECK (source_surface IN ('mobile', 'web')),
  merged_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  -- One link per guest, forever. This is the money guard: without it a retried
  -- redemption adds the guest's balance to the target a second time.
  --
  -- Deliberately NOT unique on target_user_id. One person can accumulate
  -- several guest identities — a reinstall, a second device, app data cleared —
  -- and each must be able to link to the same account.
  UNIQUE (guest_user_id),
  CHECK (guest_user_id <> target_user_id)
);

CREATE INDEX IF NOT EXISTS account_merges_target_idx
  ON public.account_merges (target_user_id, merged_at DESC);

ALTER TABLE public.account_merges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.account_merges FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.account_merges TO service_role;

-- One-time, retryable redemption tickets.
--
-- The alternative was for the client to hold the guest's access token across
-- sign-in and post it back. That token is the guest's whole identity, it lives
-- in memory, and it is gone the moment the app is killed — so a process death
-- between "signed in" and "merged" stranded the purchased balance on an
-- identity nothing could ever prove ownership of again. A ticket is a purpose-
-- built secret with one job, safe to persist in Keychain/Keystore, and valid
-- long enough (30 days) that a retry at the next launch still works.
--
-- Only the hash is stored. A leaked table is then useless for redeeming.
CREATE TABLE IF NOT EXISTS public.account_merge_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_hash text NOT NULL UNIQUE CHECK (ticket_hash ~ '^[a-f0-9]{64}$'),
  guest_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  target_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (expires_at > created_at),
  -- A consumed ticket must say what it was spent on, so a replay can be
  -- answered with the original outcome instead of a fresh merge.
  CHECK (consumed_at IS NULL OR target_user_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS account_merge_tickets_guest_idx
  ON public.account_merge_tickets (guest_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS account_merge_tickets_expiry_idx
  ON public.account_merge_tickets (expires_at)
  WHERE consumed_at IS NULL;

ALTER TABLE public.account_merge_tickets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.account_merge_tickets FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.account_merge_tickets TO service_role;

-- The account that may act for a given user id.
--
-- Returns the registered account for a linked guest, and the id itself for
-- everyone else. Every credit settlement path routes through this: a refund for
-- a generation a guest started must land on the balance that guest's owner is
-- actually spending from, not on the drained row.
--
-- One hop by construction — a guest can only ever link to a registered account,
-- and a registered account can never be linked away — so there is no chain to
-- walk and no cycle to guard against.
CREATE OR REPLACE FUNCTION public.canonical_account_id(p_user_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(
    (SELECT merged_into_user_id FROM public.profiles WHERE id = p_user_id),
    p_user_id
  );
$$;

COMMENT ON FUNCTION public.canonical_account_id(uuid) IS
  'The account that may act for this user id: the linked registered account for a merged guest, otherwise the id itself.';

REVOKE ALL ON FUNCTION public.canonical_account_id(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.canonical_account_id(uuid) TO service_role;

-- Every user id a registered account may act for: its own, plus every guest
-- linked to it. Owner reads union this so linked generations and media stay
-- reachable without their rows ever being rewritten.
CREATE OR REPLACE FUNCTION public.linked_account_ids(p_user_id uuid)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p_user_id
  UNION
  SELECT id FROM public.profiles WHERE merged_into_user_id = p_user_id;
$$;

REVOKE ALL ON FUNCTION public.linked_account_ids(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.linked_account_ids(uuid) TO service_role;

-- Forward any credit movement on a linked guest row to the account that owns it.
--
-- Twenty-one functions write profiles.credits — refunds, settlement, reservation
-- release, chargeback reconciliation, promotional reserve/restore triggers — and
-- several of them take their user id from a *row* rather than from the caller:
-- settle_generation_failed reads generations.user_id, settle_ai_usage_event
-- reads the event's, reconcile_credit_purchase_adjustment reads the
-- transaction's. Those rows keep their guest UUID forever, so after a link every
-- one of those paths would otherwise pay into (or claw back from) a drained row
-- nobody can spend: a refund the buyer never receives, or a chargeback that
-- takes nothing back.
--
-- Editing all twenty-one is a large diff that has to be repeated for every
-- function added later. Forwarding at the single point where the balance is
-- actually written covers them uniformly, including ones that do not exist yet.
--
-- No recursion: the forwarded UPDATE targets the canonical row, which by
-- definition has merged_into_user_id IS NULL, so the guard is false there.
-- The merge itself is also unaffected — it drains and links in one statement, and
-- at BEFORE UPDATE time OLD.merged_into_user_id is still NULL.
--
-- Deltas are applied raw, not clamped: 20260725231000 documents that refunding a
-- spent purchase must be allowed to drive a balance negative rather than
-- silently forgiving the difference.
CREATE OR REPLACE FUNCTION public.forward_linked_account_credit_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_credit_delta integer;
  v_promotional_delta integer;
BEGIN
  IF OLD.merged_into_user_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_credit_delta := coalesce(NEW.credits, 0) - coalesce(OLD.credits, 0);
  v_promotional_delta := coalesce(NEW.promotional_credits, 0) - coalesce(OLD.promotional_credits, 0);

  IF v_credit_delta = 0 AND v_promotional_delta = 0 THEN
    RETURN NEW;
  END IF;

  UPDATE public.profiles
  SET credits = coalesce(credits, 0) + v_credit_delta,
      promotional_credits = coalesce(promotional_credits, 0) + v_promotional_delta
  WHERE id = OLD.merged_into_user_id;

  -- The linked row stays drained. Leaving the delta on it as well would create a
  -- second spendable copy of the same credits.
  NEW.credits := OLD.credits;
  NEW.promotional_credits := OLD.promotional_credits;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_forward_linked_credit_change ON public.profiles;
CREATE TRIGGER profiles_forward_linked_credit_change
BEFORE UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.forward_linked_account_credit_change();

REVOKE ALL ON FUNCTION public.forward_linked_account_credit_change()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.forward_linked_account_credit_change() TO service_role;

CREATE OR REPLACE FUNCTION public.merge_guest_account(
  p_guest_user_id uuid,
  p_target_user_id uuid,
  p_source_surface text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_guest public.profiles%ROWTYPE;
  v_target public.profiles%ROWTYPE;
  v_existing public.account_merges%ROWTYPE;
  v_guest_is_anonymous boolean;
  v_target_is_anonymous boolean;
  v_first uuid;
  v_second uuid;
  v_credits_moved integer;
  v_promotional_credits_moved integer;
  v_target_credits integer;
BEGIN
  IF p_guest_user_id IS NULL
     OR p_target_user_id IS NULL
     OR p_guest_user_id = p_target_user_id
     OR p_source_surface NOT IN ('mobile', 'web') THEN
    RETURN jsonb_build_object('status', 'not_eligible');
  END IF;

  -- Deterministic lock order. Two devices redeeming into the same account, or a
  -- retry racing its own original, would otherwise deadlock.
  v_first := least(p_guest_user_id, p_target_user_id);
  v_second := greatest(p_guest_user_id, p_target_user_id);
  PERFORM 1 FROM public.profiles WHERE id = v_first FOR UPDATE;
  PERFORM 1 FROM public.profiles WHERE id = v_second FOR UPDATE;

  SELECT * INTO v_guest FROM public.profiles WHERE id = p_guest_user_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_eligible');
  END IF;

  SELECT * INTO v_target FROM public.profiles WHERE id = p_target_user_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_eligible');
  END IF;

  -- Idempotent replay. The client retries this after a flaky sign-in, and the
  -- unique constraint alone would surface as an error rather than a success.
  SELECT * INTO v_existing
  FROM public.account_merges
  WHERE guest_user_id = p_guest_user_id;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'status', CASE WHEN v_existing.target_user_id = p_target_user_id
                     THEN 'already_merged'
                     ELSE 'conflict' END,
      'credits_moved', v_existing.credits_moved,
      'promotional_credits_moved', v_existing.promotional_credits_moved,
      'credits', v_target.credits
    );
  END IF;

  -- Anonymity is read from auth.users, which only the auth server writes. The
  -- route proves it from the JWT as well; this is the independent check, and the
  -- one that cannot be reached around.
  SELECT coalesce(is_anonymous, false) INTO v_guest_is_anonymous
  FROM auth.users WHERE id = p_guest_user_id;
  SELECT coalesce(is_anonymous, false) INTO v_target_is_anonymous
  FROM auth.users WHERE id = p_target_user_id;

  -- A guest may not swallow a registered account, a guest may not absorb another
  -- guest, and an already-linked identity on either side is out of bounds.
  IF NOT v_guest_is_anonymous
     OR v_target_is_anonymous
     OR v_guest.merged_into_user_id IS NOT NULL
     OR v_target.merged_into_user_id IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'not_eligible');
  END IF;

  v_credits_moved := greatest(coalesce(v_guest.credits, 0), 0);
  v_promotional_credits_moved := greatest(coalesce(v_guest.promotional_credits, 0), 0);

  UPDATE public.profiles
  SET credits = greatest(coalesce(credits, 0), 0) + v_credits_moved,
      promotional_credits = greatest(coalesce(promotional_credits, 0), 0) + v_promotional_credits_moved
  WHERE id = p_target_user_id
  RETURNING credits INTO v_target_credits;

  -- Drained and linked in the same statement sequence that credits the target.
  -- A guest row left holding a balance is a second spendable copy of the same
  -- money; the link is what makes every later settlement resolve to the target.
  UPDATE public.profiles
  SET credits = 0,
      promotional_credits = 0,
      merged_into_user_id = p_target_user_id,
      merged_at = timezone('utc'::text, now())
  WHERE id = p_guest_user_id;

  -- Nothing else moves. generations, transactions, mobile_store_transactions,
  -- mobile_purchase_intents and creation_credit_reservations all keep their
  -- original guest user_id: the last two would raise on the attempt, and reads
  -- and settlement resolve through linked_account_ids()/canonical_account_id()
  -- instead.
  INSERT INTO public.account_merges (
    guest_user_id,
    target_user_id,
    credits_moved,
    promotional_credits_moved,
    source_surface
  ) VALUES (
    p_guest_user_id,
    p_target_user_id,
    v_credits_moved,
    v_promotional_credits_moved,
    p_source_surface
  );

  RETURN jsonb_build_object(
    'status', 'merged',
    'credits_moved', v_credits_moved,
    'promotional_credits_moved', v_promotional_credits_moved,
    'credits', v_target_credits
  );
END;
$$;

REVOKE ALL ON FUNCTION public.merge_guest_account(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_guest_account(uuid, uuid, text)
  TO service_role;

-- Redeem a ticket and link the identities in one transaction.
--
-- The ticket is looked up by hash, locked, and checked for expiry and prior
-- consumption before anything moves. Consumption is recorded inside the same
-- transaction as the merge, so a redemption that fails for any reason leaves
-- the ticket spendable — which is the whole point of it being retryable.
CREATE OR REPLACE FUNCTION public.redeem_account_merge_ticket(
  p_ticket_hash text,
  p_target_user_id uuid,
  p_source_surface text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ticket public.account_merge_tickets%ROWTYPE;
  v_result jsonb;
  v_status text;
BEGIN
  IF p_ticket_hash IS NULL OR p_ticket_hash !~ '^[a-f0-9]{64}$' OR p_target_user_id IS NULL THEN
    RETURN jsonb_build_object('status', 'not_eligible');
  END IF;

  SELECT * INTO v_ticket
  FROM public.account_merge_tickets
  WHERE ticket_hash = p_ticket_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_eligible');
  END IF;

  -- A ticket already spent on this same account is a retry, and must report the
  -- original outcome. Spent on a different account, it is a genuine conflict.
  IF v_ticket.consumed_at IS NOT NULL THEN
    IF v_ticket.target_user_id = p_target_user_id THEN
      RETURN jsonb_build_object('status', 'already_merged');
    END IF;
    RETURN jsonb_build_object('status', 'conflict');
  END IF;

  -- Expiry is checked before consumption so an expired ticket stays diagnosable
  -- rather than being burned by the attempt that discovered it.
  IF v_ticket.expires_at <= timezone('utc'::text, now()) THEN
    RETURN jsonb_build_object('status', 'expired');
  END IF;

  v_result := public.merge_guest_account(
    v_ticket.guest_user_id,
    p_target_user_id,
    p_source_surface
  );
  v_status := v_result->>'status';

  -- Only a settled outcome burns the ticket. 'not_eligible' can be transient
  -- from the client's point of view — a profile row still being created, say —
  -- so leaving it spendable is what lets the retry at next launch succeed.
  IF v_status IN ('merged', 'already_merged', 'conflict') THEN
    UPDATE public.account_merge_tickets
    SET consumed_at = timezone('utc'::text, now()),
        target_user_id = p_target_user_id
    WHERE id = v_ticket.id;
  END IF;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.redeem_account_merge_ticket(text, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_account_merge_ticket(text, uuid, text)
  TO service_role;
