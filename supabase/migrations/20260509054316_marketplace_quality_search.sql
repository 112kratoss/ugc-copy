CREATE OR REPLACE FUNCTION public.marketplace_text_is_placeholder(p_value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  WITH normalized AS (
    SELECT btrim(lower(regexp_replace(coalesce(p_value, ''), '[^a-z0-9]+', ' ', 'g'))) AS value
  ),
  compact AS (
    SELECT regexp_replace(value, '\s+', '', 'g') AS value
    FROM normalized
  )
  SELECT
    (SELECT value = '' FROM normalized)
    OR EXISTS (
      SELECT 1
      FROM regexp_split_to_table((SELECT value FROM normalized), '\s+') AS token
      WHERE token IN (
        'asdf',
        'demo',
        'draft',
        'example',
        'foo',
        'ipsum',
        'lorem',
        'placeholder',
        'sample',
        'test',
        'testing',
        'todo',
        'untitled'
      )
    )
    OR (
      (SELECT length(value) FROM compact) >= 6
      AND (
        SELECT count(DISTINCT char_value)
        FROM regexp_split_to_table((SELECT value FROM compact), '') AS char_value
      ) <= 3
    );
$$;

CREATE OR REPLACE FUNCTION public.marketplace_resource_bundle_quality_issue(
  p_title text,
  p_summary text,
  p_preview_text text,
  p_prompt_text text,
  p_notes_markdown text,
  p_workflow_share_url text,
  p_workflow_snapshot jsonb,
  p_attachments jsonb,
  p_allow_remix boolean,
  p_price_usd_cents integer,
  p_access_mode text,
  p_post_title text,
  p_post_body text,
  p_post_visibility text,
  p_post_archived_at timestamptz,
  p_post_review_status text,
  p_post_has_media boolean,
  p_seller_username text,
  p_seller_display_name text
)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_title text := btrim(coalesce(p_title, ''));
  v_summary text := btrim(coalesce(p_summary, ''));
  v_preview text := btrim(coalesce(nullif(p_summary, ''), p_preview_text, ''));
  v_post_title text := btrim(coalesce(p_post_title, ''));
  v_post_body text := btrim(coalesce(p_post_body, ''));
  v_username text := btrim(coalesce(p_seller_username, ''));
  v_display_name text := btrim(coalesce(p_seller_display_name, ''));
  v_attachments jsonb := CASE
    WHEN jsonb_typeof(coalesce(p_attachments, '[]'::jsonb)) = 'array' THEN coalesce(p_attachments, '[]'::jsonb)
    ELSE '[]'::jsonb
  END;
  v_has_resource boolean;
  v_has_creator boolean;
BEGIN
  IF v_title = '' OR length(v_title) < 6 THEN
    RETURN 'Add a clear listing title with at least 6 characters.';
  END IF;

  IF public.marketplace_text_is_placeholder(v_title) THEN
    RETURN 'Replace the placeholder listing title with a specific buyer-facing title.';
  END IF;

  IF v_preview = '' OR length(v_preview) < 18 OR public.marketplace_text_is_placeholder(v_preview) THEN
    RETURN 'Add a useful preview or summary that tells buyers what they will unlock.';
  END IF;

  SELECT
    (
      (nullif(btrim(coalesce(p_prompt_text, '')), '') IS NOT NULL AND length(btrim(coalesce(p_prompt_text, ''))) >= 20 AND NOT public.marketplace_text_is_placeholder(p_prompt_text))
      OR (nullif(btrim(coalesce(p_notes_markdown, '')), '') IS NOT NULL AND length(btrim(coalesce(p_notes_markdown, ''))) >= 20 AND NOT public.marketplace_text_is_placeholder(p_notes_markdown))
      OR nullif(btrim(coalesce(p_workflow_share_url, '')), '') IS NOT NULL
      OR p_workflow_snapshot IS NOT NULL
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_attachments) AS attachment
        WHERE length(btrim(coalesce(attachment->>'label', ''))) >= 4
          AND NOT public.marketplace_text_is_placeholder(attachment->>'label')
      )
      OR coalesce(p_allow_remix, false)
    )
  INTO v_has_resource;

  IF NOT coalesce(v_has_resource, false) THEN
    RETURN 'Attach at least one useful prompt, workflow, file, note, or remix permission.';
  END IF;

  IF p_access_mode = 'paid' AND coalesce(p_price_usd_cents, 0) < 100 THEN
    RETURN 'Paid unlocks must be priced at $1.00 or above.';
  END IF;

  IF p_post_visibility IS DISTINCT FROM 'public'
    OR p_post_archived_at IS NOT NULL
    OR coalesce(p_post_review_status, 'visible') = 'hidden' THEN
    RETURN 'Publish a visible public post before listing this unlock in the marketplace.';
  END IF;

  IF NOT (
    coalesce(p_post_has_media, false)
    OR (length(v_post_body) >= 24 AND NOT public.marketplace_text_is_placeholder(v_post_body))
    OR (length(v_post_title) >= 12 AND NOT public.marketplace_text_is_placeholder(v_post_title))
  ) THEN
    RETURN 'Add useful public post content or media so buyers can judge the result before unlocking.';
  END IF;

  v_has_creator :=
    (
      length(v_username) >= 3
      AND lower(v_username) NOT IN ('anonymous', 'creator', 'magicbooklet', 'unknown', 'user')
      AND NOT public.marketplace_text_is_placeholder(v_username)
    )
    OR (
      length(v_display_name) >= 3
      AND lower(v_display_name) NOT IN ('anonymous', 'creator', 'magicbooklet', 'unknown', 'user')
      AND NOT public.marketplace_text_is_placeholder(v_display_name)
    );

  IF NOT v_has_creator THEN
    RETURN 'Complete your creator profile name or username before publishing a marketplace unlock.';
  END IF;

  RETURN NULL;
