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

function createSupabaseMock(localGeneration: LocalGenerationRow | null = null) {
  const inserts: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const rpc = vi.fn(async (fn: string) => {
    if (fn === 'deduct_credits') {
      return { data: 88, error: null };
    }

    if (fn === 'refund_credits') {
      return { data: true, error: null };
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
                    void column;
                    void value;
                    return { data: null, error: null };
                  },
                  async single() {
                    if (column === 'prediction_id' && localGeneration && localGeneration.prediction_id === value) {
                      return { data: localGeneration, error: null };
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
  createServiceClient: vi.fn(),
  resolveStoredMediaUrl: vi.fn(),
}));

describe('/api/generate route', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.KIE_AI_API_KEY = 'test-key';
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
    expect(currentSupabaseMock.updates).toHaveLength(0);
  });
});
