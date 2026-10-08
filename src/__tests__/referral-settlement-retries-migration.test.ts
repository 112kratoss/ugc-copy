import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('keeps referral retry metadata private and preserves the existing settlement selector', () => {
  const sql = readFileSync('supabase/migrations/20261008030002_defer_failed_referral_purchase_settlements.sql', 'utf8');
  expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
  expect(sql).toContain('REVOKE ALL ON TABLE public.referral_purchase_reconciliation_retries FROM PUBLIC, anon, authenticated, service_role');
  expect(sql).toContain('AFTER INSERT ON public.referral_purchase_events');
  expect(sql).toContain('Expected one settlement selection join and filter');
  expect(sql).not.toMatch(/DISABLE TRIGGER|session_replication_role/i);
});
