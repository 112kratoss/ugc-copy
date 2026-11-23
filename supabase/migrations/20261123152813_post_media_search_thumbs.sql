-- Search rows draw a post's cover in a frame of 28 to 48 px (a model's, a
-- tool's or a search's row: the typeahead, the start screen and the result
-- list's models and tools), and that picture was the cover's 720 px preview,
-- 25 to 35 KB for a 144 px box. A row thumb is a fourth picture of a post's
-- media row: a WebP 144 px on its short side (48 px at 3x), about 5 KB, made
-- from the preview's own bytes beside it (`<source>.thumb.<hash>.webp`, in the
-- source's folder). Search answers it as the row's picture where the cover has
-- one, and the preview where it has none, so an installed app draws the small
-- picture without an update and a row without one draws what it drew before.
--
-- Only the preview sweep makes one (`createPostMediaPreview` with `withThumb`,
-- for a writer that records it here); `scripts/backfills/backfill-post-media-thumbs.ts`
-- makes the rest, on the owner's word. Search draws only public, visible,
-- unlabelled posts' public previews (search_post_picture), and a thumb exists
-- only in a creation's public folder, showcase/<creation>/, beside a public
-- preview: the covers of creation posts. That folder is the one every path
-- that drops a post's files reaches a thumb in, through the revocation queue
-- below; a post's own folders are listed by column in account erasure and a
-- media edit, and no queue takes them (review of #906).
--
-- Its lifecycle is its preview's. The writers that move, replace or drop a
-- preview predate it and name five path columns each; rather than teach every
-- one of them a sixth, one trigger holds the rule for all:
--   - a write that changes a row's preview without naming a thumb drops the
--     thumb (a labelled post's media moving to the private bucket, a cover
--     repointed to a new copy), so a row never pairs a thumb with a preview it
--     was not made from;
--   - a thumb a row stops naming, by such a write, by a write of another thumb
--     or by the row's delete (a post deleted, its account erased, a creation
--     deleted), goes to the showcase-media-revocations queue, whose job keeps
--     what a serving post still names and removes and verifies the rest
--     (queue_unrecorded_showcase_media: an object in a creation's public
--     folder, the only place a thumb may be).
-- Account erasure's manifest (prepare_account_deletion) does not list thumbs:
-- its cascade deletes the rows, and the queue removes their thumbs after it.
-- The TypeScript paths that remove a post's objects at once (post delete,
-- takedown, a creation's deletion or unexposure, labelling) remove the thumb
-- with the rest; the queue is their durable fallback.

-- One transaction, so the lock timeout below holds for every statement.
BEGIN;

-- CREATE TRIGGER takes SHARE ROW EXCLUSIVE and ADD COLUMN a brief ACCESS
-- EXCLUSIVE on post_media: a writer holding the table makes this wait at most
-- five seconds rather than queue every reader behind it.
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.post_media
  ADD COLUMN IF NOT EXISTS thumb_storage_path text;

COMMENT ON COLUMN public.post_media.thumb_storage_path IS
  'The row thumb search draws: a WebP 144 px on its short side made from preview_storage_path''s bytes, in the same folder. Only in a creation''s public folder (showcase/<creation>/) beside a public preview (post_media_thumb_beside_public_preview_check); dropped when the preview changes without it and queued for revocation once no row names it (post_media_thumb_follows_its_preview).';

-- The same traversal guard the other path columns carry.
ALTER TABLE public.post_media
  DROP CONSTRAINT IF EXISTS post_media_thumb_storage_path_safe_check;
ALTER TABLE public.post_media
  ADD CONSTRAINT post_media_thumb_storage_path_safe_check
  CHECK (
    thumb_storage_path IS NULL
    OR (
      thumb_storage_path NOT LIKE '%..%'
      AND thumb_storage_path !~ '[\\]'
      AND thumb_storage_path !~ '^/'
    )
  ) NOT VALID;
ALTER TABLE public.post_media
  VALIDATE CONSTRAINT post_media_thumb_storage_path_safe_check;

-- A thumb lives in a creation's public folder, the pattern the revocation
-- queue takes (queue_unrecorded_showcase_media), and is only ever drawn for a
-- public preview. A labelled post's media is all in the private bucket
-- (assert_nsfw_private_media), so with this no labelled post can carry one.
ALTER TABLE public.post_media
  DROP CONSTRAINT IF EXISTS post_media_thumb_beside_public_preview_check;
ALTER TABLE public.post_media
  ADD CONSTRAINT post_media_thumb_beside_public_preview_check
  CHECK (
    thumb_storage_path IS NULL
    OR (
      thumb_storage_path ~ '^showcase/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[^/]'
      AND preview_storage_path IS NOT NULL
      AND NOT starts_with(preview_storage_path, 'private-posts/')
    )
  ) NOT VALID;
