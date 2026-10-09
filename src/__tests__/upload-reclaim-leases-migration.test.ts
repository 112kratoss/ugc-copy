import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('closes reservation admission without releasing byte capacity or weakening access', () => {
  const sql = readFileSync('supabase/migrations/20261009030218_fence_media_upload_reclaim_consumption_leases.sql', 'utf8');
  expect(sql).toContain('public.lock_upload_owner(v_intent.user_id)');
  expect(sql).toContain('FOR UPDATE');
  expect(sql).toContain('consumption_outcome_unknown_at IS NOT NULL');
  expect(sql).toContain("SET finalization_status = 'deleted'");
  expect(sql).toContain('FROM PUBLIC, anon, authenticated');
  expect(sql).not.toMatch(/SET\s+released_at|DISABLE\s+TRIGGER/i);
});
