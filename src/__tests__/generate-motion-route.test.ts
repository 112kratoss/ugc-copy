import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    if (fn === 'deduct_credits') {
      return { data: 88, error: null };
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
    createClient: vi.fn(() => currentSupabaseMock.client),
  };
});

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: vi.fn(() => currentSupabaseMock.client),
  resolveStoredMediaUrl: vi.fn(),
}));

describe('/api/generate route', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.KIE_AI_API_KEY = 'test-key';
    process.env.WEBHOOK_SECRET = 'test-webhook-secret';
    process.env.NEXT_PUBLIC_SITE_URL = 'https://magicbooklet.com';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co';
    delete process.env.KIE_WEBHOOK_HMAC_KEY;
    currentSupabaseMock = createSupabaseMock();
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
        },
        body: JSON.stringify({
          model: 'kling-2.6',
          characterImageUrl: 'https://signed.example.com/character.png',
          referenceVideoUrl: 'https://signed.example.com/reference.mp4',
        }),
      }) as never
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: 'Unauthorized: Please log in to generate videos',
    });
    expect(currentSupabaseMock.client.auth.getUser).toHaveBeenCalledTimes(1);
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
    await expect(response.json()).resolves.toMatchObject({ code: 'RATE_LIMITED' });
    expect(currentSupabaseMock.client.rpc).toHaveBeenCalledWith('check_backend_rate_limit', expect.objectContaining({
      p_scope: 'media-generation:start',
      p_subject_key: 'user-1',
    }));
    expect(currentSupabaseMock.client.rpc).not.toHaveBeenCalledWith('deduct_credits', expect.anything());
    expect(providerFetch).not.toHaveBeenCalled();
    expect(currentSupabaseMock.inserts).toHaveLength(0);
  });

  it('fails closed before deducting credits when the webhook secret is missing', async () => {
    delete process.env.WEBHOOK_SECRET;
    const providerFetch = vi.fn();
    vi.stubGlobal('fetch', providerFetch);

    const { POST } = await import('@/app/api/generate/route');
    const response = await POST(
      new Request('http://localhost/api/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token',
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

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: 'Server configuration error: webhook secret missing',
    });
    expect(currentSupabaseMock.client.rpc).not.toHaveBeenCalledWith('deduct_credits', expect.anything());
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
      category: 'motion',
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
        },
      }) as never
    );

    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.status).toBe('processing');
    expect(data.timing).toMatchObject({
      appStatus: 'processing',
      providerState: 'generating',
      phaseLabel: 'Generating motion render',
      startedAtMs: Date.parse('2026-04-15T10:00:00.000Z'),
    });
    expect(currentSupabaseMock.selects).toContain('id, user_id, prediction_id, status, output_url, created_at, completed_at, model, category, workflow_settings, duration');
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
      category: 'motion',
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
      category: 'motion',
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
