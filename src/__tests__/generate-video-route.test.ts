import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
};

let currentSupabaseMock: ReturnType<typeof createSupabaseMock>;
type LockDecision = boolean | ((args: Record<string, unknown>) => boolean);
type AuthUser = { id: string } | null;

function createSupabaseMock(
  sourceGeneration: SourceGenerationRow | null = null,
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
          generation_id: 'gen-logged-2',
          remaining_credits: 1576,
          cost: args.p_cost,
        },
        error: null,
      };
    }

    if (fn === 'deduct_credits') {
      return { data: 1576, error: null };
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
                      data: { id: 'gen-logged-2' },
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
  createUserClient: (request: Request) => createUserClientMock(request),
  createServiceClient: vi.fn(() => currentSupabaseMock.client),
  resolveStoredMediaUrl: vi.fn(async (_supabase: unknown, value: string) => value),
}));

function expectPrivateNoStoreTraceHeaders(response: Response, requestId: string) {
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('x-request-id')).toBe(requestId);
}

describe('/api/generate-video route', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.KIE_AI_API_KEY = 'test-key';
    process.env.WEBHOOK_SECRET = 'test-webhook-secret';
    process.env.NEXT_PUBLIC_SITE_URL = 'https://magicbooklet.com';
    delete process.env.KIE_WEBHOOK_HMAC_KEY;
    currentSupabaseMock = createSupabaseMock();
    rawCreateClientMock.mockReset();
    rawCreateClientMock.mockImplementation(() => currentSupabaseMock.client);
    createUserClientMock.mockReset();
    createUserClientMock.mockImplementation(() => currentSupabaseMock.client);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('authenticates before reporting provider configuration errors', async () => {
    currentSupabaseMock = createSupabaseMock(null, null, true, true, null);
    delete process.env.KIE_AI_API_KEY;
    const providerFetch = vi.fn();
    vi.stubGlobal('fetch', providerFetch);

    const { POST } = await import('@/app/api/generate-video/route');
    const response = await POST(
      new Request('http://localhost/api/generate-video', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'video-post-auth-1',
        },
        body: JSON.stringify({
          model: 'kling-3.0-video',
          prompt: 'A cinematic product video',
        }),
      }) as never
    );

    expect(response.status).toBe(401);
    expectPrivateNoStoreTraceHeaders(response, 'video-post-auth-1');
    expect(await response.json()).toEqual({
      error: 'Unauthorized: Please log in to generate videos',
    });
    expect(currentSupabaseMock.client.auth.getUser).toHaveBeenCalledTimes(1);
    expect(createUserClientMock).toHaveBeenCalledTimes(1);
    expect(rawCreateClientMock).not.toHaveBeenCalled();
    expect(currentSupabaseMock.client.rpc).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('rejects a stale catalog revision before deducting credits', async () => {
    const providerFetch = vi.fn();
    vi.stubGlobal('fetch', providerFetch);

    const { POST } = await import('@/app/api/generate-video/route');
    const response = await POST(
      new Request('http://localhost/api/generate-video', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token',
          'x-request-id': 'video-stale-catalog-1',
        },
        body: JSON.stringify({
          model: 'kling-3.0-video',
          prompt: 'A cinematic product video',
          catalogRevision: 'stale-revision',
        }),
      }) as never
    );

    expect(response.status).toBe(409);
    expectPrivateNoStoreTraceHeaders(response, 'video-stale-catalog-1');
    expect(response.headers.has('authorization')).toBe(false);
    expect(Array.from(response.headers.entries()).join('\n')).not.toContain('Bearer token');
    expect(await response.json()).toMatchObject({ code: 'CATALOG_CHANGED' });
    expect(currentSupabaseMock.client.rpc).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('sends Kling single-shot requests with an explicit multi_shots flag', async () => {
    let providerBody: Record<string, unknown> | null = null;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        providerBody = JSON.parse(String(init?.body));
        return {
          ok: true,
          json: async () => ({ code: 200, data: { taskId: 'task-1' } }),
        };
      })
    );

    const { POST } = await import('@/app/api/generate-video/route');
    const response = await POST(
      new Request('http://localhost/api/generate-video', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token',
          'x-request-id': 'video-rate-limit-1',
        },
        body: JSON.stringify({
          model: 'kling-3.0-video',
          isMultiShot: false,
          prompt: 'Two cats doing kung fu',
          duration: 7,
          aspectRatio: '16:9',
          mode: 'std',
          sound: true,
        }),
      }) as never
    );

    expect(response.status).toBe(200);
    expect((await response.clone().json()).generationId).toBe('gen-logged-2');
    expect(providerBody).toMatchObject({
      model: 'kling-3.0/video',
      input: {
        prompt: 'Two cats doing kung fu',
        multi_shots: false,
        duration: '7',
        aspect_ratio: '16:9',
        mode: 'std',
        sound: true,
      },
    });
    expect(((providerBody as { input?: Record<string, unknown> } | null)?.input ?? {}).multi_prompt).toBeUndefined();
  });

  it('rate limits video starts before deducting credits or calling the provider', async () => {
    currentSupabaseMock = createSupabaseMock(null, null, true, false);
    const providerFetch = vi.fn();
    vi.stubGlobal('fetch', providerFetch);

    const { POST } = await import('@/app/api/generate-video/route');
    const response = await POST(
      new Request('http://localhost/api/generate-video', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token',
          'x-request-id': 'video-rate-limit-1',
        },
        body: JSON.stringify({
          model: 'kling-3.0-video',
          prompt: 'Two cats doing kung fu',
          duration: 7,
          aspectRatio: '16:9',
          mode: 'std',
        }),
      }) as never
    );

    expect(response.status).toBe(429);
    expectPrivateNoStoreTraceHeaders(response, 'video-rate-limit-1');
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

  it('sends Kling multi-shot requests with total duration and prompt segments', async () => {
    let providerBody: Record<string, unknown> | null = null;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        providerBody = JSON.parse(String(init?.body));
        return {
          ok: true,
          json: async () => ({ code: 200, data: { taskId: 'task-2' } }),
        };
      })
    );

    const { POST } = await import('@/app/api/generate-video/route');
    const response = await POST(
      new Request('http://localhost/api/generate-video', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token',
        },
        body: JSON.stringify({
          model: 'kling-3.0-video',
          isMultiShot: true,
          multiPrompts: [
            { id: '1', prompt: ' First shot ', duration: 3 },
            { id: '2', prompt: 'Second shot', duration: 5 },
          ],
          aspectRatio: '16:9',
          mode: 'pro',
          sound: true,
        }),
      }) as never
    );

    expect(response.status).toBe(200);
    expect((await response.clone().json()).generationId).toBe('gen-logged-2');
    expect(providerBody).toMatchObject({
      model: 'kling-3.0/video',
      input: {
        multi_shots: true,
        duration: '8',
        aspect_ratio: '16:9',
        mode: 'pro',
        sound: true,
        multi_prompt: [
          { prompt: 'First shot', duration: 3 },
          { prompt: 'Second shot', duration: 5 },
        ],
      },
    });
    expect(((providerBody as { input?: Record<string, unknown> } | null)?.input ?? {}).prompt).toBeUndefined();
  });

  it('persists frame descriptors when remixing with start and end frames', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ code: 200, data: { taskId: 'task-3' } }),
      }))
    );

    const { POST } = await import('@/app/api/generate-video/route');
    const response = await POST(
      new Request('http://localhost/api/generate-video', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token',
        },
        body: JSON.stringify({
          model: 'kling-3.0-video',
          isMultiShot: false,
          prompt: 'Turn this frame pair into a product reveal.',
          duration: 5,
          aspectRatio: '16:9',
          mode: 'std',
          referenceMode: 'frames',
          startImageUrl: 'https://signed.example.com/start.png',
          endImageUrl: 'https://signed.example.com/end.png',
          startFrame: {
            kind: 'image',
            label: 'Start frame',
            storagePath: 'uploads/user-1/start.png',
          },
          endFrame: {
            kind: 'image',
            label: 'End frame',
            storagePath: 'uploads/user-1/end.png',
          },
        }),
      }) as never
    );

    expect(response.status).toBe(200);
    expect(currentSupabaseMock.inserts[0].workflow_settings).toMatchObject({
      referenceMode: 'frames',
      startFrame: {
        kind: 'image',
        label: 'Start frame',
        storagePath: 'uploads/user-1/start.png',
      },
      endFrame: {
        kind: 'image',
        label: 'End frame',
        storagePath: 'uploads/user-1/end.png',
      },
    });
  });

  it('passes Seedance 2 reference video and audio arrays through to the provider payload', async () => {
    let providerBody: Record<string, unknown> | null = null;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        providerBody = JSON.parse(String(init?.body));
        return {
          ok: true,
          json: async () => ({ code: 200, data: { taskId: 'task-seedance-2' } }),
        };
      })
    );

    const { POST } = await import('@/app/api/generate-video/route');
    const response = await POST(
      new Request('http://localhost/api/generate-video', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token',
        },
        body: JSON.stringify({
          model: 'seedance-2',
          prompt: 'Keep the energy of the reference clips.',
          duration: 10,
          aspectRatio: '16:9',
          resolution: '720p',
          sound: true,
          elements: [
            {
              id: 'element-1',
              displayName: 'Hero',
              handle: '@hero',
              storagePath: 'uploads/user-1/hero.png',
              sourceGenerationId: null,
            },
          ],
          elementImageUrls: ['https://signed.example.com/hero.png'],
          referenceVideoUrls: ['asset-video-1'],
          referenceAudioUrls: ['asset-audio-1'],
          seedanceAssets: {
            images: [{ assetId: 'asset-image-1', assetType: 'Image', status: 'active', sourceUrl: 'https://signed.example.com/hero.png', error: null, lastCheckedAt: '2026-04-04T00:00:00.000Z' }],
            videos: [{ assetId: 'asset-video-1', assetType: 'Video', status: 'active', sourceUrl: 'https://signed.example.com/ref.mp4', error: null, lastCheckedAt: '2026-04-04T00:00:00.000Z' }],
            audios: [{ assetId: 'asset-audio-1', assetType: 'Audio', status: 'active', sourceUrl: 'https://signed.example.com/ref.wav', error: null, lastCheckedAt: '2026-04-04T00:00:00.000Z' }],
          },
        }),
      }) as never
    );

    expect(response.status).toBe(200);
    expect(providerBody).toMatchObject({
      model: 'bytedance/seedance-2',
      input: {
        prompt: 'Keep the energy of the reference clips.',
        reference_image_urls: ['https://signed.example.com/hero.png'],
        reference_video_urls: ['asset-video-1'],
        reference_audio_urls: ['asset-audio-1'],
        generate_audio: true,
        resolution: '720p',
        aspect_ratio: '16:9',
        duration: 10,
        web_search: false,
        return_last_frame: false,
      },
    });
    expect(currentSupabaseMock.inserts[0].workflow_settings).toMatchObject({
      referenceVideoUrls: ['asset-video-1'],
      referenceAudioUrls: ['asset-audio-1'],
      seedanceAssets: {
        videos: [expect.objectContaining({ assetId: 'asset-video-1' })],
        audios: [expect.objectContaining({ assetId: 'asset-audio-1' })],
      },
    });
  });

  it('passes Kling video elements through to the provider payload', async () => {
    let providerBody: Record<string, unknown> | null = null;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        providerBody = JSON.parse(String(init?.body));
        return {
          ok: true,
          json: async () => ({ code: 200, data: { taskId: 'task-kling-elements' } }),
        };
      })
    );

    const { POST } = await import('@/app/api/generate-video/route');
    const response = await POST(
      new Request('http://localhost/api/generate-video', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token',
        },
        body: JSON.stringify({
          model: 'kling-3.0-video',
          prompt: 'Use @motion_ref as the physical timing reference.',
          duration: 5,
          aspectRatio: '16:9',
          mode: 'std',
          klingVideoElements: [
            {
              url: 'asset-video-1',
              handle: '@motion_ref',
              displayName: 'Motion ref',
              storagePath: null,
              sourceGenerationId: null,
            },
          ],
        }),
      }) as never
    );

    expect(response.status).toBe(200);
    expect(providerBody).toMatchObject({
      model: 'kling-3.0/video',
      input: {
        prompt: 'Use @motion_ref as the physical timing reference.',
        kling_elements: [
          {
            name: 'motion_ref',
            description: 'Motion ref',
            element_input_video_urls: ['asset-video-1'],
          },
        ],
      },
    });
    expect(currentSupabaseMock.inserts[0].workflow_settings).toMatchObject({
      klingVideoElements: [
        expect.objectContaining({
          handle: '@motion_ref',
          displayName: 'Motion ref',
        }),
      ],
    });
  });

  it('returns provider-backed timing for waiting video generations', async () => {
    currentSupabaseMock = createSupabaseMock(null, {
      id: 'gen-video-1',
      prediction_id: 'task-video-status-1',
      user_id: 'user-1',
      status: 'processing',
      output_url: null,
      created_at: '2026-04-15T10:00:00.000Z',
      completed_at: null,
      model: 'kling-3.0-video',
      category: 'video',
      creation_mode: null,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          code: 200,
          data: {
            state: 'queuing',
            createTime: '2026-04-15T10:00:00.000Z',
            updateTime: '2026-04-15T10:00:08.000Z',
          },
        }),
      }))
    );

    const { GET } = await import('@/app/api/generate-video/route');
    const response = await GET(
      new Request('http://localhost/api/generate-video?id=task-video-status-1', {
        headers: {
          Authorization: 'Bearer token',
          'x-request-id': 'video-status-1',
        },
      }) as never
    );

    const data = await response.json();
    expect(response.status).toBe(200);
    expectPrivateNoStoreTraceHeaders(response, 'video-status-1');
    expect(data.status).toBe('waiting');
    expect(createUserClientMock).toHaveBeenCalledTimes(1);
    expect(rawCreateClientMock).not.toHaveBeenCalled();
    expect(data.timing).toMatchObject({
      appStatus: 'waiting',
      providerState: 'queuing',
      phaseLabel: 'Queued at provider',
      startedAtMs: Date.parse('2026-04-15T10:00:00.000Z'),
    });
    expect(currentSupabaseMock.selects).toContain('id, user_id, prediction_id, status, output_url, created_at, completed_at, model, category, creation_mode, workflow_settings, duration');
    expect(currentSupabaseMock.selects).not.toContain('*');
    expect(currentSupabaseMock.eqs).toEqual(expect.arrayContaining([
      { column: 'prediction_id', value: 'task-video-status-1' },
      { column: 'user_id', value: 'user-1' },
    ]));
    expect(currentSupabaseMock.updates).toHaveLength(0);
  });

  it('rejects unauthenticated video status checks before locks or provider calls', async () => {
    currentSupabaseMock = createSupabaseMock(null, null, true, true, null);
    const providerFetch = vi.fn();
    vi.stubGlobal('fetch', providerFetch);

    const { GET } = await import('@/app/api/generate-video/route');
    const response = await GET(
      new Request('http://localhost/api/generate-video?id=task-video-unauth-1') as never
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('Unauthorized'),
    });
    expect(currentSupabaseMock.client.rpc).not.toHaveBeenCalledWith('try_acquire_backend_job_lock', expect.anything());
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('rejects unknown video prediction ids before locks or provider calls', async () => {
    currentSupabaseMock = createSupabaseMock(null, null);
    const providerFetch = vi.fn();
    vi.stubGlobal('fetch', providerFetch);

    const { GET } = await import('@/app/api/generate-video/route');
    const response = await GET(
      new Request('http://localhost/api/generate-video?id=missing-video-task', {
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
      id: 'gen-video-locked-1',
      prediction_id: 'task-video-locked-1',
      user_id: 'user-1',
      status: 'processing',
      output_url: null,
      created_at: '2026-04-15T10:00:00.000Z',
      completed_at: null,
      model: 'kling-3.0-video',
      category: 'video',
      creation_mode: null,
    }, false);

    const providerFetch = vi.fn();
    vi.stubGlobal('fetch', providerFetch);

    const { GET } = await import('@/app/api/generate-video/route');
    const response = await GET(
      new Request('http://localhost/api/generate-video?id=task-video-locked-1', {
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

  it('returns cached failed video state without lock or provider status calls', async () => {
    currentSupabaseMock = createSupabaseMock(null, {
      id: 'gen-video-failed-1',
      prediction_id: 'task-video-failed-1',
      user_id: 'user-1',
      status: 'failed',
      output_url: null,
      created_at: '2026-04-15T10:00:00.000Z',
      completed_at: '2026-04-15T10:01:00.000Z',
      model: 'kling-3.0-video',
      category: 'video',
      creation_mode: null,
    });

    const providerFetch = vi.fn();
    vi.stubGlobal('fetch', providerFetch);

    const { GET } = await import('@/app/api/generate-video/route');
    const response = await GET(
      new Request('http://localhost/api/generate-video?id=task-video-failed-1', {
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
      expect.objectContaining({ p_name: 'generation-status:task-video-failed-1' })
    );
  });

  it('settles live provider video failures with the atomic backend RPC', async () => {
    currentSupabaseMock = createSupabaseMock(null, {
      id: 'gen-video-live-failed-1',
      prediction_id: 'task-video-live-failed-1',
      user_id: 'user-1',
      status: 'processing',
      output_url: null,
      created_at: '2026-04-15T10:00:00.000Z',
      completed_at: null,
      model: 'kling-3.0-video',
      category: 'video',
      creation_mode: null,
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

    const { GET } = await import('@/app/api/generate-video/route');
    const response = await GET(
      new Request('http://localhost/api/generate-video?id=task-video-live-failed-1', {
        headers: { Authorization: 'Bearer token' },
      }) as never
    );

    await expect(response.json()).resolves.toMatchObject({
      status: 'failed',
      error: 'provider failure',
    });
    expect(currentSupabaseMock.client.rpc).toHaveBeenCalledWith('settle_generation_failed', {
      p_prediction_id: 'task-video-live-failed-1',
      p_completed_at: '2026-04-15T10:01:00.000Z',
    });
    expect(currentSupabaseMock.client.rpc).not.toHaveBeenCalledWith(
      'refund_generation',
      expect.anything()
    );
    expect(currentSupabaseMock.updates).toHaveLength(0);
  });

  it('settles live provider video success with the atomic backend RPC', async () => {
    const statusSignal = AbortSignal.abort();
    const mediaSignal = AbortSignal.abort();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
      .mockReturnValueOnce(statusSignal)
      .mockReturnValueOnce(mediaSignal);
    let statusInit: RequestInit | undefined;
    let mediaInit: RequestInit | undefined;
    currentSupabaseMock = createSupabaseMock(null, {
      id: 'gen-video-live-success-1',
      prediction_id: 'task-video-live-success-1',
      user_id: 'user-1',
      status: 'processing',
      output_url: null,
      created_at: '2026-04-15T10:00:00.000Z',
      completed_at: null,
      model: 'kling-3.0-video',
      category: 'video',
      creation_mode: null,
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
                resultUrls: ['https://provider.example.com/video.mp4'],
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

    const { GET } = await import('@/app/api/generate-video/route');
    const response = await GET(
      new Request('http://localhost/api/generate-video?id=task-video-live-success-1', {
        headers: { Authorization: 'Bearer token' },
      }) as never
    );

    await expect(response.json()).resolves.toMatchObject({
      status: 'succeeded',
      output: 'signed:generated_videos/user-1/generated_task-video-live-success-1.mp4',
    });
    expect(currentSupabaseMock.client.rpc).toHaveBeenCalledWith('settle_generation_succeeded', expect.objectContaining({
      p_prediction_id: 'task-video-live-success-1',
      p_output_url: 'generated_videos/user-1/generated_task-video-live-success-1.mp4',
      p_completed_at: '2026-04-15T10:01:00.000Z',
    }));
    expect(timeoutSpy).toHaveBeenNthCalledWith(1, 10_000);
    expect(timeoutSpy).toHaveBeenNthCalledWith(2, 60_000);
    expect(statusInit?.signal).toBe(statusSignal);
    expect(mediaInit?.signal).toBe(mediaSignal);
    expect(currentSupabaseMock.updates).toHaveLength(0);
  });

  it('throttles provider status checks while returning cached active video state', async () => {
    currentSupabaseMock = createSupabaseMock(null, {
      id: 'gen-video-throttled-1',
      prediction_id: 'task-video-throttled-1',
      user_id: 'user-1',
      status: 'processing',
      output_url: null,
      created_at: '2026-04-15T10:00:00.000Z',
      completed_at: null,
      model: 'kling-3.0-video',
      category: 'video',
      creation_mode: null,
    }, (args) => !String(args.p_name).startsWith('generation-provider-status:'));

    const providerFetch = vi.fn();
    vi.stubGlobal('fetch', providerFetch);

    const { GET } = await import('@/app/api/generate-video/route');
    const response = await GET(
      new Request('http://localhost/api/generate-video?id=task-video-throttled-1', {
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
      p_name: 'generation-provider-status:task-video-throttled-1',
      p_ttl_seconds: 15,
    }));
  });
});
