import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync('supabase/migrations/20261004114652_maintain_post_save_counters.sql', 'utf8');

describe('post save counter migration', () => {
  it('keeps both RPCs service-only and the cleanup function unavailable for direct calls', () => {
    for (const signature of ['set_post_save_state(uuid, uuid, boolean)', 'toggle_post_save(uuid, uuid)']) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${signature} FROM PUBLIC, anon, authenticated`);
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${signature} TO service_role`);
    }
    expect(sql).toContain("SECURITY DEFINER\nSET search_path = ''");
    expect(sql).toContain('FROM PUBLIC, anon, authenticated, service_role');
  });

  it('binds the cleanup trigger to Auth deletion and does not overwrite historical counts', () => {
    expect(sql).toContain('BEFORE DELETE ON auth.users');
    expect(sql).toContain('WHERE user_id = OLD.id');
    expect(sql).toContain('SET save_count = greatest(0, save_count - removed.count)');
  });
});
