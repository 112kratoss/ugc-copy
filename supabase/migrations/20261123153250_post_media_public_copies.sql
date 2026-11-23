-- Public copies of a post's own uploaded media.
--
-- A post's uploaded originals and the derivatives built from them live in the
-- private post_media bucket under private-posts/<post>/ (20260920190000), so
-- every view of them goes through /api/media: a function call, an
-- authorization RPC and a URL signing on each read. A post anyone may read now
-- gets a verified copy of each of those objects at public-posts/<post>/<the
-- same rest> in the public showcase_media bucket, served straight from the
-- storage CDN like every other public post. The private objects stay the
-- record: purchase snapshots, deletion manifests, the NSFW and moderation
-- paths and /api/media keep naming them, and nothing here changes who may
-- read them.
--
-- A copy is served only while its row records it (public_copy_paths), and a
-- row may record one only while the post may be read by anyone signed out:
-- the rule can_read_private_post_media applies (public, not archived, review
-- status visible, not tombstoned, not NSFW, its owner active), held to every
-- transaction by a deferred constraint. Every write that ends that clears the
-- records in its own transaction and queues each copy for removal; the routes
-- then remove the objects at once and the showcase-media-revocations job
-- retries what they miss. An object is made only after a queue row names it,
-- and a queue row leaves only when the copy is recorded or its object is
-- verified gone, so no copy can exist that nothing will remove.

ALTER TABLE public.post_media
  ADD COLUMN public_copy_paths text[] NOT NULL DEFAULT '{}'::text[];

-- Each recorded copy is the public twin of one of the row's own private paths
-- (written out rather than through a function, so no grant can break it).
ALTER TABLE public.post_media
  ADD CONSTRAINT post_media_public_copy_paths_check CHECK (
    public_copy_paths <@ ARRAY[
      CASE WHEN starts_with(storage_path, 'private-posts/' || post_id::text || '/')
        THEN 'public-posts/' || substr(storage_path, 15) END,
      CASE WHEN starts_with(preview_storage_path, 'private-posts/' || post_id::text || '/')
        THEN 'public-posts/' || substr(preview_storage_path, 15) END,
      CASE WHEN starts_with(display_storage_path, 'private-posts/' || post_id::text || '/')
        THEN 'public-posts/' || substr(display_storage_path, 15) END,
      CASE WHEN starts_with(rendition_storage_path, 'private-posts/' || post_id::text || '/')
        THEN 'public-posts/' || substr(rendition_storage_path, 15) END,
      CASE WHEN starts_with(teaser_storage_path, 'private-posts/' || post_id::text || '/')
        THEN 'public-posts/' || substr(teaser_storage_path, 15) END
    ]
  );

COMMENT ON COLUMN public.post_media.public_copy_paths IS
  'Verified public copies (showcase_media, public-posts/<post>/...) of this row''s own private-posts/<post>/ objects that readers may be served. Written only by commit_post_media_public_copies; cleared, and its objects queued for removal, whenever the post stops being readable by anyone.';

