import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';

const validBlueprintInput = {
  brandName: 'Magic Booklet',
  productName: 'Creator Kit',
  audience: 'UGC creators',
  objective: 'ugc-ad',
  primaryMessage: 'Create polished launch videos faster',
  offer: 'Try it today',
  callToAction: 'Start creating',
  visualStyle: 'clean studio',
  tone: 'confident',
  aspectRatio: '9:16',
  durationSeconds: 20,
  platform: 'TikTok',
};

function createUserClient(user: { id: string } | null = { id: 'user-1' }) {
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user },
        error: user ? null : new Error('missing session'),
      })),
    },
  };
}

function createAdminClient({ rateLimitAllowed = true } = {}) {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const updates: Record<string, unknown>[] = [];

  return {
    rpcCalls,
    updates,
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });

      if (fn === 'check_backend_rate_limit') {
        return {
          data: {
            allowed: rateLimitAllowed,
            limit: 30,
            remaining: rateLimitAllowed ? 29 : 0,
            retryAfterSeconds: rateLimitAllowed ? 0 : 42,
            resetAt: '2026-06-22T07:00:00.000Z',
          },
          error: null,
        };
      }

      if (fn === 'start_ai_usage_event') {
        return {
          data: {
            status: 'started',
            event_id: 'event-1',
            remaining_credits: 94,
            cost: args.p_cost,
          },
          error: null,
        };
      }

      if (fn === 'refund_ai_usage_event') {
        return { data: true, error: null };
      }

      if (fn === 'settle_ai_usage_event') {
        return {
          data: {
            status: args.p_outcome,
            settled: true,
            event_id: args.p_event_id,
            remaining_credits: 94,
          },
          error: null,
        };
      }

      throw new Error(`Unexpected rpc: ${fn}`);
    }),
    from: vi.fn((table: string) => {
      if (table !== 'ai_usage_events') {
        throw new Error(`Unexpected table access: ${table}`);
      }

      return {
        update(record: Record<string, unknown>) {
          updates.push(record);
          return {
            async eq() {
              return { error: null };
            },
          };
        },
      };
    }),
  };
}

function createProviderResponse(content: unknown) {
  return new Response(JSON.stringify({
    choices: [{
      message: {
        content: JSON.stringify(content),
      },
    }],
  }), { status: 200 });
}

