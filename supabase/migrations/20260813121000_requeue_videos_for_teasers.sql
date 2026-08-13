-- Requeue rendition-failed videos now that the teaser pipeline exists.
--
-- Before teasers, a long video burned its three attempts against the 120s
-- ffmpeg timeout and then streamed its RAW SOURCE in the feed forever (the
-- renditionUrl ?? url fallback) — the exact egress amplifier the teaser
-- pipeline closes. Those exhausted rows sit below the sweep's
-- `attempt_count < 3` filter, permanently invisible.
--
-- Resetting them is now productive rather than a retry storm: the worker
-- encodes the 8s teaser BEFORE the full rendition, so even when the full
-- transcode times out again, the attempt secures the teaser and the feed
-- stops falling back to the source. Rows that already own a teaser are
-- excluded — content-hashed teasers never go stale.
--
-- 'processing' is included for the same reason as 20260729210000: a lambda
-- killed mid-transcode leaves the row there holding its old attempt count.
--
-- 'ready' long videos are deliberately NOT requeued just to add teasers: the
-- sweep would redo their full renditions, and the feed already streams their
-- bounded 720p/1.4Mbps copy.
--
-- Release ordering is load-bearing: production-release.yml applies migrations
-- before staging the deployment, so this reset lands together with the teaser
-- columns and ahead of the worker build that fills them.

UPDATE public.post_media
SET rendition_status = 'pending',
    rendition_attempt_count = 0,
    rendition_error = NULL
WHERE media_kind = 'video'
  AND rendition_status IN ('failed', 'processing')
  AND teaser_storage_path IS NULL;
