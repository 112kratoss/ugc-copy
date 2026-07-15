-- Hydrate public bundle summaries in one backend-only read without transferring
-- draft/private resource payloads across the database boundary.

CREATE OR REPLACE FUNCTION public.get_public_post_resource_bundle_summaries(
  p_post_ids uuid[]
)
RETURNS TABLE(
  id uuid,
  post_id uuid,
  title text,
  access_mode text,
  price_usd_cents integer,
  preview_text text,
  prompt_text text,
  notes_markdown text,
  workflow_share_url text,
  workflow_snapshot jsonb,
  attachments jsonb,
  allow_remix boolean,
  resource_sections jsonb,
  resource_items jsonb,
  sales_count integer,
  status text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    CASE WHEN bundles.status = 'published' THEN bundles.id ELSE NULL END AS id,
    bundles.post_id,
    CASE WHEN bundles.status = 'published' THEN bundles.title ELSE NULL END AS title,
    CASE WHEN bundles.status = 'published' THEN bundles.access_mode ELSE NULL END AS access_mode,
    CASE WHEN bundles.status = 'published' THEN bundles.price_usd_cents ELSE NULL END AS price_usd_cents,
    CASE WHEN bundles.status = 'published' THEN bundles.preview_text ELSE NULL END AS preview_text,
    CASE WHEN bundles.status = 'published' THEN bundles.prompt_text ELSE NULL END AS prompt_text,
    CASE WHEN bundles.status = 'published' THEN bundles.notes_markdown ELSE NULL END AS notes_markdown,
    CASE WHEN bundles.status = 'published' THEN bundles.workflow_share_url ELSE NULL END AS workflow_share_url,
    CASE WHEN bundles.status = 'published' THEN bundles.workflow_snapshot ELSE NULL END AS workflow_snapshot,
    CASE WHEN bundles.status = 'published' THEN bundles.attachments ELSE NULL END AS attachments,
    CASE WHEN bundles.status = 'published' THEN bundles.allow_remix ELSE NULL END AS allow_remix,
    CASE WHEN bundles.status = 'published' THEN bundles.resource_sections ELSE NULL END AS resource_sections,
    CASE WHEN bundles.status = 'published' THEN bundles.resource_items ELSE NULL END AS resource_items,
    CASE WHEN bundles.status = 'published' THEN bundles.sales_count ELSE NULL END AS sales_count,
    bundles.status
  FROM public.post_resource_bundles AS bundles
  WHERE bundles.post_id = ANY(coalesce(p_post_ids, ARRAY[]::uuid[]));
$$;

REVOKE ALL ON FUNCTION public.get_public_post_resource_bundle_summaries(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_public_post_resource_bundle_summaries(uuid[]) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_public_post_resource_bundle_summaries(uuid[]) TO service_role;

-- The original public SELECT policy exposed the full row for every published
-- bundle, including paid prompt/workflow/file payloads. Public reads now go
-- through backend service-role projections; authenticated owners retain direct
-- access to their own draft and published rows for compatibility with writes.
DROP POLICY IF EXISTS "Post resource bundles are viewable by owner or published"
  ON public.post_resource_bundles;
DROP POLICY IF EXISTS "Owners can view their own post resource bundles"
  ON public.post_resource_bundles;
CREATE POLICY "Owners can view their own post resource bundles"
  ON public.post_resource_bundles
  FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) = owner_user_id);
