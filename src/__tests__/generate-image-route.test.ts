import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type SourceGenerationRow = {
  id: string;
  user_id: string;
  is_public: boolean;
};

type LocalGenerationRow = {
  id: string;
  prediction_id: string;
  user_id: string;
  status: string;
  output_url: string | null;
  created_at: string;
  completed_at?: string | null;
  model: string;
  category: string | null;
  workflow_settings?: Record<string, unknown> | null;
};

let currentSupabaseMock: ReturnType<typeof createSupabaseMock>;
type LockDecision = boolean | ((args: Record<string, unknown>) => boolean);
type AuthUser = { id: string } | null;

function createSupabaseMock(
  sourceGeneration: SourceGenerationRow | null,
  localGeneration: LocalGenerationRow | null = null,
  lockAcquired: LockDecision = true,
  rateLimitAllowed = true,
  authUser: AuthUser = { id: 'user-1' }
) {
  const inserts: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const selects: string[] = [];
  const eqs: Array<{ column: string; value: unknown }> = [];
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown> = {}) => {
    if (fn === 'deduct_credits') {
      return { data: 92, error: null };
    }

    if (fn === 'refund_credits') {
      return { data: true, error: null };
    }

    if (fn === 'refund_generation') {
      return { data: true, error: null };
    }

    if (fn === 'try_acquire_backend_job_lock') {
      return {
        data: typeof lockAcquired === 'function' ? lockAcquired(args) : lockAcquired,
        error: null,
      };
    }

    if (fn === 'release_backend_job_lock') {
      return { data: true, error: null };
    }

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

    return { data: null, error: null };
  });

  return {
    inserts,
    updates,
    selects,
    eqs,
    client: {
      auth: {
        getUser: vi.fn(async () => ({
          data: {
            user: authUser,
          },
          error: authUser ? null : new Error('missing session'),
        })),
      },
      rpc,
      storage: {
        from: vi.fn(() => ({
          upload: vi.fn(async () => ({ error: null })),
        })),
      },
      from: vi.fn((table: string) => {
        if (table !== 'generations') {
          throw new Error(`Unexpected table access: ${table}`);
        }

        return {
          select(columns = '') {
            selects.push(columns);
            const filters: Record<string, unknown> = {};
            const query = {
              eq(column: string, value: unknown) {
                filters[column] = value;
                eqs.push({ column, value });
                return query;
              },
              or() {
                return query;
              },
              async maybeSingle() {
                if (filters.id && sourceGeneration && sourceGeneration.id === filters.id) {
                  return { data: sourceGeneration, error: null };
                }

                return { data: null, error: null };
              },
              async single() {
                if (
                  filters.prediction_id
                  && localGeneration
                  && localGeneration.prediction_id === filters.prediction_id
                  && (!filters.user_id || localGeneration.user_id === filters.user_id)
                ) {
                  return { data: localGeneration, error: null };
                }

                if (filters.id && sourceGeneration && sourceGeneration.id === filters.id) {
                  return { data: sourceGeneration, error: null };
                }

                return { data: null, error: null };
              },
            };

            return query;
          },
          update(record: Record<string, unknown>) {
            updates.push(record);
            return {
              async eq() {
                return { data: null, error: null };
              },
            };
          },
          insert(record: Record<string, unknown>) {
            inserts.push(record);
            return {
              select() {
                return {
                  async single() {
                    return {
                      data: { id: 'gen-logged-1' },
                      error: null,
                    };
                  },
                };
              },
            };
          },
        };
      }),
    },
  };
}

vi.mock('@supabase/supabase-js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@supabase/supabase-js')>();
  return {
    ...actual,
    createClient: vi.fn(() => currentSupabaseMock.client),
  };
});

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: vi.fn(() => currentSupabaseMock.client),
  resolveStoredMediaUrl: vi.fn(),
}));

