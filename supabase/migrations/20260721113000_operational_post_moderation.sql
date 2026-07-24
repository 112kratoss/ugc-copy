ALTER TABLE public.post_reports
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS resolution_action text,
  ADD COLUMN IF NOT EXISTS resolution_note text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.post_reports'::regclass
      AND conname = 'post_reports_resolution_action'
  ) THEN
    ALTER TABLE public.post_reports
      ADD CONSTRAINT post_reports_resolution_action
      CHECK (resolution_action IS NULL OR resolution_action IN ('take_down', 'dismiss'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.post_reports'::regclass
      AND conname = 'post_reports_resolution_note_length'
  ) THEN
    ALTER TABLE public.post_reports
      ADD CONSTRAINT post_reports_resolution_note_length
      CHECK (resolution_note IS NULL OR char_length(resolution_note) <= 1000);
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS post_reports_reviewed_by_idx
  ON public.post_reports (reviewed_by, reviewed_at DESC)
  WHERE reviewed_by IS NOT NULL;

CREATE OR REPLACE FUNCTION public.resolve_post_report_for_ops(
  p_report_id uuid,
  p_reviewer_id uuid,
  p_action text,
  p_resolution_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_report public.post_reports%ROWTYPE;
  v_now timestamptz := timezone('utc'::text, now());
  v_note text := nullif(btrim(p_resolution_note), '');
  v_resolved_count integer := 0;
BEGIN
  IF p_report_id IS NULL OR p_reviewer_id IS NULL THEN
    RAISE EXCEPTION 'Report and reviewer are required'
      USING ERRCODE = '22023';
  END IF;

  IF p_action IS NULL OR p_action NOT IN ('take_down', 'dismiss') THEN
    RAISE EXCEPTION 'Unsupported moderation action'
      USING ERRCODE = '22023';
  END IF;

  IF v_note IS NOT NULL AND char_length(v_note) > 1000 THEN
    RAISE EXCEPTION 'Resolution note must be 1000 characters or fewer'
      USING ERRCODE = '22001';
  END IF;

  -- A real auth user is required so every decision has a durable operator id.
  PERFORM 1
  FROM auth.users
  WHERE id = p_reviewer_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reviewer not found'
      USING ERRCODE = '23503';
  END IF;

  SELECT *
  INTO v_report
  FROM public.post_reports
  WHERE id = p_report_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Post report not found'
      USING ERRCODE = 'P0002';
  END IF;

  -- Serialize every decision for the same post before locking an individual
  -- report. This avoids duplicate-report deadlocks and makes the final status
  -- check authoritative under concurrent operator actions.
  PERFORM 1
  FROM public.posts
  WHERE id = v_report.post_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reported post not found'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT *
  INTO v_report
  FROM public.post_reports
  WHERE id = p_report_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Post report not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_report.status <> 'open' THEN
    RETURN jsonb_build_object(
      'status', 'already_resolved',
      'report_id', v_report.id,
      'post_id', v_report.post_id,
      'report_status', v_report.status,
      'resolution_action', v_report.resolution_action,
      'reviewed_at', v_report.reviewed_at,
      'reviewed_by', v_report.reviewed_by
    );
  END IF;

  IF p_action = 'take_down' THEN
    -- Hide the post first and remove linked paid surfaces in the same transaction.
    -- The source record and media references remain available to trusted staff for
    -- evidence and a possible appeal.
    UPDATE public.posts
    SET review_status = 'hidden',
        reviewed_at = v_now,
        reviewed_by = p_reviewer_id,
        updated_at = v_now
    WHERE id = v_report.post_id;

    UPDATE public.post_resource_bundles
    SET status = 'draft',
        updated_at = v_now
    WHERE post_id = v_report.post_id
      AND status = 'published';

    UPDATE public.marketplace_assets
    SET status = 'unlisted',
        updated_at = v_now
    WHERE post_id = v_report.post_id
      AND status = 'active';

    -- One content-level takedown resolves duplicate open reports for that post,
    -- while retaining each original report and the shared operator audit record.
    UPDATE public.post_reports
    SET status = 'reviewed',
        reviewed_at = v_now,
        reviewed_by = p_reviewer_id,
        resolution_action = 'take_down',
        resolution_note = v_note,
        updated_at = v_now
    WHERE post_id = v_report.post_id
      AND status = 'open';

    GET DIAGNOSTICS v_resolved_count = ROW_COUNT;

    RETURN jsonb_build_object(
      'status', 'taken_down',
      'report_id', v_report.id,
      'post_id', v_report.post_id,
      'report_status', 'reviewed',
      'post_review_status', 'hidden',
      'resolved_report_count', v_resolved_count,
      'reviewed_at', v_now,
      'reviewed_by', p_reviewer_id
    );
  END IF;

  UPDATE public.post_reports
  SET status = 'dismissed',
      reviewed_at = v_now,
      reviewed_by = p_reviewer_id,
      resolution_action = 'dismiss',
      resolution_note = v_note,
      updated_at = v_now
  WHERE id = v_report.id
    AND status = 'open';

  -- A report submission flags the post. Restore visibility only after the last
  -- open report is dismissed and only when no prior takedown hid the post.
  IF NOT EXISTS (
    SELECT 1
    FROM public.post_reports
    WHERE post_id = v_report.post_id
      AND status = 'open'
  ) THEN
    UPDATE public.posts
    SET review_status = 'visible',
        reviewed_at = v_now,
        reviewed_by = p_reviewer_id,
        updated_at = v_now
    WHERE id = v_report.post_id
      AND review_status = 'flagged';
  END IF;

  RETURN jsonb_build_object(
    'status', 'dismissed',
    'report_id', v_report.id,
    'post_id', v_report.post_id,
    'report_status', 'dismissed',
    'reviewed_at', v_now,
    'reviewed_by', p_reviewer_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_post_report_for_ops(uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_post_report_for_ops(uuid, uuid, text, text)
  TO service_role;

COMMENT ON FUNCTION public.resolve_post_report_for_ops(uuid, uuid, text, text) IS
  'Service-role-only atomic post moderation action with per-report operator audit fields.';
