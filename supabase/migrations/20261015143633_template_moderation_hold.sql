-- Moderation take-down hold on templates.
--
-- A confirmed template report (20261015122821_moderation_reports_template_target.sql)
-- disables the template, the same state its creator's own Disable writes, and
-- activate_template_version makes a creator's template active again on any
-- publish. So a take-down lasted until the creator pressed Publish. The
-- take-down now also records when moderation took the template down, and
-- while that is set the template cannot go live again: activation refuses with
-- TEMPLATE_TAKEN_DOWN, and a check keeps every other writer out. No product
-- path clears it; lifting a take-down is a deliberate SQL change.

ALTER TABLE public.templates
  ADD COLUMN IF NOT EXISTS moderation_disabled_at timestamptz;

COMMENT ON COLUMN public.templates.moderation_disabled_at IS
  'When moderation took the template down. While set the template stays disabled and publishing refuses with TEMPLATE_TAKEN_DOWN.';

-- The hold belongs to the row, not to one code path: whichever writer touches
-- a held template next, it stays disabled.
ALTER TABLE public.templates
  DROP CONSTRAINT IF EXISTS templates_moderation_hold_check;

ALTER TABLE public.templates
  ADD CONSTRAINT templates_moderation_hold_check CHECK (
    moderation_disabled_at IS NULL
    OR (status = 'disabled' AND is_active IS NOT TRUE)
  );

