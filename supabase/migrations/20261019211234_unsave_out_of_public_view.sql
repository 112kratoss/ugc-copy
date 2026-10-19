-- A save comes off whatever has become of its post since.
--
-- 1. Saving still needs a public post. Taking one's own save back needs
--    nothing of the post: a post made private (unlisted is stored as private
--    since 20261017144307), archived or moderated no longer holds a save in
--    place, and with it the alert naming its saver (20261019122652). Both
--    save functions are as 20261004114652 defined them otherwise.
-- 2. A post its creator deleted is tombstoned instead when it has buyers or a
--    payable order: kept for them, gone for everyone else. Its saves now go
--    as a deleted post's do, with the alerts naming its savers.

SET LOCAL lock_timeout = '5s';

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

  PERFORM pg_advisory_xact_lock(hashtextextended('post-save:' || p_user_id::text || ':' || p_post_id::text, 0));

  IF p_should_save THEN
    SELECT post.visibility
    INTO v_visibility
    FROM public.posts AS post
    WHERE post.id = p_post_id;

    IF NOT FOUND OR v_visibility IS DISTINCT FROM 'public' THEN
      RAISE EXCEPTION 'Post is private or not found';
    END IF;

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
    -- One's own row, whatever the post's visibility is now.
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
  v_deleted integer;
  v_visibility text;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'Missing user id';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('post-save:' || p_user_id::text || ':' || p_post_id::text, 0));

  SELECT EXISTS (
    SELECT 1
    FROM public.post_saves
    WHERE post_id = p_post_id
      AND user_id = p_user_id
  ) INTO v_exists;

  IF v_exists THEN
    -- One's own row, whatever the post's visibility is now.
    DELETE FROM public.post_saves
    WHERE post_id = p_post_id
      AND user_id = p_user_id;

    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    -- Auth deletion may have removed this row after the existence read.
    -- Only the operation that actually deletes the save owns its decrement.
    IF v_deleted > 0 THEN
      UPDATE public.posts
      SET save_count = greatest(0, save_count - v_deleted)
      WHERE id = p_post_id;
    END IF;

    RETURN false;
  END IF;

  SELECT visibility
  INTO v_visibility
  FROM public.posts
  WHERE id = p_post_id;

  IF NOT FOUND OR v_visibility IS DISTINCT FROM 'public' THEN
    RAISE EXCEPTION 'Post is private or not found';
  END IF;

  INSERT INTO public.post_saves (post_id, user_id)
  VALUES (p_post_id, p_user_id);

  UPDATE public.posts
  SET save_count = save_count + 1
  WHERE id = p_post_id;

  RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.set_post_save_state(uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.toggle_post_save(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_post_save_state(uuid, uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.toggle_post_save(uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.remove_post_saves_when_tombstoned()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- In the tombstoning statement, so no save outlasts it: the alerts naming
  -- its savers go with the rows (mobile_notifications_save_fkey).
  DELETE FROM public.post_saves WHERE post_id = NEW.id;
  NEW.save_count := 0;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.remove_post_saves_when_tombstoned()
FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS posts_remove_saves_when_tombstoned ON public.posts;
CREATE TRIGGER posts_remove_saves_when_tombstoned
BEFORE UPDATE OF tombstoned_at ON public.posts
FOR EACH ROW
WHEN (OLD.tombstoned_at IS NULL AND NEW.tombstoned_at IS NOT NULL)
EXECUTE FUNCTION public.remove_post_saves_when_tombstoned();

COMMENT ON FUNCTION public.remove_post_saves_when_tombstoned() IS
  'A post tombstoned for its buyers loses its saves, and the alerts naming its savers, as a deleted post does.';
