-- Let a video's poster live beside the video it was cut from.
--
-- `buildGenerationPreviewPath` derives a poster's object path from the source's,
-- so the poster for `generated_videos/<user>/clip.mp4` is
-- `generated_videos/<user>/clip.preview.<hash>.webp` — an `image/webp` inside a
-- bucket that 20260726071722_harden_data_api_and_storage_contract.sql restricted
-- to video mime types. Every video poster written after that migration was
-- rejected with "mime type image/webp is not supported", so a finished video
-- kept its clip and lost its thumbnail. The last video poster to land was
-- 2026-05-16; the hardening shipped 2026-07-26; the next video, on 2026-09-03,
-- had no poster.
--
-- Only `image/webp` is added, not the image set the upload buckets carry: the
-- poster encoder emits webp and nothing else writes images here, so the bucket
-- stays as narrow as the pipeline that uses it.
UPDATE storage.buckets
SET allowed_mime_types = ARRAY[
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-m4v',
  'image/webp'
]::text[]
WHERE id = 'generated_videos';
