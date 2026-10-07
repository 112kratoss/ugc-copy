import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const sql = readFileSync('supabase/migrations/20261007150522_referral_reward_notification_outbox.sql', 'utf8');
describe('referral notification recovery migration', () => {
  it('queues only newly committed financial events behind service-only entrypoints', () => {
    expect(sql).toContain('AFTER INSERT ON public.referral_credit_ledger');
    expect(sql).toContain('ALTER TABLE public.referral_reward_notification_outbox ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('FROM PUBLIC, anon, authenticated, service_role');
    expect(sql).toContain('GRANT SELECT ON public.referral_reward_notification_outbox TO service_role');
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.deliver_referral_reward_notifications(integer, text) FROM PUBLIC, anon, authenticated');
  });
  it('atomically records history, deferred push work and completion with bounded isolation', () => {
    expect(sql).toContain('LIMIT p_limit FOR UPDATE OF q SKIP LOCKED');
    expect(sql).toContain('WHERE completed_at IS NULL');
    expect(sql).toContain('ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING');
    expect(sql).toContain('INSERT INTO public.mobile_push_deliveries');
    expect(sql).toContain('last_error_code = SQLSTATE');
  });
});
