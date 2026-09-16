import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const gateState = vi.hoisted(() => ({
  rateLimitAllowed: true,
  blocked: false,
  blockCheckThrows: false,
}));

vi.mock('@/lib/moderation-service', () => ({
  isUserRelationshipBlocked: vi.fn(async () => {
    if (gateState.blockCheckThrows) throw new Error('moderation lookup failed');
    return gateState.blocked;
  }),
}));

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

type BundleRow = {
  id: string;
  post_id: string;
  status: 'draft' | 'published';
  allow_remix: boolean;
};

let currentUserId: string | null = 'user-1';
let generationRows = new Map<string, GenerationRow>();
let postRows = new Map<string, PostRow>();
// Keyed by post id, the column the remix gate reads a recipe by.
let bundleRows = new Map<string, BundleRow>();
let purchaseRows: Array<{ id: string; bundle_id: string; buyer_user_id: string }> = [];
let signedUploads = new Map<string, string | null>();
// Guest profiles linked into a registered account (profiles.merged_into_user_id).
let linkedProfileRows: Array<{ id: string; merged_into_user_id: string }> = [];
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

const resolveOwnedStoredMediaUrlMock = vi.fn(
  async (_adminClient: unknown, outputUrl: string, ownerUserId: string) => {
    const [, path = ''] = outputUrl.split('/', 2);
    if (outputUrl.startsWith('generated_') && path !== ownerUserId) return null;
    return `https://signed.example.com/${encodeURIComponent(outputUrl)}`;
  }
);

/** A creation made while its owner was still a guest, so it keeps the guest UUID. */
function createGuestMadeGeneration(overrides: Partial<GenerationRow> = {}): GenerationRow {
  return {
    id: 'guest-made-1',
    user_id: 'guest-1',
    is_public: false,
    share_input_media_for_remix: false,
    output_url: 'generated_images/guest-1/guest-made-1.png',
    showcase_asset_path: null,
    category: 'image',
    model: 'nano-banana-2',
    prompt: 'Made before signing up.',
    title: 'Guest creation',
    workflow_settings: {
      elements: [
        {
          id: 'el-1',
          displayName: 'Bottle',
          handle: '@bottle',
          storagePath: 'uploads/guest-1/bottle.png',
        },
      ],
    },
    ...overrides,
  };
}

/** A public creation by creator-1 that other viewers may remix while its post is exposed. */
function createPublicSource(overrides: Partial<GenerationRow> = {}): GenerationRow {
  return {
    id: 'source-1',
    user_id: 'creator-1',
    is_public: true,
    share_input_media_for_remix: true,
    output_url: 'generated_images/creator-1/source-1.png',
    showcase_asset_path: null,
    category: 'image',
    model: 'nano-banana-2',
    prompt: 'A bright creator product shot.',
    title: 'Hero frame',
    workflow_settings: {},
    ...overrides,
  };
}

/**
 * The generation's own post on the public surface: public, not archived and
 * visible to moderation, which the remix gate requires before anyone but the
 * owner may restore the generation.
 */
