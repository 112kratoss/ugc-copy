import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type GenerationRow = {
  id: string;
  user_id: string | null;
  is_public: boolean | null;
  share_input_media_for_remix?: boolean | null;
  output_url: string | null;
  showcase_asset_path: string | null;
  category: string | null;
  model: string | null;
  prompt: string | null;
  title: string | null;
  workflow_settings: Record<string, unknown> | null;
};

type PostRow = {
  id: string;
  user_id: string | null;
  generation_id: string | null;
  title: string | null;
  body?: string | null;
  prompt: string | null;
  category: string | null;
  post_format?: string | null;
  visibility: 'public' | 'unlisted' | 'private';
  archived_at: string | null;
  review_status?: 'visible' | 'flagged' | 'hidden' | null;
  showcase_asset_path?: string | null;
  output_url?: string | null;
  source_kind: string | null;
  source_tool?: string | null;
  source_tool_slug?: string | null;
  save_count?: number | null;
  remix_count?: number | null;
  share_visit_count?: number | null;
  created_at: string;
};

let currentUserId: string | null = 'user-1';
let generationRows = new Map<string, GenerationRow>();
let postRows = new Map<string, PostRow>();
let signedUploads = new Map<string, string | null>();
let inputMediaRows: Array<{
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

const resolveStoredMediaUrlMock = vi.fn(
  async (_adminClient: unknown, outputUrl: string) => `https://signed.example.com/${encodeURIComponent(outputUrl)}`
);

function createRouteRequest(url: string) {
  return {
    nextUrl: new URL(url),
    headers: new Headers({
      Authorization: 'Bearer token',
    }),
  } as never;
}

function createAdminClientMock() {
  return {
    from: vi.fn((table: string) => {
      if (table === 'post_resource_bundles') {
        const query = {
          select() {
            return query;
          },
          eq() {
            return query;
          },
          async maybeSingle() {
            return { data: null, error: null };
          },
        };
        return query;
      }

      if (table === 'profiles') {
        return {
          select() {
            return {
              async in() {
                return {
                  data: [{
                    id: 'creator-1',
                    username: 'creator',
                    display_name: 'Creator',
                    avatar_url: null,
                  }],
                  error: null,
                };
              },
            };
          },
        };
      }

      if (table === 'generation_input_media') {
        return {
          select() {
            return {
              in(_column: string, values: string[]) {
                return {
                  order() {
                    return {
                      data: inputMediaRows.filter((row) => values.includes(row.generation_id)),
                      error: null,
                    };
                  },
                };
              },
            };
          },
        };
      }

      if (table === 'posts') {
        return {
          select() {
            return {
              eq(column: string, value: unknown) {
                if (column !== 'id') {
                  throw new Error(`Unexpected filter column: ${column}`);
                }

                return {
                  async maybeSingle() {
                    return {
                      data: postRows.get(String(value)) ?? null,
                      error: null,
                    };
                  },
                };
              },
            };
          },
        };
      }

      if (table !== 'generations') {
        throw new Error(`Unexpected table access: ${table}`);
      }

      return {
        select() {
          return {
            eq(column: string, value: unknown) {
              if (column !== 'id') {
                throw new Error(`Unexpected filter column: ${column}`);
              }

              return {
                async maybeSingle() {
                  return {
                    data: generationRows.get(String(value)) ?? null,
                    error: null,
                  };
                },
              };
            },
          };
        },
      };
    }),
    storage: {
      from: vi.fn((bucket: string) => {
        if (bucket === 'uploads') {
          return {
            createSignedUrl: vi.fn(async (filePath: string) => {
              const signedUrl = signedUploads.get(filePath);
              if (!signedUrl) {
                return {
                  data: null,
                  error: { message: 'Missing asset' },
                };
              }

              return {
                data: { signedUrl },
                error: null,
              };
            }),
            createSignedUrls: vi.fn(async (filePaths: string[]) => ({
              data: filePaths.map((filePath) => {
                const signedUrl = signedUploads.get(filePath);
                return signedUrl
                  ? { error: null, path: filePath, signedUrl }
                  : { error: 'Missing asset', path: filePath, signedUrl: null };
              }),
              error: null,
            })),
          };
        }

        if (bucket === 'generation_inputs') {
          return {
            createSignedUrl: vi.fn(async (filePath: string) => ({
              data: { signedUrl: `https://signed.example.com/generation-inputs/${filePath}` },
              error: null,
            })),
            createSignedUrls: vi.fn(async (filePaths: string[]) => ({
              data: filePaths.map((filePath) => ({
                error: null,
                path: filePath,
                signedUrl: `https://signed.example.com/generation-inputs/${filePath}`,
              })),
              error: null,
            })),
          };
        }

        if (bucket === 'showcase_media') {
          return {
            getPublicUrl: vi.fn((filePath: string) => ({
              data: {
                publicUrl: `https://public.example.com/${filePath}`,
              },
            })),
          };
        }

        throw new Error(`Unexpected storage bucket: ${bucket}`);
      }),
    },
  };
}

vi.mock('@/lib/server-helpers', () => ({
  createUserClient: vi.fn(() => ({
    auth: {
      getUser: vi.fn(async () => ({
        data: {
          user: currentUserId ? { id: currentUserId } : null,
        },
        error: currentUserId ? null : { message: 'Unauthorized' },
      })),
    },
  })),
  createServiceClient: vi.fn(() => createAdminClientMock()),
  resolveStoredMediaUrl: (...args: Parameters<typeof resolveStoredMediaUrlMock>) =>
    resolveStoredMediaUrlMock(...args),
}));

describe('/api/remix-source route', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    currentUserId = 'user-1';
    generationRows = new Map();
    postRows = new Map();
    signedUploads = new Map();
    inputMediaRows = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('redacts public source input media when the owner has not opted in', async () => {
    currentUserId = 'user-2';

    generationRows.set('ref-1', {
      id: 'ref-1',
      user_id: 'creator-2',
      is_public: false,
      share_input_media_for_remix: false,
      output_url: 'generated_images/creator-2/ref-1.png',
      showcase_asset_path: null,
      category: 'image',
      model: 'nano-banana-2',
      prompt: 'Reference prompt',
      title: 'Reference generation',
      workflow_settings: {},
    });

    generationRows.set('source-1', {
      id: 'source-1',
      user_id: 'creator-1',
      is_public: true,
      share_input_media_for_remix: false,
      output_url: 'generated_images/creator-1/source-1.png',
      showcase_asset_path: null,
      category: 'image',
      model: 'nano-banana-2',
      prompt: 'A bright creator product shot.',
      title: 'Hero frame',
      workflow_settings: {
        elements: [
          {
            id: 'el-1',
            displayName: 'Bottle',
            handle: '@bottle',
            storagePath: 'uploads/creator-1/bottle.png',
          },
          {
            id: 'el-2',
            displayName: 'Reference result',
            handle: '@reference_result',
            sourceGenerationId: 'ref-1',
          },
        ],
      },
    });
    signedUploads.set('creator-1/bottle.png', 'https://signed.example.com/uploads/creator-1/bottle.png');

    const { GET } = await import('@/app/api/remix-source/route');
    const response = await GET(createRouteRequest('http://localhost/api/remix-source?id=source-1'));

    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.generation).toMatchObject({
      id: 'source-1',
      title: 'Hero frame',
      prompt: 'A bright creator product shot.',
      category: 'image',
    });
    expect(data.result).toMatchObject({
      mediaType: 'image',
      url: 'https://signed.example.com/generated_images%2Fcreator-1%2Fsource-1.png',
    });
    expect(data.inputs.image).toBeUndefined();
    expect(data.inputMedia).toEqual([]);
    expect(data.workflowSettings.elements).toBeUndefined();
    expect(data.restoreIssues).toEqual([]);
  });

  it('restores public recipe reference images when remix starts from the linked post', async () => {
    currentUserId = 'user-2';

    generationRows.set('source-1', {
      id: 'source-1',
      user_id: 'creator-1',
      is_public: true,
      share_input_media_for_remix: false,
      output_url: 'generated_images/creator-1/source-1.png',
      showcase_asset_path: null,
      category: 'image',
      model: 'nano-banana-2',
      prompt: 'Create a portrait like @alisa.',
      title: 'Public recipe source',
      workflow_settings: {
        elements: [
          {
            id: 'el-1',
            displayName: 'Alisa',
            handle: '@alisa',
            storagePath: 'uploads/creator-1/alisa.jpg',
          },
        ],
      },
    });

    postRows.set('post-1', {
      id: 'post-1',
      user_id: 'creator-1',
      generation_id: 'source-1',
      title: 'Tryingg new',
      body: '',
      prompt: 'Create a portrait like @alisa.',
      category: 'image',
      post_format: 'media',
      visibility: 'public',
      archived_at: null,
      review_status: 'visible',
      showcase_asset_path: null,
      output_url: 'generated_images/creator-1/source-1.png',
      source_kind: 'magicbooklet',
      source_tool: null,
      source_tool_slug: 'magicbooklet',
      save_count: 0,
      remix_count: 0,
      share_visit_count: 0,
      created_at: '2026-06-04T00:00:00.000Z',
    });

    inputMediaRows = [
      {
        id: 'media-1',
        generation_id: 'source-1',
        user_id: 'creator-1',
        media_type: 'image',
        role: 'reference_image',
        label: 'Alisa',
        storage_path: 'uploads/creator-1/alisa.jpg',
        source_generation_id: null,
        sort_order: 0,
        metadata: {
          id: 'el-1',
          displayName: 'Alisa',
          handle: '@alisa',
        },
      },
    ];
    signedUploads.set('creator-1/alisa.jpg', 'https://signed.example.com/uploads/creator-1/alisa.jpg');

    const { GET } = await import('@/app/api/remix-source/route');
    const response = await GET(createRouteRequest('http://localhost/api/remix-source?id=source-1&postId=post-1'));

    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.inputs.image?.elements).toEqual([
      expect.objectContaining({
        id: 'el-1',
        displayName: 'Alisa',
        handle: '@alisa',
        storagePath: 'uploads/creator-1/alisa.jpg',
        url: 'https://signed.example.com/uploads/creator-1/alisa.jpg',
      }),
    ]);
    expect(data.workflowSettings.elements).toBeUndefined();
    expect(data.restoreIssues).toEqual([]);
  });

  it('returns shared durable input media to public remixers after owner opt-in', async () => {
    currentUserId = 'user-2';
    generationRows.set('video-shared-1', {
      id: 'video-shared-1',
      user_id: 'creator-1',
      is_public: true,
      share_input_media_for_remix: true,
      output_url: 'generated_videos/creator-1/video.mp4',
      showcase_asset_path: null,
      category: 'video',
      model: 'kling-3.0/video',
      prompt: 'Product video',
      title: 'Shared source',
      workflow_settings: {
        referenceMode: 'frames',
        startFrame: {
          kind: 'image',
          label: 'Old start frame',
          storagePath: 'uploads/creator-1/old-start.png',
        },
      },
    });
    inputMediaRows = [
      {
        id: 'input-start-1',
        generation_id: 'video-shared-1',
        user_id: 'creator-1',
        media_type: 'image',
        role: 'start_frame',
        label: 'Shared start frame',
        storage_path: 'generation_inputs/creator-1/video-shared-1/00-start-frame.png',
        source_generation_id: null,
        sort_order: 0,
        metadata: null,
      },
    ];

    const { GET } = await import('@/app/api/remix-source/route');
    const response = await GET(createRouteRequest('http://localhost/api/remix-source?id=video-shared-1'));

    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.inputMedia).toEqual([
      expect.objectContaining({
        id: 'input-start-1',
        label: 'Shared start frame',
        url: 'https://signed.example.com/generation-inputs/creator-1/video-shared-1/00-start-frame.png',
      }),
    ]);
    expect(data.inputs.video.startFrame).toMatchObject({
      label: 'Shared start frame',
      url: 'https://signed.example.com/generation-inputs/creator-1/video-shared-1/00-start-frame.png',
    });
    expect(data.workflowSettings.startFrame).toEqual({
      kind: 'image',
      label: 'Old start frame',
      storagePath: 'uploads/creator-1/old-start.png',
    });
  });

  it('allows the owner to restore motion remix inputs from a private creation', async () => {
    generationRows.set('motion-1', {
      id: 'motion-1',
      user_id: 'user-1',
      is_public: false,
      share_input_media_for_remix: false,
      output_url: 'generated_videos/user-1/motion-1.mp4',
      showcase_asset_path: null,
      category: 'motion',
      model: 'kling-3.0/motion-control',
      prompt: 'Match the performer energy.',
      title: 'Motion take',
      workflow_settings: {
        characterImage: {
          kind: 'image',
          label: 'Character image',
          storagePath: 'uploads/user-1/character.png',
        },
        referenceVideo: {
          kind: 'video',
          label: 'Reference video',
          storagePath: 'uploads/user-1/reference.mp4',
        },
      },
    });
    signedUploads.set('user-1/character.png', 'https://signed.example.com/uploads/user-1/character.png');
    signedUploads.set('user-1/reference.mp4', 'https://signed.example.com/uploads/user-1/reference.mp4');

    const { GET } = await import('@/app/api/remix-source/route');
    const response = await GET(createRouteRequest('http://localhost/api/remix-source?id=motion-1'));

    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.inputs.motion.characterImage).toMatchObject({
      url: 'https://signed.example.com/uploads/user-1/character.png',
    });
    expect(data.inputs.motion.referenceVideo).toMatchObject({
      url: 'https://signed.example.com/uploads/user-1/reference.mp4',
    });
  });

  it('returns partial remix data when a saved source asset is missing', async () => {
    currentUserId = 'creator-1';

    generationRows.set('video-1', {
      id: 'video-1',
      user_id: 'creator-1',
      is_public: true,
      share_input_media_for_remix: false,
      output_url: 'generated_videos/creator-1/video-1.mp4',
      showcase_asset_path: null,
      category: 'video',
      model: 'kling-3.0/video',
      prompt: 'Product video',
      title: 'Video source',
      workflow_settings: {
        referenceMode: 'frames',
        startFrame: {
          kind: 'image',
          label: 'Start frame',
          storagePath: 'uploads/creator-1/start.png',
        },
        endFrame: {
          kind: 'image',
          label: 'End frame',
          storagePath: 'uploads/creator-1/end.png',
        },
      },
    });
    signedUploads.set('creator-1/end.png', 'https://signed.example.com/uploads/creator-1/end.png');

    const { GET } = await import('@/app/api/remix-source/route');
    const response = await GET(createRouteRequest('http://localhost/api/remix-source?id=video-1'));

    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.inputs.video.startFrame).toMatchObject({
      url: null,
    });
    expect(data.inputs.video.endFrame).toMatchObject({
      url: 'https://signed.example.com/uploads/creator-1/end.png',
    });
    expect(data.restoreIssues).toContain('video-start-frame');
  });

  it('hides private remix sources from non-owners', async () => {
    generationRows.set('private-1', {
      id: 'private-1',
      user_id: 'creator-9',
      is_public: false,
      share_input_media_for_remix: false,
      output_url: 'generated_images/creator-9/private.png',
      showcase_asset_path: null,
      category: 'image',
      model: 'nano-banana-2',
      prompt: 'Private prompt',
      title: 'Private source',
      workflow_settings: {},
    });

    const { GET } = await import('@/app/api/remix-source/route');
    const response = await GET(createRouteRequest('http://localhost/api/remix-source?id=private-1'));

    expect(response.status).toBe(404);
  });
});
