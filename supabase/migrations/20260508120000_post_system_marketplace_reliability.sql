CREATE OR REPLACE FUNCTION public.apply_post_resource_bundle_mutation(
  p_post_id uuid,
  p_owner_user_id uuid,
  p_post_title text,
  p_post_visibility text,
  p_bundle jsonb
)
RETURNS TABLE(bundle_id uuid, bundle_status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_access_mode text := coalesce(nullif(p_bundle->>'accessMode', ''), 'none');
  v_resources jsonb := coalesce(p_bundle->'resources', '{}'::jsonb);
  v_attachments jsonb := '[]'::jsonb;
  v_price_usd_cents integer := 0;
  v_status text := CASE WHEN p_post_visibility = 'public' THEN 'published' ELSE 'draft' END;
  v_prompt_text text;
  v_notes_markdown text;
  v_workflow_share_url text;
  v_workflow_snapshot jsonb;
  v_allow_remix boolean := false;
  v_bundle_id uuid;
  v_bundle_status text;
BEGIN
  IF v_access_mode = 'none' THEN
    DELETE FROM public.post_resource_bundles
    WHERE post_id = p_post_id
      AND owner_user_id = p_owner_user_id;

    RETURN QUERY SELECT NULL::uuid, NULL::text;
    RETURN;
  END IF;

  IF v_access_mode NOT IN ('free', 'paid') THEN
    RAISE EXCEPTION 'Choose whether the unlock should be free or paid';
  END IF;

  v_attachments := coalesce(v_resources->'attachments', '[]'::jsonb);
  IF jsonb_typeof(v_attachments) IS DISTINCT FROM 'array' THEN
    v_attachments := '[]'::jsonb;
  END IF;

  v_prompt_text := nullif(btrim(v_resources->>'promptText'), '');
  v_notes_markdown := nullif(btrim(v_resources->>'notesMarkdown'), '');
  v_workflow_share_url := nullif(btrim(v_resources->>'workflowShareUrl'), '');
  v_workflow_snapshot := v_resources->'workflowSnapshot';
  v_allow_remix := lower(coalesce(v_resources->>'allowRemix', 'false')) = 'true';

  IF v_prompt_text IS NULL
    AND v_notes_markdown IS NULL
    AND v_workflow_share_url IS NULL
    AND v_workflow_snapshot IS NULL
    AND jsonb_array_length(v_attachments) = 0
    AND v_allow_remix IS NOT TRUE THEN
    RAISE EXCEPTION 'Add content for at least one unlock item before publishing';
  END IF;

  IF v_access_mode = 'paid' THEN
    v_price_usd_cents := coalesce(nullif(p_bundle->>'priceUsdCents', '')::integer, 0);
    IF v_price_usd_cents < 100 THEN
      RAISE EXCEPTION 'Paid unlocks must be priced at $1.00 or above';
    END IF;
  END IF;

  INSERT INTO public.post_resource_bundles (
    post_id,
    owner_user_id,
    access_mode,
    status,
    title,
    summary,
    preview_text,
    prompt_text,
    notes_markdown,
    workflow_share_url,
    workflow_snapshot,
    attachments,
    allow_remix,
    price_usd_cents
  )
  VALUES (
    p_post_id,
    p_owner_user_id,
    v_access_mode,
    v_status,
    coalesce(nullif(btrim(p_post_title), ''), 'Attached unlock'),
    coalesce(nullif(btrim(p_bundle->>'summary'), ''), ''),
    coalesce(nullif(btrim(p_bundle->>'previewText'), ''), ''),
    v_prompt_text,
    v_notes_markdown,
    v_workflow_share_url,
    v_workflow_snapshot,
    v_attachments,
    v_allow_remix,
    v_price_usd_cents
  )
  ON CONFLICT (post_id) DO UPDATE
  SET owner_user_id = EXCLUDED.owner_user_id,
      access_mode = EXCLUDED.access_mode,
      status = EXCLUDED.status,
      title = EXCLUDED.title,
      summary = EXCLUDED.summary,
      preview_text = EXCLUDED.preview_text,
      prompt_text = EXCLUDED.prompt_text,
      notes_markdown = EXCLUDED.notes_markdown,
      workflow_share_url = EXCLUDED.workflow_share_url,
      workflow_snapshot = EXCLUDED.workflow_snapshot,
      attachments = EXCLUDED.attachments,
      allow_remix = EXCLUDED.allow_remix,
      price_usd_cents = EXCLUDED.price_usd_cents,
      updated_at = timezone('utc'::text, now())
  RETURNING id, status INTO v_bundle_id, v_bundle_status;

  RETURN QUERY SELECT v_bundle_id, v_bundle_status;
END;
$$;

CREATE OR REPLACE FUNCTION public.validate_post_resource_bundle_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_post public.posts%ROWTYPE;
BEGIN
  SELECT *
  INTO v_post
  FROM public.posts
  WHERE id = NEW.post_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Attached post not found';
  END IF;

  IF NEW.owner_user_id <> v_post.user_id THEN
    RAISE EXCEPTION 'Bundle owner must match post owner';
  END IF;

  IF NEW.status = 'published' AND v_post.visibility IS DISTINCT FROM 'public' THEN
    RAISE EXCEPTION 'Only public posts can publish resource bundles';
  END IF;

  IF NEW.access_mode = 'free' AND NEW.price_usd_cents <> 0 THEN
    RAISE EXCEPTION 'Free bundles must have a zero price';
  END IF;

  IF NEW.access_mode = 'paid' AND NEW.price_usd_cents < 100 THEN
    RAISE EXCEPTION 'Paid bundles must cost at least 100 cents';
  END IF;

  IF nullif(btrim(coalesce(NEW.workflow_share_url, '')), '') IS NOT NULL
    AND NEW.workflow_share_url !~* '^https?://' THEN
    RAISE EXCEPTION 'Workflow links must start with http:// or https://';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(coalesce(NEW.attachments, '[]'::jsonb)) AS attachment
    WHERE coalesce(attachment->>'kind', 'link') = 'link'
      AND nullif(btrim(coalesce(attachment->>'url', '')), '') IS NOT NULL
      AND attachment->>'url' !~* '^https?://'
  ) THEN
    RAISE EXCEPTION 'Unlock links must start with http:// or https://';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(coalesce(NEW.attachments, '[]'::jsonb)) AS attachment
    WHERE coalesce(attachment->>'kind', 'link') = 'file'
      AND (
        nullif(btrim(coalesce(attachment->>'storagePath', '')), '') IS NULL
        OR btrim(attachment->>'storagePath') !~ ('^' || NEW.owner_user_id::text || '/')
        OR btrim(attachment->>'storagePath') LIKE '%..%'
        OR btrim(attachment->>'storagePath') ~ '[\\]'
      )
  ) THEN
    RAISE EXCEPTION 'Uploaded unlock files must belong to the creator publishing this post';
  END IF;

  IF nullif(btrim(coalesce(NEW.prompt_text, '')), '') IS NULL
    AND nullif(btrim(coalesce(NEW.notes_markdown, '')), '') IS NULL
    AND nullif(btrim(coalesce(NEW.workflow_share_url, '')), '') IS NULL
    AND NEW.workflow_snapshot IS NULL
    AND jsonb_array_length(coalesce(NEW.attachments, '[]'::jsonb)) = 0
    AND NEW.allow_remix IS NOT TRUE THEN
    RAISE EXCEPTION 'Add content for at least one unlock item before publishing';
  END IF;

  RETURN NEW;
