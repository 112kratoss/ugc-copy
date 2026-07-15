-- Keep high-traffic read paths bounded and avoid transferring large JSON payloads
-- when callers only need summaries. All helper RPCs are backend-only.

CREATE OR REPLACE FUNCTION public.list_showcase_top_sales_post_ids(
  p_category text DEFAULT 'all',
  p_tool_slug text DEFAULT NULL,
  p_offset integer DEFAULT 0,
  p_limit integer DEFAULT 25
)
RETURNS TABLE(post_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT posts.id
  FROM public.posts AS posts
  LEFT JOIN public.post_resource_bundles AS bundles
    ON bundles.post_id = posts.id
   AND bundles.status = 'published'
  WHERE posts.visibility = 'public'
    AND posts.archived_at IS NULL
    AND coalesce(posts.review_status, 'visible') = 'visible'
    AND (
      coalesce(p_category, 'all') = 'all'
      OR (
        p_category = 'text'
        AND (posts.category = 'text' OR posts.post_format = 'mixed')
      )
      OR (
        p_category IN ('image', 'video')
        AND (
          EXISTS (
            SELECT 1
            FROM public.post_media AS media
            WHERE media.post_id = posts.id
              AND media.media_kind = p_category
          )
          OR (
            NOT EXISTS (
              SELECT 1
              FROM public.post_media AS media
              WHERE media.post_id = posts.id
            )
            AND CASE
              WHEN posts.category IN ('video', 'motion', 'ugc-ad') THEN 'video'
              ELSE 'image'
            END = p_category
          )
        )
      )
      OR (
        p_category NOT IN ('all', 'text', 'image', 'video')
        AND posts.category = p_category
      )
    )
    AND (
      nullif(btrim(coalesce(p_tool_slug, '')), '') IS NULL
      OR coalesce(
        nullif(posts.source_tool_slug, ''),
        lower(regexp_replace(btrim(coalesce(posts.source_tool, '')), '[^a-z0-9]+', '-', 'g'))
      ) = p_tool_slug
    )
  ORDER BY
    coalesce(bundles.sales_count, 0) DESC,
    posts.created_at DESC,
    posts.id DESC
  OFFSET greatest(coalesce(p_offset, 0), 0)
  LIMIT least(greatest(coalesce(p_limit, 25), 1), 101);
$$;

CREATE OR REPLACE FUNCTION public.get_creator_profile_stats(p_creator_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH visible_posts AS MATERIALIZED (
    SELECT
      posts.id,
      posts.generation_id,
      posts.save_count,
      posts.remix_count,
      posts.source_kind,
      posts.source_tool,
      coalesce(
        nullif(posts.source_tool_slug, ''),
        lower(regexp_replace(btrim(coalesce(posts.source_tool, '')), '[^a-z0-9]+', '-', 'g'))
      ) AS tool_slug
    FROM public.posts AS posts
    WHERE posts.user_id = p_creator_id
      AND posts.visibility = 'public'
      AND posts.archived_at IS NULL
      AND coalesce(posts.review_status, 'visible') <> 'hidden'
  ), post_stats AS (
    SELECT
      count(*)::integer AS public_creations,
      coalesce(sum(visible_posts.save_count), 0)::bigint AS total_saves,
      coalesce(sum(visible_posts.remix_count), 0)::bigint AS total_remixes,
      count(*) FILTER (
        WHERE bundles.status = 'published'
          OR (
            bundles.id IS NULL
            AND visible_posts.generation_id IS NOT NULL
            AND visible_posts.source_kind IN ('magicbooklet', 'emptybooklet', 'ugc_copy')
          )
      )::integer AS unlocks,
      coalesce(sum(bundles.sales_count) FILTER (WHERE bundles.status = 'published'), 0)::bigint
        AS total_unlock_sales
    FROM visible_posts
    LEFT JOIN public.post_resource_bundles AS bundles
      ON bundles.post_id = visible_posts.id
  ), tool_counts AS (
    SELECT
      visible_posts.tool_slug AS slug,
      coalesce(
        max(nullif(btrim(visible_posts.source_tool), '')),
        visible_posts.tool_slug
      ) AS label,
      count(*)::integer AS count
    FROM visible_posts
    WHERE nullif(visible_posts.tool_slug, '') IS NOT NULL
    GROUP BY visible_posts.tool_slug
  ), tools AS (
    SELECT coalesce(
      jsonb_agg(
        jsonb_build_object('slug', slug, 'label', label, 'count', count)
        ORDER BY count DESC, label ASC
      ),
      '[]'::jsonb
    ) AS value
    FROM tool_counts
  )
  SELECT jsonb_build_object(
    'publicCreations', post_stats.public_creations,
    'totalSaves', post_stats.total_saves,
    'totalRemixes', post_stats.total_remixes,
    'unlocks', post_stats.unlocks,
    'totalUnlockSales', post_stats.total_unlock_sales,
    'toolsUsed', tools.value
  )
  FROM post_stats
  CROSS JOIN tools;
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
              'prompt', 'workflow', 'settings', 'note', 'remix_access'
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
          ELSE bundles.allow_remix
        END
      THEN 'remix' END
    ], NULL)::text[] AS resource_kinds
  FROM public.post_resource_bundles AS bundles
  WHERE bundles.post_id = ANY(coalesce(p_post_ids, ARRAY[]::uuid[]));
