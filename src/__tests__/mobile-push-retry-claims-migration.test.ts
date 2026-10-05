import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const sql = readFileSync('supabase/migrations/20261005031821_fence_mobile_push_retry_attempts.sql', 'utf8');
describe('push retry claim migration', () => {
  it('adds service-only invoker functions with a fixed search path', () => {
    expect(sql.match(/SECURITY INVOKER SET search_path = ''/g)).toHaveLength(3);
    for (const signature of ['claim_mobile_push_retry(uuid, integer)', 'finish_mobile_push_retry(uuid, uuid)', 'record_mobile_push_retry_outcome(uuid, uuid, jsonb)']) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${signature} FROM PUBLIC, anon, authenticated`);
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${signature} TO service_role`);
    }
  });
});