END;
$$;

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

  INSERT INTO public.posts (
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
  WHERE public.posts.user_id = v_user_id
  RETURNING id, visibility INTO v_result_post_id, v_result_visibility;

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

  UPDATE public.posts
  SET visibility = CASE WHEN v_patch ? 'visibility' THEN v_patch->>'visibility' ELSE visibility END,
      category = CASE WHEN v_patch ? 'category' THEN v_patch->>'category' ELSE category END,
      title = CASE WHEN v_patch ? 'title' THEN nullif(btrim(v_patch->>'title'), '') ELSE title END,
      description = CASE WHEN v_patch ? 'description' THEN nullif(btrim(v_patch->>'description'), '') ELSE description END,
      body = CASE WHEN v_patch ? 'body' THEN nullif(btrim(v_patch->>'body'), '') ELSE body END,
      post_format = CASE WHEN v_patch ? 'post_format' THEN v_patch->>'post_format' ELSE post_format END,
      source_tool = CASE WHEN v_patch ? 'source_tool' THEN nullif(btrim(v_patch->>'source_tool'), '') ELSE source_tool END,
      source_tool_slug = CASE WHEN v_patch ? 'source_tool_slug' THEN nullif(btrim(v_patch->>'source_tool_slug'), '') ELSE source_tool_slug END,
      updated_at = timezone('utc'::text, now())
  WHERE id = p_post_id
    AND user_id = p_owner_user_id
  RETURNING id, visibility, title INTO v_result_post_id, v_result_visibility, v_result_title;

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

CREATE OR REPLACE FUNCTION public.list_marketplace_resource_bundles(
  p_access_filter text DEFAULT 'all',
  p_resource_filter text DEFAULT 'all',
  p_tool_slug text DEFAULT NULL,
  p_sort text DEFAULT 'recent',
  p_offset integer DEFAULT 0,
  p_limit integer DEFAULT 24
)
RETURNS TABLE(
  id uuid,
  post_id uuid,
  owner_user_id uuid,
  legacy_asset_id uuid,
  access_mode text,
  status text,
  title text,
  summary text,
  preview_text text,
  prompt_text text,
  notes_markdown text,
  workflow_share_url text,
  workflow_snapshot jsonb,
  attachments jsonb,
  allow_remix boolean,
  price_usd_cents integer,
  sales_count integer,
  earnings_usd_cents integer,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    bundles.id,
    bundles.post_id,
    bundles.owner_user_id,
    bundles.legacy_asset_id,
    bundles.access_mode,
    bundles.status,
    bundles.title,
    bundles.summary,
    bundles.preview_text,
    bundles.prompt_text,
    bundles.notes_markdown,
    bundles.workflow_share_url,
    bundles.workflow_snapshot,
    bundles.attachments,
    bundles.allow_remix,
    bundles.price_usd_cents,
    bundles.sales_count,
    bundles.earnings_usd_cents,
    bundles.created_at,
    bundles.updated_at
  FROM public.post_resource_bundles bundles
  JOIN public.posts posts ON posts.id = bundles.post_id
  WHERE bundles.status = 'published'
    AND posts.visibility = 'public'
    AND posts.archived_at IS NULL
    AND coalesce(posts.review_status, 'visible') <> 'hidden'
    AND (p_access_filter IS NULL OR p_access_filter = 'all' OR bundles.access_mode = p_access_filter)
    AND (
      p_resource_filter IS NULL
      OR p_resource_filter = 'all'
      OR (p_resource_filter = 'prompt' AND nullif(btrim(coalesce(bundles.prompt_text, '')), '') IS NOT NULL)
      OR (p_resource_filter = 'workflow' AND (nullif(btrim(coalesce(bundles.workflow_share_url, '')), '') IS NOT NULL OR bundles.workflow_snapshot IS NOT NULL))
      OR (p_resource_filter = 'files' AND jsonb_typeof(bundles.attachments) = 'array' AND jsonb_array_length(bundles.attachments) > 0)
      OR (p_resource_filter = 'notes' AND nullif(btrim(coalesce(bundles.notes_markdown, '')), '') IS NOT NULL)
      OR (p_resource_filter = 'remix' AND bundles.allow_remix = true)
    )
    AND (
      coalesce(nullif(p_tool_slug, ''), '') = ''
      OR coalesce(
        nullif(posts.source_tool_slug, ''),
        lower(regexp_replace(btrim(coalesce(posts.source_tool, '')), '[^a-z0-9]+', '-', 'g'))
      ) = p_tool_slug
    )
  ORDER BY
    CASE WHEN p_sort = 'top-sales' THEN bundles.sales_count END DESC NULLS LAST,
    bundles.created_at DESC,
    bundles.id DESC
  OFFSET greatest(coalesce(p_offset, 0), 0)
  LIMIT greatest(coalesce(p_limit, 24), 1);
$$;

CREATE INDEX IF NOT EXISTS post_resource_bundles_prompt_resource_idx
  ON public.post_resource_bundles (created_at DESC, id DESC)
  WHERE status = 'published' AND nullif(btrim(coalesce(prompt_text, '')), '') IS NOT NULL;

CREATE INDEX IF NOT EXISTS post_resource_bundles_notes_resource_idx
  ON public.post_resource_bundles (created_at DESC, id DESC)
  WHERE status = 'published' AND nullif(btrim(coalesce(notes_markdown, '')), '') IS NOT NULL;

CREATE INDEX IF NOT EXISTS post_resource_bundles_workflow_resource_idx
  ON public.post_resource_bundles (created_at DESC, id DESC)
  WHERE status = 'published' AND (nullif(btrim(coalesce(workflow_share_url, '')), '') IS NOT NULL OR workflow_snapshot IS NOT NULL);

CREATE INDEX IF NOT EXISTS post_resource_bundles_files_resource_idx
  ON public.post_resource_bundles (created_at DESC, id DESC)
  WHERE status = 'published' AND jsonb_typeof(attachments) = 'array' AND jsonb_array_length(attachments) > 0;

CREATE INDEX IF NOT EXISTS post_resource_bundles_remix_resource_idx
  ON public.post_resource_bundles (created_at DESC, id DESC)
  WHERE status = 'published' AND allow_remix = true;

REVOKE ALL ON FUNCTION public.apply_post_resource_bundle_mutation(uuid, uuid, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_post_with_resource_bundle(jsonb, jsonb, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_post_with_resource_bundle(uuid, uuid, jsonb, boolean, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.publish_generation_post_with_resource_bundle(uuid, uuid, jsonb, jsonb, jsonb, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_marketplace_resource_bundles(text, text, text, text, integer, integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.apply_post_resource_bundle_mutation(uuid, uuid, text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.upsert_post_with_resource_bundle(jsonb, jsonb, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.update_post_with_resource_bundle(uuid, uuid, jsonb, boolean, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.publish_generation_post_with_resource_bundle(uuid, uuid, jsonb, jsonb, jsonb, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_marketplace_resource_bundles(text, text, text, text, integer, integer) TO service_role;
