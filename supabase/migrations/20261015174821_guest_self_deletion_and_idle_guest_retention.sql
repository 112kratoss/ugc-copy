-- Guest data (product decision D5, 2026-10-15): a guest may delete itself, and
-- a guest identity nobody uses and that holds nothing is not kept forever.
--
-- 1. Guest self-deletion. DELETE /api/account now takes a guest's token
--    (account-deletion-route-adapter-service.ts). A guest has no provider
--    identity and no password, so it has nothing to sign in again with; what
--    has to hold instead is that the identity is still the guest's alone. A
--    guest linked to an account is spent: the account acts for its balance and
--    its creations now (they keep the guest's user_id and are read through
--    linked ids), and deleting the guest's Auth user would cascade the
--    account's linked history away. prepare_guest_account_deletion() decides
--    that under the deletion's own lock and then hands over to
--    prepare_account_deletion(), so a guest goes through the same pipeline as
--    an account: locked as `deleting`, every session revoked, storage swept,
--    the Auth user deleted, and the delayed resweep.
--
-- 2. Idle-guest retention. Every first launch, reinstall, sign-out, merge and
--    deletion mints a new anonymous user, and nothing removed the ones nobody
--    comes back to (finding 02-10). list_idle_guest_identities() names the
--    guests the operational-data-retention job deletes through the Auth admin
--    API, the way account deletion removes an Auth user; there is no SQL
--    delete of auth.users anywhere in this repository and this adds none.
--
--    A candidate is an anonymous user that
--      * is not linked to an account and was never the target of a link
--        (profiles.merged_into_user_id, account_merges, a pending ticket);
--      * holds no balance (credits = 0 and promotional_credits = 0, so a debt
--        is kept too) and has no purchase, purchase in progress, grant,
--        adjustment or credit hold on record;
--      * made nothing and uploaded nothing: no generation, generation input,
--        start request, spend audit, AI usage, template run, workflow, post,
--        comment, template, bundle, listing, upload intent or upload
--        reservation;
--      * has nothing an operator or a report recorded about it (sanctions,
--        reports it filed) and no deletion of its own under way;
--      * has not been used in the last 90 days, by any of the traces use
--        leaves. A guest signs in once, when it is created, and from then on
--        only refreshes its token, which does not move last_sign_in_at; read
--        alone, that column would have deleted a guest that opens the app
--        every day but has never bought or made anything, and the app would
--        have replaced it with a fresh guest without its Hide, Not interested
--        and interest weights. So a guest is in use while any of these is
--        recent: its creation or sign-in (auth.users), a session created,
--        updated or refreshed (auth.sessions.refreshed_at, which Auth writes
--        at every refresh), a refresh token issued or updated on one of its
--        sessions (auth.refresh_tokens), or a row the app writes as it is
--        used: a feed session, a feed event (impressions, dwell, opens), a
--        delivery fact or daily delivery row (the feed served to it), a feed
--        experiment assignment, a Not interested or Hide, an interest weight's
--        last event, an onboarding event, or a share it counted. Rows the
--        feed's own maintenance writes (user_interest_refresh_state, and the
--        updated_at it stamps on weights) are not use and are not read.
--
--    Storage needs no check of its own. Every object a client writes is
--    signed through reserve_upload_bytes*, whose row is kept until the object
--    is tombstoned (prune_upload_byte_reservations), and every object the
--    server writes for a person hangs off a generation, template run or post:
--    a candidate has none of those, so it has no files.
--
--    What deleting a candidate removes is what the guest kept to tailor the
--    app (feed sessions, impressions and events, Not interested and Hide,
--    interest weights) and telemetry that already detaches from a deleted
--    user (onboarding and share events keep their rows with a null actor).
--
--    The function only reads. The job asks it again for each identity, with
--    p_user_id, right before deleting that one, so a guest that came back
--    while the run was under way is left alone.

