import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const sql = readFileSync('supabase/migrations/20261004000000_atomic_workflow_share_import_count.sql','utf8');
describe('workflow share import counter migration', () => {
  it('increments the current persisted count and returns the written value', () => {
    expect(sql).toContain('SET import_count = import_count + 1');
    expect(sql).toContain('WHERE id = p_share_id');
    expect(sql).toContain('RETURNING import_count');
  });
  it('restricts the invoker function to service role with an empty search path', () => {
    expect(sql).toContain('SECURITY INVOKER');
    expect(sql).toContain("SET search_path = ''");
    expect(sql).toContain('FROM PUBLIC, anon, authenticated');
    expect(sql).toContain('TO service_role');
  });
});
