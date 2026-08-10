-- Keep marketplace text search proportional to the matching index entries
-- instead of rebuilding a search document for every bundle on every request.

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

CREATE TABLE IF NOT EXISTS public.marketplace_bundle_search_documents (
  bundle_id uuid PRIMARY KEY REFERENCES public.post_resource_bundles(id) ON DELETE CASCADE,
  search_text text NOT NULL
);

COMMENT ON TABLE public.marketplace_bundle_search_documents IS
  'Derived, trigger-maintained text searched by list_marketplace_resource_bundles. It avoids an O(catalog) concat/JSON expansion for every public search.';

REVOKE ALL ON public.marketplace_bundle_search_documents FROM PUBLIC;
REVOKE ALL ON public.marketplace_bundle_search_documents FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.marketplace_bundle_search_documents TO service_role;
ALTER TABLE public.marketplace_bundle_search_documents ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS marketplace_bundle_search_documents_text_idx
  ON public.marketplace_bundle_search_documents
  USING gin (search_text extensions.gin_trgm_ops);

CREATE OR REPLACE FUNCTION public.refresh_marketplace_bundle_search_documents(
  p_bundle_ids uuid[] DEFAULT NULL
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  INSERT INTO public.marketplace_bundle_search_documents AS documents (bundle_id, search_text)
  SELECT
    bundles.id,
    lower(concat_ws(
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
        SELECT string_agg(
          concat_ws(' ', item->>'title', item->>'description', item->>'textContent'),
          ' '
        )
        FROM jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(coalesce(bundles.resource_items, '[]'::jsonb)) = 'array'
              THEN coalesce(bundles.resource_items, '[]'::jsonb)
            ELSE '[]'::jsonb
          END
        ) AS item
      ),
      (
        SELECT string_agg(
          concat_ws(' ', section->>'title', section->>'description', section->>'kind'),
          ' '
        )
        FROM jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(coalesce(bundles.resource_sections, '[]'::jsonb)) = 'array'
              THEN coalesce(bundles.resource_sections, '[]'::jsonb)
            ELSE '[]'::jsonb
          END
        ) AS section
      )
    ))
  FROM public.post_resource_bundles bundles
  LEFT JOIN public.posts posts ON posts.id = bundles.post_id
  LEFT JOIN public.profiles profiles ON profiles.id = bundles.owner_user_id
  WHERE p_bundle_ids IS NULL OR bundles.id = ANY (p_bundle_ids)
  ON CONFLICT (bundle_id) DO UPDATE SET search_text = excluded.search_text
  WHERE documents.search_text IS DISTINCT FROM excluded.search_text;
$function$;

