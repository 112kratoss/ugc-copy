-- Idle guests that made something (usage audit, 2026-11-04; the window is the
-- owner's decision).
--
-- list_idle_guest_identities (20261015174821, D5) names only guests that hold
-- nothing, and the retention job deletes those with the Auth admin API alone.
-- A guest that made or uploaded anything was skipped for good: nothing ever
-- removed it, its rows or its files. This names those guests once they have
-- been unused for 180 days, so the retention job can retire each through the
-- account-deletion pipeline (executeInitialAccountDeletion, as a guest's own
-- deletion runs): prepare_guest_account_deletion's guard, every session
-- revoked, the storage sweep, the Auth user deleted and the delayed resweep.
--
-- A candidate is an anonymous user that
--   * has made or uploaded something: a generation, a generation input, a
--     start request, a spend audit, an AI usage event, a template run, a
--     workflow canvas or canvas run, an upload intent or an upload
--     reservation (exactly what keeps a guest off the first list);
--   * has not been used for 180 days, by the same traces of use the first
--     list reads, with the longer window;
--   * is its own: not linked to an account, never a link's target, no link
--     pending, no deletion of its own under way;
--   * holds no balance and has no purchase, purchase in progress, grant,
--     adjustment, credit hold, sale or wallet on record: money is never
--     retired automatically;
--   * has nothing public: no post, comment, recipe, listing, authored
--     template or shared workflow, since other people may have saved, remixed
--     or bought it;
--   * has nothing an operator or a report recorded about it.
--
-- Like the first list it only reads, answers the longest unused first, and is
-- asked again for each identity (p_user_id) right before that one is retired.

CREATE FUNCTION public.list_idle_guest_identities_with_content(
  p_now timestamptz DEFAULT NULL,
  p_limit integer DEFAULT 10,
  p_user_id uuid DEFAULT NULL
)
RETURNS TABLE (user_id uuid, created_at timestamptz, last_active_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
-- One query serves the list and the per-identity re-check, as in the first
-- list: a custom plan folds p_user_id away.
SET plan_cache_mode = force_custom_plan
AS $$
#variable_conflict use_column
DECLARE
  -- Never later than the database's own clock: no caller's clock can make a
  -- guest idle sooner than 180 days. The owner's window: change it here.
  v_cutoff timestamptz := least(coalesce(p_now, now()), now()) - interval '180 days';
  v_limit integer := least(greatest(coalesce(p_limit, 10), 1), 100);
BEGIN
  RETURN QUERY
  SELECT guest.id, guest.created_at, activity.last_active_at
  FROM auth.users AS guest
  JOIN public.profiles AS profile ON profile.id = guest.id
  -- The guest's last use as Auth saw it, read as the first list reads it.
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
    AND guest.created_at < v_cutoff
    AND activity.last_active_at < v_cutoff
    -- Made or uploaded something: the rows that keep a guest off the first list.
    AND (
      EXISTS (SELECT 1 FROM public.generations AS generation_row WHERE generation_row.user_id = guest.id)
      OR EXISTS (SELECT 1 FROM public.generation_input_media AS input_media WHERE input_media.user_id = guest.id)
      OR EXISTS (SELECT 1 FROM public.generation_start_requests AS start_request WHERE start_request.user_id = guest.id)
      OR EXISTS (SELECT 1 FROM public.generation_spend_audits AS spend_audit WHERE spend_audit.user_id = guest.id)
      OR EXISTS (SELECT 1 FROM public.ai_usage_events AS usage_event WHERE usage_event.user_id = guest.id)
      OR EXISTS (SELECT 1 FROM public.template_runs AS template_run WHERE template_run.user_id = guest.id)
      OR EXISTS (SELECT 1 FROM public.workflow_canvases AS canvas WHERE canvas.user_id = guest.id)
      OR EXISTS (SELECT 1 FROM public.workflow_canvas_runs AS canvas_run WHERE canvas_run.user_id = guest.id)
      OR EXISTS (SELECT 1 FROM public.media_upload_intents AS upload_intent WHERE upload_intent.user_id = guest.id)
      OR EXISTS (SELECT 1 FROM public.upload_byte_reservations AS reservation WHERE reservation.user_id = guest.id)
    )
    -- Use the app writes, with the longer window.
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
    -- Making something is use too: nothing made, started or uploaded lately.
    AND NOT EXISTS (
      SELECT 1 FROM public.generations AS recent_generation
      WHERE recent_generation.user_id = guest.id
        AND (recent_generation.created_at >= v_cutoff
          OR recent_generation.completed_at >= v_cutoff)
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.media_upload_intents AS recent_upload
      WHERE recent_upload.user_id = guest.id
        AND recent_upload.created_at >= v_cutoff
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
    -- adjusted, held, sold or earned.
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
    -- Nothing public that others may have saved, remixed or bought.
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
      SELECT 1 FROM public.templates AS authored_template
      WHERE authored_template.creator_user_id = guest.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.workflow_shares AS workflow_share
      WHERE workflow_share.owner_user_id = guest.id
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

REVOKE ALL ON FUNCTION public.list_idle_guest_identities_with_content(timestamptz, integer, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_idle_guest_identities_with_content(timestamptz, integer, uuid)
  TO service_role;

COMMENT ON FUNCTION public.list_idle_guest_identities_with_content(timestamptz, integer, uuid) IS
  'Idle guests that made or uploaded something and are unused for 180 days (the owner''s window): unlinked, no balance, no purchase or sale, nothing public, nothing moderated; oldest activity first, at most 100 per call; p_user_id re-checks one identity. Read only: the retention job retires each through the account-deletion pipeline, which removes its files. Service role only.';
