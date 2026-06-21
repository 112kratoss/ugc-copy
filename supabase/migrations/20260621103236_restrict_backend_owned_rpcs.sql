CREATE OR REPLACE FUNCTION public.set_post_save_state(
  p_post_id uuid,
  p_user_id uuid,
  p_should_save boolean
)
RETURNS TABLE (
  is_saved boolean,
  save_count integer,
  changed boolean
) AS $$
DECLARE
  v_visibility text;
  v_changed boolean := false;
  v_current_save_count integer := 0;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'Missing user id';
  END IF;

  IF p_should_save IS NULL THEN
    RAISE EXCEPTION 'Missing requested save state';
  END IF;

  SELECT post.visibility
  INTO v_visibility
  FROM public.posts AS post
  WHERE post.id = p_post_id;

  IF NOT FOUND OR v_visibility IS DISTINCT FROM 'public' THEN
    RAISE EXCEPTION 'Post is private or not found';
  END IF;

  IF p_should_save THEN
    INSERT INTO public.post_saves (post_id, user_id)
    VALUES (p_post_id, p_user_id)
    ON CONFLICT (user_id, post_id) DO NOTHING;

    GET DIAGNOSTICS v_current_save_count = ROW_COUNT;
    v_changed := v_current_save_count > 0;

    IF v_changed THEN
      UPDATE public.posts AS post
      SET save_count = post.save_count + 1
      WHERE post.id = p_post_id;
    END IF;
  ELSE
    DELETE FROM public.post_saves
    WHERE post_id = p_post_id
      AND user_id = p_user_id;

    GET DIAGNOSTICS v_current_save_count = ROW_COUNT;
    v_changed := v_current_save_count > 0;

    IF v_changed THEN
      UPDATE public.posts AS post
      SET save_count = greatest(0, post.save_count - 1)
      WHERE post.id = p_post_id;
    END IF;
  END IF;

  SELECT coalesce(post.save_count, 0)
  INTO v_current_save_count
  FROM public.posts AS post
  WHERE post.id = p_post_id;

  RETURN QUERY
  SELECT
    EXISTS (
      SELECT 1
      FROM public.post_saves
      WHERE post_id = p_post_id
        AND user_id = p_user_id
    ),
    coalesce(v_current_save_count, 0),
    v_changed;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.toggle_post_save(p_post_id uuid, p_user_id uuid)
RETURNS boolean AS $$
DECLARE
  v_exists boolean;
  v_visibility text;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'Missing user id';
  END IF;

  SELECT visibility
  INTO v_visibility
  FROM public.posts
  WHERE id = p_post_id;

  IF NOT FOUND OR v_visibility IS DISTINCT FROM 'public' THEN
    RAISE EXCEPTION 'Post is private or not found';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.post_saves
    WHERE post_id = p_post_id
      AND user_id = p_user_id
  ) INTO v_exists;

  IF v_exists THEN
    DELETE FROM public.post_saves
    WHERE post_id = p_post_id
      AND user_id = p_user_id;

    UPDATE public.posts
    SET save_count = greatest(0, save_count - 1)
    WHERE id = p_post_id;

    RETURN false;
  END IF;

  INSERT INTO public.post_saves (post_id, user_id)
  VALUES (p_post_id, p_user_id);

  UPDATE public.posts
  SET save_count = save_count + 1
  WHERE id = p_post_id;

  RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.toggle_showcase_save(p_generation_id uuid, p_user_id uuid)
RETURNS boolean AS $$
DECLARE
  v_exists boolean;
  v_is_public boolean;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'Missing user id';
  END IF;

  SELECT is_public
  INTO v_is_public
  FROM public.generations
  WHERE id = p_generation_id;

  IF NOT FOUND OR v_is_public IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Generation is private or not found';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.showcase_saves
    WHERE generation_id = p_generation_id
      AND user_id = p_user_id
  ) INTO v_exists;

  IF v_exists THEN
    DELETE FROM public.showcase_saves
    WHERE generation_id = p_generation_id
      AND user_id = p_user_id;

    UPDATE public.generations
    SET save_count = greatest(0, save_count - 1)
    WHERE id = p_generation_id;

    RETURN false;
  END IF;

  INSERT INTO public.showcase_saves (generation_id, user_id)
  VALUES (p_generation_id, p_user_id);

  UPDATE public.generations
  SET save_count = save_count + 1
  WHERE id = p_generation_id;

  RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.increment_post_remix_count(p_post_id uuid)
RETURNS void AS $$
DECLARE
  v_visibility text;
BEGIN
  SELECT visibility
  INTO v_visibility
  FROM public.posts
  WHERE id = p_post_id;

  IF NOT FOUND OR v_visibility IS DISTINCT FROM 'public' THEN
    RAISE EXCEPTION 'Post is private or not found';
  END IF;

  UPDATE public.posts
  SET remix_count = remix_count + 1
  WHERE id = p_post_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.increment_remix_count(p_generation_id uuid)
RETURNS void AS $$
DECLARE
  v_is_public boolean;
BEGIN
  SELECT is_public
  INTO v_is_public
  FROM public.generations
  WHERE id = p_generation_id;

  IF NOT FOUND OR v_is_public IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Generation is private or not found';
  END IF;

  UPDATE public.generations
  SET remix_count = remix_count + 1
  WHERE id = p_generation_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

ALTER FUNCTION public.touch_updated_at_column()
  SET search_path = public, pg_temp;
ALTER FUNCTION public.increment_post_report_count()
  SET search_path = public, pg_temp;
ALTER FUNCTION public.validate_post_resource_bundle_write()
  SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.apply_post_resource_bundle_mutation(uuid, uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.increment_post_remix_count(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.increment_remix_count(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_marketplace_resource_bundles(text, text, text, text, text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_marketplace_resource_bundles(text, text, text, text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.publish_generation_post_with_resource_bundle(uuid, uuid, jsonb, jsonb, jsonb, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_post_save_state(uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.toggle_post_save(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.toggle_showcase_save(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.update_post_with_resource_bundle(uuid, uuid, jsonb, boolean, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.upsert_post_with_resource_bundle(jsonb, jsonb, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.validate_post_report_bundle_match() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.apply_post_resource_bundle_mutation(uuid, uuid, text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO service_role;
GRANT EXECUTE ON FUNCTION public.increment_post_remix_count(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.increment_remix_count(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_marketplace_resource_bundles(text, text, text, text, text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_marketplace_resource_bundles(text, text, text, text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.publish_generation_post_with_resource_bundle(uuid, uuid, jsonb, jsonb, jsonb, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_post_save_state(uuid, uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.toggle_post_save(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.toggle_showcase_save(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.update_post_with_resource_bundle(uuid, uuid, jsonb, boolean, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.upsert_post_with_resource_bundle(jsonb, jsonb, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.validate_post_report_bundle_match() TO service_role;

COMMENT ON FUNCTION public.set_post_save_state(uuid, uuid, boolean) IS
  'Backend-only idempotent post save mutation. Caller identity is validated by the Vercel API before service-role invocation.';
COMMENT ON FUNCTION public.toggle_post_save(uuid, uuid) IS
  'Backend-only legacy post save mutation.';
COMMENT ON FUNCTION public.toggle_showcase_save(uuid, uuid) IS
  'Backend-only legacy generation save mutation.';
COMMENT ON FUNCTION public.increment_post_remix_count(uuid) IS
  'Backend-only post remix counter mutation.';
COMMENT ON FUNCTION public.increment_remix_count(uuid) IS
  'Backend-only legacy generation remix counter mutation.';