ALTER TABLE public.post_media
  VALIDATE CONSTRAINT post_media_thumb_beside_public_preview_check;

CREATE FUNCTION public.post_media_thumb_follows_its_preview()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.queue_unrecorded_showcase_media(ARRAY[OLD.thumb_storage_path]);
    RETURN OLD;
  END IF;

  -- A writer that names the thumb (the sweep, the backfill) says which goes
  -- with the preview it writes. One that does not was written before thumbs.
  IF NEW.preview_storage_path IS DISTINCT FROM OLD.preview_storage_path
    AND NEW.thumb_storage_path IS NOT DISTINCT FROM OLD.thumb_storage_path THEN
    NEW.thumb_storage_path := NULL;
  END IF;

  IF NEW.thumb_storage_path IS DISTINCT FROM OLD.thumb_storage_path THEN
    PERFORM public.queue_unrecorded_showcase_media(ARRAY[OLD.thumb_storage_path]);
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.post_media_thumb_follows_its_preview()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.post_media_thumb_follows_its_preview()
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.post_media_thumb_follows_its_preview() IS
  'Trusted post_media trigger: a write that changes a row''s preview without naming its thumb drops the thumb, and a thumb a row stops naming (by a write or its delete) is queued for revocation (queue_unrecorded_showcase_media), whose job keeps what a serving post still names.';

CREATE TRIGGER post_media_thumb_follows_its_preview
BEFORE UPDATE OF preview_storage_path, thumb_storage_path ON public.post_media
FOR EACH ROW
WHEN (OLD.thumb_storage_path IS NOT NULL)
EXECUTE FUNCTION public.post_media_thumb_follows_its_preview();

CREATE TRIGGER post_media_queue_deleted_thumb
AFTER DELETE ON public.post_media
FOR EACH ROW
WHEN (OLD.thumb_storage_path IS NOT NULL)
EXECUTE FUNCTION public.post_media_thumb_follows_its_preview();

-- search_post_picture as 20261115105944 wrote it, answering the cover's thumb
-- beside its preview: `thumb_path`, a key only where the cover has a thumb, so
-- the answer for one without (and every starter and typeahead answer that
-- carries it) is what it was.
CREATE OR REPLACE FUNCTION public.search_post_picture(
  p_post_id uuid,
  p_viewer_user_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  RETURN (
    SELECT jsonb_build_object(
      'post_id', posts.id,
      'path', cover.preview_storage_path,
      'thumbhash', cover.preview_thumbhash,
      'width', cover.width,
      'height', cover.height,
      'media_kind', cover.media_kind
    ) || CASE
      WHEN cover.thumb_storage_path IS NULL THEN '{}'::jsonb
      ELSE jsonb_build_object('thumb_path', cover.thumb_storage_path)
    END
    FROM public.posts AS posts
    -- A post search can show: it has a document.
    JOIN public.post_search_documents AS documents ON documents.post_id = posts.id
    CROSS JOIN LATERAL (
      -- Its cover, as a card draws it: the first media row. A video's
      -- preview is its poster.
      SELECT
        media.preview_storage_path,
        media.thumb_storage_path,
        media.preview_thumbhash,
        media.preview_status,
        media.source_unavailable_at,
        media.width,
        media.height,
        media.media_kind
      FROM public.post_media AS media
      WHERE media.post_id = posts.id
      ORDER BY media.sort_order
      LIMIT 1
    ) AS cover
    WHERE posts.id = p_post_id
      AND posts.visibility = 'public'
      AND posts.review_status = 'visible'
      AND posts.archived_at IS NULL
      AND posts.is_nsfw = false
      AND cover.preview_status = 'ready'
      AND cover.preview_storage_path IS NOT NULL
      -- A labelled post's media is moved to the private bucket; nothing of
      -- that bucket is a picture here, whatever the post says now.
      AND cover.preview_storage_path NOT LIKE 'private-posts/%'
      AND cover.source_unavailable_at IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.user_blocks AS blocks
        WHERE blocks.blocker_user_id = p_viewer_user_id
          AND blocks.blocked_user_id = posts.user_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.user_blocks AS blocks
        WHERE blocks.blocker_user_id = posts.user_id
          AND blocks.blocked_user_id = p_viewer_user_id
      )
  );
END;
$function$;

COMMENT ON FUNCTION public.search_post_picture(uuid, uuid) IS
  'The cover of a post, for a search row to draw: {post_id, path, thumbhash, width, height, media_kind} from its first media row, a video''s poster included, and thumb_path, its row thumb, where it has one; path is its preview. NULL unless the post is one search may show p_viewer_user_id (public, visible, unarchived, unlabelled, with a search document, neither side of a block) and that row''s preview is ready in the public bucket. Service role only.';

REVOKE ALL ON FUNCTION public.search_post_picture(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_post_picture(uuid, uuid) TO service_role;

COMMIT;
