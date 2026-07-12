-- Graph-backed media templates.
-- Workflow canvases remain mutable authoring documents. Published versions and
-- template runs retain private, immutable graph snapshots.

ALTER TABLE public.templates
  ALTER COLUMN video_url DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS creator_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS slug text,
  ADD COLUMN IF NOT EXISTS source_canvas_id uuid REFERENCES public.workflow_canvases(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS input_slots jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS output_kind text,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS use_count bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS active_version_id uuid,
  ADD COLUMN IF NOT EXISTS draft_output_node_id text,
  ADD COLUMN IF NOT EXISTS draft_catalog_revision text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now());

UPDATE public.templates SET status = 'disabled' WHERE creator_user_id IS NULL;

ALTER TABLE public.templates
  DROP CONSTRAINT IF EXISTS templates_status_check,
  ADD CONSTRAINT templates_status_check
    CHECK (status IN ('draft', 'active', 'disabled')),
  DROP CONSTRAINT IF EXISTS templates_input_slots_check,
  ADD CONSTRAINT templates_input_slots_check
    CHECK (jsonb_typeof(input_slots) = 'array'),
  DROP CONSTRAINT IF EXISTS templates_output_kind_check,
  ADD CONSTRAINT templates_output_kind_check
    CHECK (output_kind IS NULL OR output_kind IN ('image', 'video')),
  DROP CONSTRAINT IF EXISTS templates_use_count_check,
  ADD CONSTRAINT templates_use_count_check CHECK (use_count >= 0);

CREATE UNIQUE INDEX IF NOT EXISTS templates_slug_unique_idx
  ON public.templates (lower(slug))
  WHERE slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS templates_creator_updated_idx
  ON public.templates (creator_user_id, updated_at DESC)
  WHERE creator_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS templates_source_canvas_idx
  ON public.templates (source_canvas_id)
  WHERE source_canvas_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS templates_creator_source_canvas_unique_idx
  ON public.templates (creator_user_id, source_canvas_id)
  WHERE creator_user_id IS NOT NULL AND source_canvas_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS templates_active_created_idx
  ON public.templates (created_at DESC)
  WHERE status = 'active' AND is_active = true;

DROP TRIGGER IF EXISTS templates_set_updated_at ON public.templates;
CREATE TRIGGER templates_set_updated_at
BEFORE UPDATE ON public.templates
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at_column();

CREATE TABLE public.template_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES public.templates(id) ON DELETE RESTRICT,
  version_number integer NOT NULL,
  source_canvas_id uuid REFERENCES public.workflow_canvases(id) ON DELETE SET NULL,
  source_canvas_revision integer NOT NULL,
  graph_snapshot jsonb NOT NULL,
  graph_hash text NOT NULL,
  snapshot_hash text NOT NULL,
  output_node_id text NOT NULL,
  output_kind text NOT NULL CHECK (output_kind IN ('image', 'video')),
  input_manifest jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(input_manifest) = 'array'),
  estimated_total_credits integer NOT NULL CHECK (estimated_total_credits >= 0),
  catalog_revision text,
  demo_output_url text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  rights_confirmed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  UNIQUE (template_id, version_number),
  UNIQUE (template_id, id),
  UNIQUE NULLS NOT DISTINCT (template_id, graph_hash, source_canvas_revision, catalog_revision)
);

CREATE INDEX template_versions_template_created_idx
  ON public.template_versions (template_id, created_at DESC);
CREATE INDEX template_versions_source_canvas_idx
  ON public.template_versions (source_canvas_id, source_canvas_revision)
  WHERE source_canvas_id IS NOT NULL;
CREATE INDEX template_versions_created_by_idx
  ON public.template_versions (created_by);

ALTER TABLE public.templates
  ADD CONSTRAINT templates_active_version_belongs_to_template_fkey
  FOREIGN KEY (id, active_version_id)
  REFERENCES public.template_versions(template_id, id) ON DELETE RESTRICT;
CREATE INDEX templates_active_version_idx
  ON public.templates (active_version_id)
  WHERE active_version_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.reject_template_version_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  -- Account deletion may anonymize the historical creator reference. No other
  -- field on the immutable published snapshot may change.
  IF TG_OP = 'UPDATE' THEN
    IF OLD.created_by IS NOT NULL
       AND NEW.created_by IS NULL
       AND (to_jsonb(NEW) - 'created_by') IS NOT DISTINCT FROM
           (to_jsonb(OLD) - 'created_by') THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION 'Published template versions are immutable';
END;
$$;

CREATE TRIGGER template_versions_reject_update
BEFORE UPDATE ON public.template_versions
FOR EACH ROW EXECUTE FUNCTION public.reject_template_version_mutation();
CREATE TRIGGER template_versions_reject_delete
BEFORE DELETE ON public.template_versions
FOR EACH ROW EXECUTE FUNCTION public.reject_template_version_mutation();