function createExposedPost(generationId: string, overrides: Partial<PostRow> = {}): PostRow {
  return {
    id: `post-${generationId}`,
    user_id: 'creator-1',
    generation_id: generationId,
    title: 'Public post',
    body: '',
    prompt: null,
    category: 'image',
    post_format: 'media',
    visibility: 'public',
    archived_at: null,
    review_status: 'visible',
    showcase_asset_path: null,
    output_url: null,
    source_kind: 'magicbooklet',
    source_tool: null,
    source_tool_slug: 'magicbooklet',
    save_count: 0,
    remix_count: 0,
    share_visit_count: 0,
    created_at: '2026-06-04T00:00:00.000Z',
    ...overrides,
  };
}

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
    rpc: vi.fn(async (fn: string) => {
      if (fn !== 'check_backend_rate_limit') return { data: null, error: null };
      return {
        data: {
          allowed: gateState.rateLimitAllowed,
          limit: 60,
          remaining: gateState.rateLimitAllowed ? 59 : 0,
          retryAfterSeconds: gateState.rateLimitAllowed ? 0 : 42,
          resetAt: '2026-01-01T00:00:00.000Z',
        },
        error: null,
      };
    }),
    from: vi.fn((table: string) => {
      if (table === 'post_resource_bundles') {
        const filters = new Map<string, unknown>();
        const query = {
          select() {
            return query;
          },
          eq(column: string, value: unknown) {
            filters.set(column, value);
            return query;
          },
          async maybeSingle() {
            return { data: bundleRows.get(String(filters.get('post_id'))) ?? null, error: null };
          },
        };
        return query;
      }

      if (table === 'post_resource_bundle_purchases') {
        const filters = new Map<string, unknown>();
        const query = {
          select() {
            return query;
          },
          eq(column: string, value: unknown) {
            filters.set(column, value);
            return query;
          },
          async maybeSingle() {
            return {
              data: purchaseRows.find((row) => (
                row.bundle_id === filters.get('bundle_id')
                && row.buyer_user_id === filters.get('buyer_user_id')
              )) ?? null,
              error: null,
            };
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
              async eq(column: string, value: unknown) {
                if (column !== 'merged_into_user_id') {
                  throw new Error(`Unexpected profiles filter column: ${column}`);
                }

                return {
                  data: linkedProfileRows
                    .filter((row) => row.merged_into_user_id === value)
                    .map((row) => ({ id: row.id })),
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
                if (column !== 'id' && column !== 'generation_id') {
                  throw new Error(`Unexpected filter column: ${column}`);
                }

                return {
                  async maybeSingle() {
                    const post = column === 'id'
                      ? postRows.get(String(value))
                      : [...postRows.values()].find((row) => row.generation_id === value);
                    return {
                      data: post ?? null,
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
    // `authenticated` holds no grant on prompt, workflow_settings or is_public,
    // so every table read in this loader must stay on the service client.
    from: vi.fn((table: string) => {
      throw new Error(`The user client must not read ${table}`);
    }),
  })),
  createServiceClient: vi.fn(() => createAdminClientMock()),
  resolveOwnedStoredMediaUrl: (...args: Parameters<typeof resolveOwnedStoredMediaUrlMock>) =>
    resolveOwnedStoredMediaUrlMock(...args),
}));

describe('/api/remix-source route', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    currentUserId = 'user-1';
    generationRows = new Map();
    postRows = new Map();
    bundleRows = new Map();
    purchaseRows = [];
    signedUploads = new Map();
    linkedProfileRows = [];
    inputMediaRows = [];
    gateState.rateLimitAllowed = true;
    gateState.blocked = false;
    gateState.blockCheckThrows = false;
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
    postRows.set('post-source-1', createExposedPost('source-1'));

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

  it('keeps reference images private when the linked post has no saved recipe', async () => {
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
    expect(data.inputs.image).toBeUndefined();
    expect(data.inputMedia).toEqual([]);
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
    postRows.set('post-video-shared-1', createExposedPost('video-shared-1', { category: 'video' }));

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

  it('does not service-sign a result path whose canonical owner differs from the generation owner', async () => {
    generationRows.set('owner-mismatch-1', {
      id: 'owner-mismatch-1',
      user_id: 'user-1',
      is_public: false,
      share_input_media_for_remix: false,
      output_url: 'generated_images/user-2/private.png',
      showcase_asset_path: null,
      category: 'image',
      model: 'nano-banana-2',
      prompt: 'Owner mismatch',
      title: 'Owner mismatch',
      workflow_settings: {},
    });

    const { GET } = await import('@/app/api/remix-source/route');
    const response = await GET(createRouteRequest('http://localhost/api/remix-source?id=owner-mismatch-1'));

    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.result.url).toBeNull();
    expect(data.restoreIssues).toContain('result');
    expect(resolveOwnedStoredMediaUrlMock).toHaveBeenCalledWith(
      expect.anything(),
      'generated_images/user-2/private.png',
      'user-1',
    );
  });

  it('uses only the canonical showcase prefix for the selected generation', async () => {
    generationRows.set('showcase-valid', {
      id: 'showcase-valid',
      user_id: 'user-1',
      is_public: false,
      share_input_media_for_remix: false,
      output_url: null,
      showcase_asset_path: 'showcase/showcase-valid/output.webp',
      category: 'image',
      model: 'nano-banana-2',
      prompt: 'Valid showcase',
      title: 'Valid showcase',
      workflow_settings: {},
    });
    generationRows.set('showcase-invalid', {
      id: 'showcase-invalid',
      user_id: 'user-1',
      is_public: false,
      share_input_media_for_remix: false,
      output_url: null,
      showcase_asset_path: 'showcase/another-generation/private.webp',
      category: 'image',
      model: 'nano-banana-2',
      prompt: 'Invalid showcase',
      title: 'Invalid showcase',
      workflow_settings: {},
    });

    const { GET } = await import('@/app/api/remix-source/route');
    const validResponse = await GET(createRouteRequest(
      'http://localhost/api/remix-source?id=showcase-valid',
    ));
    const invalidResponse = await GET(createRouteRequest(
      'http://localhost/api/remix-source?id=showcase-invalid',
    ));

    expect((await validResponse.json()).result.url).toBe(
      'https://public.example.com/showcase/showcase-valid/output.webp',
    );
    const invalidData = await invalidResponse.json();
    expect(invalidData.result.url).toBeNull();
    expect(invalidData.restoreIssues).toContain('result');
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

  it('hides a public remix source from a viewer on either side of a block', async () => {
    gateState.blocked = true;
    generationRows.set('public-1', {
      id: 'public-1',
      user_id: 'creator-9',
      is_public: true,
      share_input_media_for_remix: true,
      output_url: 'generated_images/creator-9/public.png',
      showcase_asset_path: null,
      category: 'image',
      model: 'nano-banana-2',
      prompt: 'Public prompt',
      title: 'Public source',
      workflow_settings: {},
    });
    // Exposed, so the block is what refuses and not a missing post.
    postRows.set('post-public-1', createExposedPost('public-1', { user_id: 'creator-9' }));

    const { GET } = await import('@/app/api/remix-source/route');
    const response = await GET(createRouteRequest('http://localhost/api/remix-source?id=public-1'));

    // 404 rather than 403: the gate must not confirm the source exists.
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe('Remix source not found');
  });

  it('fails closed when the block lookup itself errors', async () => {
    gateState.blockCheckThrows = true;
    generationRows.set('public-1', {
      id: 'public-1',
      user_id: 'creator-9',
      is_public: true,
      share_input_media_for_remix: true,
      output_url: 'generated_images/creator-9/public.png',
      showcase_asset_path: null,
      category: 'image',
      model: 'nano-banana-2',
      prompt: 'Public prompt',
      title: 'Public source',
      workflow_settings: {},
    });
    postRows.set('post-public-1', createExposedPost('public-1', { user_id: 'creator-9' }));

    const { GET } = await import('@/app/api/remix-source/route');
    const response = await GET(createRouteRequest('http://localhost/api/remix-source?id=public-1'));

    expect(response.status).toBe(404);
  });

  it('still serves the owner their own source across a block record', async () => {
    gateState.blocked = true;
    currentUserId = 'creator-9';
    generationRows.set('mine-1', {
      id: 'mine-1',
      user_id: 'creator-9',
      is_public: false,
      share_input_media_for_remix: false,
      output_url: 'generated_images/creator-9/mine.png',
      showcase_asset_path: null,
      category: 'image',
      model: 'nano-banana-2',
      prompt: 'My own prompt',
      title: 'My source',
      workflow_settings: {},
    });

    const { GET } = await import('@/app/api/remix-source/route');
    const response = await GET(createRouteRequest('http://localhost/api/remix-source?id=mine-1'));

    expect(response.status).toBe(200);
    expect((await response.json()).generation.prompt).toBe('My own prompt');
  });

  // Creations made before someone registered keep their guest UUID. The owner
  // library lists them through the linked-account set, and Recreate reaches
  // this loader from there, so ownership here has to agree with that set.
  it.each([
    { visibility: 'private', isPublic: false },
    { visibility: 'public but unshared', isPublic: true },
  ])('restores a $visibility creation made under a guest id linked to the caller', async ({ isPublic }) => {
    linkedProfileRows = [{ id: 'guest-1', merged_into_user_id: 'user-1' }];
    generationRows.set('guest-made-1', createGuestMadeGeneration({ is_public: isPublic }));
    inputMediaRows = [
      {
        id: 'input-ref-1',
        generation_id: 'guest-made-1',
        user_id: 'guest-1',
        media_type: 'image',
        role: 'reference_image',
        label: 'Bottle',
        storage_path: 'generation_inputs/guest-1/guest-made-1/00-reference-image.png',
        source_generation_id: null,
        sort_order: 0,
        metadata: { id: 'el-1', displayName: 'Bottle', handle: '@bottle' },
      },
    ];

    const { GET } = await import('@/app/api/remix-source/route');
    const response = await GET(createRouteRequest('http://localhost/api/remix-source?id=guest-made-1'));

    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.generation).toMatchObject({
      id: 'guest-made-1',
      prompt: 'Made before signing up.',
      model: 'nano-banana-2',
    });
    const referenceUrl = 'https://signed.example.com/generation-inputs/guest-1/guest-made-1/00-reference-image.png';
    expect(data.inputMedia).toEqual([
      expect.objectContaining({ id: 'input-ref-1', url: referenceUrl }),
    ]);
    expect(data.inputs.image.elements).toEqual([
      expect.objectContaining({ url: referenceUrl }),
    ]);
    // An owner restore keeps the descriptors a non-owner remix would redact.
    expect(data.workflowSettings.elements).toHaveLength(1);
    // Media is still signed under the prefix it was stored under: the guest's.
    expect(data.result.url).toBe('https://signed.example.com/generated_images%2Fguest-1%2Fguest-made-1.png');
    expect(data.restoreIssues).toEqual([]);
  });

  it('still hides a guest-made creation from an account the guest was not linked to', async () => {
    currentUserId = 'user-2';
    linkedProfileRows = [{ id: 'guest-1', merged_into_user_id: 'user-1' }];
    generationRows.set('guest-made-1', createGuestMadeGeneration());

    const { GET } = await import('@/app/api/remix-source/route');
    const response = await GET(createRouteRequest('http://localhost/api/remix-source?id=guest-made-1'));

    // The same 404 as any other non-owner, so the gate confirms nothing.
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe('Remix source not found');
  });

  it('rate limits the hydration endpoint the way its paired remix endpoint is limited', async () => {
    gateState.rateLimitAllowed = false;
    generationRows.set('public-1', {
      id: 'public-1',
      user_id: 'creator-9',
      is_public: true,
      share_input_media_for_remix: true,
      output_url: 'generated_images/creator-9/public.png',
      showcase_asset_path: null,
      category: 'image',
      model: 'nano-banana-2',
      prompt: 'Public prompt',
      title: 'Public source',
      workflow_settings: {},
    });

    const { GET } = await import('@/app/api/remix-source/route');
    const response = await GET(createRouteRequest('http://localhost/api/remix-source?id=public-1'));

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('42');
    expect((await response.json()).code).toBe('RATE_LIMITED');
  });

  // Audit A4, read side: a generation's public flag is a copy of its post's
  // state, so another viewer's restore follows the post itself.
  it.each([
    ['has no post', null],
    ['was made private', { visibility: 'private' }],
    ['was archived', { archived_at: '2026-09-15T10:00:00.000Z' }],
    ['was hidden by moderation', { review_status: 'hidden' }],
  ] as Array<[string, Partial<PostRow> | null]>)(
    'hides a still-public generation from other viewers once its post %s',
    async (_label, postOverrides) => {
      currentUserId = 'user-2';
      generationRows.set('source-1', createPublicSource());
      if (postOverrides) {
        postRows.set('post-source-1', createExposedPost('source-1', postOverrides));
      }

      const { GET } = await import('@/app/api/remix-source/route');
      const response = await GET(createRouteRequest('http://localhost/api/remix-source?id=source-1'));

      expect(response.status).toBe(404);
      expect((await response.json()).error).toBe('Remix source not found');
    },
  );

  // Audit A1: the post tells this viewer "unlock to remix", so the source the
  // create page restores from must not answer with the recipe either.
  it('answers 403 with the unlock code for a remix-enabled recipe the viewer has not bought', async () => {
    currentUserId = 'user-2';
    generationRows.set('source-1', createPublicSource({ prompt: 'A prompt only buyers restore.' }));
    postRows.set('post-1', createExposedPost('source-1', { id: 'post-1' }));
    bundleRows.set('post-1', { id: 'bundle-1', post_id: 'post-1', status: 'published', allow_remix: true });
    purchaseRows = [{ id: 'purchase-9', bundle_id: 'bundle-1', buyer_user_id: 'someone-else' }];

    const { GET } = await import('@/app/api/remix-source/route');
    const response = await GET(createRouteRequest('http://localhost/api/remix-source?id=source-1&postId=post-1'));

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body).toEqual({ error: 'Unlock this post to remix it.', code: 'REMIX_UNLOCK_REQUIRED' });
    expect(JSON.stringify(body)).not.toContain('A prompt only buyers restore.');
  });
});
