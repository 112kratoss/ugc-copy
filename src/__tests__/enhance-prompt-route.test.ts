import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const buildEnhancerSystemPromptMock = vi.fn();
const callPromptEnhancerMock = vi.fn();
const rawCreateClientMock = vi.hoisted(() => vi.fn());
const createUserClientMock = vi.hoisted(() => vi.fn());

let currentAuthClient: ReturnType<typeof createAuthClient>;
let currentAdminClient: ReturnType<typeof createAdminClient>;

function createAuthClient() {
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: {
          user: { id: 'user-1' },
        },
        error: null,
      })),
    },
  };
}

function createAdminClient(options?: {
  remainingCredits?: number;
  rateLimitAllowed?: boolean;
  usageInsertError?: Error | null;
}) {
  const remainingCredits = options?.remainingCredits ?? 98;
  const rateLimitAllowed = options?.rateLimitAllowed ?? true;
  const usageInsertError = options?.usageInsertError ?? null;
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const inserts: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];

  return {
    rpcCalls,
    inserts,
    updates,
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });

      if (fn === 'deduct_credits') {
        return { data: remainingCredits, error: null };
      }

      if (fn === 'refund_ai_usage_event' || fn === 'refund_credits') {
        return { data: true, error: null };
      }

      if (fn === 'check_backend_rate_limit') {
        return {
          data: {
            allowed: rateLimitAllowed,
            limit: 60,
            remaining: rateLimitAllowed ? 59 : 0,
            retryAfterSeconds: rateLimitAllowed ? 0 : 42,
            resetAt: '2026-06-21T06:30:00.000Z',
          },
          error: null,
        };
      }

      return { data: null, error: null };
    }),
    from: vi.fn((table: string) => {
      if (table !== 'ai_usage_events') {
        throw new Error(`Unexpected table access: ${table}`);
      }

      return {
        insert(record: Record<string, unknown>) {
          inserts.push(record);
          return {
            select() {
              return {
                async single() {
                  return usageInsertError
                    ? { data: null, error: usageInsertError }
                    : { data: { id: 'event-1' }, error: null };
                },
              };
            },
          };
        },
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

vi.mock('@supabase/supabase-js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@supabase/supabase-js')>();

  return {
    ...actual,
    createClient: (...args: unknown[]) => rawCreateClientMock(...args),
  };
});

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: vi.fn(() => currentAdminClient),
  createUserClient: (request: Request) => createUserClientMock(request),
}));

vi.mock('@/lib/prompt-enhancer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/prompt-enhancer')>();

  return {
    ...actual,
    buildEnhancerSystemPrompt: vi.fn((...args: unknown[]) => buildEnhancerSystemPromptMock(...args)),
    callPromptEnhancer: vi.fn((...args: unknown[]) => callPromptEnhancerMock(...args)),
  };
});

