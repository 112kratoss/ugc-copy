import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type GenerationRow = {
  id: string;
  user_id: string | null;
  is_public: boolean | null;
  output_url: string | null;
  showcase_asset_path: string | null;
  category: string | null;
  model: string | null;
  prompt: string | null;
  title: string | null;
  workflow_settings: Record<string, unknown> | null;
};

let currentUserId: string | null = 'user-1';
let generationRows = new Map<string, GenerationRow>();
let signedUploads = new Map<string, string | null>();

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
    signedUploads = new Map();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a public remix bundle with signed source media and referenced generation results', async () => {
    generationRows.set('ref-1', {
      id: 'ref-1',
      user_id: 'creator-2',
      is_public: false,
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
    expect(data.inputs.image.elements).toEqual([
      expect.objectContaining({
        displayName: 'Bottle',
        storagePath: 'uploads/creator-1/bottle.png',
        url: 'https://signed.example.com/uploads/creator-1/bottle.png',
      }),
      expect.objectContaining({
        displayName: 'Reference result',
        sourceGenerationId: 'ref-1',
        url: 'https://signed.example.com/generated_images%2Fcreator-2%2Fref-1.png',
      }),
    ]);
  });

  it('allows the owner to restore motion remix inputs from a private creation', async () => {
    generationRows.set('motion-1', {
      id: 'motion-1',
      user_id: 'user-1',
      is_public: false,
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
    generationRows.set('video-1', {
      id: 'video-1',
      user_id: 'creator-1',
      is_public: true,
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