CREATE OR REPLACE FUNCTION public.prepare_guest_account_deletion(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_is_anonymous boolean;
  v_profile public.profiles%ROWTYPE;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid_request');
  END IF;

  -- prepare_account_deletion()'s own first lock, taken first here so that the
  -- guest check and the preparation it admits are one decision. Advisory locks
  -- are reentrant, so its second acquisition below costs nothing.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('account-deletion:' || p_user_id::text, 0)
  );

  -- Anonymity is read from auth.users, which only the Auth server writes. The
  -- route reads it from Auth as well; this is the check nothing can reach
  -- around, and an account is never deleted down this path, not even one
  -- whose own deletion is already under way.
  SELECT users.is_anonymous
  INTO v_is_anonymous
  FROM auth.users AS users
  WHERE users.id = p_user_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  IF NOT coalesce(v_is_anonymous, false) THEN
    RETURN jsonb_build_object('status', 'not_a_guest');
  END IF;

  -- A guest deletion already under way (a retry whose first answer was lost)
  -- goes on as it started: prepare_account_deletion() answers from the job.
  IF EXISTS (
    SELECT 1 FROM public.account_deletion_jobs AS job
    WHERE job.user_id = p_user_id
  ) THEN
    RETURN public.prepare_account_deletion(p_user_id);
  END IF;

  -- The row a merge locks and links. Locked here, a merge either finished
  -- first (and is seen below) or waits for this deletion and then refuses an
  -- identity that is no longer active.
  SELECT *
  INTO v_profile
  FROM public.profiles AS profile
  WHERE profile.id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF v_profile.merged_into_user_id IS NOT NULL
    OR v_profile.merged_at IS NOT NULL
    OR v_profile.identity_state = 'merged'
    OR EXISTS (
      SELECT 1 FROM public.account_merges AS link_row
      WHERE link_row.guest_user_id = p_user_id
    )
    OR EXISTS (
      SELECT 1 FROM public.account_merges AS link_row
      WHERE link_row.target_user_id = p_user_id
    )
    OR EXISTS (
      SELECT 1 FROM public.profiles AS linked
      WHERE linked.merged_into_user_id = p_user_id
    ) THEN
    RETURN jsonb_build_object('status', 'merged');
  END IF;

  RETURN public.prepare_account_deletion(p_user_id);
END;
$$;

