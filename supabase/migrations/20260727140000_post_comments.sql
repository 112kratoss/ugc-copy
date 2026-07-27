-- Threaded comments for public showcase posts.
--
-- Comments are backend-owned like the moderation and feed tables: every read
-- and write is mediated by the Vercel API so blocked-user filtering, post
-- visibility, and rate limits are enforced in one place. Counters are
-- maintained inside SECURITY DEFINER RPCs the same way post saves are, so the
-- denormalized totals can never drift from a partially applied client write.

ALTER TABLE public.posts
  ADD COLUMN IF NOT EXISTS comment_count integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.post_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  parent_comment_id uuid,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  status text NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'removed_by_author', 'removed_by_owner', 'removed_by_moderation')
  ),
  reply_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  -- Enables the composite parent foreign key below.
  CONSTRAINT post_comments_post_scope UNIQUE (id, post_id),
  -- A reply must live on the same post as its parent. Enforced declaratively:
  -- MATCH SIMPLE skips the check when parent_comment_id is NULL, so top-level
  -- comments are unconstrained while replies can never cross posts.
  CONSTRAINT post_comments_parent_same_post
    FOREIGN KEY (parent_comment_id, post_id)
    REFERENCES public.post_comments (id, post_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS post_comments_toplevel_idx
  ON public.post_comments (post_id, created_at DESC)
  WHERE parent_comment_id IS NULL;

CREATE INDEX IF NOT EXISTS post_comments_parent_idx
  ON public.post_comments (parent_comment_id, created_at ASC)
  WHERE parent_comment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS post_comments_user_idx
  ON public.post_comments (user_id, created_at DESC);

ALTER TABLE public.post_comments ENABLE ROW LEVEL SECURITY;

-- Comment reads must be filtered by post visibility and by blocks in both
-- directions, which clients cannot evaluate. Keeping the table off the public
-- Data API forces every access through the authenticated backend.
REVOKE ALL ON TABLE public.post_comments FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.post_comments TO service_role;

COMMENT ON TABLE public.post_comments IS
  'Backend-owned threaded comments on public posts. Removal is a soft status change so replies survive their parent.';

DROP TRIGGER IF EXISTS post_comments_set_updated_at ON public.post_comments;
CREATE TRIGGER post_comments_set_updated_at
BEFORE UPDATE ON public.post_comments
FOR EACH ROW
EXECUTE FUNCTION public.touch_updated_at_column();

CREATE OR REPLACE FUNCTION public.create_post_comment(
  p_post_id uuid,
  p_user_id uuid,
  p_parent_comment_id uuid,
  p_body text
)
RETURNS TABLE (
  comment_id uuid,
  created_at timestamptz,
  comment_count integer,
  parent_reply_count integer
) AS $$
DECLARE
  v_body text;
  v_comment_id uuid;
  v_created_at timestamptz;
  v_comment_count integer := 0;
  v_parent_reply_count integer := 0;
  v_parent_status text;
  v_parent_post_id uuid;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'Missing user id';
  END IF;

  v_body := btrim(coalesce(p_body, ''));

  IF v_body = '' THEN
    RAISE EXCEPTION 'Comment body is required';
  END IF;

  IF char_length(v_body) > 2000 THEN
    RAISE EXCEPTION 'Comment body is too long';
  END IF;

  PERFORM 1
  FROM public.posts AS post
  WHERE post.id = p_post_id
    AND post.visibility = 'public'
    AND post.archived_at IS NULL
    AND post.review_status = 'visible';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Post is private or not found';
  END IF;

  IF p_parent_comment_id IS NOT NULL THEN
    SELECT parent.status, parent.post_id
    INTO v_parent_status, v_parent_post_id
    FROM public.post_comments AS parent
    WHERE parent.id = p_parent_comment_id;

    IF NOT FOUND OR v_parent_post_id IS DISTINCT FROM p_post_id THEN
      RAISE EXCEPTION 'Parent comment not found';
    END IF;

    IF v_parent_status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'Parent comment is not available';
    END IF;
  END IF;

  INSERT INTO public.post_comments AS inserted (post_id, user_id, parent_comment_id, body)
  VALUES (p_post_id, p_user_id, p_parent_comment_id, v_body)
  RETURNING inserted.id, inserted.created_at
  INTO v_comment_id, v_created_at;

  UPDATE public.posts AS post
  SET comment_count = post.comment_count + 1
  WHERE post.id = p_post_id
  RETURNING post.comment_count INTO v_comment_count;

  IF p_parent_comment_id IS NOT NULL THEN
    UPDATE public.post_comments AS parent
    SET reply_count = parent.reply_count + 1
    WHERE parent.id = p_parent_comment_id
    RETURNING parent.reply_count INTO v_parent_reply_count;
  END IF;

  RETURN QUERY
  SELECT v_comment_id, v_created_at, coalesce(v_comment_count, 0), coalesce(v_parent_reply_count, 0);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.set_post_comment_status(
  p_comment_id uuid,
  p_actor_user_id uuid,
  p_next_status text
)
RETURNS TABLE (
  changed boolean,
  comment_count integer
) AS $$
DECLARE
  v_author_user_id uuid;
  v_post_id uuid;
  v_parent_comment_id uuid;
  v_status text;
  v_post_owner_user_id uuid;
  v_changed boolean := false;
  v_comment_count integer := 0;
BEGIN
  IF p_next_status NOT IN ('removed_by_author', 'removed_by_owner', 'removed_by_moderation') THEN
    RAISE EXCEPTION 'Unsupported comment status';
  END IF;

  SELECT target.user_id, target.post_id, target.parent_comment_id, target.status, post.user_id
  INTO v_author_user_id, v_post_id, v_parent_comment_id, v_status, v_post_owner_user_id
  FROM public.post_comments AS target
  JOIN public.posts AS post ON post.id = target.post_id
  WHERE target.id = p_comment_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Comment not found';
  END IF;

  IF p_next_status = 'removed_by_author' THEN
    IF p_actor_user_id IS NULL OR p_actor_user_id IS DISTINCT FROM v_author_user_id THEN
      RAISE EXCEPTION 'Only the comment author can delete this comment';
    END IF;
  ELSIF p_next_status = 'removed_by_owner' THEN
    IF p_actor_user_id IS NULL OR p_actor_user_id IS DISTINCT FROM v_post_owner_user_id THEN
      RAISE EXCEPTION 'Only the post owner can remove this comment';
    END IF;
  END IF;

  IF v_status = 'active' THEN
    UPDATE public.post_comments AS target
    SET status = p_next_status
    WHERE target.id = p_comment_id;

    v_changed := true;

    UPDATE public.posts AS post
    SET comment_count = greatest(0, post.comment_count - 1)
    WHERE post.id = v_post_id;

    IF v_parent_comment_id IS NOT NULL THEN
      UPDATE public.post_comments AS parent
      SET reply_count = greatest(0, parent.reply_count - 1)
      WHERE parent.id = v_parent_comment_id;
    END IF;
  END IF;

  SELECT coalesce(post.comment_count, 0)
  INTO v_comment_count
  FROM public.posts AS post
  WHERE post.id = v_post_id;

  RETURN QUERY SELECT v_changed, coalesce(v_comment_count, 0);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.create_post_comment(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_post_comment_status(uuid, uuid, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_post_comment(uuid, uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_post_comment_status(uuid, uuid, text) TO service_role;

-- Comment reports join the existing moderation queue rather than starting a new
-- one: the staffed ops CLI and /api/moderation/reports already understand
-- target-shaped reports, so a comment is simply a third target type.
ALTER TABLE public.moderation_reports
  ADD COLUMN IF NOT EXISTS comment_id uuid REFERENCES public.post_comments(id) ON DELETE SET NULL;

ALTER TABLE public.moderation_reports
  DROP CONSTRAINT IF EXISTS moderation_reports_target_type_check;

ALTER TABLE public.moderation_reports
  ADD CONSTRAINT moderation_reports_target_type_check
    CHECK (target_type IN ('user', 'generation', 'comment'));

ALTER TABLE public.moderation_reports
  DROP CONSTRAINT IF EXISTS moderation_reports_target_shape;

ALTER TABLE public.moderation_reports
  ADD CONSTRAINT moderation_reports_target_shape CHECK (
    (target_type = 'user' AND generation_id IS NULL AND comment_id IS NULL)
    OR (target_type = 'generation' AND reported_user_id IS NULL AND comment_id IS NULL)
    OR (target_type = 'comment' AND reported_user_id IS NULL AND generation_id IS NULL)
  );

ALTER TABLE public.moderation_reports
  DROP CONSTRAINT IF EXISTS moderation_reports_source_surface_check;

ALTER TABLE public.moderation_reports
  ADD CONSTRAINT moderation_reports_source_surface_check
    CHECK (source_surface IN (
      'showcase',
      'showcase-reel',
      'creator-profile',
      'generation-viewer',
      'comments'
    ));

CREATE INDEX IF NOT EXISTS moderation_reports_comment_created_idx
  ON public.moderation_reports (comment_id, created_at DESC)
  WHERE comment_id IS NOT NULL;
