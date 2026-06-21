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
};

let currentSupabaseMock: ReturnType<typeof createSupabaseMock>;

function createSupabaseMock(
  sourceGeneration: SourceGenerationRow | null = null,
  localGeneration: LocalGenerationRow | null = null,
  lockAcquired = true,
  rateLimitAllowed = true
) {
  const inserts: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const rpc = vi.fn(async (fn: string) => {
    if (fn === 'deduct_credits') {
      return { data: 1576, error: null };
    }

    if (fn === 'refund_credits') {
      return { data: true, error: null };
    }

    if (fn === 'refund_generation') {
      return { data: true, error: null };
    }

    if (fn === 'try_acquire_backend_job_lock') {
      return { data: lockAcquired, error: null };
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
    client: {
      auth: {
        getUser: vi.fn(async () => ({
          data: {
            user: { id: 'user-1' },
          },
          error: null,
        })),
      },
      rpc,
      from: vi.fn((table: string) => {
        if (table !== 'generations') {
          throw new Error(`Unexpected table access: ${table}`);
        }

        return {
          select() {
            return {
              eq(column: string, value: unknown) {
                return {
                  async maybeSingle() {
                    if (column === 'id' && sourceGeneration && sourceGeneration.id === value) {
                      return { data: sourceGeneration, error: null };
                    }

                    return { data: null, error: null };
                  },
                  async single() {
                    if (column === 'prediction_id' && localGeneration && localGeneration.prediction_id === value) {
                      return { data: localGeneration, error: null };
                    }

                    if (column === 'id' && sourceGeneration && sourceGeneration.id === value) {
                      return { data: sourceGeneration, error: null };
                    }

                    return { data: null, error: null };
                  },
                };
              },
            };
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
    createClient: vi.fn(() => currentSupabaseMock.client),
  };
});

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: vi.fn(() => currentSupabaseMock.client),
  resolveStoredMediaUrl: vi.fn(async (_supabase: unknown, value: string) => value),
}));

describe('/api/generate-video route', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.KIE_AI_API_KEY = 'test-key';
    currentSupabaseMock = createSupabaseMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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
        },
        body: JSON.stringify({
          model: 'kling-3.0-video',
          prompt: 'A cinematic product video',
          catalogRevision: 'stale-revision',
        }),
      }) as never
    );

    expect(response.status).toBe(409);
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
    await expect(response.json()).resolves.toMatchObject({ code: 'RATE_LIMITED' });
    expect(currentSupabaseMock.client.rpc).toHaveBeenCalledWith('check_backend_rate_limit', expect.objectContaining({
      p_scope: 'media-generation:start',
      p_subject_key: 'user-1',
    }));
    expect(currentSupabaseMock.client.rpc).not.toHaveBeenCalledWith('deduct_credits', expect.anything());
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
        },
      }) as never
    );

    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.status).toBe('waiting');
    expect(data.timing).toMatchObject({
      appStatus: 'waiting',
      providerState: 'queuing',
      phaseLabel: 'Queued at provider',
      startedAtMs: Date.parse('2026-04-15T10:00:00.000Z'),
    });
    expect(currentSupabaseMock.updates).toHaveLength(0);
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
});
