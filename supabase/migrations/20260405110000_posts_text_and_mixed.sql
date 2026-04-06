ALTER TABLE public.posts
  ADD COLUMN IF NOT EXISTS post_format text,
  ADD COLUMN IF NOT EXISTS body text;

UPDATE public.posts
SET post_format = 'media'
WHERE post_format IS NULL;

ALTER TABLE public.posts
  ALTER COLUMN post_format SET DEFAULT 'media',
  ALTER COLUMN post_format SET NOT NULL;

ALTER TABLE public.posts
  DROP CONSTRAINT IF EXISTS posts_category_check,
  DROP CONSTRAINT IF EXISTS posts_source_kind_check,
  DROP CONSTRAINT IF EXISTS posts_post_format_check,
  DROP CONSTRAINT IF EXISTS posts_public_surface_check;

ALTER TABLE public.posts
  ADD CONSTRAINT posts_category_check
    CHECK (category IN ('image', 'video', 'motion', 'ugc-ad', 'text')),
  ADD CONSTRAINT posts_source_kind_check
    CHECK (source_kind IN ('ugc_copy', 'external', 'manual')),
  ADD CONSTRAINT posts_post_format_check
    CHECK (post_format IN ('text', 'media', 'mixed')),
  ADD CONSTRAINT posts_public_surface_check
    CHECK (
      (post_format = 'text' AND body IS NOT NULL AND btrim(body) <> '')
      OR (
        post_format = 'media'
        AND category IN ('image', 'video', 'motion', 'ugc-ad')
        AND (showcase_asset_path IS NOT NULL OR output_url IS NOT NULL)
      )
      OR (
        post_format = 'mixed'
        AND category IN ('image', 'video', 'motion', 'ugc-ad')
        AND body IS NOT NULL
        AND btrim(body) <> ''
        AND (showcase_asset_path IS NOT NULL OR output_url IS NOT NULL)
      )
    );
