import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const sql = readFileSync('supabase/migrations/20261005190934_read_latest_provider_check_per_model.sql', 'utf8');
describe('latest provider check lookup migration', () => {
  it('keeps per-model history private and resolves timestamp ties', () => {
    expect(sql).toContain('SECURITY INVOKER');
    expect(sql).toContain("SET search_path = ''");
    expect(sql).toContain('checks.release_id = entry.release_id AND checks.model_id = entry.model_id');
    expect(sql).toContain('ORDER BY checks.checked_at DESC, checks.id DESC');
    expect(sql).toContain('FROM PUBLIC, anon, authenticated');
    expect(sql).toContain('TO service_role');
  });
});
