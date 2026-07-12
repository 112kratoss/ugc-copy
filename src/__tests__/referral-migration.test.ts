import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260712123000_invite_and_earn_referrals.sql'),
  'utf8',
);

describe('Invite & Earn migration contract', () => {
  it('versions the 5%/5% offer with a 30-day attribution window', () => {
    expect(sql).toContain("VALUES (1, 'Invite & Earn', 'active', 500, 500, 30)");
    expect(sql).toContain("CHECK (code ~ '^[a-z0-9]{8,24}$')");
  });

  it('allows only new accounts and preserves immutable first-touch attribution', () => {
    expect(sql).toContain('IF v_auth_created_at < v_visit.visited_at THEN');
    expect(sql).toContain('invitee_user_id uuid NOT NULL UNIQUE');
    expect(sql).toContain('referral_visit_id uuid NOT NULL UNIQUE');
    expect(sql).toContain('referral code identity is immutable');
  });

  it('uses durable verified-purchase ordering for the one-time friend bonus', () => {
    expect(sql).toContain('credit_purchase_succeeded_at');
    expect(sql).toContain('ORDER BY transactions.credit_purchase_succeeded_at ASC, transactions.id ASC');
    expect(sql).toContain('referral_rewards_one_invitee_bonus_idx');
  });

  it('isolates promotional credits from marketplace spend and restores exact creation sources', () => {
    expect(sql).toContain('least(v_credits, v_credits - v_promotional_credits)');
    expect(sql).toContain('generations_reserve_promotional_credits');
    expect(sql).toContain('generations_restore_promotional_credits');
    expect(sql).toContain('ai_usage_events_restore_promotional_credits');
    expect(sql).toContain('settle_generation_start_failed');
  });

  it('atomically reconciles cumulative provider refunds and referral rewards', () => {
    expect(sql).toContain('reconcile_credit_purchase_adjustment');
    expect(sql).toContain("v_action = 'reverse'");
    expect(sql).toContain("RETURN jsonb_build_object('status', 'stale_event'");
    expect(sql).toContain('credit_purchase_adjustments_append_only');
    expect(sql).toContain('reconcile_mobile_credit_purchase_adjustment');
  });

  it('keeps referral tables and mutation RPCs behind the service role', () => {
    for (const table of [
      'referral_codes',
      'referral_visits',
      'referral_attributions',
      'referral_rewards',
      'referral_credit_ledger',
      'credit_purchase_adjustments',
    ]) {
      expect(sql).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
      expect(sql).toContain(`REVOKE ALL ON public.${table} FROM PUBLIC, anon, authenticated`);
    }
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.claim_referral_visit(uuid, uuid) TO service_role');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.settle_referral_purchase_rewards(uuid) TO service_role');
  });
});
