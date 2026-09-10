-- A second image size, between the 720px preview and the original.
--
-- The preview exists for grids, where 720px is the right size and 25 KB is the
-- right cost. A full-screen viewer needs more, so it reached past the preview
-- and loaded the source: 1.19 MB on average for a stored generation, 2.17 MB
-- for a published showcase copy, up to 7.9 MB. Images were 48% of a day's
-- Storage bytes that way — more than every video kind together — and the
-- 25 KB preview sat unused behind a blur.
--
-- `display_storage_path` holds a 1440px WebP, 150–300 KB, which covers a 3x
-- phone with room for a pinch. The original is untouched and stays the
-- download and zoom target.
--
-- The column is nullable and stays null whenever a display rendition is not
-- worth storing: a source already at or below the display size, or one WebP
-- cannot meaningfully shrink. Every reader falls back to the source in that
-- case, which is exactly what it did before this column existed, so nothing
-- depends on it being populated.
--
-- Scope: published post media, which is the shared half — every viewer of a
-- showcase post pays for its cover. Private creations reach the viewer through
-- `generations.preview_url`, whose write path runs through the settlement RPC
-- and three status services; giving them the same treatment is a separate
-- change, and is recorded as such in the media delivery plan.

ALTER TABLE public.post_media
  ADD COLUMN IF NOT EXISTS display_storage_path text;

-- The same traversal guard the preview and rendition paths carry.
ALTER TABLE public.post_media
  DROP CONSTRAINT IF EXISTS post_media_display_storage_path_safe_check;
ALTER TABLE public.post_media
  ADD CONSTRAINT post_media_display_storage_path_safe_check
  CHECK (
    display_storage_path IS NULL
    OR (
      display_storage_path NOT LIKE '%..%'
      AND display_storage_path !~ '[\\]'
      AND display_storage_path !~ '^/'
    )
  ) NOT VALID;
ALTER TABLE public.post_media
  VALIDATE CONSTRAINT post_media_display_storage_path_safe_check;

-- Existing rows are filled by `scripts/backfill-media-display-renditions.ts`
-- rather than here: building one means downloading and re-encoding every image
-- source, which is work for a bounded, resumable job and not for a migration
-- that blocks a release. New media gets its display rendition from the preview
-- writer, which now emits both from one decode.
--
-- Deliberately NOT done here: resetting `preview_status` to make the repair
-- sweep rebuild these. A row with a stored preview but a non-ready status
-- reports `gridReady: false`, and the mobile showcase drops non-gridReady
-- posts from its grid — the backfill would have blanked the feed while it ran.