describe('/api/enhance-prompt route', () => {
  beforeEach(() => {
    vi.resetModules();
    currentAuthClient = createAuthClient();
    currentAdminClient = createAdminClient();
    rawCreateClientMock.mockReset();
    rawCreateClientMock.mockImplementation(() => currentAuthClient);
    createUserClientMock.mockReset();
    createUserClientMock.mockImplementation(() => currentAuthClient);
    buildEnhancerSystemPromptMock.mockReset();
    callPromptEnhancerMock.mockReset();
    buildEnhancerSystemPromptMock.mockReturnValue('system prompt');
    callPromptEnhancerMock.mockResolvedValue({
      enhancedPrompt: JSON.stringify({
        subject: 'a premium product poster',
        setting: 'a clean studio backdrop',
        composition: 'clean poster composition',
        cameraFraming: 'eye-level framing',
        lighting: 'soft diffused light',
        materialDetail: 'crisp packaging detail',
        readableText: {
          exactText: 'SALE',
          placement: 'as the headline',
          treatment: 'bold sans-serif type',
        },
        finish: 'polished commercial finish',
      }),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes richer context into the shared enhancer builder and returns the current API shape', async () => {
    const { POST } = await import('@/app/api/enhance-prompt/route');
    const context = {
      referenceImageCount: 2,
      aspectRatio: '9:16',
      resolution: '2K',
      creativeIntent: 'general',
    };

    const response = await POST(
      new Request('http://localhost/api/enhance-prompt', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token',
        },
        body: JSON.stringify({
          medium: 'image',
          selectedModel: 'nano-banana-pro',
          prompt: 'Create a product poster and the text reads SALE',
          context,
        }),
      }) as never
    );

    expect(response.status).toBe(200);
    expect(buildEnhancerSystemPromptMock).toHaveBeenCalledWith(
      'image',
      'nano-banana-pro',
      context,
      'Create a product poster and the text reads SALE'
    );
    expect(callPromptEnhancerMock).toHaveBeenCalledWith('system prompt', 'Create a product poster and the text reads SALE');
    expect(createUserClientMock).toHaveBeenCalledTimes(1);
    expect(rawCreateClientMock).not.toHaveBeenCalled();

    const data = await response.json();
    expect(data.remainingCredits).toBe(98);
    expect(data.agentId).toBe('generic-media-enhancer');
    expect(typeof data.qualityScore).toBe('number');
    expect(Array.isArray(data.warnings)).toBe(true);
    expect(Array.isArray(data.appliedSafeguards)).toBe(true);
    expect(data.enhancedPrompt).toContain('a premium product poster');
    expect(data.enhancedPrompt).toContain('Include readable text "SALE"');
    expect(currentAdminClient.updates[0]).toMatchObject({
      status: 'succeeded',
      output_text: data.enhancedPrompt,
    });
  });

  it('rejects unsupported models before calling the enhancer', async () => {
    const { POST } = await import('@/app/api/enhance-prompt/route');
    const response = await POST(
      new Request('http://localhost/api/enhance-prompt', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token',
        },
        body: JSON.stringify({
          medium: 'image',
          selectedModel: 'unsupported-model',
          prompt: 'A founder portrait',
        }),
      }) as never
    );

    expect(response.status).toBe(400);
    expect(buildEnhancerSystemPromptMock).not.toHaveBeenCalled();
    expect(callPromptEnhancerMock).not.toHaveBeenCalled();
  });

  it('rate limits prompt enhancement before deducting credits or calling the provider', async () => {
    currentAdminClient = createAdminClient({ rateLimitAllowed: false });

    const { POST } = await import('@/app/api/enhance-prompt/route');
    const response = await POST(
      new Request('http://localhost/api/enhance-prompt', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token',
        },
        body: JSON.stringify({
          medium: 'image',
          selectedModel: 'nano-banana-pro',
          prompt: 'Create a product poster',
        }),
      }) as never
    );

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({ code: 'RATE_LIMITED' });
    expect(currentAdminClient.rpc).toHaveBeenCalledWith('check_backend_rate_limit', expect.objectContaining({
      p_scope: 'prompt-enhancement',
      p_subject_key: 'user-1',
    }));
    expect(currentAdminClient.rpc).not.toHaveBeenCalledWith('deduct_credits', expect.anything());
    expect(callPromptEnhancerMock).not.toHaveBeenCalled();
    expect(currentAdminClient.inserts).toHaveLength(0);
  });

  it('refunds credits if prompt enhancement fails after deduction', async () => {
    currentAdminClient = createAdminClient({ remainingCredits: 41 });
    callPromptEnhancerMock.mockRejectedValueOnce(new Error('provider failure'));

    const { POST } = await import('@/app/api/enhance-prompt/route');
    const response = await POST(
      new Request('http://localhost/api/enhance-prompt', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token',
        },
        body: JSON.stringify({
          medium: 'video',
          selectedModel: 'veo-3.1',
          prompt: 'Creator lifts the serum and smiles to camera',
          context: {
            hasStartImage: true,
            duration: 8,
          },
        }),
      }) as never
    );

    expect(response.status).toBe(502);
    expect(currentAdminClient.rpcCalls.some((call) => call.fn === 'refund_ai_usage_event')).toBe(true);

    const data = await response.json();
    expect(data).toMatchObject({
      error: 'Prompt enhancement failed. Your credits have been refunded.',
      remainingCredits: 43,
    });
    expect(currentAdminClient.updates.at(-1)).toMatchObject({
      error_message: 'provider failure',
    });
  });

  it('refunds and skips the provider when usage event creation fails after deduction', async () => {
    currentAdminClient = createAdminClient({
      remainingCredits: 41,
      usageInsertError: new Error('usage table unavailable'),
    });

    const { POST } = await import('@/app/api/enhance-prompt/route');
    const response = await POST(
      new Request('http://localhost/api/enhance-prompt', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token',
        },
        body: JSON.stringify({
          medium: 'image',
          selectedModel: 'nano-banana-pro',
          prompt: 'Create a product poster',
        }),
      }) as never
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: 'Failed to record AI usage.',
    });
    expect(currentAdminClient.rpcCalls).toEqual(expect.arrayContaining([
      { fn: 'refund_credits', args: { p_user_id: 'user-1', p_amount: 2 } },
    ]));
    expect(callPromptEnhancerMock).not.toHaveBeenCalled();
  });

  it('keeps append-only element prompts untouched when the compiled enhancement breaks the locked opening', async () => {
    callPromptEnhancerMock.mockResolvedValueOnce({
      enhancedPrompt: JSON.stringify({
        subject: 'a premium skincare hero still',
        setting: 'a bright daylight studio',
        composition: 'clean editorial framing',
        lighting: 'soft diffused light',
        materialDetail: 'crisp glass reflections',
        finish: 'polished commercial finish',
      }),
    });

    const { POST } = await import('@/app/api/enhance-prompt/route');
    const originalPrompt = 'Use @serum in a bright studio';
    const response = await POST(
      new Request('http://localhost/api/enhance-prompt', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token',
        },
        body: JSON.stringify({
          medium: 'image',
          selectedModel: 'nano-banana-pro',
          prompt: originalPrompt,
          context: {
            elementEnhancementMode: 'append-only',
            elementReferences: [{ handle: '@serum', displayName: 'Serum bottle' }],
          },
        }),
      }) as never
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.enhancedPrompt).toBe(originalPrompt);
  });
});
