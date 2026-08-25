import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import {
  getWelcomeCreditsRouteResponse,
  postWelcomeCreditsClaimRouteResponse,
} from '@/lib/onboarding-route-adapter-service';

function queryResult(data: unknown) {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn(async () => ({ data, error: null })),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  return query;
}

describe('onboarding route adapter service', () => {
  it('returns the camel-case welcome-credit contract after an atomic claim', async () => {
    const user = {
      id: '4f65b4aa-2ac5-4f35-9291-5cc663fe7f0d',
      created_at: '2026-07-13T15:00:00.000Z',
    };
    const program = queryResult({
      program_key: 'welcome_credits_v1',
      amount: 25,
      promotional_amount: 25,
      enabled: true,
      activated_at: '2026-07-13T14:00:00.000Z',
    });
    const grant = queryResult({
      amount: 25,
      promotional_amount: 25,
      credits_balance_after: 50,
      promotional_credits_balance_after: 25,
      claimed_at: '2026-07-13T15:01:00.000Z',
    });
    const profile = queryResult({
      credits: 50,
      promotional_credits: 25,
      username: 'new-creator',
      display_name: 'New Creator',
    });
    const rpc = vi.fn(async () => ({
      data: { status: 'claimed', promotional_amount: 25 },
      error: null,
    }));
    const admin = {
      from: vi.fn((table: string) => {
        if (table === 'credit_grant_programs') return program;
        if (table === 'credit_grants') return grant;
        if (table === 'profiles') return profile;
        throw new Error(`Unexpected table: ${table}`);
      }),
      rpc,
    } as unknown as SupabaseClient;
    const userClient = {
      auth: {
        getUser: vi.fn(async () => ({ data: { user }, error: null })),
      },
    } as unknown as SupabaseClient;

    const response = await postWelcomeCreditsClaimRouteResponse({
      request: new Request('https://app.example/api/credits/welcome/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceSurface: 'mobile' }),
      }),
      dependencies: {
        createUserClient: vi.fn(() => userClient),
        createServiceClient: vi.fn(() => admin),
        enforceBackendRateLimit: vi.fn(async () => ({
          allowed: true,
          limit: 10,
          remaining: 9,
          retryAfterSeconds: 0,
          resetAt: '2026-07-13T15:02:00.000Z',
        })),
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({
      programKey: 'welcome_credits_v1',
      status: 'claimed',
      amount: 25,
      promotionalAmount: 25,
      credits: 50,
      promotionalCredits: 25,
      claimedAt: '2026-07-13T15:01:00.000Z',
      identityComplete: true,
    });
    expect(rpc).toHaveBeenCalledWith('claim_credit_grant_program', {
      p_user_id: user.id,
      p_program_key: 'welcome_credits_v1',
      p_source_surface: 'mobile',
    });
  });

  it('refuses a guest, even one that has set a username', async () => {
    // The faucet this closes: anonymous sign-in is free and unlimited, and the
    // eligibility rule reads "identity claimed" (real username + display name)
    // as a proxy for "registered". PATCH /api/profile accepts any valid JWT,
    // and a guest has one, so the proxy was bypassable —
    //   signInAnonymously -> set username -> claim -> 25 credits -> generate
    // repeatable on every fresh session. Anonymity is now checked directly.
    const guest = {
      id: '9c2f0a5e-7c1b-4a6e-9f3a-2b8d4e6f1a20',
      created_at: '2026-08-11T10:00:00.000Z',
      is_anonymous: true,
    };
    const rpc = vi.fn();
    const createServiceClient = vi.fn();
    const enforceBackendRateLimit = vi.fn();
    const userClient = {
      auth: {
        getUser: vi.fn(async () => ({ data: { user: guest }, error: null })),
      },
    } as unknown as SupabaseClient;

    const response = await postWelcomeCreditsClaimRouteResponse({
      request: new Request('https://app.example/api/credits/welcome/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceSurface: 'mobile' }),
      }),
      dependencies: {
        createUserClient: vi.fn(() => userClient),
        createServiceClient,
        enforceBackendRateLimit,
      },
    });

    expect(response.status).toBe(403);
    // `requires_account`, not `not_eligible`: the latter is the "finish your
    // creator name" state, and a guest cannot finish it — PATCH /api/profile
    // rejects anonymous callers too, so that copy pointed at a locked door.
    await expect(response.json()).resolves.toMatchObject({ status: 'requires_account' });
    // Rejected before the service-role client is even built, so a scripted
    // attempt cannot burn the rate limiter or reach the RPC.
    expect(rpc).not.toHaveBeenCalled();
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(enforceBackendRateLimit).not.toHaveBeenCalled();
  });

  it('reports requires_account from the status endpoint, not not_eligible', async () => {
    // The status endpoint and the claim endpoint disagreed: the claim checked
    // is_anonymous, the status check did not, so a guest was told to finish a
    // creator name it can never set. Both now answer the same way.
    const guest = {
      id: '4a1f7c8e-2d3b-4e5f-8a9c-1b2d3e4f5a6b',
      created_at: '2026-08-12T10:00:00.000Z',
      is_anonymous: true,
    };
    const program = queryResult({
      program_key: 'welcome_credits_v1',
      amount: 25,
      promotional_amount: 25,
      enabled: true,
      activated_at: '2026-08-11T00:00:00.000Z',
    });
    // No grant row, and the placeholder identity every guest carries: under the
    // old ordering this fell through to the identity check and read
    // `not_eligible`.
    const grant = queryResult(null);
    const profile = queryResult({
      credits: 0,
      promotional_credits: 0,
      username: 'creator-4a1f7c8e',
      display_name: null,
    });
    const admin = {
      from: vi.fn((table: string) => {
        if (table === 'credit_grant_programs') return program;
        if (table === 'credit_grants') return grant;
        if (table === 'profiles') return profile;
        throw new Error(`Unexpected table: ${table}`);
      }),
    } as unknown as SupabaseClient;
    const userClient = {
      auth: { getUser: vi.fn(async () => ({ data: { user: guest }, error: null })) },
    } as unknown as SupabaseClient;

    const response = await getWelcomeCreditsRouteResponse({
      request: new Request('https://app.example/api/credits/welcome'),
      dependencies: {
        createUserClient: vi.fn(() => userClient),
        createServiceClient: vi.fn(() => admin),
        enforceBackendRateLimit: vi.fn(),
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'requires_account' });
  });
});
