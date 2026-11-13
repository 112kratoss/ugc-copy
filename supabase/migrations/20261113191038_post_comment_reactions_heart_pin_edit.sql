-- Likes and dislikes, the creator's heart, one pinned comment and edits for
-- post comments.
--
-- The thread already was backend-owned (20260727140000): no client reads or
-- writes these tables, every access goes through the Vercel API with the
-- service role, and each write is one SECURITY DEFINER function so a counter
-- can never be left behind by half a write. This keeps to that.
--
--   * A reaction is one row per reader and comment, `like` or `dislike`. The
--     comment carries both counts; only `like_count` is ever sent to a client.
--   * A heart is the post's creator marking another person's comment. Editing
--     the comment takes it off: the creator hearted other words.
--   * A post has at most one pinned comment, a top-level one, pinned by the
--     post's creator.
--   * An edit replaces the body and stamps `edited_at`. The words it replaced
--     are kept in `post_comment_edits`, which only an operator reads: a report
--     names a comment, not its text, so without it an edit after a report
--     would leave the reviewer nothing to look at.

ALTER TABLE public.post_comments
  ADD COLUMN IF NOT EXISTS like_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS dislike_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS edited_at timestamptz,
  ADD COLUMN IF NOT EXISTS hearted_at timestamptz,
  ADD COLUMN IF NOT EXISTS pinned_at timestamptz;

ALTER TABLE public.post_comments
  ADD CONSTRAINT post_comments_reaction_counts_not_negative
    CHECK (like_count >= 0 AND dislike_count >= 0),
  -- Only a top-level comment is pinned: a reply is read under its parent.
  ADD CONSTRAINT post_comments_pin_is_top_level
    CHECK (pinned_at IS NULL OR parent_comment_id IS NULL),
  -- A removed comment shows as "[deleted]": it holds no heart and no pin. The
  -- trigger below clears both in the update that removes it, whichever of the
  -- removal paths that is.
  ADD CONSTRAINT post_comments_marks_only_while_active
    CHECK (status = 'active' OR (pinned_at IS NULL AND hearted_at IS NULL));

CREATE UNIQUE INDEX IF NOT EXISTS post_comments_one_pin_per_post_idx
  ON public.post_comments (post_id)
  WHERE pinned_at IS NOT NULL;

-- `sort=top` now orders by likes, then replies, then recency. The index it
-- had (20260809170000) led with reply_count and can no longer serve it. As
-- before it is partial on the query's own `parent_comment_id IS NULL` and
-- deliberately not narrowed by status: the listing keeps a removed comment
-- while it holds replies, and an index cannot serve half of that OR.
CREATE INDEX IF NOT EXISTS post_comments_toplevel_liked_idx
  ON public.post_comments (post_id, like_count DESC, reply_count DESC, created_at DESC, id DESC)
  WHERE parent_comment_id IS NULL;

DROP INDEX IF EXISTS public.post_comments_toplevel_top_idx;

CREATE OR REPLACE FUNCTION public.clear_post_comment_marks_on_removal()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM 'active' THEN
    NEW.pinned_at := NULL;
    NEW.hearted_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.clear_post_comment_marks_on_removal()
  FROM PUBLIC, anon, authenticated;

-- Every removal sets `status`: the author's and the owner's
-- (set_post_comment_status), a moderator's (resolve_subject_report_for_ops)
-- and an account deletion's (anonymize_post_comments_before_auth_user_delete).
DROP TRIGGER IF EXISTS post_comments_clear_marks_on_removal ON public.post_comments;
CREATE TRIGGER post_comments_clear_marks_on_removal
BEFORE UPDATE OF status ON public.post_comments
FOR EACH ROW
EXECUTE FUNCTION public.clear_post_comment_marks_on_removal();

