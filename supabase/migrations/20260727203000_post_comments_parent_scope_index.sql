-- Cover the composite self-reference used to keep replies on the same post.
-- The existing parent/created_at index serves reply pagination; this index
-- separately supports foreign-key checks and cascades on (comment, post).
CREATE INDEX IF NOT EXISTS post_comments_parent_scope_idx
  ON public.post_comments (parent_comment_id, post_id);
