import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(
  path.join(process.cwd(), 'supabase/migrations/20260729210000_reset_failed_media_rendition_attempts.sql'),
  'utf8'
);

describe('reset failed media rendition attempts migration', () => {
  it('requeues failed video renditions with a cleared attempt count', () => {
    expect(migration).toContain('UPDATE public.post_media');
    expect(migration).toContain("SET rendition_status = 'pending'");
    expect(migration).toContain('rendition_attempt_count = 0');
    expect(migration).toContain('rendition_error = NULL');
    expect(migration).toContain("media_kind = 'video'");
  });

  it('requeues failed previews on both post_media and generations', () => {
    expect(migration).toContain("SET preview_status = 'pending'");
    expect(migration).toContain('preview_attempt_count = 0');
    expect(migration).toContain('preview_error = NULL');
    expect(migration).toContain('UPDATE public.generations');
    expect(migration).toContain("status = 'succeeded'");
  });

  it('rescues rows stranded mid-transcode, not just failed ones', () => {
    // A lambda killed while transcoding leaves 'processing' holding its old
    // attempt count, which is the same permanent-invisibility trap as 'failed'.
    const requeuedStates = migration.match(/IN \('failed', 'processing'\)/g) ?? [];
    expect(requeuedStates).toHaveLength(3);
  });

  it("never requeues 'skipped', which is a correct terminal answer", () => {
    // 'skipped' means not a video, oversized, or no smaller than the source.
    // Re-queueing it would loop the repair sweep on work that cannot succeed.
    expect(migration).not.toMatch(/SET rendition_status = 'skipped'/);
    expect(migration).not.toMatch(/IN \([^)]*'skipped'[^)]*\)/);
  });
});