CREATE TABLE public.template_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES public.templates(id) ON DELETE RESTRICT,
  template_version_id uuid,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  graph_snapshot jsonb NOT NULL,
  graph_hash text NOT NULL,
  input_manifest jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(input_manifest) = 'array'),
  input_storage_paths jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(input_storage_paths) = 'object'),
  output_node_id text NOT NULL,
  output_kind text NOT NULL CHECK (output_kind IN ('image', 'video')),
  status text NOT NULL DEFAULT 'collecting_inputs' CHECK (
    status IN (
      'collecting_inputs',
      'queued',
      'processing',
      'awaiting_approval',
      'needs_attention',
      'succeeded',
      'failed',
      'cancelled'
    )
  ),
  estimated_total_credits integer NOT NULL CHECK (estimated_total_credits >= 0),
  estimated_remaining_credits integer NOT NULL CHECK (estimated_remaining_credits >= 0),
  credits_used integer NOT NULL DEFAULT 0 CHECK (credits_used >= 0),
  result_url text,
  error_message text,
  is_test boolean NOT NULL DEFAULT false,
  source_canvas_revision integer,
  catalog_revision text,
  completed_at timestamptz,
  inputs_deleted_at timestamptz,
  usage_counted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now())
);

ALTER TABLE public.template_runs
  ADD CONSTRAINT template_runs_version_belongs_to_template_fkey
  FOREIGN KEY (template_id, template_version_id)
  REFERENCES public.template_versions(template_id, id) ON DELETE RESTRICT;

CREATE INDEX template_runs_user_updated_idx
  ON public.template_runs (user_id, updated_at DESC);
CREATE INDEX template_runs_template_created_idx
  ON public.template_runs (template_id, created_at DESC);
CREATE INDEX template_runs_version_created_idx
  ON public.template_runs (template_version_id, created_at DESC)
  WHERE template_version_id IS NOT NULL;
CREATE INDEX template_runs_active_status_idx
  ON public.template_runs (status, updated_at)
  WHERE status IN ('queued', 'processing', 'awaiting_approval');

DROP TRIGGER IF EXISTS template_runs_set_updated_at ON public.template_runs;
CREATE TRIGGER template_runs_set_updated_at
BEFORE UPDATE ON public.template_runs
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at_column();

CREATE TABLE public.template_run_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.template_runs(id) ON DELETE CASCADE,
  node_id text NOT NULL,
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  kind text NOT NULL CHECK (kind IN ('generation', 'approval')),
  media_kind text NOT NULL CHECK (media_kind IN ('image', 'video')),
  label text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (
    status IN ('queued', 'processing', 'awaiting_approval', 'succeeded', 'failed', 'cancelled')
  ),
  generation_id uuid REFERENCES public.generations(id) ON DELETE SET NULL,
  output_url text,
  error_message text,
  can_retry boolean NOT NULL DEFAULT true,
  estimated_credits integer NOT NULL DEFAULT 0 CHECK (estimated_credits >= 0),
  input_snapshot jsonb,
  output_snapshot jsonb,
  approved_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  UNIQUE (run_id, node_id, attempt)
);

CREATE INDEX template_run_steps_run_created_idx
  ON public.template_run_steps (run_id, created_at, id);
CREATE INDEX template_run_steps_generation_idx
  ON public.template_run_steps (generation_id)
  WHERE generation_id IS NOT NULL;
CREATE INDEX template_run_steps_waiting_approval_idx
  ON public.template_run_steps (run_id, status)
  WHERE status = 'awaiting_approval';

ALTER TABLE public.generations
  ADD COLUMN IF NOT EXISTS template_run_id uuid REFERENCES public.template_runs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS template_run_step_id uuid REFERENCES public.template_run_steps(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS generations_template_run_created_idx
  ON public.generations (template_run_id, created_at DESC)
  WHERE template_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS generations_template_run_step_idx
  ON public.generations (template_run_step_id)
  WHERE template_run_step_id IS NOT NULL;

ALTER TABLE public.workflow_canvas_runs
  ADD COLUMN IF NOT EXISTS graph_snapshot jsonb;

ALTER TABLE public.workflow_canvas_runs
  DROP CONSTRAINT IF EXISTS workflow_canvas_runs_status_check,
  ADD CONSTRAINT workflow_canvas_runs_status_check
    CHECK (status IN ('processing', 'awaiting_approval', 'succeeded', 'failed'));

ALTER TABLE public.workflow_canvas_run_steps
  DROP CONSTRAINT IF EXISTS workflow_canvas_run_steps_status_check,
  ADD CONSTRAINT workflow_canvas_run_steps_status_check
    CHECK (status IN ('queued', 'processing', 'awaiting_approval', 'succeeded', 'failed', 'blocked'));

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'template_inputs',
  'template_inputs',
  false,
  104857600,
  ARRAY[
    'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
    'video/mp4', 'video/webm', 'video/quicktime'
  ]::text[]
)
ON CONFLICT (id) DO UPDATE
SET public = false,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'template_assets',
  'template_assets',
  false,
  104857600,
  ARRAY[
    'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
    'video/mp4', 'video/webm', 'video/quicktime'
  ]::text[]
)
ON CONFLICT (id) DO UPDATE
SET public = false,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

