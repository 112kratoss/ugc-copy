-- A remix of a creation made as a guest, posted by the account the guest was
-- linked to, is a completed remix of that post. Publish files such a post under
-- the account while the generation keeps the guest's id, and
-- record_completed_post_remix matched the post by the generation's owner
-- exactly, so these remixes were neither counted nor alerted. The match now
-- also accepts a generation owned by a guest linked to the post's owner, the
-- rule sync_generation_exposure_with_post has applied since 20261015054611.
-- 20260830123000's body otherwise; CREATE OR REPLACE keeps its owner, grants
-- and trigger.
--
-- Nothing to catch up on: production had no post of a guest-made creation, and
-- so no remix the old match missed, when this was written (2026-10-30).
CREATE OR REPLACE FUNCTION public.record_completed_post_remix()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_post_id uuid;
  v_inserted_id uuid;
BEGIN
  IF NEW.status <> 'succeeded' OR NEW.source_generation_id IS NULL
    OR nullif(trim(NEW.output_url), '') IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT p.id INTO v_post_id
  FROM public.posts p JOIN public.generations source ON source.id = p.generation_id
  WHERE p.generation_id = NEW.source_generation_id
    AND (
      p.user_id = source.user_id
      OR EXISTS (
        SELECT 1
        FROM public.profiles AS owner
        WHERE owner.id = source.user_id
          AND owner.merged_into_user_id = p.user_id
      )
    )
    AND p.visibility = 'public';
  IF v_post_id IS NULL THEN RETURN NEW; END IF;

  INSERT INTO public.completed_post_remixes(generation_id, post_id, actor_user_id, completed_at)
  VALUES (NEW.id, v_post_id, NEW.user_id, coalesce(NEW.completed_at, now()))
  ON CONFLICT (generation_id) DO NOTHING
  RETURNING generation_id INTO v_inserted_id;
  IF v_inserted_id IS NOT NULL THEN
    UPDATE public.posts SET remix_count = remix_count + 1 WHERE id = v_post_id;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.record_completed_post_remix() FROM PUBLIC, anon, authenticated;
