import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let currentSupabaseMock: ReturnType<typeof createSupabaseMock>;

function createSupabaseMock() {
  const inserts: Record<string, unknown>[] = [];
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
                    void value;
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
});
