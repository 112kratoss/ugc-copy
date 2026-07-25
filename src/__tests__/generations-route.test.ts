import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rawCreateClientMock = vi.hoisted(() => vi.fn());
const createUserClientMock = vi.hoisted(() => vi.fn());

type GenerationRow = {
  id: string;
  user_id: string;
  output_url: string | null;
  preview_url?: string | null;
  thumbnail_url?: string | null;
  showcase_asset_path?: string | null;
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
let generationPreviewColumnsAvailable = true;
let trackGenerationSelect: ((columns: string) => void) | null = null;
let linkedPostsState: Array<{
  id: string;
  generation_id: string | null;
  title: string | null;
  visibility: 'public' | 'unlisted' | 'private';
  archived_at: string | null;
}> = [];
let inputMediaState: Array<{
  id: string;
  generation_id: string;
  user_id: string;
  media_type: 'image' | 'video' | 'audio';
  role: string;
  label: string | null;
  storage_path: string;
  source_generation_id: string | null;
  sort_order: number;
  metadata: Record<string, unknown> | null;
}> = [];
let serviceTableCalls: string[] = [];
const syncGenerationStatusesMock = vi.fn(async (params?: { generationIds: string[] }) => {
  void params;
});

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
          select(columns?: string) {
            trackGenerationSelect?.(columns ?? '');
            const filters: Record<string, unknown> = {};
            let rangeStart = 0;
            let rangeEnd: number | null = null;
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
              or() {
                return query;
              },
              range(start: number, end: number) {
                rangeStart = start;
                rangeEnd = end;
                return query;
              },
              then(resolve: (value: { data: GenerationRow[]; error: null } | { data: null; error: { code: string; message: string } }) => void) {
                const selectedColumns = columns ?? '';
                if (
                  !generationPreviewColumnsAvailable
                  && (selectedColumns.includes('preview_url') || selectedColumns.includes('thumbnail_url'))
                ) {
                  resolve({
                    data: null,
                    error: {
                      code: '42703',
                      message: selectedColumns.includes('preview_url')
                        ? 'column generations.preview_url does not exist'
                        : 'column generations.thumbnail_url does not exist',
                    },
                  });
                  return;
                }

                const data = generationsState.filter((generation) => {
                  if (filters.user_id && generation.user_id !== filters.user_id) {
                    return false;
                  }
                  if (filters.id && generation.id !== filters.id) {
                    return false;
                  }
                  if (filters.archived_at === null && generation.archived_at) {
                    return false;
                  }
                  return true;
                });
                resolve({
                  data: rangeEnd === null ? data : data.slice(rangeStart, rangeEnd + 1),
                  error: null,
                });
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
    createClient: (...args: unknown[]) => rawCreateClientMock(...args),
  };
});

vi.mock('@/lib/generation-status-sync', () => ({
  syncGenerationStatuses: (...args: unknown[]) =>
    (syncGenerationStatusesMock as (...a: unknown[]) => unknown)(...args),
}));

vi.mock('@/lib/generation-services', () => ({
}));

