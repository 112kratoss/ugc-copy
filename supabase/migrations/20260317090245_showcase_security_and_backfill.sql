-- Guard showcase saves so only the authenticated user can toggle their own save
-- and only for public generations.
CREATE OR REPLACE FUNCTION public.toggle_showcase_save(p_generation_id uuid, p_user_id uuid)
RETURNS boolean AS $$
DECLARE
  v_exists boolean;
  v_is_public boolean;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT is_public
  INTO v_is_public
  FROM public.generations
  WHERE id = p_generation_id;

  IF NOT FOUND OR v_is_public IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Generation is private or not found';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.showcase_saves
    WHERE generation_id = p_generation_id AND user_id = p_user_id
  ) INTO v_exists;

  IF v_exists THEN
    DELETE FROM public.showcase_saves
    WHERE generation_id = p_generation_id AND user_id = p_user_id;

    UPDATE public.generations
    SET save_count = GREATEST(0, save_count - 1)
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
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Guard remix count updates to public generations initiated by an authenticated user.
CREATE OR REPLACE FUNCTION public.increment_remix_count(p_generation_id uuid)
RETURNS void AS $$
DECLARE
  v_is_public boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

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
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
