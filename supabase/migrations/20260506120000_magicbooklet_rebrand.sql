ALTER TABLE public.posts
  DROP CONSTRAINT IF EXISTS posts_source_kind_check;

ALTER TABLE public.posts
  ADD CONSTRAINT posts_source_kind_check
    CHECK (source_kind IN ('magicbooklet', 'emptybooklet', 'ugc_copy', 'external', 'manual'));

UPDATE public.posts
SET
  source_kind = CASE
    WHEN source_kind IN ('emptybooklet', 'ugc_copy') THEN 'magicbooklet'
    ELSE source_kind
  END,
  source_tool = CASE
    WHEN source_kind IN ('emptybooklet', 'ugc_copy')
      OR lower(coalesce(source_tool, '')) = 'emptybooklet'
      OR lower(coalesce(source_tool_slug, '')) = 'emptybooklet'
    THEN 'magicbooklet'
    ELSE source_tool
  END,
  source_tool_slug = CASE
    WHEN source_kind IN ('emptybooklet', 'ugc_copy')
      OR lower(coalesce(source_tool, '')) = 'emptybooklet'
      OR lower(coalesce(source_tool_slug, '')) = 'emptybooklet'
    THEN 'magicbooklet'
    ELSE source_tool_slug
  END
WHERE source_kind IN ('emptybooklet', 'ugc_copy')
   OR lower(coalesce(source_tool, '')) = 'emptybooklet'
   OR lower(coalesce(source_tool_slug, '')) = 'emptybooklet';

ALTER TABLE public.post_deletion_audits
  DROP CONSTRAINT IF EXISTS post_deletion_audits_source_kind_check;

ALTER TABLE public.post_deletion_audits
  ADD CONSTRAINT post_deletion_audits_source_kind_check
    CHECK (source_kind IN ('magicbooklet', 'emptybooklet', 'ugc_copy', 'external', 'manual'));

UPDATE public.post_deletion_audits
SET
  source_kind = CASE
    WHEN source_kind IN ('emptybooklet', 'ugc_copy') THEN 'magicbooklet'
    ELSE source_kind
  END
WHERE source_kind IN ('emptybooklet', 'ugc_copy');
