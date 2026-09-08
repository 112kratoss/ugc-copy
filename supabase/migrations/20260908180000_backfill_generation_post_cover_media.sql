-- Give every exposed generation-backed post the `post_media` row its public
-- derivative always needed.
--
-- Publishing a generation copies its output into the public `showcase_media`
-- bucket and records the path on `posts.showcase_asset_path`, but wrote no
-- `post_media` row. Every public derivative pipeline — preview, feed rendition,
-- teaser, and the sweeps that repair them — reads `post_media`, so these posts
-- never received a public preview or a smaller playback file. The feed served
-- them through the legacy cover instead, signing the owner's *private* preview
-- on every read (a fresh token each time, which the CDN can never reuse) and
-- handing out the full-size copy where a rendition could exist.
--
-- The rows are written with their derivatives pending; the ten-minute sweeps
-- build them. Nothing regresses while they wait: a cover with no poster still
-- gets the generation's preview grafted on, and a pending rendition keeps the
-- feed poster-only rather than falling back to the source.
--
-- Only the generation's own derivative is ever adopted. `showcase_asset_path`
-- must sit under `showcase/<generation id>/`, which is the same canonical check
-- the application makes before it writes or removes one of these objects, so a
-- path pointing anywhere else is left alone rather than trusted.
--
-- Idempotent: posts that already carry media rows are skipped entirely, so a
-- replay adopts nothing twice and never disturbs a derivative already built.

insert into public.post_media (
  post_id,
  media_key,
  storage_path,
  media_kind,
  content_type,
  original_name,
  sort_order,
  preview_status,
  preview_attempt_count,
  rendition_status,
  rendition_attempt_count
)
select
  candidate.post_id,
  'media-1',
  candidate.storage_path,
  candidate.media_kind,
  candidate.content_type,
  candidate.original_name,
  0,
  'pending',
  0,
  -- Images have nothing to transcode; `skipped` is their terminal state.
  case when candidate.media_kind = 'video' then 'pending' else 'skipped' end,
  0
from (
  select
    posts.id as post_id,
    posts.showcase_asset_path as storage_path,
    split_part(posts.showcase_asset_path, '/', 3) as original_name,
    case
      when posts.showcase_asset_path ~* '\.(mp4|m4v|mov|webm)$' then 'video'
      else 'image'
    end as media_kind,
    case
      when posts.showcase_asset_path ~* '\.mp4$' then 'video/mp4'
      when posts.showcase_asset_path ~* '\.m4v$' then 'video/mp4'
      when posts.showcase_asset_path ~* '\.mov$' then 'video/quicktime'
      when posts.showcase_asset_path ~* '\.webm$' then 'video/webm'
      when posts.showcase_asset_path ~* '\.png$' then 'image/png'
      when posts.showcase_asset_path ~* '\.webp$' then 'image/webp'
      when posts.showcase_asset_path ~* '\.gif$' then 'image/gif'
      else 'image/jpeg'
    end as content_type
  from public.posts
  where posts.generation_id is not null
    and posts.archived_at is null
    -- The derivative only exists while the post is exposed; a private post's
    -- copy has already been removed.
    and posts.visibility in ('public', 'unlisted')
    and posts.showcase_asset_path is not null
    -- The generation's own prefix, and a real object name after it.
    and posts.showcase_asset_path like ('showcase/' || posts.generation_id::text || '/%')
    and split_part(posts.showcase_asset_path, '/', 3) <> ''
    and posts.showcase_asset_path not like '%..%'
    and not exists (
      select 1 from public.post_media existing where existing.post_id = posts.id
    )
    -- Adopt only a derivative that is actually stored: a row pointing at a
    -- missing object would enter the repair sweeps and fail three times.
    and exists (
      select 1
      from storage.objects
      where storage.objects.bucket_id = 'showcase_media'
        and storage.objects.name = posts.showcase_asset_path
    )
) as candidate;