-- The copy's path for one of the post's own private paths; null for any other.
CREATE FUNCTION public.post_media_public_copy_path(p_post_id uuid, p_private_path text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN starts_with(p_private_path, 'private-posts/' || p_post_id::text || '/')
      THEN 'public-posts/' || substr(p_private_path, 15)
  END;
$$;

-- Whether anyone signed out may read the post's media now: the signed-out
-- answer of can_read_private_post_media. Unlisted posts are stored as private
-- (20261017), so public is the one visibility left.
CREATE FUNCTION public.post_media_public_copies_allowed(p_post_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.posts AS post
    JOIN public.profiles AS owner ON owner.id = post.user_id
    WHERE post.id = p_post_id
      AND post.visibility = 'public'
      AND post.archived_at IS NULL
      AND post.review_status = 'visible'
      AND post.tombstoned_at IS NULL
      AND NOT post.is_nsfw
      AND owner.identity_state = 'active'
  );
$$;

-- Every public object that may exist without a row recording it: a copy
-- being made, and every copy a write stopped serving. No foreign key: a row
-- outlives its post, whose deletion is what queued it.
CREATE TABLE public.post_media_public_copy_queue (
  public_path text PRIMARY KEY,
  post_id uuid NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  attempt_count integer NOT NULL DEFAULT 0,
  last_error text,
  claimed_at timestamptz,
  claim_token uuid,
  CONSTRAINT post_media_public_copy_queue_path_check CHECK (
    starts_with(public_path, 'public-posts/' || post_id::text || '/')
    AND length(public_path) > length('public-posts/' || post_id::text || '/')
  ),
  CONSTRAINT post_media_public_copy_queue_reason_check CHECK (
    reason IN ('copying', 'copy_refused', 'unexposed', 'media_removed', 'post_deleted', 'owner_inactive')
  ),
  CONSTRAINT post_media_public_copy_queue_attempt_count_check CHECK (attempt_count >= 0),
  CONSTRAINT post_media_public_copy_queue_claim_check CHECK ((claimed_at IS NULL) = (claim_token IS NULL))
);

CREATE INDEX post_media_public_copy_queue_due_idx
  ON public.post_media_public_copy_queue (next_attempt_at, public_path);
CREATE INDEX post_media_public_copy_queue_post_idx
  ON public.post_media_public_copy_queue (post_id);

ALTER TABLE public.post_media_public_copy_queue ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.post_media_public_copy_queue FROM PUBLIC, anon, authenticated, service_role;
-- Read by the worker; every change goes through the functions below.
GRANT SELECT ON TABLE public.post_media_public_copy_queue TO service_role;

COMMENT ON TABLE public.post_media_public_copy_queue IS
  'Public copies of post media that may exist unrecorded: being made, or no longer served. The worker removes each one not recorded on a row when it is due; a row leaves only when its copy is recorded or verified gone.';

-- Clears what the post's rows record and queues every copy, due now. Run in
-- the transaction of the write that ended the post's public reading.
CREATE FUNCTION public.revoke_post_media_public_copies(p_post_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.post_media_public_copy_queue AS queued (public_path, post_id, reason, next_attempt_at)
  SELECT DISTINCT recorded.path, media.post_id, p_reason, now()
  FROM public.post_media AS media
  CROSS JOIN LATERAL unnest(media.public_copy_paths) AS recorded(path)
  WHERE media.post_id = p_post_id
  ON CONFLICT (public_path) DO UPDATE
    SET reason = EXCLUDED.reason,
        next_attempt_at = LEAST(queued.next_attempt_at, EXCLUDED.next_attempt_at);

  -- A copy still being made is not wanted any more either.
  UPDATE public.post_media_public_copy_queue
  SET next_attempt_at = now()
  WHERE post_id = p_post_id
    AND next_attempt_at > now();

  UPDATE public.post_media
  SET public_copy_paths = '{}'::text[]
  WHERE post_id = p_post_id
    AND cardinality(public_copy_paths) > 0;
END;
$$;

CREATE FUNCTION public.revoke_post_media_public_copies_with_post()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF (
    EXISTS (
      SELECT 1 FROM public.post_media
      WHERE post_id = NEW.id AND cardinality(public_copy_paths) > 0
    )
    OR EXISTS (
      SELECT 1 FROM public.post_media_public_copy_queue
      WHERE post_id = NEW.id AND next_attempt_at > now()
    )
  ) AND NOT public.post_media_public_copies_allowed(NEW.id) THEN
    PERFORM public.revoke_post_media_public_copies(NEW.id, 'unexposed');
  END IF;
  RETURN NULL;
END;
$$;

-- The post RPCs restate these columns on every edit; the trigger is a pair of
-- index probes for a post with nothing recorded.
CREATE TRIGGER posts_revoke_media_public_copies
AFTER UPDATE OF visibility, archived_at, review_status, tombstoned_at, is_nsfw, user_id
ON public.posts
FOR EACH ROW
EXECUTE FUNCTION public.revoke_post_media_public_copies_with_post();

-- A row that stops naming a private path stops recording its copy, and the
-- copy is queued. Sweeps that record a new derivative keep the others.
CREATE FUNCTION public.prune_post_media_public_copies()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_twins text[];
  v_dropped text[];
BEGIN
  IF cardinality(NEW.public_copy_paths) = 0 THEN
    RETURN NEW;
  END IF;

  v_twins := ARRAY[
    public.post_media_public_copy_path(NEW.post_id, NEW.storage_path),
    public.post_media_public_copy_path(NEW.post_id, NEW.preview_storage_path),
    public.post_media_public_copy_path(NEW.post_id, NEW.display_storage_path),
    public.post_media_public_copy_path(NEW.post_id, NEW.rendition_storage_path),
    public.post_media_public_copy_path(NEW.post_id, NEW.teaser_storage_path)
  ];

  SELECT coalesce(array_agg(DISTINCT recorded.path), '{}'::text[])
  INTO v_dropped
  FROM unnest(NEW.public_copy_paths) AS recorded(path)
  WHERE NOT coalesce(recorded.path = ANY(v_twins), false);

  IF cardinality(v_dropped) > 0 THEN
    INSERT INTO public.post_media_public_copy_queue AS queued (public_path, post_id, reason, next_attempt_at)
    SELECT dropped.path, OLD.post_id, 'media_removed', now()
    FROM unnest(v_dropped) AS dropped(path)
    WHERE starts_with(dropped.path, 'public-posts/' || OLD.post_id::text || '/')
    ON CONFLICT (public_path) DO UPDATE
      SET reason = EXCLUDED.reason,
          next_attempt_at = LEAST(queued.next_attempt_at, EXCLUDED.next_attempt_at);

    NEW.public_copy_paths := ARRAY(
      SELECT recorded.path
      FROM unnest(NEW.public_copy_paths) AS recorded(path)
      WHERE NOT (recorded.path = ANY(v_dropped))
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER post_media_prune_public_copies
BEFORE UPDATE OF storage_path, preview_storage_path, display_storage_path, rendition_storage_path,
  teaser_storage_path, post_id
ON public.post_media
FOR EACH ROW
EXECUTE FUNCTION public.prune_post_media_public_copies();

-- A deleted row's copies are queued, whether a gallery save replaced it or
-- its post's delete cascaded to it (account erasure's cascade included).
CREATE FUNCTION public.queue_deleted_post_media_public_copies()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF cardinality(OLD.public_copy_paths) > 0 THEN
    INSERT INTO public.post_media_public_copy_queue AS queued (public_path, post_id, reason, next_attempt_at)
    SELECT DISTINCT
      recorded.path,
      OLD.post_id,
      CASE WHEN EXISTS (SELECT 1 FROM public.posts WHERE id = OLD.post_id)
        THEN 'media_removed' ELSE 'post_deleted' END,
      now()
    FROM unnest(OLD.public_copy_paths) AS recorded(path)
    ON CONFLICT (public_path) DO UPDATE
      SET reason = EXCLUDED.reason,
          next_attempt_at = LEAST(queued.next_attempt_at, EXCLUDED.next_attempt_at);
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER post_media_queue_deleted_public_copies
AFTER DELETE ON public.post_media
FOR EACH ROW
EXECUTE FUNCTION public.queue_deleted_post_media_public_copies();

-- An owner leaving the active state (deleting, merged) takes every copy of
-- their posts with it, as can_read_private_post_media stops signing them.
CREATE FUNCTION public.revoke_post_media_public_copies_with_owner()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_post_id uuid;
BEGIN
  IF NEW.identity_state IS DISTINCT FROM OLD.identity_state AND NEW.identity_state <> 'active' THEN
    FOR v_post_id IN
      SELECT media.post_id
      FROM public.post_media AS media
      JOIN public.posts AS post ON post.id = media.post_id
      WHERE post.user_id = NEW.id
        AND cardinality(media.public_copy_paths) > 0
      UNION
      SELECT queued.post_id
      FROM public.post_media_public_copy_queue AS queued
      JOIN public.posts AS post ON post.id = queued.post_id
      WHERE post.user_id = NEW.id
        AND queued.next_attempt_at > now()
    LOOP
      PERFORM public.revoke_post_media_public_copies(v_post_id, 'owner_inactive');
    END LOOP;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER profiles_revoke_media_public_copies
AFTER UPDATE OF identity_state ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION public.revoke_post_media_public_copies_with_owner();

-- No transaction may end with a copy recorded on a post that anyone signed
-- out could not read. The triggers above clear them; this refuses whatever a
-- future write path might forget.
CREATE FUNCTION public.assert_post_media_public_copies_allowed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_post_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'posts' THEN
    v_post_id := NEW.id;
  ELSE
    v_post_id := NEW.post_id;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.post_media
    WHERE post_id = v_post_id AND cardinality(public_copy_paths) > 0
  ) AND NOT public.post_media_public_copies_allowed(v_post_id) THEN
    RAISE EXCEPTION 'POST_MEDIA_PUBLIC_COPY_NOT_ALLOWED' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

-- Named to fire after posts_revoke_media_public_copies (triggers of one event
-- fire by name), so the order holds even under SET CONSTRAINTS ... IMMEDIATE.
CREATE CONSTRAINT TRIGGER z_posts_media_public_copies_allowed
AFTER UPDATE OF visibility, archived_at, review_status, tombstoned_at, is_nsfw, user_id
ON public.posts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.assert_post_media_public_copies_allowed();

CREATE CONSTRAINT TRIGGER z_post_media_public_copies_allowed
AFTER INSERT OR UPDATE OF public_copy_paths ON public.post_media
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.assert_post_media_public_copies_allowed();

-- Step one of making copies: names each of the post's own private objects
-- with no recorded copy yet and queues its copy path before any object
-- exists, so a copy whose function dies is still removed. Nothing for a post
-- anyone signed out may not read, nor for a copy whose removal is under way.
CREATE FUNCTION public.begin_post_media_public_copies(p_post_id uuid)
RETURNS TABLE (source_path text, copy_path text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- The lock commit and claim take too: one of them at a time per post.
  PERFORM 1 FROM public.posts WHERE id = p_post_id FOR UPDATE;
  IF NOT FOUND OR NOT public.post_media_public_copies_allowed(p_post_id) THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH named AS (
    SELECT DISTINCT
      named_path.value AS private_object,
      public.post_media_public_copy_path(p_post_id, named_path.value) AS public_object
    FROM public.post_media AS media
    CROSS JOIN LATERAL unnest(ARRAY[
      media.storage_path, media.preview_storage_path, media.display_storage_path,
      media.rendition_storage_path, media.teaser_storage_path
    ]) AS named_path(value)
    WHERE media.post_id = p_post_id
      AND public.post_media_public_copy_path(p_post_id, named_path.value) IS NOT NULL
      AND NOT (public.post_media_public_copy_path(p_post_id, named_path.value) = ANY(media.public_copy_paths))
  ),
  wanted AS (
    SELECT named.private_object, named.public_object
    FROM named
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.post_media_public_copy_queue AS queued
      WHERE queued.public_path = named.public_object
        AND queued.claimed_at > now() - interval '1 hour'
    )
  ),
  tracked AS (
    INSERT INTO public.post_media_public_copy_queue AS queued (public_path, post_id, reason, next_attempt_at)
    SELECT wanted.public_object, p_post_id, 'copying', now() + interval '15 minutes'
    FROM wanted
    ON CONFLICT (public_path) DO UPDATE
      SET reason = 'copying',
          claimed_at = NULL,
          claim_token = NULL,
          next_attempt_at = GREATEST(queued.next_attempt_at, EXCLUDED.next_attempt_at)
    RETURNING queued.public_path
  )
  SELECT wanted.private_object, wanted.public_object
  FROM wanted
  JOIN tracked ON tracked.public_path = wanted.public_object;
END;
$$;

-- Step two: records each copy whose object Storage holds at its source's
-- size, on every row naming the source, while the post may still be read by
-- anyone. Any copy not recorded stays queued, due now, for the worker.
CREATE FUNCTION public.commit_post_media_public_copies(p_post_id uuid, p_copy_paths text[])
RETURNS text[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_allowed boolean;
  v_copy text;
  v_source text;
  v_source_size bigint;
  v_copy_size bigint;
  v_committed text[] := '{}'::text[];
  v_owner_id uuid;
BEGIN
  SELECT post.user_id INTO v_owner_id FROM public.posts AS post WHERE post.id = p_post_id FOR UPDATE;
  IF FOUND THEN
    -- An owner leaving the active state takes the copies back from a
    -- profiles trigger that holds no post lock: the share lock makes that
    -- update wait for this commit, or this commit see it.
    PERFORM 1 FROM public.profiles WHERE id = v_owner_id FOR SHARE;
    v_allowed := public.post_media_public_copies_allowed(p_post_id);
  ELSE
    v_allowed := false;
  END IF;

  FOREACH v_copy IN ARRAY coalesce(p_copy_paths, '{}'::text[]) LOOP
    IF v_copy IS NULL
      OR NOT starts_with(v_copy, 'public-posts/' || p_post_id::text || '/')
      OR length(v_copy) <= length('public-posts/' || p_post_id::text || '/') THEN
      RAISE EXCEPTION 'Invalid public copy path' USING ERRCODE = '22023';
    END IF;
    v_source := 'private-posts/' || substr(v_copy, 14);
    v_source_size := NULL;
    v_copy_size := NULL;

    IF v_allowed
      AND EXISTS (
        SELECT 1 FROM public.post_media_public_copy_queue AS queued
        WHERE queued.public_path = v_copy AND queued.claimed_at IS NULL
      )
      AND EXISTS (
        SELECT 1 FROM public.post_media AS media
        WHERE media.post_id = p_post_id
          AND v_source = ANY(ARRAY[
            media.storage_path, media.preview_storage_path, media.display_storage_path,
            media.rendition_storage_path, media.teaser_storage_path
          ])
      ) THEN
      SELECT (objects.metadata->>'size')::bigint INTO v_source_size
      FROM storage.objects AS objects
      WHERE objects.bucket_id = 'post_media' AND objects.name = v_source;
      SELECT (objects.metadata->>'size')::bigint INTO v_copy_size
      FROM storage.objects AS objects
      WHERE objects.bucket_id = 'showcase_media' AND objects.name = v_copy;

      IF v_source_size > 0 AND v_copy_size = v_source_size THEN
        UPDATE public.post_media AS media
        SET public_copy_paths = media.public_copy_paths || v_copy
        WHERE media.post_id = p_post_id
          AND v_source = ANY(ARRAY[
            media.storage_path, media.preview_storage_path, media.display_storage_path,
            media.rendition_storage_path, media.teaser_storage_path
          ])
          AND NOT (v_copy = ANY(media.public_copy_paths));
        -- A sweep that replaced the source on the row meanwhile (it takes no
        -- post lock) left nothing recording the copy: it stays queued below.
        -- The rows the update recorded it on stay locked to this transaction,
        -- so a sweep that drops it later queues it again after this delete.
        IF EXISTS (
          SELECT 1 FROM public.post_media AS media
          WHERE media.post_id = p_post_id AND v_copy = ANY(media.public_copy_paths)
        ) THEN
          DELETE FROM public.post_media_public_copy_queue WHERE public_path = v_copy;
          v_committed := array_append(v_committed, v_copy);
          CONTINUE;
        END IF;
      END IF;
    END IF;

    -- Not recorded: whatever the copy made stays queued until it is removed.
    -- A claim under way is let go, so its finish cannot drop this row.
    INSERT INTO public.post_media_public_copy_queue AS queued (public_path, post_id, reason, next_attempt_at)
    VALUES (v_copy, p_post_id, 'copy_refused', now())
    ON CONFLICT (public_path) DO UPDATE
      SET reason = 'copy_refused',
          next_attempt_at = now(),
          claimed_at = NULL,
          claim_token = NULL;
  END LOOP;

  RETURN v_committed;
END;
$$;

-- The worker's claim on a queued copy, under the post's lock: a copy a row
-- records is served and leaves the queue; any other is claimed for removal
-- with a token its finish must show.
CREATE FUNCTION public.claim_post_media_public_copy_removal(p_copy_path text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_post_id uuid;
  v_token uuid;
BEGIN
  SELECT queued.post_id INTO v_post_id
  FROM public.post_media_public_copy_queue AS queued
  WHERE queued.public_path = p_copy_path;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'gone');
  END IF;

  PERFORM 1 FROM public.posts WHERE id = v_post_id FOR UPDATE;

  -- The rows recording it, locked: a sweep that drops the copy from one
  -- (no post lock) waits for this transaction and queues it again after the
  -- delete below, or went first and this finds it no longer recorded.
  PERFORM 1 FROM public.post_media AS media
  WHERE media.post_id = v_post_id AND p_copy_path = ANY(media.public_copy_paths)
  FOR UPDATE;
  IF FOUND THEN
    DELETE FROM public.post_media_public_copy_queue WHERE public_path = p_copy_path;
    RETURN jsonb_build_object('outcome', 'served');
  END IF;

  v_token := gen_random_uuid();
  UPDATE public.post_media_public_copy_queue
  SET claimed_at = now(),
      claim_token = v_token
  WHERE public_path = p_copy_path;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'gone');
  END IF;
  RETURN jsonb_build_object('outcome', 'claimed', 'token', v_token);
END;
$$;

-- After Storage confirmed the object gone. False when a commit let the claim
-- go meanwhile: the row stays and the next run removes the object again.
CREATE FUNCTION public.finish_post_media_public_copy_removal(p_copy_path text, p_claim_token uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH removed AS (
    DELETE FROM public.post_media_public_copy_queue
    WHERE public_path = p_copy_path
      AND claim_token = p_claim_token
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM removed);
$$;

-- A removal that failed: tried again after 10 minutes, doubling to a day.
CREATE FUNCTION public.reschedule_post_media_public_copy_removal(
  p_copy_path text,
  p_claim_token uuid,
  p_error text
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  UPDATE public.post_media_public_copy_queue
  SET attempt_count = attempt_count + 1,
      next_attempt_at = now() + LEAST(
        interval '24 hours',
        interval '10 minutes' * power(2, LEAST(attempt_count, 8))
      ),
      last_error = left(coalesce(p_error, 'unknown error'), 1000),
      claimed_at = NULL,
      claim_token = NULL
  WHERE public_path = p_copy_path
    AND claim_token = p_claim_token;
$$;

-- Posts anyone may read with a private object of their own and no recorded
-- copy of it. The maintenance job asks only for posts already served at
-- least one copy (a derivative a sweep built since); the backfill asks for
-- every such post.
CREATE FUNCTION public.list_post_media_public_copy_candidates(
  p_limit integer,
  p_include_unserved boolean DEFAULT false
)
RETURNS TABLE (post_id uuid, owner_user_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT post.id, post.user_id
  FROM public.posts AS post
  JOIN public.profiles AS owner ON owner.id = post.user_id
  WHERE post.visibility = 'public'
    AND post.archived_at IS NULL
    AND post.review_status = 'visible'
    AND post.tombstoned_at IS NULL
    AND NOT post.is_nsfw
    AND owner.identity_state = 'active'
    AND EXISTS (
      SELECT 1
      FROM public.post_media AS media
      CROSS JOIN LATERAL unnest(ARRAY[
        media.storage_path, media.preview_storage_path, media.display_storage_path,
        media.rendition_storage_path, media.teaser_storage_path
      ]) AS named_path(value)
      WHERE media.post_id = post.id
        AND public.post_media_public_copy_path(post.id, named_path.value) IS NOT NULL
        AND NOT (public.post_media_public_copy_path(post.id, named_path.value) = ANY(media.public_copy_paths))
    )
    AND (
      p_include_unserved
      OR EXISTS (
        SELECT 1 FROM public.post_media AS media
        WHERE media.post_id = post.id AND cardinality(media.public_copy_paths) > 0
      )
    )
  ORDER BY post.created_at DESC, post.id
  LIMIT greatest(1, least(coalesce(p_limit, 50), 500));
$$;

REVOKE ALL ON FUNCTION public.post_media_public_copy_path(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.post_media_public_copies_allowed(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.begin_post_media_public_copies(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.commit_post_media_public_copies(uuid, text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_post_media_public_copy_removal(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_post_media_public_copy_removal(text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reschedule_post_media_public_copy_removal(text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_post_media_public_copy_candidates(integer, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.post_media_public_copy_path(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.post_media_public_copies_allowed(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.begin_post_media_public_copies(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.commit_post_media_public_copies(uuid, text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_post_media_public_copy_removal(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_post_media_public_copy_removal(text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.reschedule_post_media_public_copy_removal(text, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_post_media_public_copy_candidates(integer, boolean) TO service_role;

-- Trigger bodies and the revoke step are not callable APIs.
REVOKE ALL ON FUNCTION public.revoke_post_media_public_copies(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.revoke_post_media_public_copies_with_post() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.prune_post_media_public_copies() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.queue_deleted_post_media_public_copies() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.revoke_post_media_public_copies_with_owner() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.assert_post_media_public_copies_allowed() FROM PUBLIC, anon, authenticated, service_role;