-- Publishing keeps its signature and its body; it gains the refusal, checked
-- under the template row lock it already takes.
CREATE OR REPLACE FUNCTION public.activate_template_version(
  p_version_id uuid,
  p_template_id uuid,
  p_creator_id uuid,
  p_source_canvas_id uuid,
  p_source_canvas_revision integer,
  p_graph_snapshot jsonb,
  p_graph_hash text,
  p_snapshot_hash text,
  p_output_node_id text,
  p_output_kind text,
  p_input_manifest jsonb,
  p_estimated_total_credits integer,
  p_catalog_revision text,
  p_demo_output_url text,
  p_rights_confirmed_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_version_id uuid;
  v_version_number integer;
  v_inserted boolean := false;
  v_input_manifest jsonb;
  v_output_kind text;
  v_demo_output_url text;
  v_moderation_disabled_at timestamptz;
BEGIN
  SELECT moderation_disabled_at
  INTO v_moderation_disabled_at
  FROM public.templates
  WHERE id = p_template_id
    AND creator_user_id = p_creator_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Template not found';
  END IF;

  -- Read under the row lock: a take-down that committed first is always
  -- seen, and one that comes later waits for this publish, then disables it.
  IF v_moderation_disabled_at IS NOT NULL THEN
    RAISE EXCEPTION 'This template was taken down by moderation and cannot be republished.'
      USING ERRCODE = 'P0001', HINT = 'TEMPLATE_TAKEN_DOWN';
  END IF;

  SELECT id, input_manifest, output_kind, demo_output_url
  INTO v_version_id, v_input_manifest, v_output_kind, v_demo_output_url
  FROM public.template_versions
  WHERE template_id = p_template_id
    AND graph_hash = p_graph_hash
    AND source_canvas_revision = p_source_canvas_revision
    AND catalog_revision IS NOT DISTINCT FROM p_catalog_revision;

  IF v_version_id IS NULL THEN
    SELECT COALESCE(MAX(version_number), 0) + 1
    INTO v_version_number
    FROM public.template_versions
    WHERE template_id = p_template_id;

    INSERT INTO public.template_versions (
      id, template_id, version_number, source_canvas_id, source_canvas_revision,
      graph_snapshot, graph_hash, snapshot_hash, output_node_id, output_kind,
      input_manifest, estimated_total_credits, catalog_revision, demo_output_url,
      created_by, rights_confirmed_at
    ) VALUES (
      p_version_id, p_template_id, v_version_number, p_source_canvas_id,
      p_source_canvas_revision, p_graph_snapshot, p_graph_hash, p_snapshot_hash,
      p_output_node_id, p_output_kind, p_input_manifest,
      p_estimated_total_credits, p_catalog_revision, p_demo_output_url,
      p_creator_id, p_rights_confirmed_at
    );

    v_version_id := p_version_id;
    v_input_manifest := p_input_manifest;
    v_output_kind := p_output_kind;
    v_demo_output_url := p_demo_output_url;
    v_inserted := true;
  END IF;

  UPDATE public.templates
  SET active_version_id = v_version_id,
      source_canvas_id = p_source_canvas_id,
      draft_output_node_id = p_output_node_id,
      draft_catalog_revision = p_catalog_revision,
      input_slots = v_input_manifest,
      output_kind = v_output_kind,
      status = 'active',
      is_active = true,
      video_url = CASE WHEN v_output_kind = 'video' THEN v_demo_output_url ELSE NULL END,
      thumbnail_url = CASE WHEN v_output_kind = 'image' THEN v_demo_output_url ELSE thumbnail_url END
  WHERE id = p_template_id
    AND creator_user_id = p_creator_id;

  RETURN jsonb_build_object('version_id', v_version_id, 'inserted', v_inserted);
END;
$$;

REVOKE ALL ON FUNCTION public.activate_template_version(
  uuid, uuid, uuid, uuid, integer, jsonb, text, text, text, text,
  jsonb, integer, text, text, timestamptz
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.activate_template_version(
  uuid, uuid, uuid, uuid, integer, jsonb, text, text, text, text,
  jsonb, integer, text, text, timestamptz
) TO service_role;

COMMENT ON FUNCTION public.activate_template_version(
  uuid, uuid, uuid, uuid, integer, jsonb, text, text, text, text,
  jsonb, integer, text, text, timestamptz
) IS
  'Records a published template version and makes the template active; refuses a template moderation took down (HINT TEMPLATE_TAKEN_DOWN).';

-- The resolver keeps its signature and everything else it does; a template
-- take-down now also stamps the hold, and each answer carries
-- template_moderation_disabled_at.
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
  v_template_hold timestamptz;
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
      SELECT target.status, target.moderation_disabled_at
      INTO v_template_status, v_template_hold
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
      'template_moderation_disabled_at', v_template_hold,
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
      'template_moderation_disabled_at', null,
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

    -- Read under the template lock taken above, so "this decision disabled
    -- it" is measured against the state the decision found.
    SELECT target.status <> 'disabled' OR target.is_active IS DISTINCT FROM false
    INTO v_template_disabled
    FROM public.templates AS target
    WHERE target.id = v_report.template_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Reported template no longer exists'
        USING ERRCODE = 'P0002';
    END IF;

    -- The take-down writes what the creator's own Disable writes
    -- (`disableMediaTemplate`, src/lib/media-template-service.ts) and what a
    -- catalog release writes when it drops a template's model: the template
    -- leaves the catalog, its page answers "not found" to everyone but its
    -- creator, and no new run can start. Runs already started keep their
    -- snapshot. The hold is what tells it apart from the creator's own
    -- Disable and keeps their next publish from bringing it back, so a
    -- template its creator had already disabled is held too.
    UPDATE public.templates AS target
    SET status = 'disabled',
        is_active = false,
        moderation_disabled_at = coalesce(target.moderation_disabled_at, v_now)
    WHERE target.id = v_report.template_id
      AND (v_template_disabled OR target.moderation_disabled_at IS NULL);

    SELECT target.status, target.moderation_disabled_at
    INTO v_template_status, v_template_hold
    FROM public.templates AS target
    WHERE target.id = v_report.template_id;

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
      'template_moderation_disabled_at', v_template_hold,
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
    'template_moderation_disabled_at', null,
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
  'Service-role-only atomic subject-report decision with a mandatory rationale; confirmed comment reports soft-remove the comment, confirmed template reports disable the template and hold it (templates.moderation_disabled_at) so it cannot be published again, and either resolves the duplicate reports.';