END;
$$;

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
  v_post public.posts%ROWTYPE;
  v_profile record;
  v_quality_issue text;
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

  IF v_status = 'published' THEN
    SELECT * INTO v_post
    FROM public.posts
    WHERE id = p_post_id;

    SELECT username, display_name INTO v_profile
    FROM public.profiles
    WHERE id = p_owner_user_id;

    v_quality_issue := public.marketplace_resource_bundle_quality_issue(
      coalesce(nullif(btrim(p_post_title), ''), 'Attached unlock'),
      coalesce(nullif(btrim(p_bundle->>'summary'), ''), ''),
      coalesce(nullif(btrim(p_bundle->>'previewText'), ''), ''),
      v_prompt_text,
      v_notes_markdown,
      v_workflow_share_url,
      v_workflow_snapshot,
      v_attachments,
      v_allow_remix,
      v_price_usd_cents,
      v_access_mode,
      v_post.title,
      v_post.body,
      v_post.visibility,
      v_post.archived_at,
      v_post.review_status,
      (nullif(btrim(coalesce(v_post.showcase_asset_path, '')), '') IS NOT NULL OR nullif(btrim(coalesce(v_post.output_url, '')), '') IS NOT NULL),
      v_profile.username,
      v_profile.display_name
    );

    IF v_quality_issue IS NOT NULL THEN
      RAISE EXCEPTION 'Improve this unlock before publishing: %', v_quality_issue;
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

DROP FUNCTION IF EXISTS public.list_marketplace_resource_bundles(text, text, text, text, integer, integer);

CREATE OR REPLACE FUNCTION public.list_marketplace_resource_bundles(
  p_access_filter text DEFAULT 'all',
  p_resource_filter text DEFAULT 'all',
  p_tool_slug text DEFAULT NULL,
  p_query text DEFAULT NULL,
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
  LEFT JOIN public.profiles profiles ON profiles.id = bundles.owner_user_id
  WHERE bundles.status = 'published'
    AND posts.visibility = 'public'
    AND posts.archived_at IS NULL
    AND coalesce(posts.review_status, 'visible') <> 'hidden'
    AND public.marketplace_resource_bundle_quality_issue(
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
      bundles.access_mode,
      posts.title,
      posts.body,
      posts.visibility,
      posts.archived_at,
      posts.review_status,
      (nullif(btrim(coalesce(posts.showcase_asset_path, '')), '') IS NOT NULL OR nullif(btrim(coalesce(posts.output_url, '')), '') IS NOT NULL),
      profiles.username,
      profiles.display_name
    ) IS NULL
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
    AND (
      coalesce(nullif(btrim(p_query), ''), '') = ''
      OR concat_ws(
        ' ',
        bundles.title,
        bundles.summary,
        bundles.preview_text,
        profiles.username,
        profiles.display_name,
        posts.title,
        posts.body,
        posts.source_tool
      ) ILIKE ('%' || btrim(p_query) || '%')
    )
  ORDER BY
    CASE WHEN p_sort = 'top-sales' THEN bundles.sales_count END DESC NULLS LAST,
    CASE WHEN p_sort = 'price-low' THEN bundles.price_usd_cents END ASC NULLS LAST,
    CASE WHEN p_sort = 'price-high' THEN bundles.price_usd_cents END DESC NULLS LAST,
    bundles.created_at DESC,
    bundles.id DESC
  OFFSET greatest(coalesce(p_offset, 0), 0)
  LIMIT greatest(coalesce(p_limit, 24), 1);
$$;

REVOKE ALL ON FUNCTION public.marketplace_text_is_placeholder(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.marketplace_resource_bundle_quality_issue(text, text, text, text, text, text, jsonb, jsonb, boolean, integer, text, text, text, text, timestamptz, text, boolean, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_post_resource_bundle_mutation(uuid, uuid, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_marketplace_resource_bundles(text, text, text, text, text, integer, integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.marketplace_text_is_placeholder(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.marketplace_resource_bundle_quality_issue(text, text, text, text, text, text, jsonb, jsonb, boolean, integer, text, text, text, text, timestamptz, text, boolean, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.apply_post_resource_bundle_mutation(uuid, uuid, text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_marketplace_resource_bundles(text, text, text, text, text, integer, integer) TO service_role;
