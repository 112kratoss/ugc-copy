import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The media-source guard parses storage locations for real; keep the genuine
// implementation so fixtures exercise the same validation production does.
import { getStoredMediaLocation as actualGetStoredMediaLocation } from '@/lib/media-urls';

import { hashGenerationStartIdempotencyKey } from '@/lib/generation-start-idempotency';

const rawCreateClientMock = vi.hoisted(() => vi.fn());
const createUserClientMock = vi.hoisted(() => vi.fn());

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
  // `value` for eq(), `values` for the linked-owner in() filter.
  const eqs: Array<{ column: string; value?: unknown; values?: unknown[] }> = [];
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown> = {}) => {
    if (fn === 'start_generation') {
      inserts.push({
        user_id: args.p_user_id,
        model: args.p_model,
        cost: args.p_cost,
        duration: args.p_duration,
        client_request_key_hash: args.p_client_request_key_hash,
        prompt: args.p_prompt,
        category: args.p_category,
        creation_mode: args.p_creation_mode,
        source_generation_id: args.p_source_generation_id,
        workflow_settings: args.p_workflow_settings,
        prediction_id: null,
        status: 'pending',
      });
      return {
        data: {
          status: 'started',
          generation_id: 'gen-logged-1',
          remaining_credits: 92,
          cost: args.p_cost,
        },
        error: null,
      };
    }

    if (fn === 'deduct_credits') {
      return { data: 92, error: null };
    }

    if (fn === 'refund_credits') {
      return { data: true, error: null };
    }

    if (fn === 'settle_generation_failed') {
      if (localGeneration) {
        localGeneration.status = 'failed';
        localGeneration.completed_at = typeof args.p_completed_at === 'string'
          ? args.p_completed_at
          : '2026-04-15T10:01:00.000Z';
      }
      return {
        data: {
          status: localGeneration ? 'failed' : 'missing',
          generation_id: localGeneration?.id ?? null,
          refunded: true,
        },
        error: null,
      };
    }

    if (fn === 'settle_generation_succeeded') {
      if (!localGeneration) {
        return {
          data: { status: 'missing' },
          error: null,
        };
      }

      if (localGeneration.status === 'failed') {
        return {
          data: {
            status: 'already_failed',
            generation_id: localGeneration.id,
            output_url: localGeneration.output_url,
            refunded: true,
          },
          error: null,
        };
      }

      localGeneration.status = 'succeeded';
      localGeneration.output_url = typeof args.p_output_url === 'string' ? args.p_output_url : null;
      localGeneration.completed_at = typeof args.p_completed_at === 'string'
        ? args.p_completed_at
        : '2026-04-15T10:01:00.000Z';
      if (args.p_workflow_settings && typeof args.p_workflow_settings === 'object') {
        localGeneration.workflow_settings = args.p_workflow_settings as Record<string, unknown>;
      }

      return {
        data: {
          status: 'succeeded',
          generation_id: localGeneration.id,
          output_url: localGeneration.output_url,
          refunded: false,
        },
        error: null,
      };
    }

    if (fn === 'attach_generation_provider_task') {
      return {
        data: {
          status: 'attached',
          generation_id: args.p_generation_id,
          prediction_id: args.p_prediction_id,
        },
        error: null,
      };
    }

    if (fn === 'enqueue_generation_output_import_job') {
      return {
        data: 'output-import-job-1',
        error: null,
      };
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

    if (fn === 'claim_generation_start_request') {
      return { data: 'claimed', error: null };
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

    if (fn === 'admit_provider_submission' || fn === 'reserve_provider_submission') {
      return {
        data: {
          allowed: true,
          reason: 'admitted',
          state: 'closed',
          retryAfterSeconds: 0,
          inFlight: 0,
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
              in(column: string, values: unknown[]) {
                filters[column] = values;
                eqs.push({ column, values });
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
                  // Owner scoping is now `in` over the linked-account set, so
                  // this arrives as an array. Accept either shape.
                  && (!filters.user_id
                    || (Array.isArray(filters.user_id)
                      ? filters.user_id.includes(localGeneration.user_id)
                      : localGeneration.user_id === filters.user_id))
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
              async in() {
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
    createClient: (...args: unknown[]) => rawCreateClientMock(...args),
  };
});

vi.mock('@/lib/server-helpers', () => ({
  getStoredMediaLocation: actualGetStoredMediaLocation,
  createUserClient: (request: Request) => createUserClientMock(request),
  createServiceClient: vi.fn(() => currentSupabaseMock.client),
  resolveStoredMediaUrl: vi.fn(),
  resolveOwnedStoredMediaUrl: vi.fn(async (_supabase: unknown, value: string) => value),
}));

function expectPrivateNoStoreTraceHeaders(response: Response, requestId: string) {
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('x-request-id')).toBe(requestId);
}

describe('/api/generate-image route', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.KIE_AI_API_KEY = 'test-key';
    process.env.KIE_PROVIDER_WEBHOOK_SECRET = 'test-webhook-secret';
    process.env.KIE_WEBHOOK_HMAC_KEY = 'hmac-key';
    process.env.NEXT_PUBLIC_SITE_URL = 'https://magicbooklet.com';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co';
    rawCreateClientMock.mockReset();
    rawCreateClientMock.mockImplementation(() => currentSupabaseMock.client);
    createUserClientMock.mockReset();
    createUserClientMock.mockImplementation(() => currentSupabaseMock.client);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const inputUrl = typeof input === 'string'
          ? input
          : input instanceof Request
            ? input.url
            : String(input);
        if (
          init?.method === 'GET'
          || inputUrl.includes('/storage/v1/object/')
        ) {
          return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
            status: 200,
            headers: { 'Content-Type': 'image/jpeg' },
          });
        }

        return Response.json({ code: 200, data: { taskId: 'task-1' } });
      })
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
          'x-request-id': 'image-post-auth-1',
        },
        body: JSON.stringify({
          prompt: 'A product hero image',
          model: 'nano-banana-2',
        }),
      }) as never
    );

    expect(response.status).toBe(401);
    expectPrivateNoStoreTraceHeaders(response, 'image-post-auth-1');
    expect(await response.json()).toEqual({
      error: 'Unauthorized: Please log in to generate images',
    });
    expect(currentSupabaseMock.client.auth.getUser).toHaveBeenCalledTimes(1);
    expect(createUserClientMock).toHaveBeenCalledTimes(1);
    expect(rawCreateClientMock).not.toHaveBeenCalled();
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
          'x-request-id': 'image-stale-catalog-1',
        },
        body: JSON.stringify({
          prompt: 'A product hero image',
          model: 'nano-banana-2',
          catalogRevision: 'stale-revision',
        }),
      }) as never
    );

    expect(response.status).toBe(409);
    expectPrivateNoStoreTraceHeaders(response, 'image-stale-catalog-1');
    expect(response.headers.has('authorization')).toBe(false);
    expect(Array.from(response.headers.entries()).join('\n')).not.toContain('Bearer token');
    expect(await response.json()).toMatchObject({ code: 'CATALOG_CHANGED' });
    expect(currentSupabaseMock.client.rpc).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('persists sourceGenerationId when the remix source is accessible', async () => {
    currentSupabaseMock = createSupabaseMock({
      id: '11111111-1111-4111-8111-111111111111',
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
          'Idempotency-Key': 'image-route-fallback-1',
          'x-request-id': 'image-route-fallback-1',
        },
        body: JSON.stringify({
          prompt: 'A product hero image',
          model: 'nano-banana-2',
          sourceGenerationId: '11111111-1111-4111-8111-111111111111',
        }),
      }) as never
    );

    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.generationId).toBe('gen-logged-1');
    expect(currentSupabaseMock.inserts[0].source_generation_id).toBe('11111111-1111-4111-8111-111111111111');
    expect(currentSupabaseMock.inserts[0].client_request_key_hash)
      .toBe(hashGenerationStartIdempotencyKey('user-1', 'image-route-fallback-1'));
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
          'x-request-id': 'image-rate-limit-1',
        },
        body: JSON.stringify({
          prompt: 'A product hero image',
          model: 'nano-banana-2',
        }),
      }) as never
    );

    expect(response.status).toBe(429);
    expectPrivateNoStoreTraceHeaders(response, 'image-rate-limit-1');
    expect(response.headers.get('Retry-After')).toBe('42');
    await expect(response.json()).resolves.toMatchObject({ code: 'RATE_LIMITED' });
    expect(currentSupabaseMock.client.rpc).toHaveBeenCalledWith('check_backend_rate_limit', expect.objectContaining({
      p_scope: 'media-generation:start',
      p_subject_key: 'user-1',
    }));
    expect(currentSupabaseMock.client.rpc).not.toHaveBeenCalledWith('start_generation', expect.anything());
    expect(providerFetch).not.toHaveBeenCalled();
    expect(currentSupabaseMock.inserts).toHaveLength(0);
  });

  it('persists image element sourceGenerationId values for future remixes', async () => {
    currentSupabaseMock = createSupabaseMock({
      id: '11111111-1111-4111-8111-111111111111',
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
          'Idempotency-Key': 'image-elements-start-1',
        },
        body: JSON.stringify({
          prompt: 'A refreshed creator frame',
          model: 'nano-banana-2',
          imageUrls: ['https://project.supabase.co/storage/v1/object/sign/uploads/user-1/source-1.png'],
          elements: [
            {
              id: 'el-1',
              displayName: 'Original result',
              handle: '@original_result',
              sourceGenerationId: '11111111-1111-4111-8111-111111111111',
            },
          ],
          sourceGenerationId: '11111111-1111-4111-8111-111111111111',
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
          sourceGenerationId: '11111111-1111-4111-8111-111111111111',
        },
      ],
    });
  }, 15_000);

  it('returns provider-backed timing for waiting image generations', async () => {
    const timeoutSignal = AbortSignal.abort();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutSignal);
    let providerInit: RequestInit | undefined;
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
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        providerInit = init;
        return {
          ok: true,
          json: async () => ({
            code: 200,
            data: {
              state: 'waiting',
              createTime: '2026-04-15T10:00:00.000Z',
              updateTime: '2026-04-15T10:00:05.000Z',
            },
          }),
        } as Response;
      })
    );

    const { GET } = await import('@/app/api/generate-image/route');
    const response = await GET(
      new Request('http://localhost/api/generate-image?id=task-image-status-1', {
        headers: {
          Authorization: 'Bearer token',
          'x-request-id': 'image-status-1',
        },
      }) as never
    );

    const data = await response.json();
    expect(response.status).toBe(200);
    expectPrivateNoStoreTraceHeaders(response, 'image-status-1');
    expect(data.status).toBe('waiting');
    expect(createUserClientMock).toHaveBeenCalledTimes(1);
    expect(rawCreateClientMock).not.toHaveBeenCalled();
    expect(data.timing).toMatchObject({
      appStatus: 'waiting',
      providerState: 'waiting',
      phaseLabel: 'Waiting for provider',
      startedAtMs: Date.parse('2026-04-15T10:00:00.000Z'),
      estimatedTotalMs: 145_000,
    });
    expect(currentSupabaseMock.selects).toContain('id, user_id, prediction_id, status, output_url, created_at, completed_at, model, category, workflow_settings, error_message');
    expect(currentSupabaseMock.selects).not.toContain('*');
    expect(currentSupabaseMock.eqs).toEqual(expect.arrayContaining([
      { column: 'prediction_id', value: 'task-image-status-1' },
      { column: 'user_id', values: ['user-1'] },
    ]));
    expect(timeoutSpy).toHaveBeenCalledWith(10_000);
    expect(providerInit?.signal).toBe(timeoutSignal);
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

  it('returns cached failed image state without lock or provider status calls', async () => {
    currentSupabaseMock = createSupabaseMock(null, {
      id: 'gen-image-failed-1',
      prediction_id: 'task-image-failed-1',
      user_id: 'user-1',
      status: 'failed',
      output_url: null,
      created_at: '2026-04-15T10:00:00.000Z',
      completed_at: '2026-04-15T10:01:00.000Z',
      model: 'nano-banana-2',
      category: 'image',
      workflow_settings: {
        resolution: '1K',
      },
    });

    const providerFetch = vi.fn();
    vi.stubGlobal('fetch', providerFetch);

    const { GET } = await import('@/app/api/generate-image/route');
    const response = await GET(
      new Request('http://localhost/api/generate-image?id=task-image-failed-1', {
        headers: {
          Authorization: 'Bearer token',
        },
      }) as never
    );

    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data).toMatchObject({
      status: 'failed',
      output: null,
      error: null,
      timing: expect.objectContaining({
        appStatus: 'failed',
      }),
    });
    expect(providerFetch).not.toHaveBeenCalled();
    expect(currentSupabaseMock.updates).toHaveLength(0);
    expect(currentSupabaseMock.client.rpc).not.toHaveBeenCalledWith(
      'try_acquire_backend_job_lock',
      expect.objectContaining({ p_name: 'generation-status:task-image-failed-1' })
    );
  });

  it('settles live provider image failures with the atomic backend RPC', async () => {
    currentSupabaseMock = createSupabaseMock(null, {
      id: 'gen-image-live-failed-1',
      prediction_id: 'task-image-live-failed-1',
      user_id: 'user-1',
      status: 'processing',
      output_url: null,
      created_at: '2026-04-15T10:00:00.000Z',
      completed_at: null,
      model: 'nano-banana-2',
      category: 'image',
      workflow_settings: { resolution: '1K' },
    });

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        code: 200,
        data: {
          state: 'fail',
          completeTime: '2026-04-15T10:01:00.000Z',
          failMsg: 'provider failure',
        },
      }),
    } as Response)));

    const { GET } = await import('@/app/api/generate-image/route');
    const response = await GET(
      new Request('http://localhost/api/generate-image?id=task-image-live-failed-1', {
        headers: { Authorization: 'Bearer token' },
      }) as never
    );

    await expect(response.json()).resolves.toMatchObject({
      status: 'failed',
      error: 'provider failure',
    });
    expect(currentSupabaseMock.client.rpc).toHaveBeenCalledWith('settle_generation_failed', {
      p_prediction_id: 'task-image-live-failed-1',
      p_completed_at: '2026-04-15T10:01:00.000Z',
      p_error_message: 'provider failure',
    });
    expect(currentSupabaseMock.client.rpc).not.toHaveBeenCalledWith(
      'refund_generation',
      expect.anything()
    );
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

  it('durably enqueues all Grok image outputs instead of importing them in the status request', async () => {
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

        throw new Error(`status request must not download output media: ${url}`);
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
      status: 'processing',
      output: null,
    });
    expect(currentSupabaseMock.client.rpc).toHaveBeenCalledWith(
      'enqueue_generation_output_import_job',
      {
        p_generation_id: 'gen-grok-image-1',
        p_output_urls: [
          'https://provider.example.com/grok-1.jpg',
          'https://provider.example.com/grok-2.jpg',
        ],
        p_provider_completed_at: '2026-04-15T10:01:00.000Z',
      },
    );
    expect(currentSupabaseMock.client.rpc).not.toHaveBeenCalledWith(
      'settle_generation_succeeded',
      expect.anything(),
    );
    expect(currentSupabaseMock.updates).toHaveLength(0);
  });
});
