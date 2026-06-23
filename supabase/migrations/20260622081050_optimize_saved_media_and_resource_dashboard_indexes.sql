-- Keep personalized saved-media pages and seller resource dashboards cheap as
-- users accumulate more saves/listings. These are additive indexes only.
CREATE INDEX IF NOT EXISTS post_saves_user_created_post_idx
  ON public.post_saves (user_id, created_at DESC, post_id);

CREATE INDEX IF NOT EXISTS showcase_saves_user_created_generation_idx
  ON public.showcase_saves (user_id, created_at DESC, generation_id);

CREATE INDEX IF NOT EXISTS post_resource_bundles_owner_created_idx
  ON public.post_resource_bundles (owner_user_id, created_at DESC, id DESC);
