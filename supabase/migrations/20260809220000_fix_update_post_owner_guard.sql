-- Restore the owner guard in update_post_with_resource_bundle.
--
-- 20260806120000_freeze_sold_post_resource_bundles.sql rewrote this function
-- and its owner guard picked up a stray fragment:
--
--   IF NOT FOUND OR v_bundle.status <> 'published' THEN
--
-- No `v_bundle` record is declared, so PL/pgSQL resolves `v_bundle.status` as
-- a missing FROM-clause reference and the function raises on *every* call —
-- text-post publishes and post metadata edits have failed since that migration
-- applied. Certification load testing found it (audit Finding A); nothing else
-- exercised the path.
--
-- The guard returns to its pre-20260806 form (`IF NOT FOUND THEN`). The
-- fragment cannot have been the sold-bundle freeze: that lives in
-- apply_post_resource_bundle_mutation and the visibility-sync trigger, and a
-- published-bundle requirement on every edit would reject every bundle-less
-- post by construction. The FOR UPDATE row lock the 20260806 migration added
-- is kept.

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
  WHERE id = p_post_id AND user_id = p_owner_user_id
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
  WHERE target.id = p_post_id AND target.user_id = p_owner_user_id
  RETURNING target.id, target.visibility, target.title
  INTO v_result_post_id, v_result_visibility, v_result_title;

  IF p_has_bundle THEN
    SELECT mutation.bundle_id, mutation.bundle_status
    INTO v_bundle_id, v_bundle_status
    FROM public.apply_post_resource_bundle_mutation(
      v_result_post_id, p_owner_user_id, v_result_title, v_result_visibility, p_bundle
    ) AS mutation;
  END IF;

  IF v_result_visibility <> 'public' THEN
    UPDATE public.post_resource_bundles AS bundles
    SET status = 'draft', updated_at = timezone('utc'::text, now())
    WHERE bundles.post_id = v_result_post_id
      AND bundles.owner_user_id = p_owner_user_id
      AND bundles.status = 'published';

    UPDATE public.marketplace_assets AS assets
    SET status = 'unlisted', updated_at = timezone('utc'::text, now())
    WHERE assets.post_id = v_result_post_id
      AND assets.seller_user_id = p_owner_user_id
      AND assets.status = 'active';
  END IF;

  IF v_bundle_id IS NULL THEN
    SELECT bundles.id, bundles.status
    INTO v_bundle_id, v_bundle_status
    FROM public.post_resource_bundles AS bundles
    WHERE bundles.post_id = v_result_post_id
      AND bundles.owner_user_id = p_owner_user_id;
  END IF;

  RETURN QUERY SELECT v_result_post_id, v_result_visibility, v_bundle_id, v_bundle_status;
END;
$$;

REVOKE ALL ON FUNCTION public.update_post_with_resource_bundle(uuid, uuid, jsonb, boolean, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_post_with_resource_bundle(uuid, uuid, jsonb, boolean, jsonb)
  TO service_role;
