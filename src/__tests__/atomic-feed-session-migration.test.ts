import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('atomic feed-session persistence migration', () => {
  it('keeps the privileged bounded operation atomic without elevating privileges', () => {
    const sql = fs.readFileSync(path.resolve('supabase/migrations/20260922054500_atomic_feed_session.sql'), 'utf8');
    expect(sql).toContain('SECURITY INVOKER');
    expect(sql).toContain('SET search_path = public, pg_temp');
    expect(sql).toContain('jsonb_array_length(p_items) NOT BETWEEN 1 AND 60');
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION[\s\S]*FROM PUBLIC, anon, authenticated/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION[\s\S]*TO service_role/);
    expect(sql).not.toMatch(/EXCEPTION\s+WHEN/i);
    expect(sql).toContain('WHERE i.served_at IS NOT NULL');
    expect(sql).toContain("'id', id::text");
  });
});