REVOKE ALL ON FUNCTION public.refresh_marketplace_bundle_search_documents(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refresh_marketplace_bundle_search_documents(uuid[]) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_marketplace_bundle_search_documents(uuid[]) TO service_role;

CREATE OR REPLACE FUNCTION public.trg_refresh_marketplace_search_for_bundle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM public.refresh_marketplace_bundle_search_documents(ARRAY[NEW.id]);
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_refresh_marketplace_search_for_post()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM public.refresh_marketplace_bundle_search_documents(
    array(SELECT id FROM public.post_resource_bundles WHERE post_id = NEW.id)
  );
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_refresh_marketplace_search_for_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM public.refresh_marketplace_bundle_search_documents(
    array(SELECT id FROM public.post_resource_bundles WHERE owner_user_id = NEW.id)
  );
  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS post_resource_bundles_refresh_marketplace_search_insert ON public.post_resource_bundles;
CREATE TRIGGER post_resource_bundles_refresh_marketplace_search_insert
  AFTER INSERT ON public.post_resource_bundles
  FOR EACH ROW EXECUTE FUNCTION public.trg_refresh_marketplace_search_for_bundle();

DROP TRIGGER IF EXISTS post_resource_bundles_refresh_marketplace_search_update ON public.post_resource_bundles;
CREATE TRIGGER post_resource_bundles_refresh_marketplace_search_update
  AFTER UPDATE ON public.post_resource_bundles
  FOR EACH ROW
  WHEN (
    OLD.post_id IS DISTINCT FROM NEW.post_id
    OR OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id
    OR OLD.title IS DISTINCT FROM NEW.title
    OR OLD.summary IS DISTINCT FROM NEW.summary
    OR OLD.preview_text IS DISTINCT FROM NEW.preview_text
    OR OLD.resource_items IS DISTINCT FROM NEW.resource_items
    OR OLD.resource_sections IS DISTINCT FROM NEW.resource_sections
  )
  EXECUTE FUNCTION public.trg_refresh_marketplace_search_for_bundle();

DROP TRIGGER IF EXISTS posts_refresh_marketplace_search ON public.posts;
CREATE TRIGGER posts_refresh_marketplace_search
  AFTER UPDATE ON public.posts
  FOR EACH ROW
  WHEN (
    OLD.title IS DISTINCT FROM NEW.title
    OR OLD.body IS DISTINCT FROM NEW.body
    OR OLD.source_tool IS DISTINCT FROM NEW.source_tool
  )
  EXECUTE FUNCTION public.trg_refresh_marketplace_search_for_post();

DROP TRIGGER IF EXISTS profiles_refresh_marketplace_search ON public.profiles;
CREATE TRIGGER profiles_refresh_marketplace_search
  AFTER UPDATE ON public.profiles
  FOR EACH ROW
  WHEN (
    OLD.username IS DISTINCT FROM NEW.username
    OR OLD.display_name IS DISTINCT FROM NEW.display_name
  )
  EXECUTE FUNCTION public.trg_refresh_marketplace_search_for_profile();

SELECT public.refresh_marketplace_bundle_search_documents(NULL);

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
  id uuid, post_id uuid, owner_user_id uuid, legacy_asset_id uuid,
  access_mode text, status text, title text, summary text, preview_text text,
  prompt_text text, notes_markdown text, workflow_share_url text,
  workflow_snapshot jsonb, attachments jsonb, allow_remix boolean,
  resource_sections jsonb, resource_items jsonb, price_usd_cents integer,
  sales_count integer, earnings_usd_cents integer, created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_order text;
  v_search_join text := '';
  v_search_filter text := 'AND coalesce(nullif(btrim($4), ''''), '''') = ''''';
BEGIN
  v_order := CASE coalesce(p_sort, 'recent')
    WHEN 'top-sales' THEN 'listings.sales_count DESC NULLS LAST, listings.created_at DESC, listings.bundle_id DESC'
    WHEN 'price-low' THEN 'listings.price_usd_cents ASC NULLS LAST, listings.created_at DESC, listings.bundle_id DESC'
    WHEN 'price-high' THEN 'listings.price_usd_cents DESC NULLS LAST, listings.created_at DESC, listings.bundle_id DESC'
    ELSE 'listings.created_at DESC, listings.bundle_id DESC'
  END;

  IF coalesce(nullif(btrim(p_query), ''), '') <> '' THEN
    v_search_join := '
      JOIN public.marketplace_bundle_search_documents search
        ON search.bundle_id = listings.bundle_id';
    v_search_filter := '
      AND char_length(btrim($4)) >= 3
      AND search.search_text ILIKE (''%%'' || lower(btrim($4)) || ''%%'')';
  END IF;

  RETURN QUERY EXECUTE format($sql$
    SELECT
      bundles.id, bundles.post_id, bundles.owner_user_id, bundles.legacy_asset_id,
      bundles.access_mode, bundles.status, bundles.title, bundles.summary,
      bundles.preview_text, bundles.prompt_text, bundles.notes_markdown,
      bundles.workflow_share_url, bundles.workflow_snapshot, bundles.attachments,
      bundles.allow_remix, bundles.resource_sections, bundles.resource_items,
      bundles.price_usd_cents, bundles.sales_count, bundles.earnings_usd_cents,
      bundles.created_at, bundles.updated_at
    FROM public.marketplace_bundle_listings listings
    JOIN public.post_resource_bundles bundles ON bundles.id = listings.bundle_id
    %s
    WHERE listings.listable
      AND ($1 IS NULL OR $1 = 'all' OR listings.access_mode = $1)
      AND (
        $2 IS NULL OR $2 = 'all'
        OR ($2 = 'prompt' AND listings.has_prompt)
        OR ($2 = 'workflow' AND listings.has_workflow)
        OR ($2 = 'files' AND listings.has_files)
        OR ($2 = 'notes' AND listings.has_notes)
        OR ($2 = 'remix' AND listings.has_remix)
      )
      AND (coalesce(nullif($3, ''), '') = '' OR listings.tool_slug = $3)
      %s
    ORDER BY %s
    OFFSET greatest(coalesce($5, 0), 0)
    LIMIT greatest(coalesce($6, 24), 1)
  $sql$, v_search_join, v_search_filter, v_order)
  USING p_access_filter, p_resource_filter, p_tool_slug, p_query, p_offset, p_limit;
END;
$function$;

COMMENT ON FUNCTION public.list_marketplace_resource_bundles(text, text, text, text, text, integer, integer) IS
  'Marketplace listing backed by page-sized sort indexes and a trigger-maintained trigram search document. Public callers must require at least three search characters.';
