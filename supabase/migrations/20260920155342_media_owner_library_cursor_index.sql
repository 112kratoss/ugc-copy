-- The owner library includes archived rows. The archive-prefixed index cannot
-- deliver that combined library in date order. Saves already have matching
-- (user_id, created_at DESC, reference_id ASC) indexes; reuse those.
CREATE INDEX IF NOT EXISTS posts_owner_created_id_idx
  ON public.posts (user_id, created_at DESC, id DESC);
