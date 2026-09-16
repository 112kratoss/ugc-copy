-- A generation-backed post's exposure lives on the post, but readers across the
-- product trust the linked generation's copy of it: `generations.is_public` and
-- `generations.showcase_asset_path`. Every writer used to keep that copy by
-- hand after its own post write had committed -- post-update-service after the
-- update RPC, the lifecycle service after archive and restore, the delete
-- service before its delete -- and logged, or never checked, a failure. A post
-- made private could leave a public generation behind, and a public derivative
-- whose delete failed stayed fetchable with nothing left to retry it
-- (model/post/remix audit 2026-09-15, finding A4).
--
-- 1. The copy now follows the post in the post write's own transaction. An
--    AFTER trigger on posts recomputes it on insert, on every change to the
--    columns that decide exposure, and on delete, whoever the writer is.
-- 2. A public derivative that an unexposed post drops, or that a deleted post
--    leaves behind, is queued in that same transaction. The routes' inline
--    delete stays the fast path; the `showcase-media-revocations` job retries
--    whatever it misses and fails its run while an object stays stuck.
-- 3. Rows the old sequence already let drift are healed toward less exposure
--    only. Nothing in this migration can make a generation more public.

CREATE TABLE IF NOT EXISTS public.showcase_media_revocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Neither id is a foreign key, on purpose: the bytes still have to go after
  -- the post or the generation row is deleted, and the job only ever removes
  -- objects under showcase/<generation_id>/.
  generation_id uuid NOT NULL,
  post_id uuid,
  showcase_asset_path text NOT NULL CHECK (btrim(showcase_asset_path) <> ''),
  reason text NOT NULL CHECK (reason IN ('post_unexposed', 'post_deleted', 'exposure_drift')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now())
);

-- An object is one delete however many times it is queued.
CREATE UNIQUE INDEX IF NOT EXISTS showcase_media_revocations_object_key
  ON public.showcase_media_revocations (generation_id, showcase_asset_path);

CREATE INDEX IF NOT EXISTS showcase_media_revocations_due_idx
  ON public.showcase_media_revocations (next_attempt_at);

ALTER TABLE public.showcase_media_revocations ENABLE ROW LEVEL SECURITY;

-- The trigger inserts as the function owner. The job reads, reschedules and
-- deletes; nothing else touches the queue.
REVOKE ALL ON TABLE public.showcase_media_revocations FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, UPDATE, DELETE ON TABLE public.showcase_media_revocations TO service_role;

COMMENT ON TABLE public.showcase_media_revocations IS
  'Public showcase derivatives a post stopped needing, queued in the post write''s own transaction. A row is deleted once its object is verified gone or still in use; the showcase-media-revocations job retries the rest.';

