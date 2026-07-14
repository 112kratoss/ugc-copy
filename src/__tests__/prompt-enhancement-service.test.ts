import { describe, expect, it, vi } from 'vitest';

import {
  enhancePromptForUser,
  type PromptEnhancementClient,
} from '@/lib/prompt-enhancement-service';

const buildEnhancerSystemPromptMock = vi.fn();
const callPromptEnhancerMock = vi.fn();
const buildPromptEnhancementArtifactsMock = vi.fn();
const applyPromptEnhancementSafeguardsWithMetadataMock = vi.fn();
const inspectPromptQualityMock = vi.fn();

vi.mock('@/lib/prompt-enhancer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/prompt-enhancer')>();

  return {
    ...actual,
    buildEnhancerSystemPrompt: vi.fn((...args: unknown[]) => buildEnhancerSystemPromptMock(...args)),
    callPromptEnhancer: vi.fn((...args: unknown[]) => callPromptEnhancerMock(...args)),
    buildPromptEnhancementArtifacts: vi.fn((...args: unknown[]) => buildPromptEnhancementArtifactsMock(...args)),
    applyPromptEnhancementSafeguardsWithMetadata: vi.fn((...args: unknown[]) => applyPromptEnhancementSafeguardsWithMetadataMock(...args)),
  };
});

vi.mock('@/lib/prompt-quality', () => ({
  inspectPromptQuality: vi.fn((...args: unknown[]) => inspectPromptQualityMock(...args)),
}));

function createClient({
  remainingCredits = 98,
  rateLimitAllowed = true,
  usageStartError = null as Error | null,
} = {}) {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const updates: Record<string, unknown>[] = [];
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    rpcCalls.push({ fn, args });

    if (fn === 'check_backend_rate_limit') {
      return {
        data: {
          allowed: rateLimitAllowed,
          limit: 60,
          remaining: rateLimitAllowed ? 59 : 0,
          retryAfterSeconds: rateLimitAllowed ? 0 : 42,
          resetAt: '2026-06-22T06:30:00.000Z',
        },
        error: null,
      };
    }

    if (fn === 'start_ai_usage_event') {
      if (usageStartError) {
        return { data: null, error: usageStartError };
      }

      return {
        data: {
          status: 'started',
          event_id: 'event-1',
          remaining_credits: remainingCredits,
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
          remaining_credits: remainingCredits,
        },
        error: null,
      };
    }

    return { data: null, error: null };
  });
  const from = vi.fn((table: string) => {
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
  });

  return {
    client: { rpc, from } as unknown as PromptEnhancementClient,
    rpc,
    rpcCalls,
    updates,
  };
}

function createRequest(idempotencyKey?: string) {
  return new Request('http://localhost/api/enhance-prompt', {
    method: 'POST',
    headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
  });
}