ALTER TABLE public.template_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.template_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.template_run_steps ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Templates are viewable by everyone" ON public.templates;
DROP POLICY IF EXISTS "Anyone can view active templates" ON public.templates;
CREATE POLICY "Anyone can view active templates"
  ON public.templates FOR SELECT TO anon
  USING (status = 'active' AND is_active = true AND creator_user_id IS NOT NULL);

DROP POLICY IF EXISTS "Authenticated users can view active or own templates" ON public.templates;
CREATE POLICY "Authenticated users can view active or own templates"
  ON public.templates FOR SELECT TO authenticated
  USING (
    (status = 'active' AND is_active = true AND creator_user_id IS NOT NULL)
    OR creator_user_id = (SELECT auth.uid())
  );

DROP POLICY IF EXISTS "Users can view own template runs" ON public.template_runs;
CREATE POLICY "Users can view own template runs"
  ON public.template_runs FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Users can view own template run steps" ON public.template_run_steps;
CREATE POLICY "Users can view own template run steps"
  ON public.template_run_steps FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.template_runs runs
      WHERE runs.id = template_run_steps.run_id
        AND runs.user_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS "Users can upload own template inputs" ON storage.objects;
DROP POLICY IF EXISTS "Users can update own template inputs" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete own template inputs" ON storage.objects;
DROP POLICY IF EXISTS "Users can read own template inputs" ON storage.objects;

-- Signed upload tokens are the only client write capability. Finalized inputs
-- are service-copied to immutable /final/ paths and have no direct user policy.

-- All writes and all private graph reads go through authenticated backend routes.
REVOKE ALL ON TABLE public.template_versions FROM anon, authenticated;
REVOKE ALL ON TABLE public.template_runs FROM anon, authenticated;
REVOKE ALL ON TABLE public.template_run_steps FROM anon, authenticated;
REVOKE SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.templates FROM anon, authenticated;
GRANT SELECT (
  id, name, description, video_url, thumbnail_url, category, is_active, created_at,
  creator_user_id, slug, input_slots, output_kind, status, use_count,
  active_version_id, updated_at
) ON TABLE public.templates TO anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.templates TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.template_versions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.template_runs TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.template_run_steps TO service_role;

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
BEGIN
  PERFORM 1
  FROM public.templates
  WHERE id = p_template_id
    AND creator_user_id = p_creator_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Template not found';
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

CREATE OR REPLACE FUNCTION public.record_template_run_success(
  p_run_id uuid,
  p_result_url text,
  p_credits_used integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_template_id uuid;
  v_is_test boolean;
BEGIN
  UPDATE public.template_runs
  SET status = 'succeeded',
      result_url = p_result_url,
      credits_used = GREATEST(0, p_credits_used),
      estimated_remaining_credits = 0,
      completed_at = COALESCE(completed_at, timezone('utc'::text, now())),
      usage_counted_at = COALESCE(usage_counted_at, timezone('utc'::text, now()))
  WHERE id = p_run_id
    AND status <> 'cancelled'
    AND usage_counted_at IS NULL
  RETURNING template_id, is_test INTO v_template_id, v_is_test;

  IF v_template_id IS NULL THEN
    RETURN false;
  END IF;

  IF NOT v_is_test THEN
    UPDATE public.templates
    SET use_count = use_count + 1
    WHERE id = v_template_id
      AND status = 'active'
      AND is_active = true;
  END IF;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.record_template_run_success(uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_template_run_success(uuid, text, integer) TO service_role;

COMMENT ON TABLE public.template_versions
  IS 'Immutable, private workflow snapshots backing published template revisions.';
COMMENT ON COLUMN public.template_versions.graph_hash
  IS 'Hash of the exact saved authoring graph revision that passed its test run.';
COMMENT ON COLUMN public.template_versions.snapshot_hash
  IS 'Hash of the immutable version snapshot after fixed and demo paths are versioned.';
COMMENT ON COLUMN public.template_versions.created_by
  IS 'Publishing user when available; anonymized on account deletion without changing the version recipe.';
COMMENT ON COLUMN public.template_run_steps.node_id
  IS 'Private workflow node identifier. API DTOs expose only the step UUID.';
COMMENT ON COLUMN public.workflow_canvas_runs.graph_snapshot
  IS 'Runtime snapshot used to keep workflow execution state out of workflow_canvases.graph.';