describe('/api/generate-image route', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.KIE_AI_API_KEY = 'test-key';
    process.env.WEBHOOK_SECRET = 'test-webhook-secret';
    process.env.NEXT_PUBLIC_SITE_URL = 'https://magicbooklet.com';
    delete process.env.KIE_WEBHOOK_HMAC_KEY;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ code: 200, data: { taskId: 'task-1' } }),
      }))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('authenticates before reporting provider configuration errors', async () => {
    currentSupabaseMock = createSupabaseMock(null, null, true, true, null);
    delete process.env.KIE_AI_API_KEY;

    const { POST } = await import('@/app/api/generate-image/route');
    const response = await POST(
      new Request('http://localhost/api/generate-image', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt: 'A product hero image',
          model: 'nano-banana-2',
        }),
      }) as never
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: 'Unauthorized: Please log in to generate images',
    });
    expect(currentSupabaseMock.client.auth.getUser).toHaveBeenCalledTimes(1);
    expect(currentSupabaseMock.client.rpc).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a stale catalog revision before deducting credits', async () => {
    currentSupabaseMock = createSupabaseMock(null);

    const { POST } = await import('@/app/api/generate-image/route');
    const response = await POST(
      new Request('http://localhost/api/generate-image', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token',
        },
        body: JSON.stringify({
          prompt: 'A product hero image',
          model: 'nano-banana-2',
          catalogRevision: 'stale-revision',
        }),
      }) as never
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'CATALOG_CHANGED' });
    expect(currentSupabaseMock.client.rpc).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('persists sourceGenerationId when the remix source is accessible', async () => {
    currentSupabaseMock = createSupabaseMock({
      id: 'source-1',
      user_id: 'other-user',
      is_public: true,
    });

    const { POST } = await import('@/app/api/generate-image/route');
    const response = await POST(
      new Request('http://localhost/api/generate-image', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token',
        },
        body: JSON.stringify({
          prompt: 'A product hero image',
          model: 'nano-banana-2',
          sourceGenerationId: 'source-1',
        }),
      }) as never
    );

    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.generationId).toBe('gen-logged-1');
    expect(currentSupabaseMock.inserts[0].source_generation_id).toBe('source-1');
  });

  it('rejects inaccessible sourceGenerationId values before inserting', async () => {
    currentSupabaseMock = createSupabaseMock(null);

    const { POST } = await import('@/app/api/generate-image/route');
    const response = await POST(
      new Request('http://localhost/api/generate-image', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token',
        },
        body: JSON.stringify({
          prompt: 'A product hero image',
          model: 'nano-banana-2',
          sourceGenerationId: 'missing-source',
        }),
      }) as never
    );

    const data = await response.json();
    expect(response.status).toBe(400);
    expect(data.error).toContain('Source generation');
    expect(currentSupabaseMock.inserts).toHaveLength(0);
  });

  it('rejects invalid GPT Image 2 resolution combinations before inserting or deducting credits', async () => {
    currentSupabaseMock = createSupabaseMock(null);

    const { POST } = await import('@/app/api/generate-image/route');
    const response = await POST(
      new Request('http://localhost/api/generate-image', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token',
        },
        body: JSON.stringify({
          prompt: 'A square product hero image',
          model: 'gpt-image-2',
          aspectRatio: '1:1',
          resolution: '4K',
        }),
      }) as never
    );

    const data = await response.json();
    expect(response.status).toBe(422);
    expect(data).toMatchObject({
      code: 'INVALID_MODEL_SETTINGS',
      fieldErrors: { resolution: expect.any(String) },
    });
    expect(currentSupabaseMock.inserts).toHaveLength(0);
    expect(currentSupabaseMock.client.rpc).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rate limits image starts before deducting credits or calling the provider', async () => {
    currentSupabaseMock = createSupabaseMock(null, null, true, false);
    const providerFetch = vi.fn();
    vi.stubGlobal('fetch', providerFetch);

    const { POST } = await import('@/app/api/generate-image/route');
    const response = await POST(
      new Request('http://localhost/api/generate-image', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token',
        },
        body: JSON.stringify({
          prompt: 'A product hero image',
          model: 'nano-banana-2',
        }),
      }) as never
    );

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({ code: 'RATE_LIMITED' });
    expect(currentSupabaseMock.client.rpc).toHaveBeenCalledWith('check_backend_rate_limit', expect.objectContaining({
      p_scope: 'media-generation:start',
      p_subject_key: 'user-1',
    }));
    expect(currentSupabaseMock.client.rpc).not.toHaveBeenCalledWith('deduct_credits', expect.anything());
    expect(providerFetch).not.toHaveBeenCalled();
    expect(currentSupabaseMock.inserts).toHaveLength(0);
  });

  it('persists image element sourceGenerationId values for future remixes', async () => {
    currentSupabaseMock = createSupabaseMock({
      id: 'source-1',
      user_id: 'other-user',
      is_public: true,
    });

    const { POST } = await import('@/app/api/generate-image/route');
    const response = await POST(
      new Request('http://localhost/api/generate-image', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token',
        },
        body: JSON.stringify({
          prompt: 'A refreshed creator frame',
          model: 'nano-banana-2',
          imageUrls: ['https://signed.example.com/source-1.png'],
          elements: [
            {
              id: 'el-1',
              displayName: 'Original result',
              handle: '@original_result',
              sourceGenerationId: 'source-1',
            },
          ],
          sourceGenerationId: 'source-1',
        }),
      }) as never
    );

    expect(response.status).toBe(200);
    expect(currentSupabaseMock.inserts[0].workflow_settings).toMatchObject({
      elements: [
        {
          id: 'el-1',
          displayName: 'Original result',
          handle: '@original_result',
          sourceGenerationId: 'source-1',
        },
      ],
    });
  });

  it('returns provider-backed timing for waiting image generations', async () => {
    currentSupabaseMock = createSupabaseMock(null, {
      id: 'gen-image-1',
      prediction_id: 'task-image-status-1',
      user_id: 'user-1',
      status: 'processing',
      output_url: null,
      created_at: '2026-04-15T10:00:00.000Z',
      completed_at: null,
      model: 'nano-banana-2',
      category: 'image',
      workflow_settings: {
        resolution: '1K',
        elements: [{ id: 'el-1' }, { id: 'el-2' }],
      },
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          code: 200,
          data: {
            state: 'waiting',
            createTime: '2026-04-15T10:00:00.000Z',
            updateTime: '2026-04-15T10:00:05.000Z',
          },
        }),
      }))
    );

    const { GET } = await import('@/app/api/generate-image/route');
    const response = await GET(
      new Request('http://localhost/api/generate-image?id=task-image-status-1', {
        headers: {
          Authorization: 'Bearer token',
        },
      }) as never
    );

    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.status).toBe('waiting');
    expect(data.timing).toMatchObject({
      appStatus: 'waiting',
      providerState: 'waiting',
      phaseLabel: 'Waiting for provider',
      startedAtMs: Date.parse('2026-04-15T10:00:00.000Z'),
      estimatedTotalMs: 145_000,
    });
    expect(currentSupabaseMock.selects).toContain('id, user_id, prediction_id, status, output_url, created_at, completed_at, model, category, workflow_settings');
    expect(currentSupabaseMock.selects).not.toContain('*');
    expect(currentSupabaseMock.eqs).toEqual(expect.arrayContaining([
      { column: 'prediction_id', value: 'task-image-status-1' },
      { column: 'user_id', value: 'user-1' },
    ]));
    expect(currentSupabaseMock.updates).toHaveLength(0);
  });

  it('rejects unauthenticated image status checks before locks or provider calls', async () => {
    currentSupabaseMock = createSupabaseMock(null, null, true, true, null);
    const providerFetch = vi.fn();
    vi.stubGlobal('fetch', providerFetch);

    const { GET } = await import('@/app/api/generate-image/route');
    const response = await GET(
      new Request('http://localhost/api/generate-image?id=task-image-unauth-1') as never
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('Unauthorized'),
    });
    expect(currentSupabaseMock.client.rpc).not.toHaveBeenCalledWith('try_acquire_backend_job_lock', expect.anything());
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('rejects unknown image prediction ids before locks or provider calls', async () => {
    currentSupabaseMock = createSupabaseMock(null, null);
    const providerFetch = vi.fn();
    vi.stubGlobal('fetch', providerFetch);

    const { GET } = await import('@/app/api/generate-image/route');
    const response = await GET(
      new Request('http://localhost/api/generate-image?id=missing-image-task', {
        headers: {
          Authorization: 'Bearer token',
        },
      }) as never
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('not found'),
    });
    expect(currentSupabaseMock.client.rpc).not.toHaveBeenCalledWith('try_acquire_backend_job_lock', expect.anything());
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('returns cached processing state without calling the provider when status refresh is already locked', async () => {
    currentSupabaseMock = createSupabaseMock(null, {
      id: 'gen-image-locked-1',
      prediction_id: 'task-image-locked-1',
      user_id: 'user-1',
      status: 'processing',
      output_url: null,
      created_at: '2026-04-15T10:00:00.000Z',
      completed_at: null,
      model: 'nano-banana-2',
      category: 'image',
      workflow_settings: {
        resolution: '1K',
      },
    }, false);

    const providerFetch = vi.fn();
    vi.stubGlobal('fetch', providerFetch);

    const { GET } = await import('@/app/api/generate-image/route');
    const response = await GET(
      new Request('http://localhost/api/generate-image?id=task-image-locked-1', {
        headers: {
          Authorization: 'Bearer token',
        },
      }) as never
    );

    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data).toMatchObject({
      status: 'processing',
      output: null,
      error: null,
      retryAfterMs: 2000,
    });
    expect(providerFetch).not.toHaveBeenCalled();
    expect(currentSupabaseMock.updates).toHaveLength(0);
  });

  it('throttles provider status checks while returning cached active image state', async () => {
    currentSupabaseMock = createSupabaseMock(null, {
      id: 'gen-image-throttled-1',
      prediction_id: 'task-image-throttled-1',
      user_id: 'user-1',
      status: 'processing',
      output_url: null,
      created_at: '2026-04-15T10:00:00.000Z',
      completed_at: null,
      model: 'nano-banana-2',
      category: 'image',
      workflow_settings: {
        resolution: '1K',
      },
    }, (args) => !String(args.p_name).startsWith('generation-provider-status:'));

    const providerFetch = vi.fn();
    vi.stubGlobal('fetch', providerFetch);

    const { GET } = await import('@/app/api/generate-image/route');
    const response = await GET(
      new Request('http://localhost/api/generate-image?id=task-image-throttled-1', {
        headers: {
          Authorization: 'Bearer token',
        },
      }) as never
    );

    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data).toMatchObject({
      status: 'processing',
      output: null,
      error: null,
      retryAfterMs: 15000,
    });
    expect(providerFetch).not.toHaveBeenCalled();
    expect(currentSupabaseMock.updates).toHaveLength(0);
    expect(currentSupabaseMock.client.rpc).toHaveBeenCalledWith('try_acquire_backend_job_lock', expect.objectContaining({
      p_name: 'generation-provider-status:task-image-throttled-1',
      p_ttl_seconds: 15,
    }));
  });

  it('persists and returns all Grok image outputs when the provider succeeds', async () => {
    currentSupabaseMock = createSupabaseMock(null, {
      id: 'gen-grok-image-1',
      prediction_id: 'task-grok-image-1',
      user_id: 'user-1',
      status: 'processing',
      output_url: null,
      created_at: '2026-04-15T10:00:00.000Z',
      completed_at: null,
      model: 'grok-imagine-image',
      category: 'image',
      workflow_settings: {
        model: 'grok-imagine-image',
        providerModel: 'grok-imagine/text-to-image',
      },
    });

    const serverHelpers = await import('@/lib/server-helpers');
    vi.mocked(serverHelpers.resolveStoredMediaUrl).mockImplementation(async (_supabase, outputUrl) => `signed:${outputUrl}`);

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/recordInfo')) {
          return {
            ok: true,
            json: async () => ({
              code: 200,
              data: {
                state: 'success',
                createTime: '2026-04-15T10:00:00.000Z',
                completeTime: '2026-04-15T10:01:00.000Z',
                resultJson: JSON.stringify({
                  resultUrls: [
                    'https://provider.example.com/grok-1.jpg',
                    'https://provider.example.com/grok-2.jpg',
                  ],
                }),
              },
            }),
          } as Response;
        }

        return {
          ok: true,
          blob: async () => new Blob(['image'], { type: 'image/jpeg' }),
        } as Response;
      })
    );

    const { GET } = await import('@/app/api/generate-image/route');
    const response = await GET(
      new Request('http://localhost/api/generate-image?id=task-grok-image-1', {
        headers: {
          Authorization: 'Bearer token',
        },
      }) as never
    );

    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data).toMatchObject({
      status: 'succeeded',
      output: 'signed:generated_images/user-1/generated_task-grok-image-1_0.jpg',
      outputs: [
        'signed:generated_images/user-1/generated_task-grok-image-1_0.jpg',
        'signed:generated_images/user-1/generated_task-grok-image-1_1.jpg',
      ],
    });
    expect(currentSupabaseMock.updates[0]).toMatchObject({
      status: 'succeeded',
      output_url: 'generated_images/user-1/generated_task-grok-image-1_0.jpg',
      workflow_settings: {
        outputs: [
          { index: 0, storagePath: 'generated_images/user-1/generated_task-grok-image-1_0.jpg' },
          { index: 1, storagePath: 'generated_images/user-1/generated_task-grok-image-1_1.jpg' },
        ],
      },
    });
  });
});
