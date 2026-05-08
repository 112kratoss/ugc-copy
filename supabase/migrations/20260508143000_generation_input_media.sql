INSERT INTO storage.buckets (id, name, public)
VALUES ('generation_inputs', 'generation_inputs', false)
ON CONFLICT (id) DO UPDATE
SET public = false;

ALTER TABLE public.generations
  ADD COLUMN IF NOT EXISTS share_input_media_for_remix boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.generation_input_media (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  generation_id uuid NOT NULL REFERENCES public.generations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  media_type text NOT NULL CHECK (media_type IN ('image', 'video', 'audio')),
  role text NOT NULL,
  label text,
  storage_path text NOT NULL,
  source_generation_id uuid REFERENCES public.generations(id) ON DELETE SET NULL,
  sort_order integer NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX IF NOT EXISTS generation_input_media_generation_order_idx
  ON public.generation_input_media (generation_id, sort_order, id);

CREATE INDEX IF NOT EXISTS generation_input_media_user_created_idx
  ON public.generation_input_media (user_id, created_at DESC);

ALTER TABLE public.generation_input_media ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own generation input media" ON public.generation_input_media;
CREATE POLICY "Users can view own generation input media"
  ON public.generation_input_media FOR SELECT TO authenticated
  USING (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM public.generations
      WHERE generations.id = generation_input_media.generation_id
        AND generations.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users can insert own generation input media" ON public.generation_input_media;
CREATE POLICY "Users can insert own generation input media"
  ON public.generation_input_media FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM public.generations
      WHERE generations.id = generation_input_media.generation_id
        AND generations.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users can update own generation input media" ON public.generation_input_media;
CREATE POLICY "Users can update own generation input media"
  ON public.generation_input_media FOR UPDATE TO authenticated
  USING (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM public.generations
      WHERE generations.id = generation_input_media.generation_id
        AND generations.user_id = auth.uid()
    )
  )
  WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM public.generations
      WHERE generations.id = generation_input_media.generation_id
        AND generations.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users can delete own generation input media" ON public.generation_input_media;
CREATE POLICY "Users can delete own generation input media"
  ON public.generation_input_media FOR DELETE TO authenticated
  USING (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM public.generations
      WHERE generations.id = generation_input_media.generation_id
        AND generations.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users can read own generation inputs" ON storage.objects;
CREATE POLICY "Users can read own generation inputs"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'generation_inputs'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "Users can upload own generation inputs" ON storage.objects;
CREATE POLICY "Users can upload own generation inputs"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'generation_inputs'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "Users can update own generation inputs" ON storage.objects;
CREATE POLICY "Users can update own generation inputs"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'generation_inputs'
    AND (storage.foldername(name))[1] = auth.uid()::text
  )
  WITH CHECK (
    bucket_id = 'generation_inputs'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "Users can delete own generation inputs" ON storage.objects;
CREATE POLICY "Users can delete own generation inputs"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'generation_inputs'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

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
    AND user_id = p_owner_user_id
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
    AND user_id = p_owner_user_id;

  RETURN QUERY
  SELECT result.post_id, result.visibility, result.bundle_id, result.bundle_status
  FROM public.upsert_post_with_resource_bundle(p_post, p_bundle, p_has_bundle) AS result;
END;
$$;

REVOKE ALL ON FUNCTION public.publish_generation_post_with_resource_bundle(uuid, uuid, jsonb, jsonb, jsonb, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.publish_generation_post_with_resource_bundle(uuid, uuid, jsonb, jsonb, jsonb, boolean) TO service_role;
