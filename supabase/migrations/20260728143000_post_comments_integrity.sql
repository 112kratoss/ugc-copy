-- Close the integrity and moderation gaps in the initial post-comments release.
--
-- This migration deliberately replaces the service-role RPCs instead of
-- modifying the already-applied post-comments migration.

-- Keep conversation structure when a commenter deletes their account. The
-- BEFORE DELETE trigger below soft-removes active comments and fixes counters;
-- this FK then anonymizes the author reference without cascading through other
-- users' replies.
ALTER TABLE public.post_comments
  DROP CONSTRAINT IF EXISTS post_comments_user_id_fkey;

ALTER TABLE public.post_comments
  ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE public.post_comments
  ADD CONSTRAINT post_comments_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION public.anonymize_post_comments_before_auth_user_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_removed record;
BEGIN
  -- UPDATE locks each matching row. A concurrent author/owner/moderator removal
  -- can therefore win only once, and only rows transitioned from active are
  -- reflected in the denormalized counters.
  FOR v_removed IN
    UPDATE public.post_comments AS target
    SET status = 'removed_by_author'
    WHERE target.user_id = OLD.id
      AND target.status = 'active'
    RETURNING target.post_id, target.parent_comment_id
  LOOP
    UPDATE public.posts AS post
    SET comment_count = greatest(0, post.comment_count - 1)
    WHERE post.id = v_removed.post_id;

    IF v_removed.parent_comment_id IS NOT NULL THEN
      UPDATE public.post_comments AS parent
      SET reply_count = greatest(0, parent.reply_count - 1)
      WHERE parent.id = v_removed.parent_comment_id;
    END IF;
  END LOOP;

  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.anonymize_post_comments_before_auth_user_delete()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS auth_users_anonymize_post_comments_before_delete
  ON auth.users;
CREATE TRIGGER auth_users_anonymize_post_comments_before_delete
BEFORE DELETE ON auth.users
FOR EACH ROW
EXECUTE FUNCTION public.anonymize_post_comments_before_auth_user_delete();

CREATE OR REPLACE FUNCTION public.create_post_comment(
  p_post_id uuid,
  p_user_id uuid,
  p_parent_comment_id uuid,
  p_body text
)
RETURNS TABLE (
  comment_id uuid,
  created_at timestamptz,
  comment_count integer,
  parent_reply_count integer
) AS $$
DECLARE
  v_body text;
  v_comment_id uuid;
  v_created_at timestamptz;
  v_comment_count integer := 0;
  v_parent_reply_count integer := 0;
  v_parent_status text;
  v_parent_post_id uuid;
  v_parent_parent_comment_id uuid;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'Missing user id';
  END IF;

  v_body := btrim(coalesce(p_body, ''));

  IF v_body = '' THEN
    RAISE EXCEPTION 'Comment body is required';
  END IF;

  IF char_length(v_body) > 2000 THEN
    RAISE EXCEPTION 'Comment body is too long';
  END IF;

  PERFORM 1
  FROM public.posts AS post
  WHERE post.id = p_post_id
    AND post.visibility = 'public'
    AND post.archived_at IS NULL
    AND post.review_status = 'visible';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Post is private or not found';
  END IF;

  IF p_parent_comment_id IS NOT NULL THEN
    -- Serialize reply creation against removal of its parent. The product
    -- contract is intentionally one level deep, so a reply can target only a
    -- top-level comment.
    SELECT parent.status, parent.post_id, parent.parent_comment_id
    INTO v_parent_status, v_parent_post_id, v_parent_parent_comment_id
    FROM public.post_comments AS parent
    WHERE parent.id = p_parent_comment_id
    FOR UPDATE;

    IF NOT FOUND OR v_parent_post_id IS DISTINCT FROM p_post_id THEN
      RAISE EXCEPTION 'Parent comment not found';
    END IF;

    IF v_parent_parent_comment_id IS NOT NULL THEN
      RAISE EXCEPTION 'Replies can only target top-level comments';
    END IF;

    IF v_parent_status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'Parent comment is not available';
    END IF;
  END IF;

  INSERT INTO public.post_comments AS inserted (post_id, user_id, parent_comment_id, body)
  VALUES (p_post_id, p_user_id, p_parent_comment_id, v_body)
  RETURNING inserted.id, inserted.created_at
  INTO v_comment_id, v_created_at;

  UPDATE public.posts AS post
  SET comment_count = post.comment_count + 1
  WHERE post.id = p_post_id
  RETURNING post.comment_count INTO v_comment_count;

  IF p_parent_comment_id IS NOT NULL THEN
    UPDATE public.post_comments AS parent
    SET reply_count = parent.reply_count + 1
    WHERE parent.id = p_parent_comment_id
    RETURNING parent.reply_count INTO v_parent_reply_count;
  END IF;

  RETURN QUERY
  SELECT v_comment_id, v_created_at, coalesce(v_comment_count, 0), coalesce(v_parent_reply_count, 0);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.set_post_comment_status(
  p_comment_id uuid,
  p_actor_user_id uuid,
  p_next_status text
)
RETURNS TABLE (
  changed boolean,
  comment_count integer
) AS $$
DECLARE
  v_author_user_id uuid;
  v_post_id uuid;
  v_parent_comment_id uuid;
  v_status text;
  v_post_owner_user_id uuid;
  v_changed boolean := false;
  v_comment_count integer := 0;
  v_updated_count integer := 0;
