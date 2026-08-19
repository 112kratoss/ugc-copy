-- Proactive post moderation.
--
-- `resolve_post_report_for_ops` can only act on a post that someone reported:
-- it loads a `post_reports` row first and derives the post from it. That left
-- two real cases with no lever at all — an operator who spots violating content
-- themselves, and a legal/DMCA demand that arrives by email rather than through
-- the in-product report button.
--
-- This table is the audit log for operator-initiated post visibility changes,
-- and `apply_admin_post_moderation` is the only supported way to write one.
--
-- DECISION: two distinct removal actions, not one.
--
--   `hide`       hides the post and pulls its paid surfaces, but leaves the
--                media in Storage. Reversible.
--   `take_down`  everything `hide` does, and additionally marks the post for
--                public media revocation. NOT reversible.
--
-- The split exists because revocation is a hard delete. `revokePostPublicMedia`
-- calls Storage `remove()` and then asserts the objects are gone, so a taken
-- down post's MP4s, posters, renditions and teasers cease to exist. A single
-- action that always revoked would force an operator making a provisional call
-- ("this looks wrong, hide it until I've read the thread") to destroy the
-- evidence and the creator's only copy to do it. A single action that never
-- revoked would leave DMCA'd media fetchable at its public Storage URL, which
-- is the case that motivated this work.
--
-- `restore` therefore refuses on any post whose media was revoked — by this
-- table's `take_down` or by a report resolution — rather than returning a post
-- to the feed with media that 404s.

CREATE TABLE public.admin_post_moderation_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  -- The operator who authorised the change. A real auth user, never a synthetic
  -- id, so the audit trail survives a move to per-person admin accounts.
  reviewer_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('hide', 'take_down', 'restore')),
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 1000),
  review_status_before text NOT NULL,
  review_status_after text NOT NULL,
  -- Set by `take_down`. Named for what the database actually knows: the RPC
  -- records that revocation is owed, and the caller performs and verifies the
  -- Storage delete afterwards, exactly as the report path already works. A true
  -- value therefore means "this post's media must be treated as gone", which is
  -- the only reading `restore` needs.
  media_revocation_required boolean NOT NULL DEFAULT false,
  -- The paid surfaces this action actually moved. Recorded so `restore`
  -- republishes precisely what a hide pulled down, and cannot resurrect a
  -- bundle the creator had drafted themselves before any moderation happened.
  drafted_bundle_ids uuid[] NOT NULL DEFAULT '{}',
  unlisted_asset_ids uuid[] NOT NULL DEFAULT '{}',
  resolved_report_count integer NOT NULL DEFAULT 0,
  -- Supplied by the caller so a double-submitted form cannot double-apply.
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE UNIQUE INDEX admin_post_moderation_actions_idempotency_key_idx
  ON public.admin_post_moderation_actions (idempotency_key);

CREATE INDEX admin_post_moderation_actions_post_created_idx
  ON public.admin_post_moderation_actions (post_id, created_at DESC);

CREATE INDEX admin_post_moderation_actions_reviewer_created_idx
  ON public.admin_post_moderation_actions (reviewer_id, created_at DESC);

ALTER TABLE public.admin_post_moderation_actions ENABLE ROW LEVEL SECURITY;

-- Operator-only data: it names the reviewer and describes internal moderation
-- decisions, so it never belongs on the public Data API.
REVOKE ALL ON TABLE public.admin_post_moderation_actions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.admin_post_moderation_actions TO service_role;

COMMENT ON TABLE public.admin_post_moderation_actions IS
  'Audit log of operator-initiated post visibility changes made from the /admin console without a report.';

