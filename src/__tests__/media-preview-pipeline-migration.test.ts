import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { BACKEND_JOBS_BY_NAME } from '@/lib/backend-jobs';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260619133531_media_preview_pipeline.sql'
), 'utf8');

describe('media preview pipeline migration', () => {
  it('adds derivative state and ThumbHash metadata to both media stores', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS preview_thumbhash text');
    expect(migration).toContain("preview_status text NOT NULL DEFAULT 'pending'");
    expect(migration).toContain('preview_attempt_count integer NOT NULL DEFAULT 0');
    expect(migration).toContain("preview_attempt_count BETWEEN 0 AND 3");
    expect(migration).toContain('generations_preview_repair_idx');
    expect(migration).toContain('post_media_preview_repair_idx');
    expect(migration).toContain("preview_status = 'pending'");
  });

  it('migrates legacy presentation categories while preserving motion workflow metadata', () => {
    expect(migration).toContain("SET creation_mode = 'motion', category = 'video'");
    expect(migration).toContain("generations_category_check CHECK (category IN ('image', 'video', 'audio'))");
    expect(migration).toContain("posts_category_check CHECK (category IN ('image', 'video', 'text'))");
  });

  it('keeps repair covered by the shared low-cost backend job orchestrator', () => {
    const vercel = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'vercel.json'), 'utf8'));
    expect(vercel.crons).toContainEqual({
      path: '/api/cron/backend-jobs',
      schedule: '*/10 * * * *',
    });
    expect(BACKEND_JOBS_BY_NAME['media-preview-repair']).toMatchObject({
      route: '/api/cron/media-preview-repair',
      schedule: '0 * * * *',
      cadenceMinutes: 60,
    });
  });
});
