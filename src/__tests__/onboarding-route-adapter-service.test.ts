import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import {
  getWelcomeCreditsRouteResponse,
  patchOnboardingStateRouteResponse,
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

describe('persisting onboarding state', () => {
  const user = {
    id: '28677503-bfbe-4e99-9105-b8f0c7e0e507',
    created_at: '2026-03-25T14:45:00.000Z',
    is_anonymous: false,
  };

  /**
   * A `mobile_onboarding_states` table stub that records what was upserted.
   *
   * The existing `queryResult` helper only covers `select/eq/maybeSingle`; the
   * PATCH path also reads the current row and then writes through
   * `upsert().select().single()`.
   */
  function patchHarness(existing: unknown, profile: unknown = { username: 'batman', display_name: 'Sassy23b' }) {
    const upsert = vi.fn();
    const states = {
      select: vi.fn(),
      eq: vi.fn(),
      maybeSingle: vi.fn(async () => ({ data: existing, error: null })),
      upsert,
      single: vi.fn(async () => ({ data: existing, error: null })),
    };
    states.select.mockReturnValue(states);
    states.eq.mockReturnValue(states);
    upsert.mockReturnValue(states);
    const admin = {
      from: vi.fn((table: string) => {
        if (table === 'mobile_onboarding_states') return states;
        if (table === 'profiles') return queryResult(profile);
        throw new Error(`Unexpected table: ${table}`);
      }),
      rpc: vi.fn(async () => ({ data: null, error: null })),
    } as unknown as SupabaseClient;
    const userClient = {
      auth: { getUser: vi.fn(async () => ({ data: { user }, error: null })) },
    } as unknown as SupabaseClient;
    return { upsert, admin, userClient };
  }

  function patchRequest(body: Record<string, unknown>) {
    return new Request('https://app.example/api/onboarding/state', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  function dependencies(harness: ReturnType<typeof patchHarness>) {
    return {
      createUserClient: vi.fn(() => harness.userClient),
      createServiceClient: vi.fn(() => harness.admin),
      enforceBackendRateLimit: vi.fn(async () => ({
        allowed: true, limit: 30, remaining: 29, retryAfterSeconds: 0,
        resetAt: '2026-08-28T07:00:00.000Z',
      })),
    };
  }

  it('never demotes a finished run', async () => {
    // The production row this pins: `completed_at` was written, then an
    // `in_progress` PATCH one second later walked the status back — so the app
    // re-offered onboarding to someone who had already finished it.
    const harness = patchHarness({
      status: 'completed',
      completed_at: '2026-08-28T06:50:51.761Z',
      username_completed_at: '2026-08-16T08:27:09.326Z',
    });
    const response = await patchOnboardingStateRouteResponse({
      request: patchRequest({ status: 'in_progress', goal: 'image' }),
      dependencies: dependencies(harness),
    });

    expect(response.status).toBe(200);
    expect(harness.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed', completed_at: '2026-08-28T06:50:51.761Z' }),
      expect.anything(),
    );
  });

  it('treats a completion stamp as final even when the stored status disagrees', async () => {
    const harness = patchHarness({
      status: 'in_progress',
      completed_at: '2026-08-28T06:50:51.761Z',
      username_completed_at: null,
    });
    await patchOnboardingStateRouteResponse({
      request: patchRequest({ status: 'skipped' }),
      dependencies: dependencies(harness),
    });

    expect(harness.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed' }),
      expect.anything(),
    );
  });

  it('does not demote an existing row through a goal-only update', async () => {
    // `body.status ?? 'in_progress'` meant a PATCH that carried nothing but a
    // goal still rewrote the status, so simply opening the flow undid progress.
    const harness = patchHarness({
      status: 'skipped', completed_at: null, username_completed_at: null,
    });
    await patchOnboardingStateRouteResponse({
      request: patchRequest({ goal: 'video' }),
      dependencies: dependencies(harness),
    });

    expect(harness.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'skipped', goal: 'video' }),
      expect.anything(),
    );
  });

  it('keeps the moment the handle was actually claimed', async () => {
    // This was unconditionally `now`, so every later PATCH overwrote the claim
    // time with the timestamp of the most recent write.
    const harness = patchHarness({
      status: 'in_progress', completed_at: null,
      username_completed_at: '2026-08-16T08:27:09.326Z',
    });
    await patchOnboardingStateRouteResponse({
      request: patchRequest({ goal: 'image' }),
      dependencies: dependencies(harness),
    });

    expect(harness.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ username_completed_at: '2026-08-16T08:27:09.326Z' }),
      expect.anything(),
    );
  });

  it('stamps completion the first time a run finishes', async () => {
    const harness = patchHarness(null);
    await patchOnboardingStateRouteResponse({
      request: patchRequest({ status: 'completed', goal: 'image' }),
      dependencies: dependencies(harness),
    });

    const [payload] = harness.upsert.mock.calls[0] as [Record<string, unknown>];
    expect(payload.status).toBe('completed');
    expect(typeof payload.completed_at).toBe('string');
  });
});
