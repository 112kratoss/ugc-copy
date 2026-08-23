-- The post update RPC can now patch `showcase_asset_path` and `output_url`.
--
-- A generation-backed post's media lives in two places: a public derivative in
-- the `showcase_media` bucket while the post is exposed, and a durable private
-- copy while it is not. Until now only the generation publish RPC could move
-- the post row between those, which is why the web client sends every
-- visibility change on a generation-backed post through the publish route.
-- The mobile client sends them through this RPC instead, so a post it made
-- private kept pointing at -- and the bucket kept serving -- the public copy.
--
-- Letting the update path write the two media columns lets
-- post-update-service do the same derivative work as the publish route, in
-- the same transaction as the visibility and bundle changes, for every
-- client. Both keys stay optional: a patch that omits them leaves the row
-- untouched, exactly as before.

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
      -- A JSON null clears the column; an absent key keeps it.
      showcase_asset_path = CASE WHEN v_patch ? 'showcase_asset_path' THEN nullif(btrim(v_patch->>'showcase_asset_path'), '') ELSE target.showcase_asset_path END,
      output_url = CASE WHEN v_patch ? 'output_url' THEN nullif(btrim(v_patch->>'output_url'), '') ELSE target.output_url END,
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
