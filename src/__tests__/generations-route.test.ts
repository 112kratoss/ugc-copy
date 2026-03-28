import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type GenerationRow = {
  id: string;
  user_id: string;
  output_url: string | null;
  status: string;
  created_at: string;
  duration: number | null;
  cost: number | null;
  model: string;
  category: string | null;
  is_public: boolean;
  title: string | null;
  prompt: string | null;
};

let generationsState: GenerationRow[] = [];
const syncGenerationStatusesMock = vi.fn(async () => undefined);

function createSupabaseClientMock() {
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: {
          user: { id: 'user-1' },
        },
        error: null,
      })),
    },
    from(table: string) {
      if (table !== 'generations') {
        throw new Error(`Unexpected table: ${table}`);
      }

      return {
        select() {
          return {
            eq(column: string, value: unknown) {
              if (column !== 'user_id') {
                throw new Error(`Unexpected filter column: ${column}`);
              }

              return {
                async order() {
                  return {
                    data: generationsState.filter((generation) => generation.user_id === value),
                    error: null,
                  };
                },
              };
            },
          };
        },
      };
    },
  };
}

vi.mock('@supabase/supabase-js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@supabase/supabase-js')>();
  return {
    ...actual,
    createClient: vi.fn(() => createSupabaseClientMock()),
  };
});

vi.mock('@/lib/generation-services', () => ({
  syncGenerationStatuses: (params: { generationIds: string[] }) => syncGenerationStatusesMock(params),
}));

vi.mock('@/lib/server-helpers', () => ({
  buildMediaProxyUrl: (bucket: string, filePath: string) => `https://proxy.example.com/${bucket}/${filePath}`,
  getStoredMediaLocation: (outputUrl: string) => {
    const normalized = outputUrl.replace(/^\/+/, '');
    const slashIndex = normalized.indexOf('/');

    if (slashIndex === -1) {
      return null;
    }

    return {
      bucket: normalized.slice(0, slashIndex),
      filePath: normalized.slice(slashIndex + 1),
    };
  },
}));

describe('/api/generations route', () => {
  beforeEach(() => {
    vi.resetModules();
    syncGenerationStatusesMock.mockReset();
    syncGenerationStatusesMock.mockResolvedValue(undefined);
    generationsState = [
      {
        id: 'gen-1',
        user_id: 'user-1',
        output_url: 'generated_images/user-1/output.jpg',
        status: 'processing',
        created_at: '2026-03-24T11:00:00.000Z',
        duration: null,
        cost: 8,
        model: 'nano-banana-2',
        category: 'image',
        is_public: false,
        title: 'Launch still',
        prompt: 'A creator-style product image with warm natural light.',
      },
    ];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('syncs processing generations and returns the refreshed rows', async () => {
    syncGenerationStatusesMock.mockImplementationOnce(async () => {
      generationsState = generationsState.map((generation) => ({
        ...generation,
        status: 'succeeded',
      }));
    });

    const { GET } = await import('@/app/api/generations/route');
    const response = await GET(
      new Request('http://localhost/api/generations', {
        headers: {
          Authorization: 'Bearer test-token',
        },
      }) as never
    );

    const data = await response.json();
    expect(response.status).toBe(200);
    expect(syncGenerationStatusesMock).toHaveBeenCalledWith({
      supabase: expect.any(Object),
      generationIds: ['gen-1'],
    });
    expect(data.generations[0].status).toBe('succeeded');
    expect(data.generations[0].output_url).toBe('https://proxy.example.com/generated_images/user-1/output.jpg');
    expect(data.generations[0].title).toBe('Launch still');
    expect(data.generations[0].prompt).toBe('A creator-style product image with warm natural light.');
  });

  it('returns data even when syncing processing generations fails', async () => {
    syncGenerationStatusesMock.mockRejectedValueOnce(new Error('provider unavailable'));

    const { GET } = await import('@/app/api/generations/route');
    const response = await GET(
      new Request('http://localhost/api/generations', {
        headers: {
          Authorization: 'Bearer test-token',
        },
      }) as never
    );

    const data = await response.json();
    expect(response.status).toBe(200);
    expect(syncGenerationStatusesMock).toHaveBeenCalledWith({
      supabase: expect.any(Object),
      generationIds: ['gen-1'],
    });
    expect(data.generations[0].status).toBe('processing');
    expect(data.generations[0].title).toBe('Launch still');
    expect(data.generations[0].prompt).toBe('A creator-style product image with warm natural light.');
  });
});
