import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import {
  ADMIN_CREDIT_ADJUSTMENT_MAX,
  applyAdminCreditAdjustment,
  planAdminCreditAdjustment,
  validateAdminCreditAdjustment,
} from '@/lib/admin-credit-adjustment-service';

const USER_ID = '3f1b7c2e-6d4a-4f8b-9c1d-2a5e7b9f0c31';
const REVIEWER_ID = 'b2c4d6e8-1a3b-4c5d-8e7f-90a1b2c3d4e5';

function createClient(response: unknown, capture?: { args?: Record<string, unknown> }) {
  return {
    rpc: vi.fn((_fn: string, args: Record<string, unknown>) => {
      if (capture) capture.args = args;
      return Promise.resolve({ data: response, error: null });
    }),
  } as unknown as SupabaseClient;
}

describe('credit adjustment policy', () => {
  it('routes goodwill to promotional credits so granted value stays out of refund math', () => {
    expect(planAdminCreditAdjustment({
      userId: USER_ID, intent: 'goodwill', amount: 500, reason: 'ok',
    })).toEqual({ creditsDelta: 0, promotionalCreditsDelta: 500 });
  });

  it('routes a refund to purchased credits so the user gets back what they paid for', () => {
    // Promotional is spent first and never refunded out, so a refund sent there
    // would under-return the purchase.
    expect(planAdminCreditAdjustment({
      userId: USER_ID, intent: 'refund', amount: 500, reason: 'ok',
    })).toEqual({ creditsDelta: 500, promotionalCreditsDelta: 0 });
  });

  it('makes a clawback negative and confines it to promotional credits', () => {
    // The console can only grant into promotional, so clawback undoes a console
    // grant. Reversing a real payment belongs to the reconciliation RPC, which
    // also updates the provider-side transaction record.
    expect(planAdminCreditAdjustment({
      userId: USER_ID, intent: 'clawback', amount: 250, reason: 'ok',
    })).toEqual({ creditsDelta: 0, promotionalCreditsDelta: -250 });
  });

  it('never touches both balances in one adjustment', () => {
    for (const intent of ['goodwill', 'refund', 'clawback'] as const) {
      const plan = planAdminCreditAdjustment({ userId: USER_ID, intent, amount: 100, reason: 'ok' });
      const touched = [plan.creditsDelta, plan.promotionalCreditsDelta].filter((delta) => delta !== 0);
      expect(touched, `${intent} should move exactly one balance`).toHaveLength(1);
    }
  });
});

describe('credit adjustment validation', () => {
  const base = { userId: USER_ID, intent: 'goodwill' as const, amount: 100, reason: 'ticket 42' };

  it('accepts a well-formed request', () => {
    expect(validateAdminCreditAdjustment(base)).toBeNull();
  });

  it('rejects a non-UUID user id', () => {
    expect(validateAdminCreditAdjustment({ ...base, userId: 'nope' })).toMatch(/UUID/);
  });

  it('rejects non-positive, fractional, and oversized amounts', () => {
    expect(validateAdminCreditAdjustment({ ...base, amount: 0 })).toMatch(/positive whole number/);
    expect(validateAdminCreditAdjustment({ ...base, amount: -5 })).toMatch(/positive whole number/);
    expect(validateAdminCreditAdjustment({ ...base, amount: 1.5 })).toMatch(/positive whole number/);
    expect(validateAdminCreditAdjustment({ ...base, amount: Number.NaN })).toMatch(/positive whole number/);
    // A cap means an accidental extra zero cannot quietly mint a fortune.
    expect(validateAdminCreditAdjustment({ ...base, amount: ADMIN_CREDIT_ADJUSTMENT_MAX + 1 }))
      .toMatch(/or fewer per adjustment/);
    expect(validateAdminCreditAdjustment({ ...base, amount: ADMIN_CREDIT_ADJUSTMENT_MAX })).toBeNull();
  });

  it('requires a usable reason', () => {
    expect(validateAdminCreditAdjustment({ ...base, reason: '  ' })).toMatch(/Reason/);
    expect(validateAdminCreditAdjustment({ ...base, reason: 'ab' })).toMatch(/Reason/);
    expect(validateAdminCreditAdjustment({ ...base, reason: 'x'.repeat(1001) })).toMatch(/Reason/);
  });
});

describe('applying a credit adjustment', () => {
  it('sends the planned deltas and the session reviewer id to the RPC', async () => {
    const capture: { args?: Record<string, unknown> } = {};
    const client = createClient(
      { status: 'applied', adjustment_id: 'adj-1', credits: 100, promotional_credits: 500 },
      capture,
    );

    const result = await applyAdminCreditAdjustment(client, {
      userId: USER_ID,
      intent: 'goodwill',
      amount: 500,
      reason: '  ticket 42  ',
      reviewerId: REVIEWER_ID,
      idempotencyKey: 'key-1',
    });

    expect(capture.args).toMatchObject({
      p_user_id: USER_ID,
      p_reviewer_id: REVIEWER_ID,
      p_credits_delta: 0,
      p_promotional_credits_delta: 500,
      p_reason: 'ticket 42',
      p_idempotency_key: 'key-1',
    });
    expect(result).toEqual({
      status: 'applied',
      adjustmentId: 'adj-1',
      credits: 100,
      promotionalCredits: 500,
      error: null,
    });
  });

  it('rejects an invalid request before reaching the database', async () => {
    const client = createClient({ status: 'applied' });

    const result = await applyAdminCreditAdjustment(client, {
      userId: USER_ID,
      intent: 'goodwill',
      amount: -1,
      reason: 'ticket 42',
      reviewerId: REVIEWER_ID,
    });

    expect(result.status).toBe('invalid');
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('surfaces a replayed adjustment as already_applied rather than a second write', async () => {
    const client = createClient({
      status: 'already_applied',
      adjustment_id: 'adj-1',
      credits: 100,
      promotional_credits: 500,
    });

    const result = await applyAdminCreditAdjustment(client, {
      userId: USER_ID,
      intent: 'goodwill',
      amount: 500,
      reason: 'ticket 42',
      reviewerId: REVIEWER_ID,
      idempotencyKey: 'key-1',
    });

    expect(result.status).toBe('already_applied');
    expect(result.adjustmentId).toBe('adj-1');
  });

  it('generates an idempotency key when the caller omits one', async () => {
    const capture: { args?: Record<string, unknown> } = {};
    const client = createClient({ status: 'applied' }, capture);

    await applyAdminCreditAdjustment(client, {
      userId: USER_ID,
      intent: 'refund',
      amount: 10,
      reason: 'ticket 42',
      reviewerId: REVIEWER_ID,
    });

    expect(typeof capture.args?.p_idempotency_key).toBe('string');
    expect(String(capture.args?.p_idempotency_key).length).toBeGreaterThan(0);
  });

  it('reports a missing user without inventing a balance', async () => {
    const client = createClient({ status: 'not_found' });

    const result = await applyAdminCreditAdjustment(client, {
      userId: USER_ID,
      intent: 'goodwill',
      amount: 10,
      reason: 'ticket 42',
      reviewerId: REVIEWER_ID,
    });

    expect(result).toMatchObject({ status: 'not_found', credits: null, promotionalCredits: null });
  });
});
