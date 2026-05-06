ALTER TABLE public.posts
  DROP CONSTRAINT IF EXISTS posts_source_kind_check;

ALTER TABLE public.posts
  ADD CONSTRAINT posts_source_kind_check
    CHECK (source_kind IN ('emptybooklet', 'ugc_copy', 'external', 'manual'));

UPDATE public.posts
SET source_kind = 'emptybooklet'
WHERE source_kind = 'ugc_copy';

ALTER TABLE public.post_deletion_audits
  DROP CONSTRAINT IF EXISTS post_deletion_audits_source_kind_check;

ALTER TABLE public.post_deletion_audits
  ADD CONSTRAINT post_deletion_audits_source_kind_check
    CHECK (source_kind IN ('emptybooklet', 'ugc_copy', 'external', 'manual'));

UPDATE public.post_deletion_audits
SET source_kind = 'emptybooklet'
WHERE source_kind = 'ugc_copy';