vi.mock('@/lib/server-helpers', () => ({
  createUserClient: (request: Request) => createUserClientMock(request),
  createServiceClient: () => {
    const baseClient = createSupabaseClientMock();
    return {
      ...baseClient,
      from(table: string) {
        serviceTableCalls.push(table);
        if (table === 'generation_input_media') {
          return {
            select() {
              return {
                in(_column: string, values: string[]) {
                  return {
                    order() {
                      return {
                        data: inputMediaState.filter((item) => values.includes(item.generation_id)),
                        error: null,
                      };
                    },
                  };
                },
              };
            },
          };
        }

        return baseClient.from(table);
      },
      storage: {
        from(bucket: string) {
          return {
            createSignedUrl: async (filePath: string) => ({
              data: { signedUrl: `https://signed.example.com/${bucket}/${filePath}` },
              error: null,
            }),
            createSignedUrls: async (filePaths: string[]) => ({
              data: filePaths.map((filePath) => ({
                error: null,
                path: filePath,
                signedUrl: `https://signed.example.com/${bucket}/${filePath}`,
              })),
              error: null,
            }),
            getPublicUrl: (filePath: string) => ({
              data: { publicUrl: `https://public.example.com/${bucket}/${filePath}` },
            }),
          };
        },
      },
    };
  },
  buildMediaProxyUrl: (bucket: string, filePath: string) => `https://proxy.example.com/${bucket}/${filePath}`,
  getStoredMediaLocation: (outputUrl: string) => {
    if (outputUrl.startsWith('http')) {
      return null;
    }

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
  resolveStoredMediaUrl: async (_supabase: unknown, outputUrl: string) => {
    if (outputUrl.startsWith('http')) {
      return outputUrl;
    }

    const normalized = outputUrl.replace(/^\/+/, '');
    const slashIndex = normalized.indexOf('/');

    if (slashIndex === -1) {
      return outputUrl;
    }

    return `https://signed.example.com/${normalized.slice(0, slashIndex)}/${normalized.slice(slashIndex + 1)}`;
  },
  resolveOwnedStoredMediaUrl: async (
    _supabase: unknown,
    outputUrl: string,
    ownerUserId: string,
  ) => {
    if (outputUrl.startsWith('http')) {
      const url = new URL(outputUrl);
      return url.protocol === 'https:' && !url.username && !url.password ? outputUrl : null;
    }

    const normalized = outputUrl.replace(/^\/+/, '');
    const slashIndex = normalized.indexOf('/');
    if (slashIndex === -1) {
      return null;
    }

    const bucket = normalized.slice(0, slashIndex);
    const filePath = normalized.slice(slashIndex + 1);
    if (!filePath.startsWith(`${ownerUserId}/`)) {
      return null;
    }

    return `https://signed.example.com/${bucket}/${filePath}`;
  },
}));

describe('/api/generations route', () => {
  beforeEach(() => {
    vi.resetModules();
    syncGenerationStatusesMock.mockReset();
    syncGenerationStatusesMock.mockResolvedValue(undefined);
    rawCreateClientMock.mockReset();
    rawCreateClientMock.mockImplementation(() => createSupabaseClientMock());
    createUserClientMock.mockReset();
    createUserClientMock.mockImplementation(() => createSupabaseClientMock());
    generationPreviewColumnsAvailable = true;
    trackGenerationSelect = null;
    serviceTableCalls = [];
    generationsState = [
      {
        id: 'gen-1',
        user_id: 'user-1',
        output_url: 'generated_images/user-1/output.jpg',
        showcase_asset_path: null,
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
    inputMediaState = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not provider-sync active generations while listing creations', async () => {
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
    expect(createUserClientMock).toHaveBeenCalledTimes(1);
    expect(rawCreateClientMock).not.toHaveBeenCalled();
    expect(syncGenerationStatusesMock).not.toHaveBeenCalled();
    expect(data.generations[0].status).toBe('processing');
    expect(data.generations[0].output_url).toBe('https://signed.example.com/generated_images/user-1/output.jpg');
    expect(data.generations[0].title).toBe('Launch still');
    expect(data.generations[0].description).toBe('A polished creator-style launch image.');
    expect(data.generations[0].prompt).toBe('A creator-style product image with warm natural light.');
    expect(data.generations[0].completed_at).toBeNull();
    expect(data.generations[0].workflow_settings).toBeUndefined();
    expect(data.generations[0].input_media).toEqual([
      expect.objectContaining({
        label: 'Bottle',
        role: 'reference_image',
        url: 'https://signed.example.com/uploads/user-1/bottle.png',
      }),
    ]);
    expect(data.generations[0].paywallPrefill).toMatchObject({
      promptText: 'A creator-style product image with warm natural light.',
      allowRemix: true,
      resourceKinds: ['prompt', 'notes', 'remix', 'files'],
      referenceCount: 1,
    });
    expect(String(data.generations[0].paywallPrefill.notesMarkdown)).toContain('Model: Nano Banana 2.0');
  });

  it('returns a bounded page with pagination metadata', async () => {
    generationsState = [
      {
        ...generationsState[0],
        id: 'gen-page-1',
        output_url: 'generated_images/user-1/page-1.jpg',
        created_at: '2026-03-24T13:00:00.000Z',
      },
      {
        ...generationsState[0],
        id: 'gen-page-2',
        output_url: 'generated_images/user-1/page-2.jpg',
        created_at: '2026-03-24T12:00:00.000Z',
      },
      {
        ...generationsState[0],
        id: 'gen-page-3',
        output_url: 'generated_images/user-1/page-3.jpg',
        created_at: '2026-03-24T11:00:00.000Z',
      },
    ];

    const { GET } = await import('@/app/api/generations/route');
    const response = await GET(
      {
        headers: new Headers({
          Authorization: 'Bearer test-token',
        }),
        nextUrl: new URL('http://localhost/api/generations?limit=2'),
      } as never
    );

    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.generations).toHaveLength(2);
    expect(data.generations.map((generation: { id: string }) => generation.id)).toEqual([
      'gen-page-1',
      'gen-page-2',
    ]);
    expect(data.pagination).toEqual({
      limit: 2,
      hasMore: true,
      nextCursor: '2',
    });
  });

  it('returns lightweight summary pages without expanding input media or paywall details', async () => {
    generationsState = [
      {
        ...generationsState[0],
        id: 'gen-summary-1',
        output_url: 'generated_images/user-1/summary-1.jpg',
        workflow_settings: {
          outputs: [
            { index: 0, storagePath: 'generated_images/user-1/summary-1.jpg' },
            { index: 1, storagePath: 'generated_images/user-1/summary-2.jpg' },
          ],
          elements: [
            {
              id: 'element-summary',
              displayName: 'Hero product',
              storagePath: 'uploads/user-1/product.png',
            },
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
        nextUrl: new URL('http://localhost/api/generations?detail=summary&limit=1'),
      } as never
    );

    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.generations).toHaveLength(1);
    expect(data.generations[0]).toMatchObject({
      id: 'gen-summary-1',
      output_url: 'https://signed.example.com/generated_images/user-1/summary-1.jpg',
      output_count: 2,
    });
    expect(data.generations[0].workflow_settings).toBeUndefined();
    expect(data.generations[0].input_media).toBeUndefined();
    expect(data.generations[0].paywallPrefill).toBeUndefined();
    expect(data.generations[0].output_urls).toBeUndefined();
    expect(serviceTableCalls).not.toContain('generation_input_media');
  });

  it('returns status-only Studio projections without media signing', async () => {
    generationsState = [
      {
        ...generationsState[0],
        id: 'gen-status-1',
        status: 'succeeded',
        output_url: 'generated_images/user-1/status-1.jpg',
        completed_at: '2026-03-24T11:01:00.000Z',
        workflow_settings: {
          outputs: [
            { index: 0, storagePath: 'generated_images/user-1/status-1.jpg' },
          ],
          elements: [
            {
              id: 'element-status',
              displayName: 'Hero product',
              storagePath: 'uploads/user-1/product.png',
            },
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
        nextUrl: new URL('http://localhost/api/generations?detail=status&limit=1'),
      } as never
    );

    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.generations).toEqual([
      {
        id: 'gen-status-1',
        status: 'succeeded',
        created_at: '2026-03-24T11:00:00.000Z',
        completed_at: '2026-03-24T11:01:00.000Z',
        category: 'image',
        model: 'nano-banana-2',
        origin: 'creation',
        template: null,
      },
    ]);
    expect(data.pagination).toEqual({
      limit: 1,
      hasMore: false,
      nextCursor: null,
    });
    expect(serviceTableCalls).toEqual(['generations']);
  });

  it('supports owner-scoped exact generation lookup without loading the whole history', async () => {
    generationsState = [
      {
        ...generationsState[0],
        id: 'gen-lookup-newest',
        output_url: 'generated_images/user-1/lookup-newest.jpg',
        created_at: '2026-03-24T13:00:00.000Z',
      },
      {
        ...generationsState[0],
        id: 'gen-lookup-middle',
        output_url: 'generated_images/user-1/lookup-middle.jpg',
        created_at: '2026-03-24T12:00:00.000Z',
      },
      {
        ...generationsState[0],
        id: 'gen-lookup-target',
        output_url: 'generated_images/user-1/lookup-target.jpg',
        created_at: '2026-03-24T11:00:00.000Z',
      },
    ];

    const { GET } = await import('@/app/api/generations/route');
    const response = await GET(
      {
        headers: new Headers({
          Authorization: 'Bearer test-token',
        }),
        nextUrl: new URL('http://localhost/api/generations?id=gen-lookup-target&limit=1'),
      } as never
    );

    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.generations).toHaveLength(1);
    expect(data.generations[0].id).toBe('gen-lookup-target');
    expect(data.generations[0].output_url).toBe('https://signed.example.com/generated_images/user-1/lookup-target.jpg');
    expect(data.pagination).toEqual({
      limit: 1,
      hasMore: false,
      nextCursor: null,
    });
  });

  it('projects Grok multi-output image URLs without exposing workflow settings', async () => {
    generationsState = [
      {
        id: 'gen-grok-1',
        user_id: 'user-1',
        output_url: 'generated_images/user-1/grok-0.jpg',
        showcase_asset_path: null,
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
    expect(data.generations[0].output_url).toBe('https://signed.example.com/generated_images/user-1/grok-0.jpg');
    expect(data.generations[0].output_urls).toEqual([
      'https://signed.example.com/generated_images/user-1/grok-0.jpg',
      'https://signed.example.com/generated_images/user-1/grok-1.jpg',
    ]);
    expect(data.generations[0].workflow_settings).toBeUndefined();
  });

  it('returns signed preview URLs for image and video generations', async () => {
    generationsState = [
      {
        id: 'gen-image-1',
        user_id: 'user-1',
        output_url: 'generated_images/user-1/image-output.jpg',
        preview_url: null,
        showcase_asset_path: null,
        status: 'succeeded',
        created_at: '2026-03-24T11:00:00.000Z',
        completed_at: '2026-03-24T11:01:00.000Z',
        duration: null,
        cost: 4,
        model: 'nano-banana-2',
        category: 'image',
        is_public: false,
        title: 'Image output',
        description: null,
        prompt: 'An image generation.',
        workflow_settings: null,
      },
      {
        id: 'gen-video-1',
        user_id: 'user-1',
        output_url: 'generated_videos/user-1/video-output.mp4',
        preview_url: 'generated_videos/user-1/video-output.preview.webp',
        showcase_asset_path: null,
        status: 'succeeded',
        created_at: '2026-03-24T11:00:00.000Z',
        completed_at: '2026-03-24T11:01:00.000Z',
        duration: null,
        cost: 12,
        model: 'kling-3.0-video',
        category: 'video',
        is_public: false,
        title: 'Video output',
        description: null,
        prompt: 'A video generation.',
        workflow_settings: null,
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
    expect(data.generations[0].preview_url).toBe('https://signed.example.com/generated_images/user-1/image-output.jpg');
    expect(data.generations[1].preview_url).toBe('https://signed.example.com/generated_videos/user-1/video-output.preview.webp');
    expect(data.generations[1].output_url).toBe('https://signed.example.com/generated_videos/user-1/video-output.mp4');
    expect(data.generations[1].media).toMatchObject({
      id: 'gen-video-1',
      kind: 'video',
      url: 'https://signed.example.com/generated_videos/user-1/video-output.mp4',
      previewUrl: 'https://signed.example.com/generated_videos/user-1/video-output.preview.webp',
      cacheKey: 'generated_videos/user-1/video-output.preview.webp',
      status: 'ready',
      gridReady: true,
    });
    expect(data.generations[1].media.expiresAt).toEqual(expect.any(String));
  });

  it('surfaces a schema error instead of retrying a narrower column list', async () => {
    // The route used to probe a ladder of column lists, leading with a
    // `thumbnail_url` column that no longer exists in production — so every
    // request logged a guaranteed Postgres error before falling back. The
    // schema is stable now, so a missing column is a genuine fault: it must
    // surface rather than be masked by a retry.
    generationPreviewColumnsAvailable = false;
    generationsState = [
      {
        id: 'gen-image-legacy-schema',
        user_id: 'user-1',
        output_url: 'generated_images/user-1/image-output.jpg',
        showcase_asset_path: null,
        status: 'succeeded',
        created_at: '2026-03-24T11:00:00.000Z',
        completed_at: '2026-03-24T11:01:00.000Z',
        duration: null,
        cost: 4,
        model: 'nano-banana-2',
        category: 'image',
        is_public: false,
        title: 'Image output',
        description: null,
        prompt: 'An image generation.',
        workflow_settings: null,
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

    expect(response.status).toBe(500);
  });

  it('never selects the retired thumbnail_url column', async () => {
    const selectedColumnLists: string[] = [];
    generationsState = [];
    trackGenerationSelect = (columns: string) => {
      selectedColumnLists.push(columns);
    };

    const { GET } = await import('@/app/api/generations/route');
    const response = await GET(
      {
        headers: new Headers({
          Authorization: 'Bearer test-token',
        }),
        nextUrl: new URL('http://localhost/api/generations'),
      } as never
    );

    expect(response.status).toBe(200);
    expect(selectedColumnLists.length).toBeGreaterThan(0);
    for (const columns of selectedColumnLists) {
      expect(columns).not.toContain('thumbnail_url');
    }
  });

  it('prefers durable showcase assets over expired provider URLs', async () => {
    generationsState = [
      {
        id: 'gen-published-1',
        user_id: 'user-1',
        output_url: 'https://tempfile.example.com/expired.jpg',
        showcase_asset_path: 'showcase/gen-published-1/expired.jpg',
        status: 'succeeded',
        created_at: '2026-03-24T11:00:00.000Z',
        completed_at: '2026-03-24T11:01:00.000Z',
        duration: null,
        cost: 4,
        model: 'nano-banana-2',
        category: 'image',
        is_public: false,
        title: 'Published image',
        description: null,
        prompt: 'A durable published preview.',
        workflow_settings: null,
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
    expect(data.generations[0].output_url).toBe('https://public.example.com/showcase_media/showcase/gen-published-1/expired.jpg');
    expect(data.generations[0].workflow_settings).toBeUndefined();
  });

  it('returns durable input media when snapshots exist', async () => {
    inputMediaState = [
      {
        id: 'input-1',
        generation_id: 'gen-1',
        user_id: 'user-1',
        media_type: 'image',
        role: 'reference_image',
        label: 'Hero bottle',
        storage_path: 'generation_inputs/user-1/gen-1/00-reference-image.png',
        source_generation_id: null,
        sort_order: 0,
        metadata: { handle: '@hero' },
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
    expect(data.generations[0].input_media).toEqual([
      expect.objectContaining({
        id: 'input-1',
        label: 'Hero bottle',
        mediaType: 'image',
        role: 'reference_image',
        url: 'https://signed.example.com/generation_inputs/user-1/gen-1/00-reference-image.png',
      }),
    ]);
    expect(data.generations[0].workflow_settings).toBeUndefined();
  });

  it('returns durable input media when snapshots exist', async () => {
    inputMediaState = [
      {
        id: 'input-1',
        generation_id: 'gen-1',
        user_id: 'user-1',
        media_type: 'image',
        role: 'reference_image',
        label: 'Hero bottle',
        storage_path: 'generation_inputs/user-1/gen-1/00-reference-image.png',
        source_generation_id: null,
        sort_order: 0,
        metadata: { handle: '@hero' },
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
    expect(data.generations[0].input_media).toEqual([
      expect.objectContaining({
        id: 'input-1',
        label: 'Hero bottle',
        mediaType: 'image',
        role: 'reference_image',
        url: 'https://signed.example.com/generation_inputs/user-1/gen-1/00-reference-image.png',
      }),
    ]);
    expect(data.generations[0].workflow_settings).toBeUndefined();
  });

  it('returns active generations without provider sync side effects', async () => {
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
    expect(syncGenerationStatusesMock).not.toHaveBeenCalled();
    expect(data.generations[0].status).toBe('processing');
    expect(data.generations[0].title).toBe('Launch still');
    expect(data.generations[0].description).toBe('A polished creator-style launch image.');
    expect(data.generations[0].prompt).toBe('A creator-style product image with warm natural light.');
    expect(data.generations[0].completed_at).toBeNull();
    expect(data.generations[0].workflow_settings).toBeUndefined();
    expect(data.generations[0].paywallPrefill).toMatchObject({
      allowRemix: true,
      resourceKinds: ['prompt', 'notes', 'remix', 'files'],
      referenceCount: 1,
    });
  });
});
