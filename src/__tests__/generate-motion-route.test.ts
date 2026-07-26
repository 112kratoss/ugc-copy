import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The media-source guard parses storage locations for real; keep the genuine
// implementation so fixtures exercise the same validation production does.
import { getStoredMediaLocation as actualGetStoredMediaLocation } from '@/lib/media-urls';

const rawCreateClientMock = vi.hoisted(() => vi.fn());
const createUserClientMock = vi.hoisted(() => vi.fn());

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
  creation_mode?: string | null;
  duration?: number | null;
};

let currentSupabaseMock: ReturnType<typeof createSupabaseMock>;
type LockDecision = boolean | ((args: Record<string, unknown>) => boolean);
type AuthUser = { id: string } | null;

function createSupabaseMock(
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
          generation_id: 'gen-motion-1',
          remaining_credits: 88,
          cost: args.p_cost,
        },
        error: null,
      };
    }

    if (fn === 'deduct_credits') {
      return { data: 88, error: null };
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
          createSignedUrl: vi.fn(async (filePath: string) => ({
            data: { signedUrl: `signed:generated_videos/${filePath}` },
            error: null,
          })),
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
                      data: { id: 'gen-motion-1' },
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
}));

function expectPrivateNoStoreTraceHeaders(response: Response, requestId: string) {
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('x-request-id')).toBe(requestId);
}

