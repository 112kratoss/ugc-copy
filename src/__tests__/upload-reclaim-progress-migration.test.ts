import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('orders upload reclaim by operational scan history without changing original age', () => {
  const sql = readFileSync('supabase/migrations/20261008142924_rotate_checked_upload_reclaim_candidates.sql', 'utf8');
  expect(sql).toContain('GENERATED ALWAYS AS (coalesce(reclaim_checked_at, created_at)) STORED');
  expect(sql).toContain('WHERE storage_cleared_at IS NULL');
  expect(sql).not.toMatch(/UPDATE public.media_upload_intents|GRANT|DISABLE/i);
});
