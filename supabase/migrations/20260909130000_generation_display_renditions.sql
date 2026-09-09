-- The display size for private creations: the half of F3 that migration
-- 20260909070000 left open.
--
-- That migration gave published post media a 1440px WebP between the 720px
-- preview and the source, and measured the result at 95.7% fewer bytes per
-- open. It stopped at `post_media` because private creations reach the viewer
-- through `generations`, whose preview is written by the settlement RPC and
-- the repair sweep rather than by one preview writer.
--
-- The exposure is the same shape and larger: a creator opens their own library
-- far more often than a stranger opens the feed, and until now every one of
-- those opens downloaded the original — 1.2 MB on average, 7.9 MB at the top.
--
-- `display_url` is named to sit beside `preview_url`. Both hold a storage path
-- (`generated_images/<owner>/…`) despite the name, because that is what
-- `preview_url` has always held; a third convention would be worse than a
-- misnomer shared consistently. The object lives in the same private bucket as
-- the preview and is signed the same way, under the owner prefix.
--
-- Nullable and null whenever a display rendition is not worth storing — a
-- source already at or below the display size, or one WebP cannot shrink by a
-- quarter. Every reader falls back to the source, exactly as it did before the
-- column existed, so nothing depends on it being populated.
--
-- Deliberately NOT written by `settle_generation_succeeded`. That RPC owns the
-- single-effect credit decision, and its 33 pgTAP assertions are the proof.
-- A display rendition is a cache with a fallback; it is recorded by a
-- conditioned follow-up write after settlement and by the repair sweep, and
-- rows either misses are filled by `npm run backfill:generation-display-renditions`.

ALTER TABLE public.generations
  ADD COLUMN IF NOT EXISTS display_url text;

-- The same traversal guard `post_media.display_storage_path` carries.
ALTER TABLE public.generations
  DROP CONSTRAINT IF EXISTS generations_display_url_safe_check;
ALTER TABLE public.generations
  ADD CONSTRAINT generations_display_url_safe_check
  CHECK (
    display_url IS NULL
    OR (
      display_url NOT LIKE '%..%'
      AND display_url !~ '[\\]'
      AND display_url !~ '^/'
    )
  ) NOT VALID;
ALTER TABLE public.generations
  VALIDATE CONSTRAINT generations_display_url_safe_check;
