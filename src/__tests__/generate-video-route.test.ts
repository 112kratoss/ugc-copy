import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type SourceGenerationRow = {
  id: string;
  user_id: string;
  is_public: boolean;
};

let currentSupabaseMock: ReturnType<typeof createSupabaseMock>;

function createSupabaseMock(sourceGeneration: SourceGenerationRow | null = null) {
  const inserts: Record<string, unknown>[] = [];
  const rpc = vi.fn(async (fn: string) => {
    if (fn === 'deduct_credits') {
      return { data: 1576, error: null };
    }

    if (fn === 'refund_credits') {
      return { data: true, error: null };
    }

    return { data: null, error: null };
  });

  return {
    inserts,
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
                if (column !== 'id') {
                  throw new Error(`Unexpected select column: ${column}`);
                }

                return {
                  async maybeSingle() {
                    if (sourceGeneration && sourceGeneration.id === value) {
                      return { data: sourceGeneration, error: null };
                    }

                    return { data: null, error: null };
                  },
                };
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
  createServiceClient: vi.fn(),
  resolveStoredMediaUrl: vi.fn(),
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
    expect((providerBody?.input as Record<string, unknown>).multi_prompt).toBeUndefined();
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
    expect((providerBody?.input as Record<string, unknown>).prompt).toBeUndefined();
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
});