$$;

CREATE OR REPLACE FUNCTION public.get_owner_post_sales_summary(p_owner_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'salesCount', coalesce(sum(bundles.sales_count), 0)::bigint,
    'earningsUsdCents', coalesce(sum(bundles.earnings_usd_cents), 0)::bigint,
    'listingCount', count(*)::integer
  )
  FROM public.post_resource_bundles AS bundles
  JOIN public.posts AS posts ON posts.id = bundles.post_id
  WHERE posts.user_id = p_owner_id;
$$;

CREATE OR REPLACE FUNCTION public.build_workflow_canvas_library_summary(p_graph jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
DECLARE
  v_nodes jsonb := CASE
    WHEN jsonb_typeof(p_graph->'nodes') = 'array' THEN p_graph->'nodes'
    ELSE '[]'::jsonb
  END;
  v_edges jsonb := CASE
    WHEN jsonb_typeof(p_graph->'edges') = 'array' THEN p_graph->'edges'
    ELSE '[]'::jsonb
  END;
  v_preview_nodes jsonb;
  v_preview_edges jsonb;
  v_output_kinds jsonb;
BEGIN
  WITH selected_nodes AS (
    SELECT node, ordinal - 1 AS index
    FROM jsonb_array_elements(v_nodes) WITH ORDINALITY AS rows(node, ordinal)
    ORDER BY ordinal
    LIMIT 48
  )
  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', 'n' || index,
        'type', coalesce(node->>'type', 'note'),
        'position', jsonb_build_object(
          'x', CASE WHEN jsonb_typeof(node->'position'->'x') = 'number'
            THEN (node->'position'->>'x')::numeric ELSE 0 END,
          'y', CASE WHEN jsonb_typeof(node->'position'->'y') = 'number'
            THEN (node->'position'->>'y')::numeric ELSE 0 END
        )
      )
      ORDER BY index
    ),
    '[]'::jsonb
  )
  INTO v_preview_nodes
  FROM selected_nodes;

  WITH selected_nodes AS (
    SELECT node->>'id' AS id, ordinal - 1 AS index
    FROM jsonb_array_elements(v_nodes) WITH ORDINALITY AS rows(node, ordinal)
    WHERE nullif(node->>'id', '') IS NOT NULL
    ORDER BY ordinal
    LIMIT 48
  ), matching_edges AS (
    SELECT
      source_node.index AS source_index,
      target_node.index AS target_index,
      edge_rows.ordinal
    FROM jsonb_array_elements(v_edges) WITH ORDINALITY AS edge_rows(edge, ordinal)
    JOIN selected_nodes AS source_node ON source_node.id = edge_rows.edge->>'source'
    JOIN selected_nodes AS target_node ON target_node.id = edge_rows.edge->>'target'
    ORDER BY edge_rows.ordinal
    LIMIT 72
  )
  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'source', 'n' || source_index,
        'target', 'n' || target_index
      )
      ORDER BY ordinal
    ),
    '[]'::jsonb
  )
  INTO v_preview_edges
  FROM matching_edges;

  WITH output_nodes AS (
    SELECT
      CASE node->>'type'
        WHEN 'image-generate' THEN 'image'
        WHEN 'video-generate' THEN 'video'
        WHEN 'motion-generate' THEN 'video'
        WHEN 'voiceover-generate' THEN 'audio'
        WHEN 'music-generate' THEN 'audio'
        WHEN 'sound-effects-generate' THEN 'audio'
        ELSE NULL
      END AS kind,
      ordinal
    FROM jsonb_array_elements(v_nodes) WITH ORDINALITY AS rows(node, ordinal)
  ), first_kinds AS (
    SELECT kind, min(ordinal) AS first_ordinal
    FROM output_nodes
    WHERE kind IS NOT NULL
    GROUP BY kind
  )
  SELECT coalesce(jsonb_agg(kind ORDER BY first_ordinal), '[]'::jsonb)
  INTO v_output_kinds
  FROM first_kinds;

  RETURN jsonb_build_object(
    'preview', jsonb_build_object(
      'nodes', v_preview_nodes,
      'edges', v_preview_edges,
      'truncated', jsonb_array_length(v_nodes) > 48
        OR jsonb_array_length(v_edges) > jsonb_array_length(v_preview_edges)
    ),
    'node_count', jsonb_array_length(v_nodes),
    'connection_count', jsonb_array_length(v_edges),
    'output_kinds', v_output_kinds
  );
