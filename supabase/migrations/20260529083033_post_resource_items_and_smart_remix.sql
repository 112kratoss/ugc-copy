ALTER TABLE public.post_resource_bundles
  ADD COLUMN IF NOT EXISTS resource_items jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.post_resource_bundles
  DROP CONSTRAINT IF EXISTS post_resource_bundles_resource_items_array_check;

ALTER TABLE public.post_resource_bundles
  ADD CONSTRAINT post_resource_bundles_resource_items_array_check
  CHECK (jsonb_typeof(resource_items) = 'array');

CREATE OR REPLACE FUNCTION public.build_post_resource_items_from_legacy_bundle(
  p_prompt_text text,
  p_notes_markdown text,
  p_workflow_share_url text,
  p_workflow_snapshot jsonb,
  p_attachments jsonb,
  p_allow_remix boolean
)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_items jsonb := '[]'::jsonb;
  v_attachment jsonb;
  v_attachment_type text;
  v_sort_order integer := 0;
BEGIN
  IF nullif(btrim(coalesce(p_prompt_text, '')), '') IS NOT NULL THEN
    v_items := v_items || jsonb_build_array(jsonb_build_object('type', 'prompt', 'role', 'primary', 'title', 'Prompt', 'textContent', p_prompt_text, 'sortOrder', v_sort_order, 'isPrimary', v_sort_order = 0, 'remixUse', 'none'));
    v_sort_order := v_sort_order + 1;
  END IF;

  IF nullif(btrim(coalesce(p_workflow_share_url, '')), '') IS NOT NULL OR p_workflow_snapshot IS NOT NULL THEN
    v_items := v_items || jsonb_build_array(jsonb_build_object('type', 'workflow', 'role', 'primary', 'title', 'Workflow', 'externalUrl', p_workflow_share_url, 'workflowSnapshot', p_workflow_snapshot, 'sortOrder', v_sort_order, 'isPrimary', v_sort_order = 0, 'remixUse', 'import_source'));
    v_sort_order := v_sort_order + 1;
  END IF;

  FOR v_attachment IN
    SELECT value
    FROM jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(coalesce(p_attachments, '[]'::jsonb)) = 'array' THEN coalesce(p_attachments, '[]'::jsonb)
        ELSE '[]'::jsonb
      END
    )
  LOOP
    v_attachment_type := CASE
      WHEN coalesce(v_attachment->>'resourceType', '') IN ('workflow', 'reference_image', 'source_file', 'preset', 'external_link') THEN v_attachment->>'resourceType'
      WHEN coalesce(v_attachment->>'contentType', '') LIKE 'image/%' THEN 'reference_image'
      WHEN lower(coalesce(v_attachment->>'label', '') || ' ' || coalesce(v_attachment->>'storagePath', '') || ' ' || coalesce(v_attachment->>'url', '')) LIKE '%workflow%' THEN 'workflow'
      WHEN lower(coalesce(v_attachment->>'label', '') || ' ' || coalesce(v_attachment->>'storagePath', '') || ' ' || coalesce(v_attachment->>'url', '')) LIKE '%preset%' THEN 'preset'
      WHEN coalesce(v_attachment->>'kind', 'link') = 'file' THEN 'source_file'
      ELSE 'external_link'
    END;

    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'type', v_attachment_type,
      'role', coalesce(nullif(v_attachment->>'role', ''), CASE WHEN v_attachment_type = 'reference_image' THEN 'style_reference' ELSE 'primary' END),
      'title', coalesce(nullif(v_attachment->>'label', ''), 'Resource'),
      'externalUrl', nullif(v_attachment->>'url', ''),
      'storagePath', nullif(v_attachment->>'storagePath', ''),
      'contentType', nullif(v_attachment->>'contentType', ''),
      'sizeBytes', CASE WHEN jsonb_typeof(v_attachment->'sizeBytes') = 'number' THEN v_attachment->'sizeBytes' ELSE NULL END,
      'sortOrder', v_sort_order,
      'isPrimary', v_sort_order = 0,
      'remixUse', coalesce(nullif(v_attachment->>'remixUse', ''), CASE WHEN v_attachment_type = 'reference_image' THEN 'reference_only' WHEN v_attachment_type = 'workflow' THEN 'import_source' ELSE 'none' END)
    ));
    v_sort_order := v_sort_order + 1;
  END LOOP;

  IF nullif(btrim(coalesce(p_notes_markdown, '')), '') IS NOT NULL THEN
    v_items := v_items || jsonb_build_array(jsonb_build_object('type', 'note', 'role', 'primary', 'title', 'Notes', 'textContent', p_notes_markdown, 'sortOrder', v_sort_order, 'isPrimary', v_sort_order = 0, 'remixUse', 'none'));
    v_sort_order := v_sort_order + 1;
  END IF;

  IF coalesce(p_allow_remix, false) THEN
    v_items := v_items || jsonb_build_array(jsonb_build_object('type', 'remix_access', 'role', 'primary', 'title', 'Remix access', 'sortOrder', v_sort_order, 'isPrimary', v_sort_order = 0, 'remixUse', 'direct_remix'));
  END IF;

  RETURN v_items;
END;
$$;