REVOKE ALL ON FUNCTION public.prepare_guest_account_deletion(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_guest_account_deletion(uuid)
  TO service_role;

COMMENT ON FUNCTION public.prepare_guest_account_deletion(uuid) IS
  'A guest''s own deletion (D5): refuses an account (not_a_guest) and a guest linked to an account or named as a link target (merged), then prepares the deletion exactly as prepare_account_deletion() does. Service role only.';

CREATE OR REPLACE FUNCTION public.list_idle_guest_identities(
  p_now timestamptz DEFAULT NULL,
  p_limit integer DEFAULT 100,
  p_user_id uuid DEFAULT NULL
)
RETURNS TABLE (user_id uuid, created_at timestamptz, last_active_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
-- One query serves the whole list and the per-identity re-check. A custom plan
-- folds p_user_id away and answers the re-check from the indexes; a cached
-- generic plan could not.
SET plan_cache_mode = force_custom_plan
AS $$
#variable_conflict use_column
DECLARE
  -- Never later than the database's own clock: no caller's clock can make a
  -- guest idle sooner than 90 days.
  v_cutoff timestamptz := least(coalesce(p_now, now()), now()) - interval '90 days';
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 500);
BEGIN
  RETURN QUERY
  SELECT guest.id, guest.created_at, activity.last_active_at
  FROM auth.users AS guest
  JOIN public.profiles AS profile ON profile.id = guest.id
  -- The guest's last use as Auth saw it: created, signed in, or a session
  -- created, updated or refreshed (refreshed_at is stored without a time zone,
  -- in UTC), or a refresh token issued or updated on one of its sessions.
  CROSS JOIN LATERAL (
    SELECT greatest(
      guest.created_at,
      guest.last_sign_in_at,
      (
        SELECT max(greatest(
          auth_session.created_at,
          auth_session.updated_at,
          auth_session.refreshed_at AT TIME ZONE 'UTC'
        ))
        FROM auth.sessions AS auth_session
        WHERE auth_session.user_id = guest.id
      ),
      (
        SELECT max(greatest(refresh_token.created_at, refresh_token.updated_at))
        FROM auth.sessions AS token_session
        JOIN auth.refresh_tokens AS refresh_token
          ON refresh_token.session_id = token_session.id
        WHERE token_session.user_id = guest.id
      )
    ) AS last_active_at
  ) AS activity
  WHERE guest.is_anonymous
    AND (p_user_id IS NULL OR guest.id = p_user_id)
    AND guest.deleted_at IS NULL
    -- Idle: created, signed in and last used 90 days ago or earlier. An
    -- unknown time counts as recent (NULL never compares below the cutoff).
    AND guest.created_at < v_cutoff
    AND activity.last_active_at < v_cutoff
    -- ...and nothing the app writes as a guest uses it is recent either.
    AND NOT EXISTS (
      SELECT 1 FROM public.feed_sessions AS feed_session
      WHERE feed_session.viewer_user_id = guest.id
        AND (feed_session.created_at >= v_cutoff
          OR feed_session.last_accessed_at >= v_cutoff)
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.feed_events AS feed_event
      WHERE feed_event.viewer_user_id = guest.id
        AND (feed_event.occurred_at >= v_cutoff
          OR feed_event.received_at >= v_cutoff)
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.feed_delivery_facts AS delivery
      WHERE delivery.viewer_user_id = guest.id
        AND (delivery.ranked_at >= v_cutoff
          OR delivery.served_at >= v_cutoff
          OR delivery.last_event_at >= v_cutoff)
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.feed_viewer_daily AS viewer_day
      WHERE viewer_day.viewer_user_id = guest.id
        AND viewer_day.last_served_at >= v_cutoff
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.feed_experiment_assignments AS experiment_assignment
      WHERE experiment_assignment.viewer_user_id = guest.id
        AND experiment_assignment.assigned_at >= v_cutoff
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.feed_user_post_feedback AS post_feedback
      WHERE post_feedback.user_id = guest.id
        AND (post_feedback.first_recorded_at >= v_cutoff
          OR post_feedback.updated_at >= v_cutoff)
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.feed_user_creator_feedback AS creator_feedback
      WHERE creator_feedback.user_id = guest.id
        AND (creator_feedback.first_recorded_at >= v_cutoff
          OR creator_feedback.updated_at >= v_cutoff)
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.user_interest_weights AS interest
      WHERE interest.user_id = guest.id
        AND (interest.last_event_at >= v_cutoff
          OR interest.last_event_received_at >= v_cutoff)
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.onboarding_events AS onboarding_event
      WHERE onboarding_event.user_id = guest.id
        AND (onboarding_event.occurred_at >= v_cutoff
          OR onboarding_event.created_at >= v_cutoff)
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.post_share_events AS post_share
      WHERE post_share.actor_user_id = guest.id
        AND post_share.created_at >= v_cutoff
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.profile_share_events AS profile_share
      WHERE profile_share.actor_user_id = guest.id
        AND profile_share.created_at >= v_cutoff
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.generation_share_events AS generation_share
      WHERE generation_share.actor_user_id = guest.id
        AND generation_share.created_at >= v_cutoff
    )
    -- Its own: not linked, never a link's target, no link pending, and no
    -- deletion of its own under way.
    AND profile.identity_state = 'active'
    AND profile.merged_into_user_id IS NULL
    AND profile.merged_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.profiles AS linked
      WHERE linked.merged_into_user_id = guest.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.account_merges AS link_row
      WHERE link_row.guest_user_id = guest.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.account_merges AS link_row
      WHERE link_row.target_user_id = guest.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.account_merge_tickets AS ticket
      WHERE ticket.guest_user_id = guest.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.account_merge_tickets AS ticket
      WHERE ticket.target_user_id = guest.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.account_deletion_jobs AS job
      WHERE job.user_id = guest.id
    )
    -- Money: no balance either way, and nothing bought, being bought, granted,
    -- adjusted or held.
    AND coalesce(profile.credits, 0) = 0
    AND coalesce(profile.promotional_credits, 0) = 0
    AND NOT EXISTS (
      SELECT 1 FROM public.transactions AS purchase
      WHERE purchase.user_id = guest.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.mobile_store_transactions AS purchase
      WHERE purchase.user_id = guest.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.mobile_purchase_intents AS intent
      WHERE intent.user_id = guest.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.razorpay_checkout_intents AS intent
      WHERE intent.user_id = guest.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.credit_grants AS grant_row
      WHERE grant_row.user_id = guest.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.referral_credit_ledger AS ledger
      WHERE ledger.user_id = guest.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.admin_credit_adjustments AS adjustment
      WHERE adjustment.user_id = guest.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.creation_credit_reservations AS credit_hold
      WHERE credit_hold.user_id = guest.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.post_resource_bundle_orders AS bundle_order
      WHERE bundle_order.buyer_user_id = guest.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.post_resource_bundle_purchases AS bundle_purchase
      WHERE bundle_purchase.buyer_user_id = guest.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.marketplace_orders AS market_order
      WHERE market_order.buyer_user_id = guest.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.marketplace_purchases AS market_purchase
      WHERE market_purchase.buyer_user_id = guest.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.creator_resource_wallets AS wallet
      WHERE wallet.user_id = guest.id
    )
    -- Anything it made, started making, or uploaded (see the storage note).
    AND NOT EXISTS (
      SELECT 1 FROM public.generations AS generation_row
      WHERE generation_row.user_id = guest.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.generation_input_media AS input_media
      WHERE input_media.user_id = guest.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.generation_start_requests AS start_request
      WHERE start_request.user_id = guest.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.generation_spend_audits AS spend_audit
      WHERE spend_audit.user_id = guest.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.ai_usage_events AS usage_event
      WHERE usage_event.user_id = guest.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.template_runs AS template_run
      WHERE template_run.user_id = guest.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.workflow_canvases AS canvas
      WHERE canvas.user_id = guest.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.workflow_canvas_runs AS canvas_run
      WHERE canvas_run.user_id = guest.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.workflow_shares AS workflow_share
      WHERE workflow_share.owner_user_id = guest.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.templates AS authored_template
      WHERE authored_template.creator_user_id = guest.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.posts AS post
      WHERE post.user_id = guest.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.post_comments AS post_comment
      WHERE post_comment.user_id = guest.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.post_resource_bundles AS bundle
      WHERE bundle.owner_user_id = guest.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.marketplace_assets AS listing
      WHERE listing.seller_user_id = guest.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.media_upload_intents AS upload_intent
      WHERE upload_intent.user_id = guest.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.upload_byte_reservations AS reservation
      WHERE reservation.user_id = guest.id
    )
    -- Records an operator or the guest itself filed.
    AND NOT EXISTS (
      SELECT 1 FROM public.admin_user_sanctions AS sanction
      WHERE sanction.user_id = guest.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.moderation_reports AS report
      WHERE report.reporter_user_id = guest.id
    )
  -- The longest idle first, so a backlog drains oldest first.
  ORDER BY activity.last_active_at, guest.id
  LIMIT v_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.list_idle_guest_identities(timestamptz, integer, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_idle_guest_identities(timestamptz, integer, uuid)
  TO service_role;

COMMENT ON FUNCTION public.list_idle_guest_identities(timestamptz, integer, uuid) IS
  'Idle-guest retention (D5): anonymous users unused for 90 days that are unlinked, hold no balance and have no purchase, creation, upload, link or deletion on record; oldest activity first, at most 500 per call; p_user_id re-checks one identity. Read only: the retention job deletes each through the Auth admin API. Service role only.';
