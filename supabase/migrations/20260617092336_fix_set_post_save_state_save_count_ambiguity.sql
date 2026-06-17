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
  IF auth.uid() IS NULL OR auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'Unauthorized';
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
    WHERE post_id = p_post_id AND user_id = p_user_id;

    GET DIAGNOSTICS v_current_save_count = ROW_COUNT;
    v_changed := v_current_save_count > 0;

    IF v_changed THEN
      UPDATE public.posts AS post
      SET save_count = GREATEST(0, post.save_count - 1)
      WHERE post.id = p_post_id;
    END IF;
  END IF;

  SELECT COALESCE(post.save_count, 0)
  INTO v_current_save_count
  FROM public.posts AS post
  WHERE post.id = p_post_id;

  RETURN QUERY
  SELECT
    EXISTS (
      SELECT 1
      FROM public.post_saves
      WHERE post_id = p_post_id AND user_id = p_user_id
    ) AS is_saved,
    COALESCE(v_current_save_count, 0) AS save_count,
    v_changed AS changed;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.set_post_save_state(uuid, uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_post_save_state(uuid, uuid, boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public.set_post_save_state(uuid, uuid, boolean) TO authenticated;
