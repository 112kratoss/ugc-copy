import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('keeps standalone teaser claims bounded and service-only without requeueing full video playback', () => {
  const sql = readFileSync('supabase/migrations/20260905201219_repair_ready_video_teasers.sql', 'utf8');
  expect(sql).toMatch(/for update of pm skip locked/i);
  expect(sql).toContain('teaser_attempt_count = pm.teaser_attempt_count + 1');
  expect(sql).toContain('33554432');
  expect(sql).toContain("interval '5 minutes'");
  expect(sql).toMatch(/revoke all on function .* from public, anon, authenticated/i);
  expect(sql).toMatch(/grant execute on function .* to service_role/i);
  expect(sql).not.toMatch(/security definer|set rendition_status/i);
});
