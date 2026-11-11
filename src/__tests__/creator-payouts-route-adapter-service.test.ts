import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/server-auth-user', () => ({
  getVerifiedAuthUserResult: vi.fn(async () => ({
    data: { user: { id: 'creator-1', is_anonymous: false } },
    error: null,
  })),
}));

vi.mock('@/lib/creator-payout-details-crypto', () => ({
  encryptCreatorPayoutDetails: vi.fn((plain: string) => `sealed:${plain.length}`),
}));

import { createCreatorPayoutsRouteHandlers } from '@/lib/creator-payouts-route-adapter-service';

import mobileApiContract from '../../contracts/mobile-api-v1.json';

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

// The app files its payout through this route (owner, 2026-11-11), so the answer
// and every refusal are pinned under `requestCreatorPayout` in
// contracts/mobile-api-v1.json, which the app's suite reads too. The real
// service runs here against a stand-in for the database's RPC.
describe('POST /api/creator/payouts against the mobile contract', () => {
  const endpoint = mobileApiContract.endpoints.requestCreatorPayout;

  function contractRoute(rpcAnswer: Record<string, unknown>) {
    const rpc = vi.fn(async () => ({ data: rpcAnswer, error: null }));
    const handlers = createCreatorPayoutsRouteHandlers({
      dependencies: {
        createUserClient: vi.fn(() => ({}) as unknown as SupabaseClient),
        createServiceClient: vi.fn(() => ({ rpc }) as unknown as SupabaseClient),
        enforceBackendRateLimit: vi.fn(async () => undefined as never),
        logError: vi.fn(),
      },
    });
    const post = (body: unknown) => handlers.POST(new Request(`https://magicbooklet.test${endpoint.path}`, {
      method: endpoint.method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));
    return { post, rpc };
  }

  it('answers a request in the shape the contract pins', async () => {
    const { post, rpc } = contractRoute({
      status: 'requested',
      request_id: endpoint.response.requestId,
      amount_token_subunits: endpoint.response.amountTokenSubunits,
    });

    const response = await post(endpoint.request);

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe(endpoint.cacheControl);
    await expect(response.json()).resolves.toEqual(endpoint.response);
    expect(rpc).toHaveBeenCalledWith('request_creator_payout', expect.objectContaining({
      p_user_id: 'creator-1',
      p_payout_method: endpoint.request.payoutMethod,
    }));
  });

  it.each([
    ['belowMinimum', { status: 'below_minimum' }, endpoint.request],
    ['alreadyPending', { status: 'already_pending' }, endpoint.request],
    ['invalidMethod', { status: 'requested' }, { ...endpoint.request, payoutMethod: 'crypto' }],
    ['methodUnavailable', { status: 'requested' }, { ...endpoint.request, payoutMethod: 'paypal' }],
    ['invalidDetails', { status: 'requested' }, { ...endpoint.request, payoutDetails: ' ' }],
    ['invalidDetails', { status: 'requested' }, { ...endpoint.request, payoutDetails: 'x'.repeat(501) }],
  ] as const)('answers %s in the contract\'s words', async (key, rpcAnswer, body) => {
    const refusal = endpoint.errors[key];
    const { post } = contractRoute(rpcAnswer);

    const response = await post(body);

    expect(response.status).toBe(refusal.status);
    await expect(response.json()).resolves.toEqual(refusal.response);
  });
});