BEGIN
  IF p_next_status NOT IN ('removed_by_author', 'removed_by_owner', 'removed_by_moderation') THEN
    RAISE EXCEPTION 'Unsupported comment status';
  END IF;

  -- Lock the comment before checking its status. Concurrent removals then
  -- observe the first committed transition and cannot decrement counters twice.
  SELECT target.user_id, target.post_id, target.parent_comment_id, target.status, post.user_id
  INTO v_author_user_id, v_post_id, v_parent_comment_id, v_status, v_post_owner_user_id
  FROM public.post_comments AS target
  JOIN public.posts AS post ON post.id = target.post_id
  WHERE target.id = p_comment_id
  FOR UPDATE OF target;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Comment not found';
  END IF;

  IF p_next_status = 'removed_by_author' THEN
    IF p_actor_user_id IS NULL OR p_actor_user_id IS DISTINCT FROM v_author_user_id THEN
      RAISE EXCEPTION 'Only the comment author can delete this comment';
    END IF;
  ELSIF p_next_status = 'removed_by_owner' THEN
    IF p_actor_user_id IS NULL OR p_actor_user_id IS DISTINCT FROM v_post_owner_user_id THEN
      RAISE EXCEPTION 'Only the post owner can remove this comment';
    END IF;
  END IF;

  IF v_status = 'active' THEN
    UPDATE public.post_comments AS target
    SET status = p_next_status
    WHERE target.id = p_comment_id
      AND target.status = 'active';

    GET DIAGNOSTICS v_updated_count = ROW_COUNT;
    v_changed := v_updated_count = 1;

    IF v_changed THEN
      UPDATE public.posts AS post
      SET comment_count = greatest(0, post.comment_count - 1)
      WHERE post.id = v_post_id;

      IF v_parent_comment_id IS NOT NULL THEN
        UPDATE public.post_comments AS parent
        SET reply_count = greatest(0, parent.reply_count - 1)
        WHERE parent.id = v_parent_comment_id;
      END IF;
    END IF;
  END IF;

  SELECT coalesce(post.comment_count, 0)
  INTO v_comment_count
  FROM public.posts AS post
  WHERE post.id = v_post_id;

  RETURN QUERY SELECT v_changed, coalesce(v_comment_count, 0);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.create_post_comment(uuid, uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_post_comment_status(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_post_comment(uuid, uuid, uuid, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.set_post_comment_status(uuid, uuid, text)
  TO service_role;

-- Resolve comment reports and remove confirmed violating comments in one
-- transaction. User and generation subjects retain their existing manual-action
-- workflow, but now share the same atomic, reviewer-validated report resolver.
CREATE OR REPLACE FUNCTION public.resolve_subject_report_for_ops(
  p_report_id uuid,
  p_reviewer_id uuid,
  p_action text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_report public.moderation_reports%ROWTYPE;
  v_now timestamptz := timezone('utc'::text, now());
  v_comment_status text;
  v_comment_removed boolean := false;
  v_comment_count integer;
  v_resolved_count integer := 0;
BEGIN
  IF p_report_id IS NULL OR p_reviewer_id IS NULL THEN
    RAISE EXCEPTION 'Report and reviewer are required'
      USING ERRCODE = '22023';
  END IF;

  IF p_action IS NULL OR p_action NOT IN ('resolve', 'dismiss') THEN
    RAISE EXCEPTION 'Unsupported moderation action'
      USING ERRCODE = '22023';
  END IF;

  PERFORM 1
  FROM auth.users
  WHERE id = p_reviewer_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reviewer not found'
      USING ERRCODE = '23503';
  END IF;

  SELECT *
  INTO v_report
  FROM public.moderation_reports
  WHERE id = p_report_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Moderation report not found'
      USING ERRCODE = 'P0002';
  END IF;

  -- Decisions for duplicate reports about one comment must acquire the shared
  -- content lock before an individual report lock. This gives concurrent
  -- moderators one lock order and avoids report1 -> comment / report2 ->
  -- comment deadlocks when the winner resolves every duplicate.
  IF v_report.target_type = 'comment' AND v_report.comment_id IS NOT NULL THEN
    PERFORM 1
    FROM public.post_comments AS target
    WHERE target.id = v_report.comment_id
    FOR UPDATE;
  END IF;

  SELECT *
  INTO v_report
  FROM public.moderation_reports
  WHERE id = p_report_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Moderation report not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_report.status NOT IN ('open', 'reviewing') THEN
    IF v_report.comment_id IS NOT NULL THEN
      SELECT target.status
      INTO v_comment_status
      FROM public.post_comments AS target
      WHERE target.id = v_report.comment_id;
    END IF;

    RETURN jsonb_build_object(
      'status', 'already_resolved',
      'report_id', v_report.id,
      'target_type', v_report.target_type,
      'comment_id', v_report.comment_id,
      'comment_status', v_comment_status,
      'comment_removed', false,
      'reviewed_at', v_report.reviewed_at,
      'reviewed_by', v_report.reviewed_by
    );
  END IF;

  IF v_report.target_type = 'comment' AND p_action = 'resolve' THEN
    IF v_report.comment_id IS NULL THEN
      RAISE EXCEPTION 'Reported comment no longer exists'
        USING ERRCODE = 'P0002';
    END IF;

    SELECT target.status
    INTO v_comment_status
    FROM public.post_comments AS target
    WHERE target.id = v_report.comment_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Reported comment no longer exists'
        USING ERRCODE = 'P0002';
    END IF;

    SELECT status_result.changed, status_result.comment_count
    INTO v_comment_removed, v_comment_count
    FROM public.set_post_comment_status(
      v_report.comment_id,
      p_reviewer_id,
      'removed_by_moderation'
    ) AS status_result;

    SELECT target.status
    INTO v_comment_status
    FROM public.post_comments AS target
    WHERE target.id = v_report.comment_id;

    UPDATE public.moderation_reports
    SET status = 'resolved',
        reviewed_at = v_now,
        reviewed_by = p_reviewer_id,
        updated_at = v_now
    WHERE comment_id = v_report.comment_id
      AND status IN ('open', 'reviewing');

    GET DIAGNOSTICS v_resolved_count = ROW_COUNT;

    RETURN jsonb_build_object(
      'status', 'resolved',
      'report_id', v_report.id,
      'target_type', v_report.target_type,
      'comment_id', v_report.comment_id,
      'comment_status', v_comment_status,
      'comment_removed', v_comment_removed,
      'comment_count', v_comment_count,
      'resolved_report_count', v_resolved_count,
      'reviewed_at', v_now,
      'reviewed_by', p_reviewer_id
    );
  END IF;

  UPDATE public.moderation_reports
  SET status = CASE WHEN p_action = 'resolve' THEN 'resolved' ELSE 'dismissed' END,
      reviewed_at = v_now,
      reviewed_by = p_reviewer_id,
      updated_at = v_now
  WHERE id = v_report.id
    AND status IN ('open', 'reviewing');

  RETURN jsonb_build_object(
    'status', CASE WHEN p_action = 'resolve' THEN 'resolved' ELSE 'dismissed' END,
    'report_id', v_report.id,
    'target_type', v_report.target_type,
    'comment_id', v_report.comment_id,
    'comment_status', null,
    'comment_removed', false,
    'reviewed_at', v_now,
    'reviewed_by', p_reviewer_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_subject_report_for_ops(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_subject_report_for_ops(uuid, uuid, text)
  TO service_role;

COMMENT ON FUNCTION public.resolve_subject_report_for_ops(uuid, uuid, text) IS
  'Service-role-only atomic subject-report decision; confirmed comment reports soft-remove the comment and resolve duplicate reports.';

-- Repair any drift introduced before this migration. These updates are also a
-- final invariant check after changing account-deletion behavior.
UPDATE public.posts AS post
SET comment_count = counters.active_count
FROM (
  SELECT candidate.id AS post_id, count(comment.id)::integer AS active_count
  FROM public.posts AS candidate
  LEFT JOIN public.post_comments AS comment
    ON comment.post_id = candidate.id
   AND comment.status = 'active'
  GROUP BY candidate.id
) AS counters
WHERE post.id = counters.post_id
  AND post.comment_count IS DISTINCT FROM counters.active_count;

UPDATE public.post_comments AS parent
SET reply_count = counters.active_count
FROM (
  SELECT candidate.id AS parent_id, count(reply.id)::integer AS active_count
  FROM public.post_comments AS candidate
  LEFT JOIN public.post_comments AS reply
    ON reply.parent_comment_id = candidate.id
   AND reply.status = 'active'
  GROUP BY candidate.id
) AS counters
WHERE parent.id = counters.parent_id
  AND parent.reply_count IS DISTINCT FROM counters.active_count;
