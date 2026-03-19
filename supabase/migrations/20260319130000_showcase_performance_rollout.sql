ALTER TABLE public.generations
  ADD COLUMN IF NOT EXISTS showcase_asset_path text;

INSERT INTO storage.buckets (id, name, public)
VALUES ('showcase_media', 'showcase_media', true)
ON CONFLICT (id) DO UPDATE
SET public = EXCLUDED.public;

CREATE INDEX IF NOT EXISTS generations_public_recent_idx
  ON public.generations (created_at DESC, id DESC)
  WHERE is_public = true
    AND status = 'succeeded'
    AND output_url IS NOT NULL;

CREATE INDEX IF NOT EXISTS generations_public_top_saves_idx
  ON public.generations (save_count DESC, created_at DESC, id DESC)
  WHERE is_public = true
    AND status = 'succeeded'
    AND output_url IS NOT NULL;

CREATE INDEX IF NOT EXISTS generations_public_top_remixes_idx
  ON public.generations (remix_count DESC, created_at DESC, id DESC)
  WHERE is_public = true
    AND status = 'succeeded'
    AND output_url IS NOT NULL;

CREATE INDEX IF NOT EXISTS generations_public_category_recent_idx
  ON public.generations (category, created_at DESC, id DESC)
  WHERE is_public = true
    AND status = 'succeeded'
    AND output_url IS NOT NULL;

CREATE INDEX IF NOT EXISTS showcase_saves_generation_id_idx
  ON public.showcase_saves (generation_id);

DROP POLICY IF EXISTS "Anyone can view public generations" ON public.generations;
DROP POLICY IF EXISTS "Users can view own generations" ON public.generations;
DROP POLICY IF EXISTS "Users can view their own generations." ON public.generations;
DROP POLICY IF EXISTS "Users can create own generations" ON public.generations;
DROP POLICY IF EXISTS "Users can insert their own generations." ON public.generations;
DROP POLICY IF EXISTS "Users can update own generations" ON public.generations;
DROP POLICY IF EXISTS "Users can update their own generations." ON public.generations;

CREATE POLICY "Users can view accessible generations"
  ON public.generations FOR SELECT TO public
  USING (
    is_public = true
    OR (select auth.uid()) = user_id
  );

CREATE POLICY "Users can create own generations"
  ON public.generations FOR INSERT TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can update own generations"
  ON public.generations FOR UPDATE TO authenticated
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can view own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can update own profile." ON public.profiles;

CREATE POLICY "Users can view own profile"
  ON public.profiles FOR SELECT TO authenticated
  USING ((select auth.uid()) = id);

CREATE POLICY "Users can update own profile."
  ON public.profiles FOR UPDATE TO authenticated
  USING ((select auth.uid()) = id)
  WITH CHECK ((select auth.uid()) = id);

DROP POLICY IF EXISTS "Anyone can view saves" ON public.showcase_saves;
DROP POLICY IF EXISTS "Users can insert their own saves" ON public.showcase_saves;
DROP POLICY IF EXISTS "Users can delete their own saves" ON public.showcase_saves;

CREATE POLICY "Anyone can view saves"
  ON public.showcase_saves FOR SELECT TO public
  USING (true);

CREATE POLICY "Users can insert their own saves"
  ON public.showcase_saves FOR INSERT TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can delete their own saves"
  ON public.showcase_saves FOR DELETE TO authenticated
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can view their own workflow canvases" ON public.workflow_canvases;
DROP POLICY IF EXISTS "Users can create their own workflow canvases" ON public.workflow_canvases;
DROP POLICY IF EXISTS "Users can update their own workflow canvases" ON public.workflow_canvases;
DROP POLICY IF EXISTS "Users can delete their own workflow canvases" ON public.workflow_canvases;

CREATE POLICY "Users can view their own workflow canvases"
  ON public.workflow_canvases FOR SELECT TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can create their own workflow canvases"
  ON public.workflow_canvases FOR INSERT TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can update their own workflow canvases"
  ON public.workflow_canvases FOR UPDATE TO authenticated
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can delete their own workflow canvases"
  ON public.workflow_canvases FOR DELETE TO authenticated
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can view their own workflow runs" ON public.workflow_canvas_runs;
DROP POLICY IF EXISTS "Users can create their own workflow runs" ON public.workflow_canvas_runs;
DROP POLICY IF EXISTS "Users can update their own workflow runs" ON public.workflow_canvas_runs;

CREATE POLICY "Users can view their own workflow runs"
  ON public.workflow_canvas_runs FOR SELECT TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can create their own workflow runs"
  ON public.workflow_canvas_runs FOR INSERT TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can update their own workflow runs"
  ON public.workflow_canvas_runs FOR UPDATE TO authenticated
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can view their own workflow run steps" ON public.workflow_canvas_run_steps;
DROP POLICY IF EXISTS "Users can create their own workflow run steps" ON public.workflow_canvas_run_steps;
DROP POLICY IF EXISTS "Users can update their own workflow run steps" ON public.workflow_canvas_run_steps;

CREATE POLICY "Users can view their own workflow run steps"
  ON public.workflow_canvas_run_steps FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.workflow_canvas_runs runs
      WHERE runs.id = workflow_canvas_run_steps.run_id
        AND runs.user_id = (select auth.uid())
    )
  );

CREATE POLICY "Users can create their own workflow run steps"
  ON public.workflow_canvas_run_steps FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.workflow_canvas_runs runs
      WHERE runs.id = workflow_canvas_run_steps.run_id
        AND runs.user_id = (select auth.uid())
    )
  );

CREATE POLICY "Users can update their own workflow run steps"
  ON public.workflow_canvas_run_steps FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.workflow_canvas_runs runs
      WHERE runs.id = workflow_canvas_run_steps.run_id
        AND runs.user_id = (select auth.uid())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.workflow_canvas_runs runs
      WHERE runs.id = workflow_canvas_run_steps.run_id
        AND runs.user_id = (select auth.uid())
    )
  );
