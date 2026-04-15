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
  sourceGeneration: SourceGenerationRow | null,
  localGeneration: LocalGenerationRow | null = null
) {
  const inserts: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const rpc = vi.fn(async (fn: string) => {
    if (fn === 'deduct_credits') {
      return { data: 92, error: null };
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
  createServiceClient: vi.fn(),
  resolveStoredMediaUrl: vi.fn(),
}));

describe('/api/generate-image route', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.KIE_AI_API_KEY = 'test-key';
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
    });
    expect(currentSupabaseMock.updates).toHaveLength(0);
  });
});