CREATE OR REPLACE FUNCTION public.sync_generation_exposure_with_post()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_post_id uuid;
  v_generation_id uuid;
  v_owner_user_id uuid;
  v_new_path text;
  v_generation_path text;
  v_dropped_path text;
  v_reason text;
  v_exposed boolean := false;
  v_is_public boolean := false;
  v_path text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Account erasure deletes posts through a cascade, and its own sweep owns
    -- that media. Only a direct delete is handled here.
    IF pg_trigger_depth() > 1 THEN
      RETURN NULL;
    END IF;

    v_post_id := OLD.id;
    v_generation_id := OLD.generation_id;
    v_owner_user_id := OLD.user_id;
    v_dropped_path := OLD.showcase_asset_path;
    v_reason := 'post_deleted';
  ELSE
    v_post_id := NEW.id;
    v_generation_id := NEW.generation_id;
    v_owner_user_id := NEW.user_id;
    v_new_path := NEW.showcase_asset_path;
    v_exposed := NEW.visibility <> 'private' AND NEW.archived_at IS NULL;
    -- Hidden content can never be public: generations_prevent_hidden_republish
    -- raises on that, and would roll the post write back with it.
    v_is_public := NEW.visibility = 'public'
      AND NEW.archived_at IS NULL
      AND coalesce(NEW.review_status, 'visible') <> 'hidden';

    IF TG_OP = 'UPDATE' THEN
      -- A generation the post stops linking to loses the post's exposure.
      IF OLD.generation_id IS NOT NULL AND OLD.generation_id IS DISTINCT FROM NEW.generation_id THEN
        UPDATE public.generations AS generations
        SET is_public = false,
            showcase_asset_path = NULL
        WHERE generations.id = OLD.generation_id
          AND generations.user_id = OLD.user_id
          AND generations.moderation_removed_at IS NULL
          AND (generations.is_public OR generations.showcase_asset_path IS NOT NULL);
      END IF;

      -- An unexposed post that drops its derivative no longer needs the public
      -- copy. Archiving keeps the path, and with it the copy, for restore; a
      -- tombstone keeps both for the buyers.
      IF NOT v_exposed
        AND OLD.showcase_asset_path IS NOT NULL
        AND NEW.showcase_asset_path IS NULL THEN
        v_dropped_path := OLD.showcase_asset_path;
        v_reason := 'post_unexposed';
      END IF;
    END IF;
  END IF;

  IF v_generation_id IS NULL OR v_owner_user_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- An operator removal owns the generation's exposure while it stands.
  SELECT generations.showcase_asset_path
  INTO v_generation_path
  FROM public.generations AS generations
  WHERE generations.id = v_generation_id
    AND generations.user_id = v_owner_user_id
    AND generations.moderation_removed_at IS NULL;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- A still-exposed post without a path of its own keeps the generation's:
  -- older creation posts only ever recorded the derivative on the generation.
  v_path := CASE WHEN v_exposed THEN coalesce(v_new_path, v_generation_path) END;

  UPDATE public.generations AS generations
  SET is_public = v_is_public,
      showcase_asset_path = v_path
  WHERE generations.id = v_generation_id
    AND generations.user_id = v_owner_user_id
    AND (
      generations.is_public IS DISTINCT FROM v_is_public
      OR generations.showcase_asset_path IS DISTINCT FROM v_path
    );

  IF v_reason IS NOT NULL THEN
    INSERT INTO public.showcase_media_revocations (
      generation_id, post_id, showcase_asset_path, reason
    )
    SELECT DISTINCT v_generation_id, v_post_id, candidates.path, v_reason
    FROM (VALUES (v_dropped_path), (v_generation_path)) AS candidates(path)
    WHERE nullif(btrim(candidates.path), '') IS NOT NULL
    ON CONFLICT (generation_id, showcase_asset_path) DO NOTHING;
  END IF;

  RETURN NULL;
END;
$$;

ALTER FUNCTION public.sync_generation_exposure_with_post()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sync_generation_exposure_with_post()
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.sync_generation_exposure_with_post() IS
  'Trusted posts trigger: keeps generations.is_public and showcase_asset_path in the post write''s transaction and queues public derivatives the post stopped needing.';

DROP TRIGGER IF EXISTS posts_sync_generation_exposure ON public.posts;

-- The post RPCs assign these columns on every call, so the trigger also runs
-- for edits that restate them; the IS DISTINCT FROM guard keeps those free.
CREATE TRIGGER posts_sync_generation_exposure
AFTER INSERT OR DELETE OR UPDATE OF visibility, archived_at, review_status, showcase_asset_path, generation_id
ON public.posts
FOR EACH ROW
EXECUTE FUNCTION public.sync_generation_exposure_with_post();

-- Heal what the old write order already let drift, toward less exposure only.
WITH drifted AS (
  SELECT
    generations.id AS generation_id,
    posts.id AS post_id,
    posts.visibility,
    generations.showcase_asset_path AS generation_path,
    posts.showcase_asset_path AS post_path,
    (posts.visibility <> 'private' AND posts.archived_at IS NULL) AS exposed,
    (
      posts.visibility = 'public'
      AND posts.archived_at IS NULL
      AND coalesce(posts.review_status, 'visible') <> 'hidden'
    ) AS should_be_public
  FROM public.generations AS generations
  JOIN public.posts AS posts
    ON posts.generation_id = generations.id
   AND posts.user_id = generations.user_id
  WHERE generations.moderation_removed_at IS NULL
),
queued AS (
  -- A private post that no longer points at its derivative while its
  -- generation still does: the copy a failed sync left public.
  INSERT INTO public.showcase_media_revocations (
    generation_id, post_id, showcase_asset_path, reason
  )
  SELECT drifted.generation_id, drifted.post_id, drifted.generation_path, 'exposure_drift'
  FROM drifted
  WHERE drifted.visibility = 'private'
    AND drifted.post_path IS NULL
    AND nullif(btrim(drifted.generation_path), '') IS NOT NULL
  ON CONFLICT (generation_id, showcase_asset_path) DO NOTHING
  RETURNING 1
)
UPDATE public.generations AS generations
SET is_public = generations.is_public AND drifted.should_be_public,
    showcase_asset_path = CASE WHEN drifted.exposed THEN generations.showcase_asset_path END
FROM drifted
WHERE generations.id = drifted.generation_id
  AND (
    (generations.is_public AND NOT drifted.should_be_public)
    OR (NOT drifted.exposed AND generations.showcase_asset_path IS NOT NULL)
  );
