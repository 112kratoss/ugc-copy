import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync('supabase/migrations/20261007174934_retain_referral_history_on_account_deletion.sql', 'utf8');
describe('referral account deletion migration safety', () => {
  it('preserves append-only guards and denies public access to trigger functions', () => {
    expect(sql).toContain("RAISE EXCEPTION 'referral audit rows are append-only'");
    expect(sql).toContain("(to_jsonb(NEW) - 'user_id' - 'detached_user_id')");
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM auth.users WHERE id = OLD.user_id)');
    for (const name of ['retain_referral_account_identity', 'cancel_deleted_account_referrals', 'prevent_referral_audit_mutation']) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${name}() FROM PUBLIC, anon, authenticated, service_role`);
    }
    expect(sql).not.toMatch(/DISABLE TRIGGER|session_replication_role/i);
  });
});
