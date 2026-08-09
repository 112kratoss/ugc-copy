-- F9: cover the `sort=top` comment ordering.
--
-- The top-level comment list orders by `reply_count DESC, created_at DESC,
-- id DESC` within a post, and `post_comments` had no index reaching
-- `reply_count` at all — only `post_comments_toplevel_idx (post_id,
-- created_at DESC) WHERE parent_comment_id IS NULL`, which serves the default
-- recency sort. So `sort=top` read every top-level comment on the post and
-- sorted it in memory, and the visible-comment scan could repeat that per
-- batch.
--
-- The partial predicate matches the query's own `parent_comment_id IS NULL`,
-- so replies stay out of the index entirely; they are served by
-- `post_comments_parent_idx`.
--
-- Deliberately *not* narrowed by status. The listing filters
-- `status = 'active' OR reply_count > 0` — a removed comment stays in the
-- thread while it still holds replies, so the conversation underneath it does
-- not disappear. Folding that disjunction into the index predicate would make
-- the index unusable for the half of the OR it excluded, and Postgres cannot
-- match a partial index against a predicate broader than its own.

CREATE INDEX IF NOT EXISTS post_comments_toplevel_top_idx
  ON public.post_comments (post_id, reply_count DESC, created_at DESC, id DESC)
  WHERE parent_comment_id IS NULL;
