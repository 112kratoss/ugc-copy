import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type GenerationRow = {
  id: string;
  user_id: string;
  output_url: string | null;
  status: string;
  created_at: string;
  completed_at?: string | null;
  duration: number | null;
  cost: number | null;
  model: string;
  category: string | null;
  is_public: boolean;
  title: string | null;
  description: string | null;
  prompt: string | null;
  workflow_settings?: Record<string, unknown> | null;
  archived_at?: string | null;
};

let generationsState: GenerationRow[] = [];
let linkedPostsState: Array<{
  id: string;
  generation_id: string | null;
  title: string | null;
  visibility: 'public' | 'unlisted' | 'private';
  archived_at: string | null;
}> = [];
const syncGenerationStatusesMock = vi.fn(async (_params?: { generationIds: string[] }) => undefined);

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
      if (table === 'generations') {
        return {
          select() {
            const filters: Record<string, unknown> = {};
            const query = {
              eq(column: string, value: unknown) {
                filters[column] = value;
                return query;
              },
              order() {
                return query;
              },
              is(column: string, value: unknown) {
                filters[column] = value;
                return query;
              },
              then(resolve: (value: { data: GenerationRow[]; error: null }) => void) {
                const data = generationsState.filter((generation) => {
                  if (filters.user_id && generation.user_id !== filters.user_id) {
                    return false;
                  }
                  if (filters.archived_at === null && generation.archived_at) {
                    return false;
                  }
                  return true;
                });
                resolve({ data, error: null });
              },
            };

            return query;
          },
        };
      }

      if (table === 'posts') {
        return {
          select() {
            const filters: Record<string, unknown> = {};
            let generationIds: string[] = [];
            const query = {
              in(column: string, values: string[]) {
                if (column === 'generation_id') {
                  generationIds = values;
                }
                return query;
              },
              eq(column: string, value: unknown) {
                filters[column] = value;
                return query;
              },
              is(column: string, value: unknown) {
                filters[column] = value;
                return query;
              },
              then(resolve: (value: { data: typeof linkedPostsState; error: null }) => void) {
                const data = linkedPostsState.filter((post) => {
                  if (generationIds.length > 0 && (!post.generation_id || !generationIds.includes(post.generation_id))) {
                    return false;
                  }
                  if (filters.archived_at === null && post.archived_at) {
                    return false;
                  }
                  return true;
                });
                resolve({ data, error: null });
              },
            };

            return query;
          },
        };
      }

      throw new Error(`Unexpected table: ${table}`);
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
        completed_at: null,
        duration: null,
        cost: 8,
        model: 'nano-banana-2',
        category: 'image',
        is_public: false,
        title: 'Launch still',
        description: 'A polished creator-style launch image.',
        prompt: 'A creator-style product image with warm natural light.',
        workflow_settings: {
          model: 'nano-banana-2',
          aspectRatio: '4:5',
          resolution: '1K',
          elements: [
            {
              id: 'element-1',
              displayName: 'Bottle',
              handle: '@bottle',
              storagePath: 'uploads/user-1/bottle.png',
            },
          ],
        },
      },
    ];
    linkedPostsState = [];
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
      {
        headers: new Headers({
          Authorization: 'Bearer test-token',
        }),
        nextUrl: new URL('http://localhost/api/generations'),
      } as never
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
    expect(data.generations[0].description).toBe('A polished creator-style launch image.');
    expect(data.generations[0].prompt).toBe('A creator-style product image with warm natural light.');
    expect(data.generations[0].completed_at).toBeNull();
    expect(data.generations[0].workflow_settings).toBeUndefined();
    expect(data.generations[0].paywallPrefill).toMatchObject({
      promptText: 'A creator-style product image with warm natural light.',
      allowRemix: true,
      resourceKinds: ['prompt', 'notes', 'remix'],
    });
    expect(String(data.generations[0].paywallPrefill.notesMarkdown)).toContain('Model: Nano Banana 2.0');
  });

  it('projects Grok multi-output image URLs without exposing workflow settings', async () => {
    generationsState = [
      {
        id: 'gen-grok-1',
        user_id: 'user-1',
        output_url: 'generated_images/user-1/grok-0.jpg',
        status: 'succeeded',
        created_at: '2026-03-24T11:00:00.000Z',
        completed_at: '2026-03-24T11:01:00.000Z',
        duration: null,
        cost: 4,
        model: 'grok-imagine-image',
        category: 'image',
        is_public: false,
        title: 'Grok set',
        description: null,
        prompt: 'A product poster.',
        workflow_settings: {
          outputs: [
            { index: 0, storagePath: 'generated_images/user-1/grok-0.jpg' },
            { index: 1, storagePath: 'generated_images/user-1/grok-1.jpg' },
          ],
        },
      },
    ];

    const { GET } = await import('@/app/api/generations/route');
    const response = await GET(
      {
        headers: new Headers({
          Authorization: 'Bearer test-token',
        }),
        nextUrl: new URL('http://localhost/api/generations'),
      } as never
    );

    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.generations[0].output_url).toBe('https://proxy.example.com/generated_images/user-1/grok-0.jpg');
    expect(data.generations[0].output_urls).toEqual([
      'https://proxy.example.com/generated_images/user-1/grok-0.jpg',
      'https://proxy.example.com/generated_images/user-1/grok-1.jpg',
    ]);
    expect(data.generations[0].workflow_settings).toBeUndefined();
  });

  it('returns data even when syncing processing generations fails', async () => {
    syncGenerationStatusesMock.mockRejectedValueOnce(new Error('provider unavailable'));

    const { GET } = await import('@/app/api/generations/route');
    const response = await GET(
      {
        headers: new Headers({
          Authorization: 'Bearer test-token',
        }),
        nextUrl: new URL('http://localhost/api/generations'),
      } as never
    );

    const data = await response.json();
    expect(response.status).toBe(200);
    expect(syncGenerationStatusesMock).toHaveBeenCalledWith({
      supabase: expect.any(Object),
      generationIds: ['gen-1'],
    });
    expect(data.generations[0].status).toBe('processing');
    expect(data.generations[0].title).toBe('Launch still');
    expect(data.generations[0].description).toBe('A polished creator-style launch image.');
    expect(data.generations[0].prompt).toBe('A creator-style product image with warm natural light.');
    expect(data.generations[0].completed_at).toBeNull();
    expect(data.generations[0].workflow_settings).toBeUndefined();
    expect(data.generations[0].paywallPrefill).toMatchObject({
      allowRemix: true,
      resourceKinds: ['prompt', 'notes', 'remix'],
    });
  });
});