UPDATE public.post_resource_bundles
SET resource_items = public.build_post_resource_items_from_legacy_bundle(
  prompt_text,
  notes_markdown,
  workflow_share_url,
  workflow_snapshot,
  attachments,
  allow_remix
)
WHERE jsonb_array_length(resource_items) = 0
  AND (
    nullif(btrim(coalesce(prompt_text, '')), '') IS NOT NULL
    OR nullif(btrim(coalesce(notes_markdown, '')), '') IS NOT NULL
    OR nullif(btrim(coalesce(workflow_share_url, '')), '') IS NOT NULL
    OR workflow_snapshot IS NOT NULL
    OR jsonb_array_length(coalesce(attachments, '[]'::jsonb)) > 0
    OR allow_remix = true
  );

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
  v_resource_items jsonb := '[]'::jsonb;
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

  v_resource_items := coalesce(v_resources->'items', '[]'::jsonb);
  IF jsonb_typeof(v_resource_items) IS DISTINCT FROM 'array' THEN
    v_resource_items := '[]'::jsonb;
  END IF;

  v_prompt_text := nullif(btrim(v_resources->>'promptText'), '');
  v_notes_markdown := nullif(btrim(v_resources->>'notesMarkdown'), '');
  v_workflow_share_url := nullif(btrim(v_resources->>'workflowShareUrl'), '');
  v_workflow_snapshot := v_resources->'workflowSnapshot';
  v_allow_remix := lower(coalesce(v_resources->>'allowRemix', 'false')) = 'true';

  IF jsonb_array_length(v_resource_items) = 0 THEN
    v_resource_items := public.build_post_resource_items_from_legacy_bundle(
      v_prompt_text,
      v_notes_markdown,
      v_workflow_share_url,
      v_workflow_snapshot,
      v_attachments,
      v_allow_remix
    );
  END IF;

  IF v_prompt_text IS NULL
    AND v_notes_markdown IS NULL
    AND v_workflow_share_url IS NULL
    AND v_workflow_snapshot IS NULL
    AND jsonb_array_length(v_attachments) = 0
    AND v_allow_remix IS NOT TRUE
    AND jsonb_array_length(v_resource_items) = 0 THEN
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
    resource_items,
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
    v_resource_items,
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
      resource_items = EXCLUDED.resource_items,
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
    FROM jsonb_array_elements(coalesce(NEW.resource_items, '[]'::jsonb)) AS item
    WHERE nullif(btrim(coalesce(item->>'externalUrl', '')), '') IS NOT NULL
      AND item->>'externalUrl' !~* '^https?://'
  ) THEN
    RAISE EXCEPTION 'Resource links must start with http:// or https://';
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

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(coalesce(NEW.resource_items, '[]'::jsonb)) AS item
    WHERE nullif(btrim(coalesce(item->>'storagePath', '')), '') IS NOT NULL
      AND (
        btrim(item->>'storagePath') !~ ('^' || NEW.owner_user_id::text || '/')
        OR btrim(item->>'storagePath') LIKE '%..%'
        OR btrim(item->>'storagePath') ~ '[\\]'
      )
  ) THEN
    RAISE EXCEPTION 'Uploaded resource files must belong to the creator publishing this post';
  END IF;

  IF nullif(btrim(coalesce(NEW.prompt_text, '')), '') IS NULL
    AND nullif(btrim(coalesce(NEW.notes_markdown, '')), '') IS NULL
    AND nullif(btrim(coalesce(NEW.workflow_share_url, '')), '') IS NULL
    AND NEW.workflow_snapshot IS NULL
    AND jsonb_array_length(coalesce(NEW.attachments, '[]'::jsonb)) = 0
    AND NEW.allow_remix IS NOT TRUE
    AND jsonb_array_length(coalesce(NEW.resource_items, '[]'::jsonb)) = 0 THEN
    RAISE EXCEPTION 'Add content for at least one unlock item before publishing';
  END IF;

  RETURN NEW;
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
  resource_items jsonb,
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
    bundles.resource_items,
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
      OR (p_resource_filter = 'prompt' AND (
        nullif(btrim(coalesce(bundles.prompt_text, '')), '') IS NOT NULL
        OR bundles.resource_items @> '[{"type":"prompt"}]'::jsonb
      ))
      OR (p_resource_filter = 'workflow' AND (
        nullif(btrim(coalesce(bundles.workflow_share_url, '')), '') IS NOT NULL
        OR bundles.workflow_snapshot IS NOT NULL
        OR bundles.resource_items @> '[{"type":"workflow"}]'::jsonb
      ))
      OR (p_resource_filter = 'files' AND (
        (jsonb_typeof(bundles.attachments) = 'array' AND jsonb_array_length(bundles.attachments) > 0)
        OR bundles.resource_items @> '[{"type":"reference_image"}]'::jsonb
        OR bundles.resource_items @> '[{"type":"source_file"}]'::jsonb
        OR bundles.resource_items @> '[{"type":"preset"}]'::jsonb
        OR bundles.resource_items @> '[{"type":"external_link"}]'::jsonb
      ))
      OR (p_resource_filter = 'notes' AND (
        nullif(btrim(coalesce(bundles.notes_markdown, '')), '') IS NOT NULL
        OR bundles.resource_items @> '[{"type":"note"}]'::jsonb
        OR bundles.resource_items @> '[{"type":"settings"}]'::jsonb
      ))
      OR (p_resource_filter = 'remix' AND (
        bundles.allow_remix = true
        OR bundles.resource_items @> '[{"type":"remix_access"}]'::jsonb
      ))
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

CREATE INDEX IF NOT EXISTS post_resource_bundles_resource_items_gin_idx
  ON public.post_resource_bundles USING gin (resource_items)
  WHERE status = 'published';

REVOKE ALL ON FUNCTION public.build_post_resource_items_from_legacy_bundle(text, text, text, jsonb, jsonb, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_post_resource_bundle_mutation(uuid, uuid, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_marketplace_resource_bundles(text, text, text, text, integer, integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.apply_post_resource_bundle_mutation(uuid, uuid, text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_marketplace_resource_bundles(text, text, text, text, integer, integer) TO service_role;
