-- A guest→account link that is refused now says why, and whether trying again
-- can ever help (2026-11-25).
--
-- merge_guest_account and redeem_account_merge_ticket answered every refusal
-- with the same bare 'not_eligible', and the ticket stays unspent for it, so
-- the app kept the ticket and sent it again at every launch: a refusal that can
-- pass later (the account's profile row not there yet) looked exactly like one
-- that never can (no ticket with that hash, the guest gone, or the guest an
-- account of its own). A ticket minted on another database and sent here was
-- refused at every launch of an iPhone for days, each time with "Guest credits
-- not added yet" on Home.
--
-- Each 'not_eligible' answer now also carries
--   reason     what refused it, and
--   retryable  true only when a later attempt with the same ticket can succeed.
--
--   reason             retryable  when
--   invalid_request    false      a missing id or hash, or an unknown surface;
--                                 the route never sends one
--   unknown_ticket     false      no ticket with this hash: never minted on this
--                                 database, pruned 30 days after its expiry
--                                 (prune_account_merge_tickets), or gone with
--                                 its guest
--   same_account       false      the guest is the signed-in account itself, so
--                                 its credits are already there
--   guest_gone         false      the guest's profile no longer exists
--   guest_registered   false      the guest has since become an account of its
--                                 own, which holds its credits
--   guest_linked       false      the guest is already linked to an account
--   account_linked     false      the signed-in account is itself linked into
--                                 another account; the route turns such a
--                                 caller away first
--   account_not_ready  true       the signed-in account's profile is missing, or
--                                 not yet a registered account's
--
-- Nothing else changes: the status stays 'not_eligible' (an installed app that
-- reads only the status keeps doing what it did), a refusal still never spends
-- the ticket, and the eligibility, lock order, balances, ledger row, replay
-- answer and grants are 20261015054611's for merge_guest_account and
-- 20260811110000's for redeem_account_merge_ticket. The combined checks are
-- split one condition per answer, and where both sides refuse the guest's
-- permanent reason is checked first, and the account's own link before its
-- retryable state. The one exception keeps the old order:
-- the account's missing profile is read before the replay check that needs it,
-- so it can be reported over a guest that can never link; the retry it asks for
-- gets the guest's reason once that profile exists, and the route admits no
-- caller without one.

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
     OR p_source_surface NOT IN ('mobile', 'web') THEN
    RETURN jsonb_build_object('status', 'not_eligible', 'reason', 'invalid_request', 'retryable', false);
  END IF;

  -- A guest made an account in place keeps its id, and its credits with it.
  IF p_guest_user_id = p_target_user_id THEN
    RETURN jsonb_build_object('status', 'not_eligible', 'reason', 'same_account', 'retryable', false);
  END IF;

  -- Deterministic lock order. Two devices redeeming into the same account, or a
  -- retry racing its own original, would otherwise deadlock.
  v_first := least(p_guest_user_id, p_target_user_id);
  v_second := greatest(p_guest_user_id, p_target_user_id);
  PERFORM 1 FROM public.profiles WHERE id = v_first FOR UPDATE;
  PERFORM 1 FROM public.profiles WHERE id = v_second FOR UPDATE;

  SELECT * INTO v_guest FROM public.profiles WHERE id = p_guest_user_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_eligible', 'reason', 'guest_gone', 'retryable', false);
  END IF;

  -- The one refusal a retry can cure: the account's own profile row.
  SELECT * INTO v_target FROM public.profiles WHERE id = p_target_user_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_eligible', 'reason', 'account_not_ready', 'retryable', true);
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
  -- guest, and an already-linked identity on either side is out of bounds. The
  -- guest's side first: an identity that has left anonymity never returns to
  -- it, and a link is never undone, so neither refusal is cured by a retry.
  IF NOT v_guest_is_anonymous THEN
    RETURN jsonb_build_object('status', 'not_eligible', 'reason', 'guest_registered', 'retryable', false);
  END IF;

  IF v_guest.merged_into_user_id IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'not_eligible', 'reason', 'guest_linked', 'retryable', false);
  END IF;

  -- The account linked into another one: a link is never undone, so no retry
  -- cures it. The route turns a linked caller away before this runs.
  IF v_target.merged_into_user_id IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'not_eligible', 'reason', 'account_linked', 'retryable', false);
  END IF;

  -- The route admits only a registered caller, so this is a profile or token
  -- out of step with auth.users; the ticket is kept for the attempt after.
  IF v_target_is_anonymous THEN
    RETURN jsonb_build_object('status', 'not_eligible', 'reason', 'account_not_ready', 'retryable', true);
  END IF;

  -- Preserve both accounts signed balances; linking must never forgive debt.
  v_credits_moved := coalesce(v_guest.credits, 0);
  v_promotional_credits_moved := coalesce(v_guest.promotional_credits, 0);

  UPDATE public.profiles
  SET credits = coalesce(credits, 0) + v_credits_moved,
      promotional_credits = coalesce(promotional_credits, 0) + v_promotional_credits_moved
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

  -- No owned record moves. generations, transactions, mobile_store_transactions,
  -- mobile_purchase_intents and creation_credit_reservations all keep their
  -- original guest user_id: the last two would raise on the attempt, and reads
  -- and settlement resolve through linked_account_ids()/canonical_account_id()
  -- instead. The guest's feed preferences are settings rather than records, and
  -- they go with the person, below.
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

  -- After the link above, which carry_guest_feed_preferences requires. A replay
  -- returns before this, so the preferences move exactly once.
  PERFORM public.carry_guest_feed_preferences(p_guest_user_id, p_target_user_id);

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
GRANT EXECUTE ON FUNCTION public.merge_guest_account(uuid, uuid, text) TO service_role;

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
    RETURN jsonb_build_object('status', 'not_eligible', 'reason', 'invalid_request', 'retryable', false);
  END IF;

  SELECT * INTO v_ticket
  FROM public.account_merge_tickets
  WHERE ticket_hash = p_ticket_hash
  FOR UPDATE;

  -- A hash that is not here never will be: the route mints every ticket from
  -- fresh random bytes and stores it before handing it out, and a row, once
  -- gone, is never written back. So the ticket was minted on another database,
  -- pruned 30 days after its expiry, or deleted with its guest.
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_eligible', 'reason', 'unknown_ticket', 'retryable', false);
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

  -- Only a settled outcome burns the ticket. A 'not_eligible' one is left
  -- spendable even when its reason says no retry can help: spending it would
  -- make the next attempt answer 'already_merged', a success nothing moved
  -- for. Its 'retryable' is what tells the client to stop sending it.
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

COMMENT ON FUNCTION public.redeem_account_merge_ticket(text, uuid, text) IS
  'Links the ticket''s guest to p_target_user_id once. A not_eligible answer names its reason and says whether the same ticket can pass later (retryable); it never spends the ticket.';
