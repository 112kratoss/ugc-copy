-- What a guest leaves behind when it registers (2026-10-15 auth, onboarding and
-- pricing comparison): the merge carries its feed preferences (finding 02-5),
-- and the account it is linked to can publish its creations, with their
-- exposure following the post (finding 02-4, below the merge).
--
-- A guest's Hide and Not interested are stored under its own uid
-- (feed_user_creator_feedback, feed_user_post_feedback, written by
-- record_showcase_feed_events and showcase-feed-events-service.ts), and every
-- read of them asks for the viewer's own rows only: the v4 candidate SQL
-- (20261012061058), the feed's viewer relations and the exclusions route.
-- merge_guest_account moved the balances and nothing else, so a creator the
-- guest had hidden was back on the same phone the minute the person created an
-- account, and the interest weights built as a guest were dropped the same way.
--
-- Hide and Not interested now move to the account. Where the account already
-- has a row for the same post or creator, its own row is kept. Interest weights
-- are copied rather than moved: refresh_user_interest_weights rebuilds each
-- user's rows from that user's own events, creations and onboarding goal, so
-- the guest's rows would come back at its next refresh anyway, and the copy is
-- what the account ranks with until its own refresh replaces it.
--
-- merge_guest_account is otherwise 20260926135311's: the same eligibility,
-- lock order, balances, ledger row, replay answer and grants.

