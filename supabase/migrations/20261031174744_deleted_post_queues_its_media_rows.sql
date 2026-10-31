-- A deleted creation post left the media the sweeps made from its public copy
-- in the public bucket: its cover row's preview, display, feed rendition and
-- teaser, beside the copy in the creation's folder (showcase/<creation>/).
-- posts_sync_generation_exposure queues the copy a deleted post leaves behind,
-- but it runs AFTER DELETE, and by then the delete's cascade has removed the
-- post's post_media rows (the foreign key's trigger fires first), so nothing
-- named the rest again. Live and deleted creations alike; left open by #603.
--
-- A BEFORE DELETE trigger now queues what the post's media rows name in the
-- creation's folder: of a live creation the post's owner made (or a guest
-- linked to them), or of the deleted creation the post recorded. Two
-- differences from the exposure trigger's rule for the copy:
--   - account erasure is told by its cascade from auth.users, which runs once
--     the owner's row is gone. Its own sweep owns that media. A BEFORE trigger
--     runs a level down inside any trigger, so depth would also skip a direct
--     delete issued from one;
--   - a creation an operator removed is queued too. The removal only hides the
--     creation and leaves its storage, and the showcase-media-revocations job
--     keeps whatever the creation still names (its copy, for a restore).
-- A creation published again at once gets the same content-addressed names, so
-- the job also keeps what a serving post of the creation still names.
--
-- private-posts/ paths are the private bucket's: post_media_private_cleanup
-- owns a post's own, and the sweeps build nothing in a creation's.

-- CREATE TRIGGER takes SHARE ROW EXCLUSIVE on posts: reads go on beside it,
-- and a writer holding the table makes this wait at most five seconds.
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION public.queue_deleted_post_media_revocations()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_folder_id uuid;
BEGIN
  -- Account erasure deletes posts through the cascade from auth.users, and its
  -- own sweep owns that media.
  IF NOT EXISTS (
    SELECT 1
    FROM auth.users AS users
    WHERE users.id = OLD.user_id
  ) THEN
    RETURN OLD;
  END IF;

  IF OLD.generation_id IS NULL THEN
    v_folder_id := OLD.deleted_generation_id;
  ELSE
    SELECT generations.id
    INTO v_folder_id
    FROM public.generations AS generations
    WHERE generations.id = OLD.generation_id
      AND (
        generations.user_id = OLD.user_id
        OR EXISTS (
          SELECT 1
          FROM public.profiles AS owner
          WHERE owner.id = generations.user_id
            AND owner.merged_into_user_id = OLD.user_id
        )
      );
  END IF;

  IF v_folder_id IS NULL THEN
    RETURN OLD;
  END IF;

  INSERT INTO public.showcase_media_revocations (
    generation_id, post_id, showcase_asset_path, reason
  )
  SELECT DISTINCT v_folder_id, OLD.id, named.path, 'post_deleted'
  FROM public.post_media AS media
  CROSS JOIN LATERAL unnest(ARRAY[
    media.storage_path, media.preview_storage_path, media.display_storage_path,
    media.rendition_storage_path, media.teaser_storage_path
  ]) AS named(path)
  WHERE media.post_id = OLD.id
    AND starts_with(named.path, 'showcase/' || v_folder_id::text || '/')
  ON CONFLICT (generation_id, showcase_asset_path) DO NOTHING;

  RETURN OLD;
END;
$$;

ALTER FUNCTION public.queue_deleted_post_media_revocations()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.queue_deleted_post_media_revocations()
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.queue_deleted_post_media_revocations() IS
  'Trusted posts trigger: before a delete cascades to the post''s media rows, queues what they name in the creation''s public folder for revocation. Account erasure''s cascade is left to its sweep.';

CREATE TRIGGER posts_queue_deleted_post_media
BEFORE DELETE ON public.posts
FOR EACH ROW
EXECUTE FUNCTION public.queue_deleted_post_media_revocations();
