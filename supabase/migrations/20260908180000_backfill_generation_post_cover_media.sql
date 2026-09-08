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
-- This selection is deliberately NARROWER than the canonical path check the
-- application makes (`getCanonicalGenerationShowcaseAssetPath`, which
-- percent-decodes and rejects encoded separators, control characters,
-- backslashes and traversal). Reproducing that decoder in SQL would risk
-- disagreeing with it; instead anything it could interpret differently is left
-- for the application to adopt on the post's next publish or exposure change:
--
--   * `%` is excluded outright — the app stores the *decoded* path, so for an
--     escaped name the two could write different strings for the same object,
--     and the app would then repoint the row (clearing its derivatives) on
--     every edit forever.
--   * `\` is excluded — it would violate `post_media_storage_path_safe_check`
--     and abort the whole release.
--   * exactly three segments are required, so `split_part(..., 3)` below is the
--     object name, matching the app's `path.split('/').pop()`. Every path the
--     copier writes has exactly three.
--
-- Media kind follows the file extension first and the post's category second,
-- mirroring `inferShowcaseContentType`. Falling back to 'image' instead would
-- turn a video with an unrecognised extension into an image row: the card
-- would render an <img> at a video file, the rendition sweep (which requires
-- media_kind = 'video') would never claim it, and the preview sweep would feed
-- it to an image encoder three times and give up.
--
-- Idempotent: posts that already carry media rows are skipped, and the insert
-- takes no conflict, so a replay adopts nothing twice and a publish racing this
-- migration cannot abort the release.

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
      when posts.showcase_asset_path ~* '\.(png|jpg|jpeg|webp|gif)$' then 'image'
      -- The extension is unrecognised, so the post's own category decides,
      -- the same fallback `inferShowcaseContentType` makes.
      when posts.category in ('video', 'motion', 'ugc-ad') then 'video'
      else 'image'
    end as media_kind,
    case
      when posts.showcase_asset_path ~* '\.(mp4|m4v)$' then 'video/mp4'
      when posts.showcase_asset_path ~* '\.mov$' then 'video/quicktime'
      when posts.showcase_asset_path ~* '\.webm$' then 'video/webm'
      when posts.showcase_asset_path ~* '\.png$' then 'image/png'
      when posts.showcase_asset_path ~* '\.webp$' then 'image/webp'
      when posts.showcase_asset_path ~* '\.gif$' then 'image/gif'
      when posts.showcase_asset_path ~* '\.(jpg|jpeg)$' then 'image/jpeg'
      when posts.category in ('video', 'motion', 'ugc-ad') then 'video/mp4'
      else 'image/jpeg'
    end as content_type
  from public.posts
  where posts.generation_id is not null
    -- The derivative exists for as long as the post is not private, whether or
    -- not it is archived: only the private transition removes it. An archived
    -- post left out here would come back from the archive on the legacy cover
    -- path with nothing to heal it.
    and posts.visibility in ('public', 'unlisted')
    and posts.showcase_asset_path is not null
    -- The generation's own prefix, exactly three segments, and none of the
    -- characters the application's canonical decoder would treat differently.
    and posts.showcase_asset_path like ('showcase/' || posts.generation_id::text || '/%')
    and split_part(posts.showcase_asset_path, '/', 3) <> ''
    and split_part(posts.showcase_asset_path, '/', 4) = ''
    and posts.showcase_asset_path not like '%..%'
    and position('%' in posts.showcase_asset_path) = 0
    and position('\' in posts.showcase_asset_path) = 0
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
) as candidate
-- A publish or caption edit racing this migration writes the same row; losing
-- that race must not fail the release.
on conflict (post_id, media_key) do nothing;
