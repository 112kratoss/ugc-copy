import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(
  path.join(process.cwd(), 'supabase/migrations/20260908180000_backfill_generation_post_cover_media.sql'),
  'utf8'
);

describe('generation post cover media backfill migration', () => {
  it('adopts the derivative as the cover row the public sweeps read', () => {
    expect(migration).toContain('insert into public.post_media');
    expect(migration).toContain('posts.showcase_asset_path as storage_path');
    expect(migration).toContain("'media-1'");
    expect(migration).toContain('posts.generation_id is not null');
  });

  it('leaves the derivatives pending so the existing sweeps build them', () => {
    expect(migration).toContain("'pending'");
    // Images have nothing to transcode; only videos enter the rendition sweep.
    expect(migration).toContain("case when candidate.media_kind = 'video' then 'pending' else 'skipped' end");
  });

  it('falls back to the post category when the extension is unrecognised', () => {
    // Falling back to 'image' would render an <img> at a video file, keep the
    // rendition sweep (media_kind = 'video') from ever claiming it, and feed
    // the file to an image encoder until all three attempts were spent.
    expect(migration).toContain("posts.showcase_asset_path ~* '\\.(mp4|m4v|mov|webm)$' then 'video'");
    expect(migration).toContain("when posts.category in ('video', 'motion', 'ugc-ad') then 'video'");
    expect(migration).toContain("when posts.category in ('video', 'motion', 'ugc-ad') then 'video/mp4'");
  });

  it('adopts only a derivative under the generation’s own prefix', () => {
    expect(migration).toContain("posts.showcase_asset_path like ('showcase/' || posts.generation_id::text || '/%')");
    expect(migration).toContain("posts.showcase_asset_path not like '%..%'");
    expect(migration).toContain("split_part(posts.showcase_asset_path, '/', 3) <> ''");
  });

  it('leaves every path the application would canonicalise differently alone', () => {
    // A percent escape could make the app store a decoded path that no longer
    // equals this one, and it would then repoint the row — clearing its
    // derivatives — on every edit. A backslash would violate
    // post_media_storage_path_safe_check and abort the release.
    expect(migration).toContain("position('%' in posts.showcase_asset_path) = 0");
    expect(migration).toContain("position('\\' in posts.showcase_asset_path) = 0");
    // Exactly three segments, so split_part(..., 3) is the object name and
    // matches the application's `path.split('/').pop()`.
    expect(migration).toContain("split_part(posts.showcase_asset_path, '/', 4) = ''");
  });

  it('follows visibility rather than the archive, which never removes a derivative', () => {
    expect(migration).toContain("posts.visibility in ('public', 'unlisted')");
    expect(migration).toContain('posts.showcase_asset_path is not null');
    // Archiving leaves the public copy in place, so an archived post excluded
    // here would return from the archive with nothing to heal it.
    expect(migration).not.toContain('posts.archived_at is null');
  });

  it('never adopts a path with no stored object behind it', () => {
    // A row pointing at a missing object would enter the repair sweeps and
    // burn all three attempts before giving up.
    expect(migration).toContain("where storage.objects.bucket_id = 'showcase_media'");
    expect(migration).toContain('storage.objects.name = posts.showcase_asset_path');
  });

  it('is replayable and cannot abort the release on a race', () => {
    expect(migration).toContain('not exists (');
    expect(migration).toContain('from public.post_media existing where existing.post_id = posts.id');
    // A publish writing the same row between the snapshot and the insert would
    // otherwise raise 23505 and fail the whole production release.
    expect(migration).toContain('on conflict (post_id, media_key) do nothing');
  });
});