CREATE OR REPLACE FUNCTION public.apply_admin_post_moderation(
  p_post_id uuid,
  p_reviewer_id uuid,
  p_action text,
  p_reason text,
  p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing public.admin_post_moderation_actions%ROWTYPE;
  v_last_removal public.admin_post_moderation_actions%ROWTYPE;
  v_post public.posts%ROWTYPE;
  v_now timestamptz := timezone('utc'::text, now());
  v_reason text := btrim(coalesce(p_reason, ''));
  v_key text := btrim(coalesce(p_idempotency_key, ''));
  v_status_after text;
  v_drafted uuid[] := '{}';
  v_unlisted uuid[] := '{}';
  v_resolved_count integer := 0;
  v_open_reports integer := 0;
  v_media_revoked boolean := false;
  v_action_id uuid;
BEGIN
  IF p_post_id IS NULL OR p_reviewer_id IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid', 'error', 'post and reviewer are required');
  END IF;

  IF p_action IS NULL OR p_action NOT IN ('hide', 'take_down', 'restore') THEN
    RETURN jsonb_build_object('status', 'invalid', 'error', 'unsupported moderation action');
  END IF;

  -- Mandatory rationale. The audit record is the only durable explanation of
  -- why content was removed, and an empty note makes an appeal unanswerable.
  IF char_length(v_reason) < 3 OR char_length(v_reason) > 1000 THEN
    RETURN jsonb_build_object('status', 'invalid', 'error', 'reason must be between 3 and 1000 characters');
  END IF;

  IF v_key = '' THEN
    RETURN jsonb_build_object('status', 'invalid', 'error', 'idempotency key is required');
  END IF;

  -- Replaying the same key returns the original outcome instead of applying a
  -- second action, so a retried request is safe.
  SELECT * INTO v_existing
  FROM public.admin_post_moderation_actions
  WHERE idempotency_key = v_key;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'status', 'already_applied',
      'action_id', v_existing.id,
      'post_id', v_existing.post_id,
      'action', v_existing.action,
      'post_review_status', v_existing.review_status_after,
      'media_revocation_required', v_existing.media_revocation_required,
      'resolved_report_count', v_existing.resolved_report_count
    );
  END IF;

  -- A real auth user is required so every decision has a durable operator id.
  PERFORM 1 FROM auth.users WHERE id = p_reviewer_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'invalid', 'error', 'reviewer not found');
  END IF;

  -- Serialize every decision for this post, matching the lock order
  -- `resolve_post_report_for_ops` takes, so a proactive action and a report
  -- resolution racing on the same post cannot deadlock or interleave.
  SELECT * INTO v_post
  FROM public.posts
  WHERE id = p_post_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF p_action IN ('hide', 'take_down') THEN
    v_status_after := 'hidden';
    v_media_revoked := (p_action = 'take_down');

    -- Deliberately not short-circuited when the post is already hidden:
    -- `hide` then `take_down` is the intended escalation path, and the second
    -- action must still record itself and still owe media revocation.
    UPDATE public.posts
    SET review_status = 'hidden',
        reviewed_at = v_now,
        reviewed_by = p_reviewer_id,
        updated_at = v_now
    WHERE id = p_post_id;

    WITH drafted AS (
      UPDATE public.post_resource_bundles
      SET status = 'draft',
          updated_at = v_now
      WHERE post_id = p_post_id
        AND status = 'published'
      RETURNING id
    )
    SELECT coalesce(array_agg(id), '{}') INTO v_drafted FROM drafted;

    WITH unlisted AS (
      UPDATE public.marketplace_assets
      SET status = 'unlisted',
          updated_at = v_now
      WHERE post_id = p_post_id
        AND status = 'active'
      RETURNING id
    )
    SELECT coalesce(array_agg(id), '{}') INTO v_unlisted FROM unlisted;

    -- Only a take-down closes open reports, and deliberately so.
    --
    -- `hide` is provisional: the content is out of view, but the operator has
    -- not yet ruled on the report and the reporter is still owed a verdict, so
    -- the report stays in the queue.
    --
    -- This also keeps `post_reports.resolution_action = 'take_down'` meaning
    -- exactly one thing across the product: this post's public media was
    -- revoked. The `restore` branch below depends on that. When `hide` also
    -- wrote that value -- its only alternative, since the column's vocabulary
    -- is ('take_down', 'dismiss') -- hiding a *reported* post silently and
    -- permanently marked it unrestorable.
    IF p_action = 'take_down' THEN
      UPDATE public.post_reports
      SET status = 'reviewed',
          reviewed_at = v_now,
          reviewed_by = p_reviewer_id,
          resolution_action = 'take_down',
          resolution_note = v_reason,
          updated_at = v_now
      WHERE post_id = p_post_id
        AND status = 'open';

      GET DIAGNOSTICS v_resolved_count = ROW_COUNT;
    END IF;
  ELSE
    -- Restore. Refuse whenever this post's public media has already been
    -- destroyed, whether by this table's `take_down` or by a report resolution
    -- that ran the same revocation. Flipping `review_status` would otherwise
    -- return a post to the feed whose every media URL 404s.
    IF EXISTS (
      SELECT 1
      FROM public.admin_post_moderation_actions
      WHERE post_id = p_post_id
        AND media_revocation_required
      UNION ALL
      SELECT 1
      FROM public.post_reports
      WHERE post_id = p_post_id
        AND resolution_action = 'take_down'
    ) THEN
      RETURN jsonb_build_object(
        'status', 'not_restorable',
        'post_id', p_post_id,
        'error', 'this post had its public media revoked by a take-down and cannot be restored'
      );
    END IF;

    SELECT count(*) INTO v_open_reports
    FROM public.post_reports
    WHERE post_id = p_post_id
      AND status = 'open';

    -- A pending report flags the post rather than clearing it outright, which
    -- is the same rule the dismiss path in `resolve_post_report_for_ops` uses.
    v_status_after := CASE WHEN v_open_reports > 0 THEN 'flagged' ELSE 'visible' END;

    UPDATE public.posts
    SET review_status = v_status_after,
        reviewed_at = v_now,
        reviewed_by = p_reviewer_id,
        updated_at = v_now
    WHERE id = p_post_id;

    -- Reverse exactly what the most recent removal moved, and nothing else.
    SELECT * INTO v_last_removal
    FROM public.admin_post_moderation_actions
    WHERE post_id = p_post_id
      AND action IN ('hide', 'take_down')
    ORDER BY created_at DESC, id DESC
    LIMIT 1;

    IF FOUND THEN
      UPDATE public.post_resource_bundles
      SET status = 'published',
          updated_at = v_now
      WHERE id = ANY (v_last_removal.drafted_bundle_ids)
        AND status = 'draft';

      UPDATE public.marketplace_assets
      SET status = 'active',
          updated_at = v_now
      WHERE id = ANY (v_last_removal.unlisted_asset_ids)
        AND status = 'unlisted';

      v_drafted := v_last_removal.drafted_bundle_ids;
      v_unlisted := v_last_removal.unlisted_asset_ids;
    END IF;
  END IF;

  INSERT INTO public.admin_post_moderation_actions (
    post_id,
    reviewer_id,
    action,
    reason,
    review_status_before,
    review_status_after,
    media_revocation_required,
    drafted_bundle_ids,
    unlisted_asset_ids,
    resolved_report_count,
    idempotency_key
  ) VALUES (
    p_post_id,
    p_reviewer_id,
    p_action,
    v_reason,
    v_post.review_status,
    v_status_after,
    v_media_revoked,
    v_drafted,
    v_unlisted,
    v_resolved_count,
    v_key
  )
  RETURNING id INTO v_action_id;

  RETURN jsonb_build_object(
    'status', 'applied',
    'action_id', v_action_id,
    'post_id', p_post_id,
    'action', p_action,
    'post_review_status', v_status_after,
    'post_review_status_before', v_post.review_status,
    'media_revocation_required', v_media_revoked,
    'resolved_report_count', v_resolved_count,
    'affected_bundle_count', coalesce(array_length(v_drafted, 1), 0),
    'affected_asset_count', coalesce(array_length(v_unlisted, 1), 0)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.apply_admin_post_moderation(uuid, uuid, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_admin_post_moderation(uuid, uuid, text, text, text)
  TO service_role;

COMMENT ON FUNCTION public.apply_admin_post_moderation(uuid, uuid, text, text, text) IS
  'Service-role-only proactive post moderation: hide, take down, or restore a post with no report attached.';
