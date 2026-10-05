import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const sql = readFileSync('supabase/migrations/20261005170739_track_empty_interest_refreshes.sql', 'utf8');
describe('empty interest refresh progress migration', () => {
  it('keeps progress private, tied to account lifetime and separate from interest dimensions', () => {
    expect(sql).toContain('REFERENCES auth.users(id) ON DELETE CASCADE');
    expect(sql).toContain('ALTER TABLE public.user_interest_refresh_state ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE ON TABLE public.user_interest_refresh_state TO service_role');
    expect(sql).toContain('SECURITY INVOKER');
    expect(sql).toContain('SELECT user_id, clock_timestamp() FROM unnest(v_user_ids)');
  });
});
