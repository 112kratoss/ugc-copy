import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/server-auth-user', () => ({
  getVerifiedAuthUserResult: vi.fn(async () => ({
    data: { user: { id: 'creator-1', is_anonymous: false } },
    error: null,
  })),
}));

import { createCreatorPayoutsRouteHandlers } from '@/lib/creator-payouts-route-adapter-service';

function routeWith() {
  const requestCreatorPayout = vi.fn(async () => ({
    ok: true as const,
    requestId: 'request-1',
    amountTokenSubunits: 1_500_000,
  }));
  const handlers = createCreatorPayoutsRouteHandlers({
    dependencies: {
      createUserClient: vi.fn(() => ({}) as unknown as SupabaseClient),
      createServiceClient: vi.fn(() => ({}) as unknown as SupabaseClient),
      // Under the limit; the route reads nothing from the answer.
      enforceBackendRateLimit: vi.fn(async () => undefined as never),
      requestCreatorPayout,
      logError: vi.fn(),
    },
  });
  const post = (body: Record<string, unknown>) => handlers.POST(new Request('https://magicbooklet.test/api/creator/payouts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
  return { post, requestCreatorPayout };
}

// Decision 7 (2026-10-17): payouts are sent by hand in INR to a UPI id or an
// Indian bank account; PayPal and international transfers are not offered yet.
describe('POST /api/creator/payouts', () => {
  it.each(['upi', 'bank_transfer'])('takes a %s request for the caller', async (payoutMethod) => {
    const { post, requestCreatorPayout } = routeWith();

    const response = await post({ payoutMethod, payoutDetails: 'creator@upi' });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true, requestId: 'request-1', amountTokenSubunits: 1_500_000 });
    expect(requestCreatorPayout).toHaveBeenCalledWith(expect.objectContaining({ userId: 'creator-1', payoutMethod }));
  });

  it('answers PayPal with "coming soon" and stores nothing', async () => {
    const { post, requestCreatorPayout } = routeWith();

    const response = await post({ payoutMethod: 'paypal', payoutDetails: 'creator@example.com' });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'PayPal payouts are coming soon. Choose UPI or an Indian bank transfer.',
      code: 'METHOD_UNAVAILABLE',
    });
    expect(requestCreatorPayout).not.toHaveBeenCalled();
  });

  it.each([['international_transfer'], ['crypto'], [null]])('refuses the unknown method %j', async (payoutMethod) => {
    const { post, requestCreatorPayout } = routeWith();

    const response = await post({ payoutMethod, payoutDetails: 'creator@upi' });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Choose how you want to be paid.', code: 'INVALID_METHOD' });
    expect(requestCreatorPayout).not.toHaveBeenCalled();
  });
});