CREATE TABLE IF NOT EXISTS public.post_comment_reactions (
  comment_id uuid NOT NULL REFERENCES public.post_comments(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reaction text NOT NULL CHECK (reaction IN ('like', 'dislike')),
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  PRIMARY KEY (comment_id, user_id)
);

-- "Which of these comments has this reader reacted to" is asked by comment id
-- with the reader fixed; the primary key leads with the comment.
CREATE INDEX IF NOT EXISTS post_comment_reactions_user_idx
  ON public.post_comment_reactions (user_id, comment_id);

ALTER TABLE public.post_comment_reactions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.post_comment_reactions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.post_comment_reactions TO service_role;

COMMENT ON TABLE public.post_comment_reactions IS
  'Backend-owned: one like or dislike per reader and comment. The comment''s like_count and dislike_count follow it by trigger.';

-- The counts follow the rows by trigger, not inside the function that writes
-- a reaction, because a reaction also goes when its reader's account is
-- deleted (the cascade above), and no function of ours runs then.
CREATE OR REPLACE FUNCTION public.apply_post_comment_reaction_counts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_comment_id uuid;
  v_like_delta integer := 0;
  v_dislike_delta integer := 0;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    v_comment_id := OLD.comment_id;
    IF OLD.reaction = 'like' THEN v_like_delta := v_like_delta - 1; END IF;
    IF OLD.reaction = 'dislike' THEN v_dislike_delta := v_dislike_delta - 1; END IF;
  END IF;

  IF TG_OP <> 'DELETE' THEN
    -- A reaction never moves to another comment: the key is not updated.
    IF TG_OP = 'UPDATE' AND NEW.comment_id IS DISTINCT FROM OLD.comment_id THEN
      RAISE EXCEPTION 'A reaction cannot move to another comment';
    END IF;
    v_comment_id := NEW.comment_id;
    IF NEW.reaction = 'like' THEN v_like_delta := v_like_delta + 1; END IF;
    IF NEW.reaction = 'dislike' THEN v_dislike_delta := v_dislike_delta + 1; END IF;
  END IF;

  IF v_like_delta <> 0 OR v_dislike_delta <> 0 THEN
    -- No row when the comment itself is going (a post's deletion cascades to
    -- its comments and on to their reactions): nothing is left to count on.
    UPDATE public.post_comments AS target
    SET like_count = greatest(0, target.like_count + v_like_delta),
        dislike_count = greatest(0, target.dislike_count + v_dislike_delta)
    WHERE target.id = v_comment_id;
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_post_comment_reaction_counts()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS post_comment_reactions_apply_counts ON public.post_comment_reactions;
CREATE TRIGGER post_comment_reactions_apply_counts
AFTER INSERT OR UPDATE OR DELETE ON public.post_comment_reactions
FOR EACH ROW
EXECUTE FUNCTION public.apply_post_comment_reaction_counts();

-- The words an edit replaced, for an operator reviewing a report. Append-only:
-- a new table is born with the full service_role grant set, so the two that
-- would let a row be rewritten or dropped are taken back. Rows go only with
-- their comment.
CREATE TABLE IF NOT EXISTS public.post_comment_edits (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  comment_id uuid NOT NULL REFERENCES public.post_comments(id) ON DELETE CASCADE,
  previous_body text NOT NULL,
  replaced_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX IF NOT EXISTS post_comment_edits_comment_idx
  ON public.post_comment_edits (comment_id, replaced_at DESC);

ALTER TABLE public.post_comment_edits ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.post_comment_edits FROM PUBLIC, anon, authenticated;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.post_comment_edits FROM service_role;
GRANT SELECT, INSERT ON TABLE public.post_comment_edits TO service_role;

COMMENT ON TABLE public.post_comment_edits IS
  'Backend-owned, append-only: the body each edit of a comment replaced. Read by operators reviewing a report; never sent to a client.';

-- The post a comment sits on still takes comments: public, not archived, not
-- taken down. The same test create_post_comment applies.
CREATE OR REPLACE FUNCTION public.set_post_comment_reaction(
  p_comment_id uuid,
  p_user_id uuid,
  p_reaction text
)
RETURNS TABLE (
  like_count integer,
  viewer_reaction text
) AS $$
DECLARE
  v_status text;
  v_post_id uuid;
  v_like_count integer := 0;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'Missing user id';
  END IF;

  IF p_reaction IS NULL OR p_reaction NOT IN ('like', 'dislike', 'none') THEN
    RAISE EXCEPTION 'Unsupported comment reaction';
  END IF;

  -- The lock orders two presses on one comment: each sees the count the other
  -- left, and the trigger's update of this row waits for nobody.
  SELECT target.status, target.post_id
  INTO v_status, v_post_id
  FROM public.post_comments AS target
  WHERE target.id = p_comment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Comment not found';
  END IF;

  IF v_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'Comment is not available';
  END IF;

  PERFORM 1
  FROM public.posts AS post
  WHERE post.id = v_post_id
    AND post.visibility = 'public'
    AND post.archived_at IS NULL
    AND post.review_status = 'visible';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Post is private or not found';
  END IF;

  IF p_reaction = 'none' THEN
    DELETE FROM public.post_comment_reactions AS reaction
    WHERE reaction.comment_id = p_comment_id
      AND reaction.user_id = p_user_id;
  ELSE
    INSERT INTO public.post_comment_reactions AS reaction (comment_id, user_id, reaction)
    VALUES (p_comment_id, p_user_id, p_reaction)
    ON CONFLICT (comment_id, user_id) DO UPDATE
      SET reaction = EXCLUDED.reaction,
          created_at = timezone('utc'::text, now())
      WHERE reaction.reaction IS DISTINCT FROM EXCLUDED.reaction;
  END IF;

  SELECT target.like_count
  INTO v_like_count
  FROM public.post_comments AS target
  WHERE target.id = p_comment_id;

  RETURN QUERY
  SELECT coalesce(v_like_count, 0),
         CASE WHEN p_reaction = 'none' THEN NULL ELSE p_reaction END;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.edit_post_comment(
  p_comment_id uuid,
  p_actor_user_id uuid,
  p_body text
)
RETURNS TABLE (
  body text,
  edited_at timestamptz,
  changed boolean
) AS $$
DECLARE
  v_body text;
  v_author_user_id uuid;
  v_status text;
  v_post_id uuid;
  v_previous_body text;
  v_edited_at timestamptz;
BEGIN
  v_body := btrim(coalesce(p_body, ''));

  IF v_body = '' THEN
    RAISE EXCEPTION 'Comment body is required';
  END IF;

  IF char_length(v_body) > 2000 THEN
    RAISE EXCEPTION 'Comment body is too long';
  END IF;

  SELECT target.user_id, target.status, target.post_id, target.body, target.edited_at
  INTO v_author_user_id, v_status, v_post_id, v_previous_body, v_edited_at
  FROM public.post_comments AS target
  WHERE target.id = p_comment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Comment not found';
  END IF;

  IF p_actor_user_id IS NULL OR p_actor_user_id IS DISTINCT FROM v_author_user_id THEN
    RAISE EXCEPTION 'Only the comment author can edit this comment';
  END IF;

  IF v_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'Comment is not available';
  END IF;

  PERFORM 1
  FROM public.posts AS post
  WHERE post.id = v_post_id
    AND post.visibility = 'public'
    AND post.archived_at IS NULL
    AND post.review_status = 'visible';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Post is private or not found';
  END IF;

  -- Saving the same words is not an edit: no mark, no history, the heart stays.
  IF v_body = v_previous_body THEN
    RETURN QUERY SELECT v_previous_body, v_edited_at, false;
    RETURN;
  END IF;

  INSERT INTO public.post_comment_edits (comment_id, previous_body)
  VALUES (p_comment_id, v_previous_body);

  UPDATE public.post_comments AS target
  SET body = v_body,
      edited_at = timezone('utc'::text, now()),
      hearted_at = NULL
  WHERE target.id = p_comment_id
  RETURNING target.edited_at INTO v_edited_at;

  RETURN QUERY SELECT v_body, v_edited_at, true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.set_post_comment_heart(
  p_comment_id uuid,
  p_actor_user_id uuid,
  p_hearted boolean
)
RETURNS TABLE (
  hearted boolean
) AS $$
DECLARE
  v_author_user_id uuid;
  v_status text;
  v_post_owner_user_id uuid;
BEGIN
  SELECT target.user_id, target.status, post.user_id
  INTO v_author_user_id, v_status, v_post_owner_user_id
  FROM public.post_comments AS target
  JOIN public.posts AS post ON post.id = target.post_id
  WHERE target.id = p_comment_id
  FOR UPDATE OF target;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Comment not found';
  END IF;

  IF p_actor_user_id IS NULL OR p_actor_user_id IS DISTINCT FROM v_post_owner_user_id THEN
    RAISE EXCEPTION 'Only the post owner can heart this comment';
  END IF;

  IF v_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'Comment is not available';
  END IF;

  -- The heart is the creator's word on someone else's comment.
  IF coalesce(p_hearted, false) AND v_author_user_id IS NOT DISTINCT FROM p_actor_user_id THEN
    RAISE EXCEPTION 'A creator cannot heart their own comment';
  END IF;

  UPDATE public.post_comments AS target
  SET hearted_at = CASE
        WHEN NOT coalesce(p_hearted, false) THEN NULL
        ELSE coalesce(target.hearted_at, timezone('utc'::text, now()))
      END
  WHERE target.id = p_comment_id;

  RETURN QUERY SELECT coalesce(p_hearted, false);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.set_post_comment_pin(
  p_comment_id uuid,
  p_actor_user_id uuid,
  p_pinned boolean
)
RETURNS TABLE (
  pinned boolean,
  unpinned_comment_id uuid
) AS $$
DECLARE
  v_post_id uuid;
  v_post_owner_user_id uuid;
  v_status text;
  v_parent_comment_id uuid;
  v_unpinned_comment_id uuid;
BEGIN
  SELECT target.post_id
  INTO v_post_id
  FROM public.post_comments AS target
  WHERE target.id = p_comment_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Comment not found';
  END IF;

  -- Two pins on one post take turns on an advisory lock named for the post,
  -- so the one pin a post may hold is moved, never contended for. The post's
  -- own row is deliberately not the lock: every other comment write
  -- (create_post_comment, set_post_comment_status, the account-deletion
  -- anonymizer) takes a comment first and the post after, and a pin that held
  -- the post while it waited for a comment would deadlock with a reply to, or
  -- the removal of, the comment being pinned or unpinned.
  PERFORM pg_advisory_xact_lock(hashtextextended('post-comment-pin:post:' || v_post_id::text, 0));

  SELECT post.user_id
  INTO v_post_owner_user_id
  FROM public.posts AS post
  WHERE post.id = v_post_id;

  IF p_actor_user_id IS NULL OR p_actor_user_id IS DISTINCT FROM v_post_owner_user_id THEN
    RAISE EXCEPTION 'Only the post owner can pin this comment';
  END IF;

  -- The comment and the one holding the pin now, locked in id order: a writer
  -- that takes several of a post's comments never meets this one half-way.
  PERFORM 1
  FROM public.post_comments AS held
  WHERE held.id = p_comment_id
     OR (held.post_id = v_post_id AND held.pinned_at IS NOT NULL)
  ORDER BY held.id
  FOR UPDATE;

  SELECT target.status, target.parent_comment_id
  INTO v_status, v_parent_comment_id
  FROM public.post_comments AS target
  WHERE target.id = p_comment_id;

  IF v_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'Comment is not available';
  END IF;

  IF NOT coalesce(p_pinned, false) THEN
    UPDATE public.post_comments AS target
    SET pinned_at = NULL
    WHERE target.id = p_comment_id;

    RETURN QUERY SELECT false, NULL::uuid;
    RETURN;
  END IF;

  IF v_parent_comment_id IS NOT NULL THEN
    RAISE EXCEPTION 'Only a top-level comment can be pinned';
  END IF;

  UPDATE public.post_comments AS previous
  SET pinned_at = NULL
  WHERE previous.post_id = v_post_id
    AND previous.pinned_at IS NOT NULL
    AND previous.id <> p_comment_id
  RETURNING previous.id INTO v_unpinned_comment_id;

  UPDATE public.post_comments AS target
  SET pinned_at = coalesce(target.pinned_at, timezone('utc'::text, now()))
  WHERE target.id = p_comment_id;

  RETURN QUERY SELECT true, v_unpinned_comment_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.set_post_comment_reaction(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.edit_post_comment(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_post_comment_heart(uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_post_comment_pin(uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.set_post_comment_reaction(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.edit_post_comment(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_post_comment_heart(uuid, uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_post_comment_pin(uuid, uuid, boolean) TO service_role;