-- One function for the merge and for the guests linked before this migration.
-- Invoker rights and no grant to any role: only the merge, which runs as its
-- owner, and this migration call it.
CREATE OR REPLACE FUNCTION public.carry_guest_feed_preferences(
  p_guest_user_id uuid,
  p_target_user_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  -- Only onto the account this guest is linked to, so no call can hand one
  -- person's preferences to someone else. With the two ids equal, the delete
  -- below would remove rows the insert then finds taken.
  IF p_guest_user_id IS NOT DISTINCT FROM p_target_user_id
     OR NOT EXISTS (
       SELECT 1
       FROM public.profiles AS guest
       WHERE guest.id = p_guest_user_id
         AND guest.merged_into_user_id = p_target_user_id
     ) THEN
    RETURN;
  END IF;

  -- Delete and insert in one statement, so a guest row only ever leaves
  -- together with its copy: a write racing the merge stays on the guest rather
  -- than vanishing. An inactive row holds no preference and is not carried.
  WITH moved AS (
    DELETE FROM public.feed_user_post_feedback AS feedback
    WHERE feedback.user_id = p_guest_user_id
    RETURNING
      feedback.post_id,
      feedback.feedback_type,
      feedback.is_active,
      feedback.reason,
      feedback.first_recorded_at,
      feedback.updated_at
  )
  INSERT INTO public.feed_user_post_feedback (
    user_id,
    post_id,
    feedback_type,
    is_active,
    reason,
    first_recorded_at,
    updated_at
  )
  SELECT
    p_target_user_id,
    moved.post_id,
    moved.feedback_type,
    moved.is_active,
    moved.reason,
    moved.first_recorded_at,
    moved.updated_at
  FROM moved
  WHERE moved.is_active
  ON CONFLICT (user_id, post_id) DO NOTHING;

  -- A guest that hid the account itself carries nothing over: an account
  -- cannot hide itself (feed_user_creator_feedback_not_self_check), and the
  -- violation would roll back the whole merge.
  WITH moved AS (
    DELETE FROM public.feed_user_creator_feedback AS feedback
    WHERE feedback.user_id = p_guest_user_id
    RETURNING
      feedback.creator_user_id,
      feedback.feedback_type,
      feedback.is_active,
      feedback.reason,
      feedback.first_recorded_at,
      feedback.updated_at
  )
  INSERT INTO public.feed_user_creator_feedback (
    user_id,
    creator_user_id,
    feedback_type,
    is_active,
    reason,
    first_recorded_at,
    updated_at
  )
  SELECT
    p_target_user_id,
    moved.creator_user_id,
    moved.feedback_type,
    moved.is_active,
    moved.reason,
    moved.first_recorded_at,
    moved.updated_at
  FROM moved
  WHERE moved.is_active
    AND moved.creator_user_id <> p_target_user_id
  ON CONFLICT (user_id, creator_user_id) DO NOTHING;

  -- refresh_user_interest_weights deletes and rebuilds a batch of users'
  -- weights while it holds this lock. Writing the account's weights at the same
  -- moment could deadlock the two, and a deadlock here would roll back the
  -- merge, balance and all. So the copy waits for nothing: while the refresh
  -- holds the lock the copy is skipped (that refresh is rebuilding weights
  -- anyway), and a refresh that starts while a merge holds it skips one run.
  IF NOT pg_try_advisory_xact_lock(
    hashtextextended('refresh_user_interest_weights', 0)
  ) THEN
    RETURN;
  END IF;

  INSERT INTO public.user_interest_weights (
    user_id,
    dimension_type,
    dimension_value,
    weight,
    positive_score,
    negative_score,
    positive_event_count,
    negative_event_count,
    last_event_at,
    last_event_received_at,
    updated_at
  )
  SELECT
    p_target_user_id,
    interests.dimension_type,
    interests.dimension_value,
    interests.weight,
    interests.positive_score,
    interests.negative_score,
    interests.positive_event_count,
    interests.negative_event_count,
    interests.last_event_at,
    interests.last_event_received_at,
    interests.updated_at
  FROM public.user_interest_weights AS interests
  WHERE interests.user_id = p_guest_user_id
  ON CONFLICT (user_id, dimension_type, dimension_value) DO NOTHING;
END;
$$;

-- The merge's owner reaches this through ownership, the only grant left on it.
ALTER FUNCTION public.carry_guest_feed_preferences(uuid, uuid)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.carry_guest_feed_preferences(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.carry_guest_feed_preferences(uuid, uuid) IS
  'Moves a linked guest''s active Hide and Not interested rows to the account it is linked to and copies its interest weights; the account''s own rows win every conflict. Called by merge_guest_account only.';

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

-- A creation made as a guest keeps the guest's id after the merge, and the
-- account it is linked to publishes it as its own: showcase-publish-service.ts
-- checks ownership with isOwnOrLinkedAccountId and writes the post as the
-- caller. This RPC still required generations.user_id to be the caller, so that
-- publish failed here. Ownership now also accepts a generation whose owner is a
-- guest linked to the caller, in the check and in the update alike; the post is
-- still the caller's. 20260508143000's body otherwise, with the grants
-- 20260621103236 left it.
CREATE OR REPLACE FUNCTION public.publish_generation_post_with_resource_bundle(
  p_generation_id uuid,
  p_owner_user_id uuid,
  p_generation_update jsonb,
  p_post jsonb,
  p_bundle jsonb DEFAULT NULL,
  p_has_bundle boolean DEFAULT false
)
RETURNS TABLE(post_id uuid, visibility text, bundle_id uuid, bundle_status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_generation_update jsonb := coalesce(p_generation_update, '{}'::jsonb);
  v_post_owner uuid := nullif(p_post->>'user_id', '')::uuid;
BEGIN
  IF v_post_owner IS DISTINCT FROM p_owner_user_id THEN
    RAISE EXCEPTION 'Post owner must match generation owner';
  END IF;

  PERFORM 1
  FROM public.generations
  WHERE id = p_generation_id
    AND (
      user_id = p_owner_user_id
      OR EXISTS (
        SELECT 1
        FROM public.profiles AS owner
        WHERE owner.id = generations.user_id
          AND owner.merged_into_user_id = p_owner_user_id
      )
    )
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Generation not found or not owned by user';
  END IF;

  UPDATE public.generations
  SET is_public = CASE WHEN v_generation_update ? 'is_public' THEN (v_generation_update->>'is_public')::boolean ELSE is_public END,
      share_input_media_for_remix = CASE
        WHEN v_generation_update ? 'share_input_media_for_remix'
          THEN (v_generation_update->>'share_input_media_for_remix')::boolean
        ELSE share_input_media_for_remix
      END,
      showcase_asset_path = CASE WHEN v_generation_update ? 'showcase_asset_path' THEN nullif(btrim(v_generation_update->>'showcase_asset_path'), '') ELSE showcase_asset_path END,
      title = CASE WHEN v_generation_update ? 'title' THEN nullif(btrim(v_generation_update->>'title'), '') ELSE title END,
      description = CASE WHEN v_generation_update ? 'description' THEN nullif(btrim(v_generation_update->>'description'), '') ELSE description END,
      prompt = CASE WHEN v_generation_update ? 'prompt' THEN nullif(btrim(v_generation_update->>'prompt'), '') ELSE prompt END,
      category = CASE WHEN v_generation_update ? 'category' THEN v_generation_update->>'category' ELSE category END,
      workflow_settings = CASE WHEN v_generation_update ? 'workflow_settings' THEN v_generation_update->'workflow_settings' ELSE workflow_settings END
  WHERE id = p_generation_id
    AND (
      user_id = p_owner_user_id
      OR EXISTS (
        SELECT 1
        FROM public.profiles AS owner
        WHERE owner.id = generations.user_id
          AND owner.merged_into_user_id = p_owner_user_id
      )
    );

  RETURN QUERY
  SELECT result.post_id, result.visibility, result.bundle_id, result.bundle_status
  FROM public.upsert_post_with_resource_bundle(p_post, p_bundle, p_has_bundle) AS result;
END;
$$;

REVOKE ALL ON FUNCTION public.publish_generation_post_with_resource_bundle(uuid, uuid, jsonb, jsonb, jsonb, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publish_generation_post_with_resource_bundle(uuid, uuid, jsonb, jsonb, jsonb, boolean) TO service_role;

-- The same link, from the post's side. posts_sync_generation_exposure matched
-- the generation by the post owner's id, so the post of a guest-made creation
-- left its generation's exposure where it was when the post was archived,
-- made private, deleted or moved off it: a public copy nothing would revoke.
-- Each of its three matches now also accepts a generation owned by a guest
-- linked to the post's owner. 20260916090000's body otherwise, with its owner,
-- grants and comment.
CREATE OR REPLACE FUNCTION public.sync_generation_exposure_with_post()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_post_id uuid;
  v_generation_id uuid;
  v_owner_user_id uuid;
  v_new_path text;
  v_generation_path text;
  v_dropped_path text;
  v_reason text;
  v_exposed boolean := false;
  v_is_public boolean := false;
  v_path text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Account erasure deletes posts through a cascade, and its own sweep owns
    -- that media. Only a direct delete is handled here.
    IF pg_trigger_depth() > 1 THEN
      RETURN NULL;
    END IF;

    v_post_id := OLD.id;
    v_generation_id := OLD.generation_id;
    v_owner_user_id := OLD.user_id;
    v_dropped_path := OLD.showcase_asset_path;
    v_reason := 'post_deleted';
  ELSE
    v_post_id := NEW.id;
    v_generation_id := NEW.generation_id;
    v_owner_user_id := NEW.user_id;
    v_new_path := NEW.showcase_asset_path;
    v_exposed := NEW.visibility <> 'private' AND NEW.archived_at IS NULL;
    -- Hidden content can never be public: generations_prevent_hidden_republish
    -- raises on that, and would roll the post write back with it.
    v_is_public := NEW.visibility = 'public'
      AND NEW.archived_at IS NULL
      AND coalesce(NEW.review_status, 'visible') <> 'hidden';

    IF TG_OP = 'UPDATE' THEN
      -- A generation the post stops linking to loses the post's exposure.
      IF OLD.generation_id IS NOT NULL AND OLD.generation_id IS DISTINCT FROM NEW.generation_id THEN
        UPDATE public.generations AS generations
        SET is_public = false,
            showcase_asset_path = NULL
        WHERE generations.id = OLD.generation_id
          AND (
            generations.user_id = OLD.user_id
            OR EXISTS (
              SELECT 1
              FROM public.profiles AS owner
              WHERE owner.id = generations.user_id
                AND owner.merged_into_user_id = OLD.user_id
            )
          )
          AND generations.moderation_removed_at IS NULL
          AND (generations.is_public OR generations.showcase_asset_path IS NOT NULL);
      END IF;

      -- An unexposed post that drops its derivative no longer needs the public
      -- copy. Archiving keeps the path, and with it the copy, for restore; a
      -- tombstone keeps both for the buyers.
      IF NOT v_exposed
        AND OLD.showcase_asset_path IS NOT NULL
        AND NEW.showcase_asset_path IS NULL THEN
        v_dropped_path := OLD.showcase_asset_path;
        v_reason := 'post_unexposed';
      END IF;
    END IF;
  END IF;

  IF v_generation_id IS NULL OR v_owner_user_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- An operator removal owns the generation's exposure while it stands.
  SELECT generations.showcase_asset_path
  INTO v_generation_path
  FROM public.generations AS generations
  WHERE generations.id = v_generation_id
    AND (
      generations.user_id = v_owner_user_id
      OR EXISTS (
        SELECT 1
        FROM public.profiles AS owner
        WHERE owner.id = generations.user_id
          AND owner.merged_into_user_id = v_owner_user_id
      )
    )
    AND generations.moderation_removed_at IS NULL;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- A still-exposed post without a path of its own keeps the generation's:
  -- older creation posts only ever recorded the derivative on the generation.
  v_path := CASE WHEN v_exposed THEN coalesce(v_new_path, v_generation_path) END;

  UPDATE public.generations AS generations
  SET is_public = v_is_public,
      showcase_asset_path = v_path
  WHERE generations.id = v_generation_id
    AND (
      generations.user_id = v_owner_user_id
      OR EXISTS (
        SELECT 1
        FROM public.profiles AS owner
        WHERE owner.id = generations.user_id
          AND owner.merged_into_user_id = v_owner_user_id
      )
    )
    AND (
      generations.is_public IS DISTINCT FROM v_is_public
      OR generations.showcase_asset_path IS DISTINCT FROM v_path
    );

  IF v_reason IS NOT NULL THEN
    INSERT INTO public.showcase_media_revocations (
      generation_id, post_id, showcase_asset_path, reason
    )
    SELECT DISTINCT v_generation_id, v_post_id, candidates.path, v_reason
    FROM (VALUES (v_dropped_path), (v_generation_path)) AS candidates(path)
    WHERE nullif(btrim(candidates.path), '') IS NOT NULL
    ON CONFLICT (generation_id, showcase_asset_path) DO NOTHING;
  END IF;

  RETURN NULL;
END;
$$;

ALTER FUNCTION public.sync_generation_exposure_with_post()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sync_generation_exposure_with_post()
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.sync_generation_exposure_with_post() IS
  'Trusted posts trigger: keeps generations.is_public and showcase_asset_path in the post write''s transaction and queues public derivatives the post stopped needing.';

-- Guests linked before this migration lost their preferences at the time; this
-- gives them back. Oldest link first, the order those merges ran in, so an
-- account with several guests ends where the merge itself would have left it.
DO $carry_linked_guests$
DECLARE
  v_guest record;
BEGIN
  FOR v_guest IN
    SELECT profile.id, profile.merged_into_user_id
    FROM public.profiles AS profile
    WHERE profile.identity_state = 'merged'
    ORDER BY profile.merged_at, profile.id
  LOOP
    PERFORM public.carry_guest_feed_preferences(
      v_guest.id,
      v_guest.merged_into_user_id
    );
  END LOOP;
END;
$carry_linked_guests$;
