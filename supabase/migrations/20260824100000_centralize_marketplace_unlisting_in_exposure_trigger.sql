-- One owner for what losing exposure does to a recipe's sale surfaces.
--
-- 20260823130000 gave the posts trigger the whole bundle-status story, but the
-- marketplace asset only half of it: the trigger re-activates a sold listing
-- when its post returns to public, while the flip to `unlisted` still lived
-- only inside the two post RPCs. That split meant a path that changes
-- visibility without those RPCs -- archiving is one -- demoted the recipe but
-- left the linked marketplace asset `active`, and the standalone marketplace
-- list reads exactly that flag.
--
-- The trigger now owns both directions: losing exposure (going non-public or
-- archived) unlists the linked asset, and the RPCs drop their inline blocks.
-- Nothing else changes for the RPCs -- their post UPDATE always assigns the
-- visibility column, so the trigger fires on every call the blocks used to
-- cover, and a brand-new post has no bundle or asset rows to demote. The
-- bundle side needs no belt either: `post_resource_bundles_validate_write`
-- rejects `published` while the post is not public.

CREATE OR REPLACE FUNCTION public.sync_post_resource_bundle_exposure()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_exposed boolean := NEW.visibility = 'public' AND NEW.archived_at IS NULL;
BEGIN
  IF v_exposed THEN
    UPDATE public.post_resource_bundles AS bundles
    SET status = 'published',
        retired_at = NULL,
        updated_at = timezone('utc'::text, now())
    WHERE bundles.post_id = NEW.id
      AND bundles.owner_user_id = NEW.user_id
      AND (bundles.status IS DISTINCT FROM 'published' OR bundles.retired_at IS NOT NULL)
      AND (
        -- Sold: validated when listed, frozen since.
        EXISTS (
          SELECT 1
          FROM public.post_resource_bundle_purchases AS purchases
          WHERE purchases.bundle_id = bundles.id
            AND purchases.price_usd_cents > 0
        )
        -- Unsold: only if it would pass the gate a publishing write applies.
        OR public.post_resource_bundle_quality_issue_for(bundles.id) IS NULL
      );
  ELSE
    UPDATE public.post_resource_bundles AS bundles
    SET status = 'draft',
        updated_at = timezone('utc'::text, now())
    WHERE bundles.post_id = NEW.id
      AND bundles.owner_user_id = NEW.user_id
      AND bundles.status IS DISTINCT FROM 'draft';

    -- Both directions of the linked marketplace asset live here now; the
    -- post RPCs no longer carry their own unlisting.
    UPDATE public.marketplace_assets AS assets
    SET status = 'unlisted',
        updated_at = timezone('utc'::text, now())
    WHERE assets.post_id = NEW.id
      AND assets.seller_user_id = NEW.user_id
      AND assets.status = 'active';
  END IF;

  -- A linked marketplace asset that was unlisted by the post leaving public
  -- comes back only for a sold recipe on a post moderation still shows.
  IF v_exposed AND coalesce(NEW.review_status, 'visible') = 'visible' THEN
    UPDATE public.marketplace_assets AS assets
    SET status = 'active',
        updated_at = timezone('utc'::text, now())
    WHERE assets.post_id = NEW.id
      AND assets.seller_user_id = NEW.user_id
      AND assets.status = 'unlisted'
      AND EXISTS (
        SELECT 1
        FROM public.post_resource_bundles AS bundles
        JOIN public.post_resource_bundle_purchases AS purchases
          ON purchases.bundle_id = bundles.id
        WHERE bundles.post_id = NEW.id
          AND bundles.owner_user_id = NEW.user_id
          AND purchases.price_usd_cents > 0
      );
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_post_resource_bundle_exposure()
  FROM PUBLIC, anon, authenticated;

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
    id, user_id, visibility, category, title, description, prompt, body,
    post_format, source_kind, source_tool, source_tool_slug, generation_id,
    showcase_asset_path, output_url
  )
  VALUES (
    v_post_id, v_user_id, v_visibility, v_category,
    nullif(btrim(p_post->>'title'), ''),
    nullif(btrim(p_post->>'description'), ''),
    nullif(btrim(p_post->>'prompt'), ''),
    nullif(btrim(p_post->>'body'), ''),
    v_post_format, v_source_kind,
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
      v_result_post_id, v_user_id, p_post->>'title', v_result_visibility, p_bundle
    ) AS mutation;
  END IF;

  IF v_bundle_id IS NULL THEN
    SELECT bundles.id, bundles.status
    INTO v_bundle_id, v_bundle_status
    FROM public.post_resource_bundles AS bundles
    WHERE bundles.post_id = v_result_post_id
      AND bundles.owner_user_id = v_user_id;
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

REVOKE ALL ON FUNCTION public.upsert_post_with_resource_bundle(jsonb, jsonb, boolean)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.update_post_with_resource_bundle(uuid, uuid, jsonb, boolean, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_post_with_resource_bundle(jsonb, jsonb, boolean)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.update_post_with_resource_bundle(uuid, uuid, jsonb, boolean, jsonb)
  TO service_role;
