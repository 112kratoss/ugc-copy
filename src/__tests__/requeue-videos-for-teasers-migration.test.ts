import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  path.join(process.cwd(), 'supabase/migrations/20260813121000_requeue_videos_for_teasers.sql'),
  'utf8',
);

describe('requeue videos for teasers migration', () => {
  it('requeues only exhausted video rows that still lack a teaser', () => {
    expect(migration).toContain("rendition_status IN ('failed', 'processing')");
    expect(migration).toContain("media_kind = 'video'");
    expect(migration).toContain('teaser_storage_path IS NULL');
  });

  it('resets the attempt counter so the sweep can see the rows again', () => {
    expect(migration).toContain("rendition_status = 'pending'");
    expect(migration).toContain('rendition_attempt_count = 0');
    expect(migration).toContain('rendition_error = NULL');
  });

  it('leaves ready and skipped rows alone', () => {
    // 'skipped' is a correct terminal verdict, and requeuing 'ready' long
    // videos just to add teasers would redo their full renditions.
    expect(migration).not.toMatch(/IN \([^)]*'ready'/);
    expect(migration).not.toMatch(/IN \([^)]*'skipped'/);
    // Exactly one UPDATE: this reset must not touch previews or generations.
    expect(migration.match(/UPDATE public\./g)).toHaveLength(1);
  });
});
