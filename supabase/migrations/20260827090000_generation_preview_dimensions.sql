-- Record the pixel size of a generation's stored preview, so the showcase feed
-- can send an aspect ratio for covers that predate `post_media`.
--
-- The mobile showcase is a masonry grid: every card's height comes from its
-- media's aspect ratio. When the payload carries no dimensions the client lays
-- the card out at a placeholder height and measures the image itself
-- afterwards, which rewrites the card's height — and the column beneath it —
-- while the reader is looking at it. Apple's Collections guidance asks the
-- opposite: "avoid changing the layout while people are viewing and interacting
-- with it, unless it's in response to an explicit action."
--
-- Every `post_media` row already carries width and height, so modern posts are
-- unaffected. The gap is the handful of public posts that predate `post_media`
-- and have no row there: `buildLegacyPostMediaItems` synthesises their cover,
-- and `showcase-feed` grafts the linked generation's preview URL onto it —
-- the URL, but nothing about its shape, because `generations` had nowhere to
-- record one.
--
-- These columns describe the STORED PREVIEW, not the source output. That is
-- deliberate and is why they are named for it: the preview is a `fit: inside`
-- resize of the source, so it is faithful on ratio and smaller in absolute
-- terms, and it is the artefact a backfill can measure for a few kilobytes
-- instead of re-downloading full-resolution originals. Aspect ratio is the only
-- thing the grid asks of them.
--
-- Existing rows are filled by `npm run backfill:generation-preview-dimensions`,
-- which measures the preview already in storage. Run it AFTER this migration
-- reaches an environment: until it does, those rows stay null and the client
-- falls back to measuring the image itself, which is where it already was.
-- New previews record their size as they are written, in the repair job.
--
-- No grant changes. `generations` deliberately exposes only a narrow column
-- list to `authenticated` (the resume columns); a new column is not part of a
-- column-level grant, so it stays service-role-only, which is where the
-- showcase feed reads it from.

ALTER TABLE public.generations
  ADD COLUMN IF NOT EXISTS preview_width integer,
  ADD COLUMN IF NOT EXISTS preview_height integer;

COMMENT ON COLUMN public.generations.preview_width IS
  'Pixel width of the stored preview image (not the source output). Feeds the showcase grid''s aspect ratio for covers with no post_media row.';

COMMENT ON COLUMN public.generations.preview_height IS
  'Pixel height of the stored preview image (not the source output). Feeds the showcase grid''s aspect ratio for covers with no post_media row.';
