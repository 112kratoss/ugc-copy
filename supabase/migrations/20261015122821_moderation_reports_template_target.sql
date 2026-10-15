-- Template reports.
--
-- Templates are user-generated (a creator's name, description and demo media)
-- and are listed to signed-out visitors, guests and App Review, yet nothing
-- could report one: the queue took users, generations and comments only, so an
-- offensive template could be removed with SQL alone. A template becomes a
-- fourth target of the same queue, the way comments joined it in
-- 20260727140000_post_comments.sql, so POST /api/moderation/reports, the admin
-- console and `npm run ops:moderation` keep one shape.

ALTER TABLE public.moderation_reports
  ADD COLUMN IF NOT EXISTS template_id uuid REFERENCES public.templates(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.moderation_reports.template_id IS
  'The reported template when target_type = ''template''. Resolving such a report disables the template.';

ALTER TABLE public.moderation_reports
  DROP CONSTRAINT IF EXISTS moderation_reports_target_type_check;

ALTER TABLE public.moderation_reports
  ADD CONSTRAINT moderation_reports_target_type_check
    CHECK (target_type IN ('user', 'generation', 'comment', 'template'));

ALTER TABLE public.moderation_reports
  DROP CONSTRAINT IF EXISTS moderation_reports_target_shape;

ALTER TABLE public.moderation_reports
  ADD CONSTRAINT moderation_reports_target_shape CHECK (
    (target_type = 'user' AND generation_id IS NULL AND comment_id IS NULL AND template_id IS NULL)
    OR (target_type = 'generation' AND reported_user_id IS NULL AND comment_id IS NULL AND template_id IS NULL)
    OR (target_type = 'comment' AND reported_user_id IS NULL AND generation_id IS NULL AND template_id IS NULL)
    OR (target_type = 'template' AND reported_user_id IS NULL AND generation_id IS NULL AND comment_id IS NULL)
  );

-- A template is reported with the reasons a post's own content is (spam,
-- stolen content, unsafe content, other), so 'stolen_content' joins the list.
-- Declared inline in 20260720150842, the constraint carries the name Postgres
-- generates for a column check (<table>_<column>_check), as the source-surface
-- constraint below does.
ALTER TABLE public.moderation_reports
  DROP CONSTRAINT IF EXISTS moderation_reports_reason_check;

ALTER TABLE public.moderation_reports
  ADD CONSTRAINT moderation_reports_reason_check CHECK (
    reason IN (
      'spam',
      'harassment',
      'impersonation',
      'unsafe_content',
      'offensive_ai_output',
      'stolen_content',
      'other'
    )
  );

ALTER TABLE public.moderation_reports
  DROP CONSTRAINT IF EXISTS moderation_reports_source_surface_check;

ALTER TABLE public.moderation_reports
  ADD CONSTRAINT moderation_reports_source_surface_check
    CHECK (source_surface IN (
      'showcase',
      'showcase-reel',
      'creator-profile',
      'generation-viewer',
      'comments',
      'template-detail'
    ));

CREATE INDEX IF NOT EXISTS moderation_reports_template_created_idx
  ON public.moderation_reports (template_id, created_at DESC)
  WHERE template_id IS NOT NULL;

-- One open report per reporter per template. The index is the guard, so two
-- taps racing each other still file one report, and the route answers the
-- second 409 ALREADY_REPORTED. A decided report leaves the index, so the same
-- person can report the template again after a decision.
CREATE UNIQUE INDEX IF NOT EXISTS moderation_reports_one_open_template_report_idx
  ON public.moderation_reports (template_id, reporter_user_id)
  WHERE target_type = 'template' AND status IN ('open', 'reviewing');

COMMENT ON TABLE public.moderation_reports IS
  'Backend-owned moderation queue for reports of users, private AI generations, comments and templates.';

-- The resolver keeps its signature (one function, so no caller can skip the
-- note) and gains the template take-down beside the comment one: the decision,
-- the take-down and every duplicate report commit together, from the console
-- and from the ops CLI alike.
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
  v_template_status text;
  v_template_disabled boolean := false;
  v_disabled_count integer := 0;
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

  -- Decisions for duplicate reports about one comment or one template must
  -- acquire the shared content lock before an individual report lock. This
  -- gives concurrent moderators one lock order and avoids report1 -> content /
  -- report2 -> content deadlocks when the winner resolves every duplicate.
  -- The template lock is NO KEY UPDATE: the take-down changes no key, so runs
  -- being created against the template (their foreign key takes KEY SHARE)
  -- are not held behind a decision.
  IF v_report.target_type = 'comment' AND v_report.comment_id IS NOT NULL THEN
    PERFORM 1
    FROM public.post_comments AS target
    WHERE target.id = v_report.comment_id
    FOR UPDATE;
  ELSIF v_report.target_type = 'template' AND v_report.template_id IS NOT NULL THEN
    PERFORM 1
    FROM public.templates AS target
    WHERE target.id = v_report.template_id
    FOR NO KEY UPDATE;
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

    IF v_report.template_id IS NOT NULL THEN
      SELECT target.status
      INTO v_template_status
      FROM public.templates AS target
      WHERE target.id = v_report.template_id;
    END IF;

    RETURN jsonb_build_object(
      'status', 'already_resolved',
      'report_id', v_report.id,
      'target_type', v_report.target_type,
      'comment_id', v_report.comment_id,
      'comment_status', v_comment_status,
      'comment_removed', false,
      'template_id', v_report.template_id,
      'template_status', v_template_status,
      'template_disabled', false,
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
      'template_id', null,
      'template_status', null,
      'template_disabled', false,
      'resolved_report_count', v_resolved_count,
      'resolution_note', v_note,
      'reviewed_at', v_now,
      'reviewed_by', p_reviewer_id
    );
  END IF;

  IF v_report.target_type = 'template' AND p_action = 'resolve' THEN
    IF v_report.template_id IS NULL THEN
      RAISE EXCEPTION 'Reported template no longer exists'
        USING ERRCODE = 'P0002';
    END IF;

    -- The take-down writes what the creator's own Disable writes
    -- (`disableMediaTemplate`, src/lib/media-template-service.ts) and what a
    -- catalog release writes when it drops a template's model: the template
    -- leaves the catalog, its page answers "not found" to everyone but its
    -- creator, and no new run can start. Runs already started keep their
    -- snapshot.
    UPDATE public.templates AS target
    SET status = 'disabled',
        is_active = false
    WHERE target.id = v_report.template_id
      AND (target.status <> 'disabled' OR target.is_active IS DISTINCT FROM false);

    GET DIAGNOSTICS v_disabled_count = ROW_COUNT;
    v_template_disabled := v_disabled_count > 0;

    SELECT target.status
    INTO v_template_status
    FROM public.templates AS target
    WHERE target.id = v_report.template_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Reported template no longer exists'
        USING ERRCODE = 'P0002';
    END IF;

    -- Duplicates for the same template were closed by this action, so they
    -- carry its reviewer and its note.
    UPDATE public.moderation_reports
    SET status = 'resolved',
        reviewed_at = v_now,
        reviewed_by = p_reviewer_id,
        resolution_note = v_note,
        updated_at = v_now
    WHERE template_id = v_report.template_id
      AND status IN ('open', 'reviewing');

    GET DIAGNOSTICS v_resolved_count = ROW_COUNT;

    RETURN jsonb_build_object(
      'status', 'resolved',
      'report_id', v_report.id,
      'target_type', v_report.target_type,
      'comment_id', null,
      'comment_status', null,
      'comment_removed', false,
      'template_id', v_report.template_id,
      'template_status', v_template_status,
      'template_disabled', v_template_disabled,
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
    'template_id', v_report.template_id,
    'template_status', null,
    'template_disabled', false,
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
  'Service-role-only atomic subject-report decision with a mandatory rationale; confirmed comment reports soft-remove the comment, confirmed template reports disable the template, and either resolves the duplicate reports.';
