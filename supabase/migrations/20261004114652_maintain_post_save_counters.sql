-- Preserve save counters through account deletion and concurrent legacy toggles.
-- No historical counter backfill: existing drift needs separate reconciliation.
-- Keep both service-only RPC signatures for supported clients.

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
  v_deleted integer;
  v_visibility text;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'Missing user id';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('post-save:' || p_user_id::text || ':' || p_post_id::text, 0));

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

CREATE OR REPLACE FUNCTION public.remove_post_saves_before_auth_user_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  removed record;
BEGIN
  -- Own the deleted rows before adjusting counters. Concurrent unsave can
  -- therefore decrement only if it actually won deletion of that save row.
  FOR removed IN
    WITH deleted AS (
      DELETE FROM public.post_saves
      WHERE user_id = OLD.id
      RETURNING post_id
    )
    SELECT post_id, count(*)::integer AS count
    FROM deleted
    GROUP BY post_id
    ORDER BY post_id
  LOOP
    UPDATE public.posts
    SET save_count = greatest(0, save_count - removed.count)
    WHERE id = removed.post_id;
  END LOOP;
  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.remove_post_saves_before_auth_user_delete()
FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER auth_users_remove_post_saves_before_delete
BEFORE DELETE ON auth.users
FOR EACH ROW
EXECUTE FUNCTION public.remove_post_saves_before_auth_user_delete();