END;
$$;

ALTER TABLE public.workflow_canvases
  ADD COLUMN IF NOT EXISTS library_summary jsonb;

UPDATE public.workflow_canvases
SET library_summary = public.build_workflow_canvas_library_summary(graph)
WHERE library_summary IS NULL;

ALTER TABLE public.workflow_canvases
  ALTER COLUMN library_summary SET DEFAULT
    '{"preview":{"nodes":[],"edges":[],"truncated":false},"node_count":0,"connection_count":0,"output_kinds":[]}'::jsonb,
  ALTER COLUMN library_summary SET NOT NULL;

CREATE OR REPLACE FUNCTION public.refresh_workflow_canvas_library_summary()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  NEW.library_summary := public.build_workflow_canvas_library_summary(NEW.graph);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workflow_canvases_refresh_library_summary
  ON public.workflow_canvases;
CREATE TRIGGER workflow_canvases_refresh_library_summary
  BEFORE INSERT OR UPDATE OF graph ON public.workflow_canvases
  FOR EACH ROW
  EXECUTE FUNCTION public.refresh_workflow_canvas_library_summary();

CREATE INDEX IF NOT EXISTS posts_public_owner_profile_stats_idx
  ON public.posts (user_id, created_at DESC, id DESC)
  INCLUDE (save_count, remix_count, source_kind, source_tool, source_tool_slug, generation_id)
  WHERE visibility = 'public' AND archived_at IS NULL;

REVOKE ALL ON FUNCTION public.list_showcase_top_sales_post_ids(text, text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_showcase_top_sales_post_ids(text, text, integer, integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_showcase_top_sales_post_ids(text, text, integer, integer) TO service_role;

REVOKE ALL ON FUNCTION public.get_creator_profile_stats(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_creator_profile_stats(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_creator_profile_stats(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.get_owner_post_bundle_summaries(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_owner_post_bundle_summaries(uuid[]) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_owner_post_bundle_summaries(uuid[]) TO service_role;

REVOKE ALL ON FUNCTION public.get_owner_post_sales_summary(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_owner_post_sales_summary(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_owner_post_sales_summary(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.build_workflow_canvas_library_summary(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.build_workflow_canvas_library_summary(jsonb) FROM anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.refresh_workflow_canvas_library_summary() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refresh_workflow_canvas_library_summary() FROM anon, authenticated, service_role;

COMMENT ON FUNCTION public.list_showcase_top_sales_post_ids(text, text, integer, integer) IS
  'Backend-only bounded showcase ordering for top-sales pages.';
COMMENT ON FUNCTION public.get_creator_profile_stats(uuid) IS
  'Backend-only aggregate creator profile statistics without hydrating lifetime post rows.';
COMMENT ON FUNCTION public.get_owner_post_bundle_summaries(uuid[]) IS
  'Backend-only compact unlock summaries for owner post lists.';
COMMENT ON FUNCTION public.get_owner_post_sales_summary(uuid) IS
  'Backend-only lifetime seller totals without hydrating owner post rows.';
COMMENT ON COLUMN public.workflow_canvases.library_summary IS
  'Data-free workflow library preview maintained from graph by trigger.';
