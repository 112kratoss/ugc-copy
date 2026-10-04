import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync('supabase/migrations/20261004121413_serialize_follow_block_relationships.sql', 'utf8');

describe('follow/block concurrency migration', () => {
  it('preserves private definer functions and service-only trigger execution grants', () => {
    for (const name of ['reject_blocked_user_follow', 'remove_follows_for_user_block']) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${name}() FROM PUBLIC, anon, authenticated`);
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${name}() TO service_role`);
    }
    expect(sql.match(/SECURITY DEFINER\nSET search_path = ''/g)).toHaveLength(2);
  });
});
