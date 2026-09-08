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

  it('classifies video by the stored file rather than the post category', () => {
    expect(migration).toContain("posts.showcase_asset_path ~* '\\.(mp4|m4v|mov|webm)$' then 'video'");
    expect(migration).toContain("posts.showcase_asset_path ~* '\\.mp4$' then 'video/mp4'");
  });

  it('adopts only a derivative under the generation’s own prefix', () => {
    // The same canonical check the application makes before it writes or
    // removes one of these objects.
    expect(migration).toContain("posts.showcase_asset_path like ('showcase/' || posts.generation_id::text || '/%')");
    expect(migration).toContain("posts.showcase_asset_path not like '%..%'");
    expect(migration).toContain("split_part(posts.showcase_asset_path, '/', 3) <> ''");
  });

  it('skips posts whose derivative is already gone or was never exposed', () => {
    expect(migration).toContain("posts.visibility in ('public', 'unlisted')");
    expect(migration).toContain('posts.archived_at is null');
    expect(migration).toContain('posts.showcase_asset_path is not null');
  });

  it('never adopts a path with no stored object behind it', () => {
    // A row pointing at a missing object would enter the repair sweeps and
    // burn all three attempts before giving up.
    expect(migration).toContain("where storage.objects.bucket_id = 'showcase_media'");
    expect(migration).toContain('storage.objects.name = posts.showcase_asset_path');
  });

  it('is replayable, because it skips any post that already has media rows', () => {
    expect(migration).toContain('not exists (');
    expect(migration).toContain('from public.post_media existing where existing.post_id = posts.id');
  });
});
