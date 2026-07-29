-- Subject-report resolution notes.
--
-- `post_reports` has recorded a `resolution_note` since the ops CLI shipped, so
-- a post takedown always carries its rationale. Subject reports (user,
-- generation, comment) had no equivalent: the resolver accepted only an action,
-- which meant a moderator could resolve a report and leave nothing behind
-- explaining why. That is the weakest part of the audit trail — an appeal
-- cannot be answered from a status change alone.
--
-- The note is mandatory at the function boundary rather than optional, so the
-- admin console and any future caller are held to the same standard the
-- post-report path already enforces.

ALTER TABLE public.moderation_reports
  ADD COLUMN IF NOT EXISTS resolution_note text
    CHECK (resolution_note IS NULL OR char_length(btrim(resolution_note)) BETWEEN 3 AND 1000);

COMMENT ON COLUMN public.moderation_reports.resolution_note IS
  'Moderator rationale captured at decision time. Null only for reports resolved before this column existed.';

-- The signature changes, so the old three-argument version must go rather than
-- linger as an overload that silently skips the note.
DROP FUNCTION IF EXISTS public.resolve_subject_report_for_ops(uuid, uuid, text);

CREATE OR REPLACE FUNCTION public.resolve_subject_report_for_ops(
  p_report_id uuid,
  p_reviewer_id uuid,
  p_action text,
  p_resolution_note text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_report public.moderation_reports%ROWTYPE;
  v_now timestamptz := timezone('utc'::text, now());
  v_note text := nullif(btrim(coalesce(p_resolution_note, '')), '');
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

  IF v_note IS NULL OR char_length(v_note) < 3 OR char_length(v_note) > 1000 THEN
    RAISE EXCEPTION 'A resolution note of 3 to 1000 characters is required'
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
      'resolution_note', v_report.resolution_note,
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

    -- Duplicates for the same comment inherit this decision's note: they were
    -- closed by this action, so the rationale that closed them is this one.
    UPDATE public.moderation_reports
    SET status = 'resolved',
        reviewed_at = v_now,
        reviewed_by = p_reviewer_id,
        resolution_note = v_note,
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
      'resolution_note', v_note,
      'reviewed_at', v_now,
      'reviewed_by', p_reviewer_id
    );
  END IF;

  UPDATE public.moderation_reports
  SET status = CASE WHEN p_action = 'resolve' THEN 'resolved' ELSE 'dismissed' END,
      reviewed_at = v_now,
      reviewed_by = p_reviewer_id,
      resolution_note = v_note,
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
    'resolution_note', v_note,
    'reviewed_at', v_now,
    'reviewed_by', p_reviewer_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_subject_report_for_ops(uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_subject_report_for_ops(uuid, uuid, text, text)
  TO service_role;

COMMENT ON FUNCTION public.resolve_subject_report_for_ops(uuid, uuid, text, text) IS
  'Service-role-only atomic subject-report decision with a mandatory rationale; confirmed comment reports soft-remove the comment and resolve duplicate reports.';
