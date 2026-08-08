-- Align already-stored public showcase objects with the one-day cache policy.
--
-- `cacheControl` is object metadata written at upload time, so changing
-- SHOWCASE_PUBLIC_MEDIA_CACHE_CONTROL only affects new writes. Without this
-- pass the existing objects keep whatever TTL was in force the day they landed,
-- and the code change looks like it did nothing.
--
-- Production at the time of writing held three generations of policy in one
-- bucket, which is why this moves objects in both directions:
--
--   max-age=31536000  60 objects, all content-hashed derivatives, 2026-06-14
--                     to 2026-07-16 -- back when derivatives were treated as
--                     immutable. A year is longer than moderation can accept,
--                     so these move DOWN.
--   max-age=3600      29 objects, all originals, from supabase-js's default
--                     when no cacheControl was passed. These move UP.
--   max-age=300       10 objects, written after the 300s constant landed on
--                     2026-07-29. These move UP.
--
-- Rewriting metadata rather than re-uploading is deliberate: every public path
-- in this bucket is write-once, so the bytes and the ETag are already correct
-- and only the header needs to change. Re-uploading 615 MB to alter a header
-- would also churn every object's version for no benefit.
--
-- Supabase's CDN may keep serving a previously cached Cache-Control until its
-- own entry expires, so the effect on an object already in a CDN edge is not
-- instant. New edges and browser fetches pick it up immediately.

update storage.objects
set metadata = jsonb_set(
      metadata,
      '{cacheControl}',
      to_jsonb('max-age=86400'::text),
      true
    )
where bucket_id = 'showcase_media'
  and coalesce(metadata->>'cacheControl', '') is distinct from 'max-age=86400';