describe('enhancePromptForUser', () => {
  it('rejects invalid prompt requests before privileged client or provider work', async () => {
    const clientFactory = vi.fn(() => createClient().client);

    await expect(enhancePromptForUser({
      body: {
        medium: 'image',
        selectedModel: 'unsupported-model',
        prompt: 'A founder portrait',
      },
      userId: 'user-1',
      request: createRequest(),
      client: clientFactory,
    })).resolves.toEqual({
      ok: false,
      status: 400,
      error: 'Unsupported model: unsupported-model',
    });

    expect(clientFactory).not.toHaveBeenCalled();
    expect(callPromptEnhancerMock).not.toHaveBeenCalled();
  });

  it('rate limits before starting paid usage or calling the provider', async () => {
    const client = createClient({ rateLimitAllowed: false });

    const result = await enhancePromptForUser({
      body: {
        medium: 'image',
        selectedModel: 'nano-banana-pro',
        prompt: 'Create a product poster',
      },
      userId: 'user-1',
      request: createRequest(),
      client: client.client,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 429,
      code: 'RATE_LIMITED',
      retryAfterSeconds: 42,
    });
    expect(client.rpc).toHaveBeenCalledWith('check_backend_rate_limit', expect.objectContaining({
      p_scope: 'prompt-enhancement',
      p_subject_key: 'user-1',
    }));
    expect(client.rpcCalls.map((call) => call.fn)).toEqual(['check_backend_rate_limit']);
    expect(callPromptEnhancerMock).not.toHaveBeenCalled();
  });

  it('starts paid usage, enhances the prompt, and records the route response payload', async () => {
    const client = createClient({ remainingCredits: 41 });
    buildEnhancerSystemPromptMock.mockReturnValue('system prompt');
    callPromptEnhancerMock.mockResolvedValue({
      enhancedPrompt: 'provider structured response',
    });
    buildPromptEnhancementArtifactsMock.mockReturnValue({
      compiledPrompt: 'compiled prompt',
      agentId: 'test-enhancer',
      appliedSafeguards: ['artifact safeguard'],
    });
    applyPromptEnhancementSafeguardsWithMetadataMock.mockReturnValue({
      enhancedPrompt: 'final enhanced prompt',
      appliedSafeguards: ['metadata safeguard'],
    });
    inspectPromptQualityMock.mockReturnValue({
      qualityScore: 91,
      warnings: [{ code: 'minor_note', message: 'Minor note.' }],
    });

    const result = await enhancePromptForUser({
      body: {
        medium: 'image',
        selectedModel: 'nano-banana-pro',
        prompt: 'Create a product poster and the text reads SALE',
        context: { aspectRatio: '9:16' },
      },
      userId: 'user-1',
      request: createRequest('enhance-click-1'),
      client: client.client,
    });

    expect(buildEnhancerSystemPromptMock).toHaveBeenCalledWith(
      'image',
      'nano-banana-pro',
      { aspectRatio: '9:16' },
      'Create a product poster and the text reads SALE'
    );
    expect(callPromptEnhancerMock).toHaveBeenCalledWith('system prompt', 'Create a product poster and the text reads SALE');
    expect(result).toEqual({
      ok: true,
      response: {
        enhancedPrompt: 'final enhanced prompt',
        remainingCredits: 41,
        agentId: 'test-enhancer',
        qualityScore: 91,
        warnings: [{ code: 'minor_note', message: 'Minor note.' }],
        appliedSafeguards: ['artifact safeguard', 'metadata safeguard'],
      },
    });
    expect(client.rpcCalls).toContainEqual({
      fn: 'settle_ai_usage_event',
      args: expect.objectContaining({
        p_outcome: 'succeeded',
        p_output_text: 'final enhanced prompt',
        p_response_payload: expect.objectContaining({
        enhancedPrompt: 'final enhanced prompt',
        remainingCredits: 41,
      }),
      }),
    });
  });

  it('refunds paid usage when the provider fails after ledger start', async () => {
    const client = createClient({ remainingCredits: 41 });
    buildEnhancerSystemPromptMock.mockReturnValue('system prompt');
    callPromptEnhancerMock.mockRejectedValue(new Error('provider failure'));

    await expect(enhancePromptForUser({
      body: {
        medium: 'video',
        selectedModel: 'veo-3.1',
        prompt: 'Creator lifts the serum and smiles to camera',
      },
      userId: 'user-1',
      request: createRequest(),
      client: client.client,
    })).resolves.toEqual({
      ok: false,
      status: 502,
      error: 'Prompt enhancement failed. Your credits have been refunded.',
      remainingCredits: 43,
    });

    expect(client.rpcCalls.map((call) => call.fn)).toEqual([
      'check_backend_rate_limit',
      'start_ai_usage_event',
      'settle_ai_usage_event',
    ]);
    expect(client.rpcCalls.at(-1)?.args).toMatchObject({
      p_outcome: 'refunded',
      p_error_message: 'provider failure',
    });
    expect(client.updates).toHaveLength(0);
  });
});
