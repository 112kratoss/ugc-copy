CREATE OR REPLACE FUNCTION public.upsert_post_with_resource_bundle(
  p_post jsonb,
  p_bundle jsonb DEFAULT NULL,
  p_has_bundle boolean DEFAULT true
)
RETURNS TABLE(post_id uuid, visibility text, bundle_id uuid, bundle_status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_post_id uuid := nullif(p_post->>'id', '')::uuid;
  v_generation_id uuid := nullif(p_post->>'generation_id', '')::uuid;
  v_user_id uuid := nullif(p_post->>'user_id', '')::uuid;
  v_visibility text := coalesce(nullif(p_post->>'visibility', ''), 'private');
  v_category text := coalesce(nullif(p_post->>'category', ''), 'image');
  v_post_format text := coalesce(nullif(p_post->>'post_format', ''), 'media');
  v_source_kind text := coalesce(nullif(p_post->>'source_kind', ''), 'external');
  v_result_post_id uuid;
  v_result_visibility text;
  v_bundle_id uuid;
  v_bundle_status text;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Post owner is required';
  END IF;

  IF v_post_id IS NULL AND v_generation_id IS NOT NULL THEN
    SELECT id INTO v_post_id
    FROM public.posts
    WHERE generation_id = v_generation_id;
  END IF;

  IF v_post_id IS NULL THEN
    v_post_id := gen_random_uuid();
  END IF;

  INSERT INTO public.posts AS target (
    id,
    user_id,
    visibility,
    category,
    title,
    description,
    prompt,
    body,
    post_format,
    source_kind,
    source_tool,
    source_tool_slug,
    generation_id,
    showcase_asset_path,
    output_url
  )
  VALUES (
    v_post_id,
    v_user_id,
    v_visibility,
    v_category,
    nullif(btrim(p_post->>'title'), ''),
    nullif(btrim(p_post->>'description'), ''),
    nullif(btrim(p_post->>'prompt'), ''),
    nullif(btrim(p_post->>'body'), ''),
    v_post_format,
    v_source_kind,
    nullif(btrim(p_post->>'source_tool'), ''),
    nullif(btrim(p_post->>'source_tool_slug'), ''),
    v_generation_id,
    nullif(btrim(p_post->>'showcase_asset_path'), ''),
    nullif(btrim(p_post->>'output_url'), '')
  )
  ON CONFLICT (id) DO UPDATE
  SET visibility = EXCLUDED.visibility,
      category = EXCLUDED.category,
      title = EXCLUDED.title,
      description = EXCLUDED.description,
      prompt = EXCLUDED.prompt,
      body = EXCLUDED.body,
      post_format = EXCLUDED.post_format,
      source_kind = EXCLUDED.source_kind,
      source_tool = EXCLUDED.source_tool,
      source_tool_slug = EXCLUDED.source_tool_slug,
      generation_id = EXCLUDED.generation_id,
      showcase_asset_path = EXCLUDED.showcase_asset_path,
      output_url = EXCLUDED.output_url,
      updated_at = timezone('utc'::text, now())
  WHERE target.user_id = v_user_id
  RETURNING target.id, target.visibility INTO v_result_post_id, v_result_visibility;

  IF v_result_post_id IS NULL THEN
    RAISE EXCEPTION 'Post not found or not owned by user';
  END IF;

  IF p_has_bundle THEN
    SELECT mutation.bundle_id, mutation.bundle_status
    INTO v_bundle_id, v_bundle_status
    FROM public.apply_post_resource_bundle_mutation(
      v_result_post_id,
      v_user_id,
      p_post->>'title',
      v_result_visibility,
      p_bundle
    ) AS mutation;
  END IF;

  IF v_result_visibility <> 'public' THEN
    UPDATE public.post_resource_bundles
    SET status = 'draft',
        updated_at = timezone('utc'::text, now())
    WHERE post_id = v_result_post_id
      AND owner_user_id = v_user_id
      AND status = 'published';

    UPDATE public.marketplace_assets
    SET status = 'unlisted',
        updated_at = timezone('utc'::text, now())
    WHERE post_id = v_result_post_id
      AND seller_user_id = v_user_id
      AND status = 'active';
  END IF;

  RETURN QUERY SELECT v_result_post_id, v_result_visibility, v_bundle_id, v_bundle_status;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_post_with_resource_bundle(
  p_post_id uuid,
  p_owner_user_id uuid,
  p_post_patch jsonb,
  p_has_bundle boolean DEFAULT false,
  p_bundle jsonb DEFAULT NULL
)
RETURNS TABLE(post_id uuid, visibility text, bundle_id uuid, bundle_status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_patch jsonb := coalesce(p_post_patch, '{}'::jsonb);
  v_result_post_id uuid;
  v_result_visibility text;
  v_result_title text;
  v_bundle_id uuid;
  v_bundle_status text;
BEGIN
  PERFORM 1
  FROM public.posts
  WHERE id = p_post_id
    AND user_id = p_owner_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Post not found or not owned by user';
  END IF;

  UPDATE public.posts AS target
  SET visibility = CASE WHEN v_patch ? 'visibility' THEN v_patch->>'visibility' ELSE target.visibility END,
      category = CASE WHEN v_patch ? 'category' THEN v_patch->>'category' ELSE target.category END,
      title = CASE WHEN v_patch ? 'title' THEN nullif(btrim(v_patch->>'title'), '') ELSE target.title END,
      description = CASE WHEN v_patch ? 'description' THEN nullif(btrim(v_patch->>'description'), '') ELSE target.description END,
      body = CASE WHEN v_patch ? 'body' THEN nullif(btrim(v_patch->>'body'), '') ELSE target.body END,
      post_format = CASE WHEN v_patch ? 'post_format' THEN v_patch->>'post_format' ELSE target.post_format END,
      source_tool = CASE WHEN v_patch ? 'source_tool' THEN nullif(btrim(v_patch->>'source_tool'), '') ELSE target.source_tool END,
      source_tool_slug = CASE WHEN v_patch ? 'source_tool_slug' THEN nullif(btrim(v_patch->>'source_tool_slug'), '') ELSE target.source_tool_slug END,
      updated_at = timezone('utc'::text, now())
  WHERE target.id = p_post_id
    AND target.user_id = p_owner_user_id
  RETURNING target.id, target.visibility, target.title INTO v_result_post_id, v_result_visibility, v_result_title;

  IF p_has_bundle THEN
    SELECT mutation.bundle_id, mutation.bundle_status
    INTO v_bundle_id, v_bundle_status
    FROM public.apply_post_resource_bundle_mutation(
      v_result_post_id,
      p_owner_user_id,
      v_result_title,
      v_result_visibility,
      p_bundle
    ) AS mutation;
  END IF;

  IF v_result_visibility <> 'public' THEN
    UPDATE public.post_resource_bundles
    SET status = 'draft',
        updated_at = timezone('utc'::text, now())
    WHERE post_id = v_result_post_id
      AND owner_user_id = p_owner_user_id
      AND status = 'published';

    UPDATE public.marketplace_assets
    SET status = 'unlisted',
        updated_at = timezone('utc'::text, now())
    WHERE post_id = v_result_post_id
      AND seller_user_id = p_owner_user_id
      AND status = 'active';
  END IF;

  RETURN QUERY SELECT v_result_post_id, v_result_visibility, v_bundle_id, v_bundle_status;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_post_with_resource_bundle(jsonb, jsonb, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_post_with_resource_bundle(uuid, uuid, jsonb, boolean, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_post_with_resource_bundle(jsonb, jsonb, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.update_post_with_resource_bundle(uuid, uuid, jsonb, boolean, jsonb) TO service_role;