describe('/api/generate route', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.KIE_AI_API_KEY = 'test-key';
    process.env.KIE_PROVIDER_WEBHOOK_SECRET = 'test-webhook-secret';
    process.env.KIE_WEBHOOK_HMAC_KEY = 'hmac-key';
    process.env.NEXT_PUBLIC_SITE_URL = 'https://magicbooklet.com';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co';
    currentSupabaseMock = createSupabaseMock();
    rawCreateClientMock.mockReset();
    rawCreateClientMock.mockImplementation(() => currentSupabaseMock.client);
    createUserClientMock.mockReset();
    createUserClientMock.mockImplementation(() => currentSupabaseMock.client);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ code: 200, data: { taskId: 'task-motion-1' } }),
      }))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('authenticates before reporting provider configuration errors', async () => {
    currentSupabaseMock = createSupabaseMock(null, true, true, null);
    delete process.env.KIE_AI_API_KEY;

    const { POST } = await import('@/app/api/generate/route');
    const response = await POST(
      new Request('http://localhost/api/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'motion-post-auth-1',
        },
        body: JSON.stringify({
          model: 'kling-2.6',
          characterImageUrl: 'https://signed.example.com/character.png',
          referenceVideoUrl: 'https://signed.example.com/reference.mp4',
        }),
      }) as never
    );

    expect(response.status).toBe(401);
    expectPrivateNoStoreTraceHeaders(response, 'motion-post-auth-1');
    expect(await response.json()).toEqual({
      error: 'Unauthorized: Please log in to generate videos',
    });
    expect(currentSupabaseMock.client.auth.getUser).toHaveBeenCalledTimes(1);
    expect(createUserClientMock).toHaveBeenCalledTimes(1);
    expect(rawCreateClientMock).not.toHaveBeenCalled();
    expect(currentSupabaseMock.client.rpc).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a stale catalog revision before deducting credits', async () => {
    const { POST } = await import('@/app/api/generate/route');
    const response = await POST(
      new Request('http://localhost/api/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token',
          'x-request-id': 'motion-stale-catalog-1',
        },
        body: JSON.stringify({
          model: 'kling-2.6',
          characterImageUrl: 'https://signed.example.com/character.png',
          referenceVideoUrl: 'https://signed.example.com/reference.mp4',
          catalogRevision: 'stale-revision',
        }),
      }) as never
    );

    expect(response.status).toBe(409);
    expectPrivateNoStoreTraceHeaders(response, 'motion-stale-catalog-1');
    expect(response.headers.has('authorization')).toBe(false);
    expect(Array.from(response.headers.entries()).join('\n')).not.toContain('Bearer token');
    expect(await response.json()).toMatchObject({ code: 'CATALOG_CHANGED' });
    expect(currentSupabaseMock.client.rpc).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('persists motion input descriptors for remix restoration', async () => {
    const { POST } = await import('@/app/api/generate/route');
    const response = await POST(
      new Request('http://localhost/api/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token',
          'Idempotency-Key': 'motion-descriptors-start-1',
          'x-request-id': 'motion-rate-limit-1',
        },
        body: JSON.stringify({
          model: 'kling-3.0',
          characterImageUrl: 'https://signed.example.com/character.png',
          referenceVideoUrl: 'https://signed.example.com/reference.mp4',
          duration: 6,
          characterOrientation: 'image',
          mode: '1080p',
          prompt: 'Transfer the performance naturally.',
          characterImage: {
            kind: 'image',
            label: 'Character image',
            storagePath: 'uploads/user-1/character.png',
          },
          referenceVideo: {
            kind: 'video',
            label: 'Reference video',
            sourceGenerationId: 'source-video-1',
          },
        }),
      }) as never
    );

    expect(response.status).toBe(200);
    expect(currentSupabaseMock.inserts[0].workflow_settings).toMatchObject({
      model: 'kling-3.0',
      mode: '1080p',
      characterOrientation: 'image',
      characterImage: {
        kind: 'image',
        label: 'Character image',
        storagePath: 'uploads/user-1/character.png',
      },
      referenceVideo: {
        kind: 'video',
        label: 'Reference video',
        sourceGenerationId: 'source-video-1',
      },
    });
  });

  it('rate limits motion starts before deducting credits or calling the provider', async () => {
    currentSupabaseMock = createSupabaseMock(null, true, false);
    const providerFetch = vi.fn();
    vi.stubGlobal('fetch', providerFetch);

    const { POST } = await import('@/app/api/generate/route');
    const response = await POST(
      new Request('http://localhost/api/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token',
          'x-request-id': 'motion-rate-limit-1',
        },
        body: JSON.stringify({
          model: 'kling-3.0',
          characterImageUrl: 'https://signed.example.com/character.png',
          referenceVideoUrl: 'https://signed.example.com/reference.mp4',
          duration: 6,
          characterOrientation: 'image',
          mode: '1080p',
          prompt: 'Transfer the performance naturally.',
        }),
      }) as never
    );

    expect(response.status).toBe(429);
    expectPrivateNoStoreTraceHeaders(response, 'motion-rate-limit-1');
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

  it('fails closed before deducting credits when the webhook secret is missing', async () => {
    delete process.env.KIE_PROVIDER_WEBHOOK_SECRET;
    const providerFetch = vi.fn();
    vi.stubGlobal('fetch', providerFetch);

    const { POST } = await import('@/app/api/generate/route');
    const response = await POST(
      new Request('http://localhost/api/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token',
          'Idempotency-Key': 'motion-missing-webhook-start-1',
        },
        body: JSON.stringify({
          model: 'kling-3.0',
          characterImageUrl: 'https://signed.example.com/character.png',
          referenceVideoUrl: 'https://signed.example.com/reference.mp4',
          duration: 6,
          characterOrientation: 'image',
          mode: '1080p',
          prompt: 'Transfer the performance naturally.',
        }),
      }) as never
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: 'Generation setup is incomplete. No credits were charged for this attempt. Ask an administrator to finish the service setup before retrying.',
    });
    expect(currentSupabaseMock.client.rpc).not.toHaveBeenCalledWith('start_generation', expect.anything());
    expect(providerFetch).not.toHaveBeenCalled();
    expect(currentSupabaseMock.inserts).toHaveLength(0);
  });

  it('returns provider-backed timing for motion generations', async () => {
    currentSupabaseMock = createSupabaseMock({
      id: 'gen-motion-1',
      prediction_id: 'task-motion-status-1',
      user_id: 'user-1',
      status: 'processing',
      output_url: null,
      created_at: '2026-04-15T10:00:00.000Z',
      completed_at: null,
      model: 'kling-3.0',
      category: 'video',
      creation_mode: 'motion',
      duration: 6,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          code: 200,
          data: {
            state: 'generating',
            createTime: '2026-04-15T10:00:00.000Z',
            updateTime: '2026-04-15T10:00:12.000Z',
          },
        }),
      }))
    );

    const { GET } = await import('@/app/api/generate/route');
    const response = await GET(
      new Request('http://localhost/api/generate?id=task-motion-status-1', {
        headers: {
          Authorization: 'Bearer token',
          'x-request-id': 'motion-status-1',
        },
      }) as never
    );

    const data = await response.json();
    expect(response.status).toBe(200);
    expectPrivateNoStoreTraceHeaders(response, 'motion-status-1');
    expect(data.status).toBe('processing');
    expect(createUserClientMock).toHaveBeenCalledTimes(1);
    expect(rawCreateClientMock).not.toHaveBeenCalled();
    expect(data.timing).toMatchObject({
      appStatus: 'processing',
      providerState: 'generating',
      phaseLabel: 'Generating motion render',
      startedAtMs: Date.parse('2026-04-15T10:00:00.000Z'),
    });
    expect(currentSupabaseMock.selects).toContain('id, user_id, prediction_id, status, output_url, created_at, completed_at, model, category, creation_mode, workflow_settings, duration');
    expect(currentSupabaseMock.selects).not.toContain('*');
    expect(currentSupabaseMock.eqs).toEqual(expect.arrayContaining([
      { column: 'prediction_id', value: 'task-motion-status-1' },
      { column: 'user_id', value: 'user-1' },
    ]));
    expect(currentSupabaseMock.updates).toHaveLength(0);
  });

  it('rejects unauthenticated motion status checks before locks or provider calls', async () => {
    currentSupabaseMock = createSupabaseMock(null, true, true, null);
    const providerFetch = vi.fn();
    vi.stubGlobal('fetch', providerFetch);

    const { GET } = await import('@/app/api/generate/route');
    const response = await GET(
      new Request('http://localhost/api/generate?id=task-motion-unauth-1') as never
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('Unauthorized'),
    });
    expect(currentSupabaseMock.client.rpc).not.toHaveBeenCalledWith('try_acquire_backend_job_lock', expect.anything());
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('rejects unknown motion prediction ids before locks or provider calls', async () => {
    currentSupabaseMock = createSupabaseMock(null);
    const providerFetch = vi.fn();
    vi.stubGlobal('fetch', providerFetch);

    const { GET } = await import('@/app/api/generate/route');
    const response = await GET(
      new Request('http://localhost/api/generate?id=missing-motion-task', {
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
    currentSupabaseMock = createSupabaseMock({
      id: 'gen-motion-locked-1',
      prediction_id: 'task-motion-locked-1',
      user_id: 'user-1',
      status: 'processing',
      output_url: null,
      created_at: '2026-04-15T10:00:00.000Z',
      completed_at: null,
      model: 'kling-3.0',
      category: 'video',
      creation_mode: 'motion',
      duration: 6,
    }, false);

    const providerFetch = vi.fn();
    vi.stubGlobal('fetch', providerFetch);

    const { GET } = await import('@/app/api/generate/route');
    const response = await GET(
      new Request('http://localhost/api/generate?id=task-motion-locked-1', {
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

  it('returns cached failed motion state without lock or provider status calls', async () => {
    currentSupabaseMock = createSupabaseMock({
      id: 'gen-motion-failed-1',
      prediction_id: 'task-motion-failed-1',
      user_id: 'user-1',
      status: 'failed',
      output_url: null,
      created_at: '2026-04-15T10:00:00.000Z',
      completed_at: '2026-04-15T10:01:00.000Z',
      model: 'kling-3.0',
      category: 'video',
      creation_mode: 'motion',
      duration: 6,
    });

    const providerFetch = vi.fn();
    vi.stubGlobal('fetch', providerFetch);

    const { GET } = await import('@/app/api/generate/route');
    const response = await GET(
      new Request('http://localhost/api/generate?id=task-motion-failed-1', {
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
      expect.objectContaining({ p_name: 'generation-status:task-motion-failed-1' })
    );
  });

  it('settles live provider motion failures with the atomic backend RPC', async () => {
    currentSupabaseMock = createSupabaseMock({
      id: 'gen-motion-live-failed-1',
      prediction_id: 'task-motion-live-failed-1',
      user_id: 'user-1',
      status: 'processing',
      output_url: null,
      created_at: '2026-04-15T10:00:00.000Z',
      completed_at: null,
      model: 'kling-3.0',
      category: 'video',
      creation_mode: 'motion',
      duration: 6,
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

    const { GET } = await import('@/app/api/generate/route');
    const response = await GET(
      new Request('http://localhost/api/generate?id=task-motion-live-failed-1', {
        headers: { Authorization: 'Bearer token' },
      }) as never
    );

    await expect(response.json()).resolves.toMatchObject({
      status: 'failed',
      error: 'provider failure',
    });
    expect(currentSupabaseMock.client.rpc).toHaveBeenCalledWith('settle_generation_failed', {
      p_prediction_id: 'task-motion-live-failed-1',
      p_completed_at: '2026-04-15T10:01:00.000Z',
    });
    expect(currentSupabaseMock.client.rpc).not.toHaveBeenCalledWith(
      'refund_generation',
      expect.anything()
    );
    expect(currentSupabaseMock.updates).toHaveLength(0);
  });

  it('settles live provider motion success with the atomic backend RPC', async () => {
    const statusSignal = AbortSignal.abort();
    const mediaSignal = AbortSignal.abort();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
      .mockReturnValueOnce(statusSignal)
      .mockReturnValueOnce(mediaSignal);
    let statusInit: RequestInit | undefined;
    let mediaInit: RequestInit | undefined;
    currentSupabaseMock = createSupabaseMock({
      id: 'gen-motion-live-success-1',
      prediction_id: 'task-motion-live-success-1',
      user_id: 'user-1',
      status: 'processing',
      output_url: null,
      created_at: '2026-04-15T10:00:00.000Z',
      completed_at: null,
      model: 'kling-3.0',
      category: 'video',
      creation_mode: 'motion',
      duration: 6,
    });

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/recordInfo')) {
        statusInit = init;
        return {
          ok: true,
          json: async () => ({
            code: 200,
            data: {
              state: 'success',
              completeTime: '2026-04-15T10:01:00.000Z',
              resultJson: JSON.stringify({
                resultUrls: ['https://provider.example.com/motion.mp4'],
              }),
            },
          }),
        } as Response;
      }

      mediaInit = init;
      return {
        ok: true,
        blob: async () => new Blob(['video'], { type: 'video/mp4' }),
      } as Response;
    }));

    const { GET } = await import('@/app/api/generate/route');
    const response = await GET(
      new Request('http://localhost/api/generate?id=task-motion-live-success-1', {
        headers: { Authorization: 'Bearer token' },
      }) as never
    );

    await expect(response.json()).resolves.toMatchObject({
      status: 'succeeded',
      output: 'signed:generated_videos/user-1/generated_task-motion-live-success-1.mp4',
    });
    expect(currentSupabaseMock.client.rpc).toHaveBeenCalledWith('settle_generation_succeeded', expect.objectContaining({
      p_prediction_id: 'task-motion-live-success-1',
      p_output_url: 'generated_videos/user-1/generated_task-motion-live-success-1.mp4',
      p_completed_at: '2026-04-15T10:01:00.000Z',
    }));
    expect(timeoutSpy).toHaveBeenNthCalledWith(1, 10_000);
    expect(timeoutSpy).toHaveBeenNthCalledWith(2, 60_000);
    expect(statusInit?.signal).toBe(statusSignal);
    expect(mediaInit?.signal).toBe(mediaSignal);
    expect(currentSupabaseMock.updates).toHaveLength(0);
  });

  it('throttles provider status checks while returning cached active motion state', async () => {
    currentSupabaseMock = createSupabaseMock({
      id: 'gen-motion-throttled-1',
      prediction_id: 'task-motion-throttled-1',
      user_id: 'user-1',
      status: 'processing',
      output_url: null,
      created_at: '2026-04-15T10:00:00.000Z',
      completed_at: null,
      model: 'kling-3.0',
      category: 'video',
      creation_mode: 'motion',
      duration: 6,
    }, (args) => !String(args.p_name).startsWith('generation-provider-status:'));

    const providerFetch = vi.fn();
    vi.stubGlobal('fetch', providerFetch);

    const { GET } = await import('@/app/api/generate/route');
    const response = await GET(
      new Request('http://localhost/api/generate?id=task-motion-throttled-1', {
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
      p_name: 'generation-provider-status:task-motion-throttled-1',
      p_ttl_seconds: 15,
    }));
  });
});
