-- Give proof media and resource items durable identities so one recipe can safely
-- target all proof outputs or a selected subset. Existing resource items remain
-- global; this migration does not change bundle visibility or storage policies.

ALTER TABLE public.post_media
  ADD COLUMN IF NOT EXISTS media_key text;

UPDATE public.post_media
SET media_key = 'media-' || (sort_order + 1)::text
WHERE nullif(btrim(coalesce(media_key, '')), '') IS NULL;

ALTER TABLE public.post_media
  ALTER COLUMN media_key SET DEFAULT gen_random_uuid()::text,
  ALTER COLUMN media_key SET NOT NULL,
  DROP CONSTRAINT IF EXISTS post_media_media_key_check;

ALTER TABLE public.post_media
  ADD CONSTRAINT post_media_media_key_check CHECK (
    length(media_key) BETWEEN 1 AND 80
    AND media_key ~ '^[A-Za-z0-9][A-Za-z0-9_-]*$'
  );

CREATE UNIQUE INDEX IF NOT EXISTS post_media_post_media_key_idx
  ON public.post_media (post_id, media_key);

COMMENT ON COLUMN public.post_media.media_key IS
  'Stable client-visible proof-media identity used by scoped recipe resources.';

CREATE OR REPLACE FUNCTION public.replace_post_media(
  p_post_id uuid,
  p_owner_user_id uuid,
  p_media_items jsonb
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_item jsonb;
  v_item_count integer;
  v_cover jsonb;
  v_sort_order integer;
  v_media_key text;
  v_seen_media_keys text[] := ARRAY[]::text[];
  v_existing_media_keys jsonb := '{}'::jsonb;
  v_normalized_media_items jsonb := '[]'::jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.posts
    WHERE id = p_post_id AND user_id = p_owner_user_id AND generation_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Manual post not found or media is not editable.';
  END IF;

  IF jsonb_typeof(coalesce(p_media_items, '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'Post media must be an array.';
  END IF;

  v_item_count := jsonb_array_length(coalesce(p_media_items, '[]'::jsonb));
  IF v_item_count > 5 THEN
    RAISE EXCEPTION 'Posts support up to 5 media items.';
  END IF;

  -- Old clients do not send mediaKey. Keep the key already occupying that sort
  -- position when possible, then fall back to the deterministic legacy key.
  SELECT coalesce(jsonb_object_agg(sort_order::text, media_key), '{}'::jsonb)
  INTO v_existing_media_keys
  FROM public.post_media
  WHERE post_id = p_post_id;

  FOR v_item IN
    SELECT value
    FROM jsonb_array_elements(coalesce(p_media_items, '[]'::jsonb))
  LOOP
    v_sort_order := (v_item->>'sortOrder')::integer;
    v_media_key := coalesce(
      nullif(btrim(coalesce(v_item->>'mediaKey', '')), ''),
      nullif(v_existing_media_keys->>v_sort_order::text, ''),
      'media-' || (v_sort_order + 1)::text
    );

    IF length(v_media_key) > 80
      OR v_media_key !~ '^[A-Za-z0-9][A-Za-z0-9_-]*$' THEN
      RAISE EXCEPTION 'Post media keys may only use letters, numbers, hyphens, and underscores.';
    END IF;

    IF v_media_key = ANY(v_seen_media_keys) THEN
      RAISE EXCEPTION 'Post media keys must be unique within a post.';
    END IF;

    v_seen_media_keys := array_append(v_seen_media_keys, v_media_key);
    v_normalized_media_items := v_normalized_media_items
      || jsonb_build_array(v_item || jsonb_build_object('mediaKey', v_media_key));
  END LOOP;

  DELETE FROM public.post_media WHERE post_id = p_post_id;

  FOR v_item IN
    SELECT value
    FROM jsonb_array_elements(v_normalized_media_items)
  LOOP
    INSERT INTO public.post_media (
      post_id, media_key, storage_path, preview_storage_path, preview_thumbhash, preview_status,
      preview_attempt_count, preview_error, preview_generated_at, external_url,
      media_kind, content_type, original_name, width, height, duration_seconds, sort_order
    ) VALUES (
      p_post_id,
      v_item->>'mediaKey',
      nullif(btrim(coalesce(v_item->>'storagePath', '')), ''),
      nullif(btrim(coalesce(v_item->>'previewStoragePath', '')), ''),
      nullif(btrim(coalesce(v_item->>'previewThumbhash', '')), ''),
      coalesce(nullif(v_item->>'previewStatus', ''), 'pending'),
      coalesce((v_item->>'previewAttemptCount')::integer, 0),
      nullif(btrim(coalesce(v_item->>'previewError', '')), ''),
      CASE WHEN nullif(v_item->>'previewGeneratedAt', '') IS NULL THEN NULL ELSE (v_item->>'previewGeneratedAt')::timestamptz END,
      nullif(btrim(coalesce(v_item->>'externalUrl', '')), ''),
      v_item->>'mediaKind',
      nullif(btrim(coalesce(v_item->>'contentType', '')), ''),
      nullif(btrim(coalesce(v_item->>'originalName', '')), ''),
      CASE WHEN v_item ? 'width' THEN (v_item->>'width')::integer ELSE NULL END,
      CASE WHEN v_item ? 'height' THEN (v_item->>'height')::integer ELSE NULL END,
      CASE WHEN v_item ? 'durationSeconds' THEN (v_item->>'durationSeconds')::numeric ELSE NULL END,
      (v_item->>'sortOrder')::integer
    );
  END LOOP;

  v_cover := v_normalized_media_items->0;
  UPDATE public.posts
  SET
    showcase_asset_path = nullif(btrim(coalesce(v_cover->>'storagePath', '')), ''),
    output_url = CASE
      WHEN nullif(btrim(coalesce(v_cover->>'storagePath', '')), '') IS NULL
        THEN nullif(btrim(coalesce(v_cover->>'externalUrl', '')), '')
      ELSE NULL
    END,
    category = CASE WHEN v_item_count = 0 THEN category WHEN v_cover->>'mediaKind' = 'video' THEN 'video' ELSE 'image' END,
    updated_at = timezone('utc'::text, now())
  WHERE id = p_post_id AND user_id = p_owner_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_owner_post_bundle_summaries(p_post_ids uuid[])
RETURNS TABLE(
  id uuid,
  post_id uuid,
  access_mode text,
  status text,
  price_usd_cents integer,
  sales_count integer,
  earnings_usd_cents integer,
  resource_kinds text[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    bundles.id,
    bundles.post_id,
    bundles.access_mode,
    bundles.status,
    bundles.price_usd_cents,
    bundles.sales_count,
    bundles.earnings_usd_cents,
    array_remove(ARRAY[
      CASE WHEN
        CASE
          WHEN jsonb_array_length(coalesce(bundles.resource_items, '[]'::jsonb)) > 0
            THEN bundles.resource_items @> '[{"type":"prompt"}]'::jsonb
          ELSE nullif(btrim(coalesce(bundles.prompt_text, '')), '') IS NOT NULL
        END
      THEN 'prompt' END,
      CASE WHEN
        CASE
          WHEN jsonb_array_length(coalesce(bundles.resource_items, '[]'::jsonb)) > 0
            THEN bundles.resource_items @> '[{"type":"workflow"}]'::jsonb
          ELSE nullif(btrim(coalesce(bundles.workflow_share_url, '')), '') IS NOT NULL
            OR bundles.workflow_snapshot IS NOT NULL
        END
      THEN 'workflow' END,
      CASE WHEN
        CASE
          WHEN jsonb_array_length(coalesce(bundles.resource_items, '[]'::jsonb)) > 0 THEN EXISTS (
            SELECT 1
            FROM jsonb_array_elements(bundles.resource_items) AS item
            WHERE coalesce(item->>'type', '') NOT IN (
              'prompt', 'workflow', 'settings', 'note', 'remix_access', 'remix_link'
            )
          )
          ELSE jsonb_typeof(coalesce(bundles.attachments, '[]'::jsonb)) = 'array'
            AND jsonb_array_length(coalesce(bundles.attachments, '[]'::jsonb)) > 0
        END
      THEN 'files' END,
      CASE WHEN
        CASE
          WHEN jsonb_array_length(coalesce(bundles.resource_items, '[]'::jsonb)) > 0
            THEN bundles.resource_items @> '[{"type":"settings"}]'::jsonb
              OR bundles.resource_items @> '[{"type":"note"}]'::jsonb
          ELSE nullif(btrim(coalesce(bundles.notes_markdown, '')), '') IS NOT NULL
        END
      THEN 'notes' END,
      CASE WHEN
        CASE
          WHEN jsonb_array_length(coalesce(bundles.resource_items, '[]'::jsonb)) > 0
            THEN bundles.resource_items @> '[{"type":"remix_access"}]'::jsonb
              OR bundles.resource_items @> '[{"type":"remix_link"}]'::jsonb
          ELSE bundles.allow_remix
        END
      THEN 'remix' END
    ], NULL)::text[] AS resource_kinds
  FROM public.post_resource_bundles AS bundles
  WHERE bundles.post_id = ANY(coalesce(p_post_ids, ARRAY[]::uuid[]));
$$;

REVOKE ALL ON FUNCTION public.get_owner_post_bundle_summaries(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_owner_post_bundle_summaries(uuid[]) TO service_role;

COMMENT ON FUNCTION public.get_owner_post_bundle_summaries(uuid[]) IS
  'Backend-only compact unlock summaries for owner post lists.';

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
  resource_sections jsonb,
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
SET search_path = public, pg_temp
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
    bundles.resource_sections,
    bundles.resource_items,
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
      (
        CASE
          WHEN jsonb_typeof(coalesce(bundles.attachments, '[]'::jsonb)) = 'array' THEN coalesce(bundles.attachments, '[]'::jsonb)
          ELSE '[]'::jsonb
        END
        || coalesce(
          (
            SELECT jsonb_agg(
              jsonb_build_object(
                'label',
                coalesce(
                  nullif(btrim(item->>'title'), ''),
                  nullif(btrim(item->>'description'), ''),
                  CASE coalesce(item->>'type', '')
                    WHEN 'prompt' THEN 'Prompt resource'
                    WHEN 'workflow' THEN 'Workflow resource'
                    WHEN 'reference_image' THEN 'Reference image'
                    WHEN 'reference_video' THEN 'Reference video'
                    WHEN 'reference_audio' THEN 'Reference audio'
                    WHEN 'source_file' THEN 'Source file'
                    WHEN 'preset' THEN 'Preset resource'
                    WHEN 'settings' THEN 'Settings resource'
                    WHEN 'note' THEN 'Note resource'
                    WHEN 'external_link' THEN 'External resource'
                    WHEN 'remix_access' THEN 'Remix access'
                    WHEN 'remix_link' THEN 'Remix link'
                    ELSE 'Resource item'
                  END
                )
              )
            )
            FROM jsonb_array_elements(coalesce(bundles.resource_items, '[]'::jsonb)) AS item
          ),
          '[]'::jsonb
        )
      ),
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
        OR bundles.resource_items @> '[{"type":"reference_video"}]'::jsonb
        OR bundles.resource_items @> '[{"type":"reference_audio"}]'::jsonb
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
        OR bundles.resource_items @> '[{"type":"remix_link"}]'::jsonb
      ))
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
        posts.source_tool,
        (
          SELECT string_agg(concat_ws(' ', item->>'title', item->>'description', item->>'textContent'), ' ')
          FROM jsonb_array_elements(coalesce(bundles.resource_items, '[]'::jsonb)) AS item
        ),
        (
          SELECT string_agg(concat_ws(' ', section->>'title', section->>'description', section->>'kind'), ' ')
          FROM jsonb_array_elements(coalesce(bundles.resource_sections, '[]'::jsonb)) AS section
        )
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

CREATE OR REPLACE FUNCTION public.list_marketplace_resource_bundles(
  p_access_filter text,
  p_resource_filter text,
  p_tool_slug text,
  p_sort text,
  p_offset integer,
  p_limit integer
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
  resource_sections jsonb,
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
SET search_path = public, pg_temp
AS $$
  SELECT *
  FROM public.list_marketplace_resource_bundles(
    p_access_filter,
    p_resource_filter,
    p_tool_slug,
    NULL,
    p_sort,
    p_offset,
    p_limit
  );
$$;

REVOKE ALL ON FUNCTION public.list_marketplace_resource_bundles(text, text, text, text, text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_marketplace_resource_bundles(text, text, text, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_marketplace_resource_bundles(text, text, text, text, text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_marketplace_resource_bundles(text, text, text, text, integer, integer) TO service_role;

REVOKE ALL ON FUNCTION public.replace_post_media(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_post_media(uuid, uuid, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.normalize_post_resource_items(p_items jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_item jsonb;
  v_ordinal bigint;
  v_result jsonb := '[]'::jsonb;
  v_raw_id text;
  v_base_id text;
  v_item_id text;
  v_suffix integer;
  v_seen_ids text[] := ARRAY[]::text[];
  v_scope jsonb;
  v_scope_kind text;
  v_media_key_value jsonb;
  v_media_key text;
  v_media_keys jsonb;
  v_seen_media_keys text[];
BEGIN
  IF jsonb_typeof(coalesce(p_items, '[]'::jsonb)) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Resource items must be an array';
  END IF;

  FOR v_item, v_ordinal IN
    SELECT value, ordinality
    FROM jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) WITH ORDINALITY
  LOOP
    IF jsonb_typeof(v_item) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'Resource items must be objects';
    END IF;

    v_raw_id := nullif(btrim(coalesce(v_item->>'id', '')), '');
    IF v_raw_id IS NOT NULL
      AND (length(v_raw_id) > 80 OR v_raw_id !~ '^[A-Za-z0-9][A-Za-z0-9_-]*$') THEN
      RAISE EXCEPTION 'Resource item ids may only use letters, numbers, hyphens, and underscores';
    END IF;

    v_base_id := coalesce(v_raw_id, 'item-' || v_ordinal::text);
    v_item_id := v_base_id;
    v_suffix := 2;
    WHILE v_item_id = ANY(v_seen_ids) LOOP
      v_item_id := left(v_base_id, greatest(1, 79 - length(v_suffix::text))) || '-' || v_suffix::text;
      v_suffix := v_suffix + 1;
    END LOOP;
    v_seen_ids := array_append(v_seen_ids, v_item_id);

    v_scope := v_item->'scope';
    IF v_scope IS NULL OR v_scope = 'null'::jsonb THEN
      v_scope := jsonb_build_object('kind', 'all');
    ELSIF jsonb_typeof(v_scope) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'Choose whether each resource applies to all outputs or selected media';
    ELSE
      v_scope_kind := v_scope->>'kind';
      IF v_scope_kind = 'all' THEN
        v_scope := jsonb_build_object('kind', 'all');
      ELSIF v_scope_kind = 'media' THEN
        IF jsonb_typeof(v_scope->'mediaKeys') IS DISTINCT FROM 'array'
          OR jsonb_array_length(v_scope->'mediaKeys') = 0 THEN
          RAISE EXCEPTION 'Select at least one proof media item for a media-scoped resource';
        END IF;

        v_media_keys := '[]'::jsonb;
        v_seen_media_keys := ARRAY[]::text[];
        FOR v_media_key_value IN
          SELECT value FROM jsonb_array_elements(v_scope->'mediaKeys')
        LOOP
          IF jsonb_typeof(v_media_key_value) IS DISTINCT FROM 'string' THEN
            RAISE EXCEPTION 'Resource media keys may only use letters, numbers, hyphens, and underscores';
          END IF;
          v_media_key := btrim(v_media_key_value #>> '{}');
          IF length(v_media_key) > 80
            OR v_media_key !~ '^[A-Za-z0-9][A-Za-z0-9_-]*$' THEN
            RAISE EXCEPTION 'Resource media keys may only use letters, numbers, hyphens, and underscores';
          END IF;
          IF v_media_key = ANY(v_seen_media_keys) THEN
            RAISE EXCEPTION 'Resource media keys must be unique within an item scope';
          END IF;
          v_seen_media_keys := array_append(v_seen_media_keys, v_media_key);
          v_media_keys := v_media_keys || jsonb_build_array(v_media_key);
        END LOOP;
        v_scope := jsonb_build_object('kind', 'media', 'mediaKeys', v_media_keys);
      ELSE
        RAISE EXCEPTION 'Choose whether each resource applies to all outputs or selected media';
      END IF;
    END IF;

    v_result := v_result || jsonb_build_array(
      (v_item - 'id' - 'scope')
      || jsonb_build_object('id', v_item_id, 'scope', v_scope)
    );
  END LOOP;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.normalize_post_resource_items(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.normalize_post_resource_items(jsonb) TO authenticated, service_role;

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
      WHEN coalesce(v_attachment->>'resourceType', '') IN (
        'workflow', 'reference_image', 'reference_video', 'reference_audio',
        'source_file', 'preset', 'external_link', 'remix_link'
      ) THEN v_attachment->>'resourceType'
      WHEN coalesce(v_attachment->>'contentType', '') LIKE 'image/%' THEN 'reference_image'
      WHEN coalesce(v_attachment->>'contentType', '') LIKE 'video/%' THEN 'reference_video'
      WHEN coalesce(v_attachment->>'contentType', '') LIKE 'audio/%' THEN 'reference_audio'
      WHEN lower(coalesce(v_attachment->>'label', '') || ' ' || coalesce(v_attachment->>'storagePath', '') || ' ' || coalesce(v_attachment->>'url', '')) LIKE '%workflow%' THEN 'workflow'
      WHEN lower(coalesce(v_attachment->>'label', '') || ' ' || coalesce(v_attachment->>'storagePath', '') || ' ' || coalesce(v_attachment->>'url', '')) LIKE '%preset%' THEN 'preset'
      WHEN coalesce(v_attachment->>'kind', 'link') = 'file' THEN 'source_file'
      ELSE 'external_link'
    END;

    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'type', v_attachment_type,
      'role', coalesce(
        nullif(v_attachment->>'role', ''),
        CASE WHEN v_attachment_type IN ('reference_image', 'reference_video', 'reference_audio') THEN 'style_reference' ELSE 'primary' END
      ),
      'title', coalesce(nullif(v_attachment->>'label', ''), 'Resource'),
      'externalUrl', nullif(v_attachment->>'url', ''),
      'storagePath', nullif(v_attachment->>'storagePath', ''),
      'contentType', nullif(v_attachment->>'contentType', ''),
      'sizeBytes', CASE WHEN jsonb_typeof(v_attachment->'sizeBytes') = 'number' THEN v_attachment->'sizeBytes' ELSE NULL END,
      'sortOrder', v_sort_order,
      'isPrimary', v_sort_order = 0,
      'remixUse', coalesce(
        nullif(v_attachment->>'remixUse', ''),
        CASE
          WHEN v_attachment_type IN ('reference_image', 'reference_video', 'reference_audio') THEN 'reference_only'
          WHEN v_attachment_type = 'workflow' THEN 'import_source'
          ELSE 'none'
        END
      )
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

  RETURN public.normalize_post_resource_items(v_items);
END;
$$;

REVOKE ALL ON FUNCTION public.build_post_resource_items_from_legacy_bundle(text, text, text, jsonb, jsonb, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.build_post_resource_items_from_legacy_bundle(text, text, text, jsonb, jsonb, boolean) TO service_role;

-- Every pre-existing item lacked scope under the old contract, so normalization
-- assigns {"kind":"all"} without changing who can see or unlock the bundle.
UPDATE public.post_resource_bundles
SET resource_items = public.normalize_post_resource_items(resource_items);

ALTER TABLE public.post_resource_bundles
  DROP CONSTRAINT IF EXISTS post_resource_bundles_price_usd_cents_check,
  DROP CONSTRAINT IF EXISTS post_resource_bundles_access_mode_price_check;

ALTER TABLE public.post_resource_bundles
  ADD CONSTRAINT post_resource_bundles_price_usd_cents_check CHECK (
    price_usd_cents = 0
    OR (price_usd_cents >= 10 AND price_usd_cents % 10 = 0)
  ) NOT VALID,
  ADD CONSTRAINT post_resource_bundles_access_mode_price_check CHECK (
    (access_mode = 'free' AND price_usd_cents = 0)
    OR (access_mode = 'paid' AND price_usd_cents >= 10 AND price_usd_cents % 10 = 0)
  ) NOT VALID;

-- Historic clients allowed arbitrary cent values. Do not block deployment if an
-- old listing has one; the checks still apply to every new or changed row.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.post_resource_bundles
    WHERE price_usd_cents <> 0
      AND (price_usd_cents < 10 OR price_usd_cents % 10 <> 0)
  ) THEN
    EXECUTE 'ALTER TABLE public.post_resource_bundles VALIDATE CONSTRAINT post_resource_bundles_price_usd_cents_check';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.post_resource_bundles
    WHERE NOT (
      (access_mode = 'free' AND price_usd_cents = 0)
      OR (access_mode = 'paid' AND price_usd_cents >= 10 AND price_usd_cents % 10 = 0)
    )
  ) THEN
    EXECUTE 'ALTER TABLE public.post_resource_bundles VALIDATE CONSTRAINT post_resource_bundles_access_mode_price_check';
  END IF;
END;
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

  IF p_access_mode = 'paid'
    AND (
      coalesce(p_price_usd_cents, 0) < 10
      OR coalesce(p_price_usd_cents, 0) % 10 <> 0
    ) THEN
    RETURN 'Paid unlocks must cost at least 10 tokens and use 10-token increments.';
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

REVOKE ALL ON FUNCTION public.marketplace_resource_bundle_quality_issue(text, text, text, text, text, text, jsonb, jsonb, boolean, integer, text, text, text, text, timestamptz, text, boolean, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.marketplace_resource_bundle_quality_issue(text, text, text, text, text, text, jsonb, jsonb, boolean, integer, text, text, text, text, timestamptz, text, boolean, text, text) TO service_role;

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
SET search_path = public, pg_temp
AS $$
DECLARE
  v_access_mode text := coalesce(nullif(p_bundle->>'accessMode', ''), 'none');
  v_resources jsonb := coalesce(p_bundle->'resources', '{}'::jsonb);
  v_attachments jsonb := '[]'::jsonb;
  v_resource_sections jsonb := '[]'::jsonb;
  v_resource_items jsonb := '[]'::jsonb;
  v_quality_attachments jsonb := '[]'::jsonb;
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

  v_resource_sections := coalesce(v_resources->'sections', '[]'::jsonb);
  IF jsonb_typeof(v_resource_sections) IS DISTINCT FROM 'array' THEN
    v_resource_sections := '[]'::jsonb;
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
  ELSE
    v_resource_items := public.normalize_post_resource_items(v_resource_items);
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
    IF v_price_usd_cents < 10 OR v_price_usd_cents % 10 <> 0 THEN
      RAISE EXCEPTION 'Paid unlocks must cost at least 10 tokens and use 10-token increments';
    END IF;
  END IF;

  IF v_status = 'published' THEN
    SELECT * INTO v_post
    FROM public.posts
    WHERE id = p_post_id;

    SELECT username, display_name INTO v_profile
    FROM public.profiles
    WHERE id = p_owner_user_id;

    SELECT v_attachments || coalesce(
      jsonb_agg(
        jsonb_build_object(
          'label',
          coalesce(
            nullif(btrim(item->>'title'), ''),
            nullif(btrim(item->>'description'), ''),
            CASE coalesce(item->>'type', '')
              WHEN 'prompt' THEN 'Prompt resource'
              WHEN 'workflow' THEN 'Workflow resource'
              WHEN 'reference_image' THEN 'Reference image'
              WHEN 'reference_video' THEN 'Reference video'
              WHEN 'reference_audio' THEN 'Reference audio'
              WHEN 'source_file' THEN 'Source file'
              WHEN 'preset' THEN 'Preset resource'
              WHEN 'settings' THEN 'Settings resource'
              WHEN 'note' THEN 'Note resource'
              WHEN 'external_link' THEN 'External resource'
              WHEN 'remix_access' THEN 'Remix access'
              WHEN 'remix_link' THEN 'Remix link'
              ELSE 'Resource item'
            END
          )
        )
      ),
      '[]'::jsonb
    )
    INTO v_quality_attachments
    FROM jsonb_array_elements(v_resource_items) AS item;

    v_quality_issue := public.marketplace_resource_bundle_quality_issue(
      coalesce(nullif(btrim(p_post_title), ''), 'Attached unlock'),
      coalesce(nullif(btrim(p_bundle->>'summary'), ''), ''),
      coalesce(nullif(btrim(p_bundle->>'previewText'), ''), ''),
      v_prompt_text,
      v_notes_markdown,
      v_workflow_share_url,
      v_workflow_snapshot,
      v_quality_attachments,
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
    resource_sections,
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
    v_resource_sections,
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
      resource_sections = EXCLUDED.resource_sections,
      resource_items = EXCLUDED.resource_items,
      price_usd_cents = EXCLUDED.price_usd_cents,
      updated_at = timezone('utc'::text, now())
  RETURNING id, status INTO v_bundle_id, v_bundle_status;

  RETURN QUERY SELECT v_bundle_id, v_bundle_status;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_post_resource_bundle_mutation(uuid, uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_post_resource_bundle_mutation(uuid, uuid, text, text, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.validate_post_resource_bundle_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
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

  IF NEW.access_mode = 'paid'
    AND (NEW.price_usd_cents < 10 OR NEW.price_usd_cents % 10 <> 0) THEN
    RAISE EXCEPTION 'Paid bundles must cost at least 10 tokens and use 10-token increments';
  END IF;

  IF jsonb_typeof(coalesce(NEW.resource_sections, '[]'::jsonb)) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Resource sections must be an array';
  END IF;

  IF jsonb_typeof(coalesce(NEW.resource_items, '[]'::jsonb)) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Resource items must be an array';
  END IF;

  -- This also adds missing stable IDs and global scopes. Media-scope membership is
  -- checked by the API because new-post bundles are persisted before post_media.
  NEW.resource_items := public.normalize_post_resource_items(NEW.resource_items);

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(coalesce(NEW.resource_sections, '[]'::jsonb)) AS section
    WHERE nullif(btrim(coalesce(section->>'id', '')), '') IS NULL
  ) THEN
    RAISE EXCEPTION 'Resource sections must include a stable id';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(coalesce(NEW.resource_sections, '[]'::jsonb)) AS section
    WHERE coalesce(nullif(btrim(section->>'kind'), ''), 'other') NOT IN (
      'global',
      'scene',
      'shot',
      'frame',
      'variation',
      'workflow_step',
      'asset_group',
      'chapter',
      'other'
    )
  ) THEN
    RAISE EXCEPTION 'Choose a valid resource section kind';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      SELECT btrim(section->>'id') AS section_id
      FROM jsonb_array_elements(coalesce(NEW.resource_sections, '[]'::jsonb)) AS section
      GROUP BY btrim(section->>'id')
      HAVING count(*) > 1
    ) duplicates
  ) THEN
    RAISE EXCEPTION 'Resource sections must have unique ids';
  END IF;

  IF EXISTS (
    WITH section_ids AS (
      SELECT btrim(section->>'id') AS section_id
      FROM jsonb_array_elements(coalesce(NEW.resource_sections, '[]'::jsonb)) AS section
      WHERE nullif(btrim(coalesce(section->>'id', '')), '') IS NOT NULL
    )
    SELECT 1
    FROM jsonb_array_elements(coalesce(NEW.resource_items, '[]'::jsonb)) AS item
    WHERE nullif(btrim(coalesce(item->>'sectionId', '')), '') IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM section_ids
        WHERE section_ids.section_id = btrim(item->>'sectionId')
      )
  ) THEN
    RAISE EXCEPTION 'Resource item sectionId must reference an existing resource section';
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
