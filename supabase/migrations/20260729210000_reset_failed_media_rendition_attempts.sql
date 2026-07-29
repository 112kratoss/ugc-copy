-- Requeue media derivatives that could never have succeeded.
--
-- ffmpeg was unreachable in the Vercel serverless runtime: Turbopack bundled
-- ffmpeg-static and inlined its __dirname as "/ROOT/node_modules/ffmpeg-static",
-- so every spawn failed with ENOENT. Each video row burned all three attempts
-- and then fell below the repair sweep's `attempt_count < 3` filter, which is
-- why media-preview-repair has reported "no repairable media" every hour since
-- while zero renditions existed.
--
-- Release ordering is load-bearing: production-release.yml applies migrations
-- before staging the deployment, so this reset lands ahead of the build that
-- externalizes ffmpeg-static, and the first repair window after promotion picks
-- the work up.
--
-- 'processing' is included deliberately. A lambda killed mid-transcode leaves
-- the row there holding its old attempt count, which is the same permanent
-- invisibility trap as 'failed'.
--
-- 'skipped' is deliberately untouched: it is a correct terminal answer (not a
-- video, oversized input, or a rendition no smaller than its source), not a
-- failure to retry.

UPDATE public.post_media
SET rendition_status = 'pending',
    rendition_attempt_count = 0,
    rendition_error = NULL
WHERE media_kind = 'video'
  AND rendition_status IN ('failed', 'processing');

UPDATE public.post_media
SET preview_status = 'pending',
    preview_attempt_count = 0,
    preview_error = NULL
WHERE preview_status IN ('failed', 'processing')
  AND storage_path IS NOT NULL;

UPDATE public.generations
SET preview_status = 'pending',
    preview_attempt_count = 0,
    preview_error = NULL
WHERE preview_status IN ('failed', 'processing')
  AND status = 'succeeded'
  AND output_url IS NOT NULL;
