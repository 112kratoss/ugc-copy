import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

const rawCreateClientMock = vi.hoisted(() => vi.fn());
const createUserClientMock = vi.hoisted(() => vi.fn());

let currentAuthClient: ReturnType<typeof createAuthClient>;
let currentAdminClient: ReturnType<typeof createAdminClient>;

function createAuthClient() {
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: { id: 'user-1' } },
        error: null,
      })),
    },
  };
}

function createAdminClient(options?: {
  remainingCredits?: number;
  rateLimitAllowed?: boolean;
  usageInsertError?: Error | null;
  existingUsageEvent?: {
    id: string;
    user_id: string;
    feature: string;
    client_request_key_hash: string;
    status: string;
    cost: number;
    response_payload?: Record<string, unknown> | null;
  } | null;
}) {
  const remainingCredits = options?.remainingCredits ?? 94;
  const rateLimitAllowed = options?.rateLimitAllowed ?? true;
  const usageInsertError = options?.usageInsertError ?? null;
  const existingUsageEvent = options?.existingUsageEvent ?? null;
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const inserts: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];

  return {
    rpcCalls,
    inserts,
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
            resetAt: '2026-06-21T06:30:00.000Z',
          },
          error: null,
        };
      }

      if (fn === 'deduct_credits') {
        return { data: remainingCredits, error: null };
      }

      if (fn === 'refund_ai_usage_event' || fn === 'refund_credits') {
        return { data: true, error: null };
      }

      throw new Error(`Unexpected rpc: ${fn}`);
    }),
    from: vi.fn((table: string) => {
      if (table === 'profiles') {
        return createSelectChain([{ id: 'user-1', credits: remainingCredits }]);
      }

      if (table !== 'ai_usage_events') {
        throw new Error(`Unexpected table access: ${table}`);
      }

      return {
        select() {
          return createSelectChain(existingUsageEvent ? [existingUsageEvent] : []);
        },
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

function createSelectChain(rows: Array<Record<string, unknown>>) {
  const filters: Array<{ column: string; value: unknown }> = [];
  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn((column: string, value: unknown) => {
      filters.push({ column, value });
      return chain;
    }),
    maybeSingle: vi.fn(async () => ({
      data: rows.find((row) => filters.every((filter) => row[filter.column] === filter.value)) ?? null,
      error: null,
    })),
  };

  return chain;
}

function testKeyHash(userId: string, feature: string, key: string) {
  return createHash('sha256')
    .update(userId)
    .update('\0')
    .update(feature)
    .update('\0')
    .update(key)
    .digest('hex');
}

function createBlueprintRequest() {
  return new Request('http://localhost/api/workflow-blueprint', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer token',
    },
    body: JSON.stringify({
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
    }),
  }) as never;
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

describe('/api/workflow-blueprint route', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('KIE_AI_API_KEY', 'test-key');
    currentAuthClient = createAuthClient();
    currentAdminClient = createAdminClient();
    rawCreateClientMock.mockReset();
    rawCreateClientMock.mockImplementation(() => currentAuthClient);
    createUserClientMock.mockReset();
    createUserClientMock.mockImplementation(() => currentAuthClient);
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
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
            }),
          },
        }],
      }),
    })));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('rate limits blueprint generation before charging credits or calling the provider', async () => {
    currentAdminClient = createAdminClient({ rateLimitAllowed: false });

    const { POST } = await import('@/app/api/workflow-blueprint/route');
    const response = await POST(createBlueprintRequest());

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({ code: 'RATE_LIMITED' });
    expect(currentAdminClient.rpc).toHaveBeenCalledWith('check_backend_rate_limit', expect.objectContaining({
      p_scope: 'workflow-blueprint',
      p_subject_key: 'user-1',
    }));
    expect(currentAdminClient.rpc).not.toHaveBeenCalledWith('deduct_credits', expect.anything());
    expect(currentAdminClient.inserts).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('creates a blueprint after charging credits when within the limit', async () => {
    const { POST } = await import('@/app/api/workflow-blueprint/route');
    const response = await POST(createBlueprintRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      remainingCredits: 94,
      blueprint: {
        title: 'Launch workflow',
      },
    });
    expect(currentAdminClient.rpc).toHaveBeenCalledWith('check_backend_rate_limit', expect.objectContaining({
      p_scope: 'workflow-blueprint',
      p_subject_key: 'user-1',
    }));
    expect(currentAdminClient.rpc).toHaveBeenCalledWith('deduct_credits', expect.objectContaining({
      p_user_id: 'user-1',
    }));
    expect(currentAdminClient.inserts).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(createUserClientMock).toHaveBeenCalledTimes(1);
    expect(rawCreateClientMock).not.toHaveBeenCalled();
  });

  it('replays a completed idempotent blueprint without charging credits or calling the provider again', async () => {
    currentAdminClient = createAdminClient({
      remainingCredits: 82,
      existingUsageEvent: {
        id: 'event-existing',
        user_id: 'user-1',
        feature: 'workflow_blueprint',
        client_request_key_hash: testKeyHash('user-1', 'workflow_blueprint', 'blueprint-click-1'),
        status: 'succeeded',
        cost: 6,
        response_payload: {
          blueprint: {
            title: 'Existing workflow',
            creativeStrategy: 'Reuse the previous paid answer.',
            shots: [],
          },
          remainingCredits: 90,
        },
      },
    });

    const { POST } = await import('@/app/api/workflow-blueprint/route');
    const response = await POST(
      new Request('http://localhost/api/workflow-blueprint', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token',
          'Idempotency-Key': 'blueprint-click-1',
        },
        body: JSON.stringify({
          productName: 'Creator Kit',
          audience: 'UGC creators',
          primaryMessage: 'Create polished launch videos faster',
          idempotencyKey: 'blueprint-click-1',
        }),
      }) as never
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      idempotentReplay: true,
      remainingCredits: 82,
      blueprint: {
        title: 'Existing workflow',
      },
    });
    expect(currentAdminClient.rpcCalls.map((call) => call.fn)).toContain('check_backend_rate_limit');
    expect(currentAdminClient.rpcCalls.map((call) => call.fn)).not.toContain('deduct_credits');
    expect(currentAdminClient.inserts).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refunds and skips the provider when usage event creation fails after deduction', async () => {
    currentAdminClient = createAdminClient({
      remainingCredits: 94,
      usageInsertError: new Error('usage table unavailable'),
    });

    const { POST } = await import('@/app/api/workflow-blueprint/route');
    const response = await POST(createBlueprintRequest());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: 'Failed to record AI usage.',
    });
    expect(currentAdminClient.rpcCalls).toEqual(expect.arrayContaining([
      { fn: 'refund_credits', args: { p_user_id: 'user-1', p_amount: 6 } },
    ]));
    expect(fetch).not.toHaveBeenCalled();
  });
});