describe('workflow blueprint service', () => {
  let createAdminSupabase: Mock<() => unknown>;
  let createUserSupabase: Mock<() => unknown>;
  let providerFetch: ReturnType<typeof vi.fn>;
  let adminClient: ReturnType<typeof createAdminClient>;

  beforeEach(() => {
    adminClient = createAdminClient();
    createAdminSupabase = vi.fn(() => adminClient);
    createUserSupabase = vi.fn(() => createUserClient());
    providerFetch = vi.fn(async () => createProviderResponse({
      title: 'Launch workflow',
      creativeStrategy: 'Open with the pain point and show the solution.',
      hook: 'Stop wasting time on scattered tools.',
      narrative: 'Problem, product, result, CTA.',
      voiceover: 'Create launch content faster.',
      editingNotes: ['Keep captions clear.'],
      assetChecklist: ['Product still'],
      shots: [{
        id: 'shot-1',
        title: 'Product reveal',
        purpose: 'Introduce the kit',
        beat: 'Creator opens the app',
        visualPrompt: 'Clean product still',
        videoPrompt: 'Creator launches the tool',
        motionPrompt: 'Smooth confident motion',
        duration: 5,
      }],
      deliveryPlan: {
        primaryModel: 'kling-3.0-video',
        stillImageModel: 'nano-banana-pro',
        motionModel: 'kling-3.0',
        recommendedSequence: ['Generate stills', 'Create video'],
      },
    }));
  });

  it('authenticates before parsing JSON or creating privileged clients', async () => {
    createUserSupabase.mockReturnValueOnce(createUserClient(null));
    const { planWorkflowBlueprintForRoute } = await import('@/lib/workflow-blueprint-service');
    const readRequestBody = vi.fn(async () => {
      throw new Error('body should not be read');
    });

    const result = await planWorkflowBlueprintForRoute({
      createAdminSupabase,
      createUserSupabase,
      kieApiKey: undefined,
      providerFetch,
      readRequestBody,
      request: new Request('http://localhost/api/workflow-blueprint'),
    });

    expect(result).toEqual({
      ok: false,
      body: { error: 'Unauthorized' },
      status: 401,
    });
    expect(readRequestBody).not.toHaveBeenCalled();
    expect(createAdminSupabase).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('rejects invalid inputs before privileged clients, charging, or provider work', async () => {
    const { planWorkflowBlueprintForRoute } = await import('@/lib/workflow-blueprint-service');

    const result = await planWorkflowBlueprintForRoute({
      createAdminSupabase,
      createUserSupabase,
      kieApiKey: 'kie-key',
      providerFetch,
      readRequestBody: async () => ({
        productName: 'Creator Kit',
        audience: '',
        primaryMessage: 'Create polished launch videos faster',
      }),
      request: new Request('http://localhost/api/workflow-blueprint'),
    });

    expect(result).toEqual({
      ok: false,
      body: { error: 'Product name, audience, and primary message are required.' },
      status: 400,
    });
    expect(createAdminSupabase).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('maps Supabase-backed rate limits before charging or provider work', async () => {
    adminClient = createAdminClient({ rateLimitAllowed: false });
    createAdminSupabase.mockReturnValueOnce(adminClient);
    const { planWorkflowBlueprintForRoute } = await import('@/lib/workflow-blueprint-service');

    const result = await planWorkflowBlueprintForRoute({
      createAdminSupabase,
      createUserSupabase,
      kieApiKey: 'kie-key',
      providerFetch,
      readRequestBody: async () => validBlueprintInput,
      request: new Request('http://localhost/api/workflow-blueprint'),
    });

    expect(result).toMatchObject({
      ok: false,
      status: 429,
      rateLimitError: expect.any(BackendRateLimitError),
    });
    expect(adminClient.rpcCalls.map((call) => call.fn)).toEqual(['check_backend_rate_limit']);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('charges once, calls the provider, marks success, and returns the sanitized blueprint', async () => {
    const { planWorkflowBlueprintForRoute } = await import('@/lib/workflow-blueprint-service');
    const request = new Request('http://localhost/api/workflow-blueprint', {
      headers: { 'idempotency-key': 'blueprint-click-1' },
    });

    const result = await planWorkflowBlueprintForRoute({
      createAdminSupabase,
      createUserSupabase,
      kieApiKey: 'kie-key',
      providerFetch,
      readRequestBody: async () => validBlueprintInput,
      request,
    });

    expect(result).toEqual({
      ok: true,
      body: {
        remainingCredits: 94,
        blueprint: expect.objectContaining({
          title: 'Launch workflow',
          deliveryPlan: expect.objectContaining({
            primaryModel: 'kling-3.0-video',
          }),
        }),
      },
    });
    expect(adminClient.rpcCalls.map((call) => call.fn)).toEqual([
      'check_backend_rate_limit',
      'start_ai_usage_event',
      'settle_ai_usage_event',
    ]);
    expect(providerFetch).toHaveBeenCalledWith(
      'https://api.kie.ai/gemini-3-flash/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer kie-key',
        }),
      }),
      30_000,
      fetch,
      'KIE workflow blueprint',
    );
    expect(adminClient.rpcCalls).toContainEqual({
      fn: 'settle_ai_usage_event',
      args: expect.objectContaining({
        p_outcome: 'succeeded',
        p_response_payload: expect.objectContaining({
        remainingCredits: 94,
      }),
      }),
    });
  });
});
