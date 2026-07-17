import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

type GenerationRow = {
  id: string;
  user_id: string;
  status: string;
  model: string;
  category: string | null;
  output_url: string | null;
  showcase_asset_path: string | null;
  title: string | null;
  description: string | null;
  prompt: string | null;
};

type GenerationInputMediaRow = {
  id: string;
  generation_id: string;
  user_id: string;
  media_type: 'image' | 'video' | 'audio';
  role: string;
  label: string | null;
  storage_path: string;
  source_generation_id: string | null;
  sort_order: number | null;
  metadata: Record<string, unknown> | null;
};

let generationState: GenerationRow | null = null;
let generationInputMediaRows: GenerationInputMediaRow[] = [];
const generationUpdates: Array<Record<string, unknown>> = [];
const postUpserts: Array<Record<string, unknown>> = [];
const listingUpdateCalls: Array<{
  payload: Record<string, unknown>;
  filters: Record<string, unknown>;
}> = [];
const bundleUpdateCalls: Array<{
  payload: Record<string, unknown>;
  filters: Record<string, unknown>;
}> = [];
const publishRpcCalls: Array<Record<string, unknown>> = [];
const rateLimitRpcCalls: Array<Record<string, unknown>> = [];
const removeMock = vi.fn(async () => ({ data: null, error: null }));
const downloadMock = vi.fn(async () => ({
  data: new Blob(['reference-image'], { type: 'image/png' }),
  error: null,
}));
const uploadMock = vi.fn(async () => ({ data: null, error: null }));
const getStoredMediaLocationMock = vi.fn();
const createUserClientMock = vi.fn();
const createServiceClientMock = vi.fn();
const ensureDurableGenerationMediaMock = vi.fn();
let publishRpcError: { message: string } | null = null;
let rateLimitResult = {
  allowed: true,
  limit: 20,
  remaining: 19,
  retryAfterSeconds: 0,
  resetAt: '2026-06-21T06:30:00.000Z',
};
const sourceToolCatalog = vi.hoisted(() => [
  { slug: 'magicbooklet', label: 'magicbooklet', models: [], supportedMediaKinds: ['image', 'video'] },
]);

function createServiceClientTestDouble() {
  return {
    from(table: string) {
      if (table === 'profiles') {
        const query = {
          select() {
            return query;
          },
          eq() {
            return query;
          },
          async maybeSingle() {
            return {
              data: {
                username: 'creator-one',
                display_name: 'Creator One',
                avatar_url: 'https://cdn.example.com/avatar.jpg',
              },
              error: null,
            };
          },
        };

        return query;
      }

      if (table === 'generation_input_media') {
        const query = {
          select() {
            return query;
          },
          eq(column: string, value: unknown) {
            if (column === 'generation_id') {
              generationInputMediaRows = generationInputMediaRows.filter((row) => row.generation_id === value);
            }
            if (column === 'user_id') {
              generationInputMediaRows = generationInputMediaRows.filter((row) => row.user_id === value);
            }
            return query;
          },
          order() {
            return Promise.resolve({
              data: generationInputMediaRows,
              error: null,
            });
          },
        };

        return query;
      }

      throw new Error(`Unexpected service table access: ${table}`);
    },
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === 'check_backend_rate_limit') {
        rateLimitRpcCalls.push(args);
        return {
          data: rateLimitResult,
          error: null,
        };
      }

      if (name !== 'publish_generation_post_with_resource_bundle') {
        throw new Error(`Unexpected rpc call: ${name}`);
      }

      publishRpcCalls.push(args);
      generationUpdates.push(args.p_generation_update as Record<string, unknown>);
      postUpserts.push(args.p_post as Record<string, unknown>);

      return {
        data: publishRpcError
          ? null
          : [{
              post_id: 'post-1',
              visibility: (args.p_post as Record<string, unknown>).visibility,
              bundle_id: args.p_has_bundle ? 'bundle-1' : null,
              bundle_status: args.p_has_bundle
                ? (args.p_post as Record<string, unknown>).visibility === 'public'
                  ? 'published'
                  : 'draft'
                : null,
            }],
        error: publishRpcError,
      };
    }),
    storage: {
      from: vi.fn((bucket: string) => ({
        remove: removeMock,
        download: bucket === 'generation_inputs' || bucket === 'generated_images' ? downloadMock : vi.fn(async () => ({ data: null, error: null })),
        upload: bucket === 'post_resource_files' ? uploadMock : vi.fn(async () => ({ data: null, error: null })),
      })),
    },
  };
}

vi.mock('@/lib/durable-generation-media', () => ({
  ensureDurableGenerationMedia: (...args: unknown[]) => ensureDurableGenerationMediaMock(...args),
}));

vi.mock('@/lib/posts-server', () => ({
  deriveTitleFromBody: vi.fn((value: string | null | undefined) => value?.split('\n')[0] ?? null),
  isMissingPostsSchemaError: vi.fn(() => false),
  isMissingMarketplaceSchemaError: vi.fn(() => false),
  isMissingPostResourceBundlesSchemaError: vi.fn(() => false),
}));

vi.mock('@/lib/server-helpers', () => ({
  createUserClient: (request: NextRequest) => createUserClientMock(request),
  createServiceClient: () => createServiceClientMock(),
  getStoredMediaLocation: (value: string) => getStoredMediaLocationMock(value),
}));

vi.mock('@/lib/source-tools-server', () => ({
  listSourceToolsCatalog: () => Promise.resolve(sourceToolCatalog),
}));

function expectPrivateNoStoreTraceHeaders(response: Response, requestId: string) {
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('x-request-id')).toBe(requestId);
}

describe('/api/showcase/publish route', () => {
  beforeEach(() => {
    vi.resetModules();
    generationState = {
      id: 'gen-1',
      user_id: 'user-1',
      status: 'succeeded',
      model: 'nano-banana-2',
      category: 'image',
      output_url: 'generated_images/user-1/example.jpg',
      showcase_asset_path: 'showcase/gen-1/example.jpg',
      title: 'Original title',
      description: 'Original description',
      prompt: 'Original prompt',
    };
    generationInputMediaRows = [];
    generationUpdates.length = 0;
    postUpserts.length = 0;
    listingUpdateCalls.length = 0;
    bundleUpdateCalls.length = 0;
    publishRpcCalls.length = 0;
    rateLimitRpcCalls.length = 0;
    publishRpcError = null;
    rateLimitResult = {
      allowed: true,
      limit: 20,
      remaining: 19,
      retryAfterSeconds: 0,
      resetAt: '2026-06-21T06:30:00.000Z',
    };
    removeMock.mockClear();
    downloadMock.mockClear();
    uploadMock.mockClear();
    getStoredMediaLocationMock.mockReset();
    createServiceClientMock.mockReset();
    createServiceClientMock.mockImplementation(createServiceClientTestDouble);
    getStoredMediaLocationMock.mockImplementation((value: string) => {
      if (value.startsWith('generated_images/')) {
        return {
          bucket: 'generated_images',
          filePath: value.replace('generated_images/', ''),
        };
      }

      if (value.startsWith('generation_inputs/')) {
        return {
          bucket: 'generation_inputs',
          filePath: value.replace('generation_inputs/', ''),
        };
      }

      return null;
    });
    ensureDurableGenerationMediaMock.mockReset();
    ensureDurableGenerationMediaMock.mockImplementation(async ({ generation }) => ({
      outputUrl: generation.outputUrl,
      createdLocation: null,
    }));
    createUserClientMock.mockReset();
    createUserClientMock.mockReturnValue({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: 'user-1' } },
          error: null,
        })),
      },
      from(table: string) {
        if (table === 'generations') {
          return {
            select() {
              return {
                eq(_column: string, value: unknown) {
                  return {
                    async single() {
                      return {
                        data: generationState?.id === value ? generationState : null,
                        error: generationState?.id === value ? null : { message: 'not found' },
                      };
                    },
                  };
                },
              };
            },
            update(payload: Record<string, unknown>) {
              generationUpdates.push(payload);

              return {
                async eq() {
                  return {
                    error: null,
                  };
                },
              };
            },
          };
        }

        if (table === 'posts') {
          return {
            upsert(payload: Record<string, unknown>) {
              postUpserts.push(payload);

              return {
                select() {
                  return {
                    async single() {
                      return {
                        data: { id: 'post-1' },
                        error: null,
                      };
                    },
                  };
                },
              };
            },
          };
        }

        if (table === 'marketplace_assets') {
          return {
            update(payload: Record<string, unknown>) {
              const call = {
                payload,
                filters: {} as Record<string, unknown>,
              };
              listingUpdateCalls.push(call);

              const query = {
                eq(column: string, value: unknown) {
                  call.filters[column] = value;
                  return query;
                },
                then(resolve: (value: { error: null }) => void) {
                  resolve({ error: null });
                },
              };

              return query;
            },
          };
        }

        if (table === 'post_resource_bundles') {
          return {
            delete() {
              const call = {
                payload: {
                  deleted: true,
                },
                filters: {} as Record<string, unknown>,
              };
              bundleUpdateCalls.push(call);

              const query = {
                eq(column: string, value: unknown) {
                  call.filters[column] = value;
                  return query;
                },
                then(resolve: (value: { error: null }) => void) {
                  resolve({ error: null });
                },
              };

              return query;
            },
            update(payload: Record<string, unknown>) {
              const call = {
                payload,
                filters: {} as Record<string, unknown>,
              };
              bundleUpdateCalls.push(call);

              const query = {
                eq(column: string, value: unknown) {
                  call.filters[column] = value;
                  return query;
                },
                then(resolve: (value: { error: null }) => void) {
                  resolve({ error: null });
                },
              };

              return query;
            },
          };
        }

        throw new Error(`Unexpected table access: ${table}`);
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('does not create an admin client before authentication succeeds', async () => {
    createUserClientMock.mockReturnValueOnce({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: null },
          error: new Error('missing session'),
        })),
      },
    });

    const { POST } = await import('@/app/api/showcase/publish/route');
    const response = await POST(new Request('http://localhost/api/showcase/publish', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': 'showcase-publish-auth-1',
      },
      body: JSON.stringify({
        generationId: 'gen-1',
        visibility: 'public',
      }),
    }) as NextRequest);

    expect(response.status).toBe(401);
    expectPrivateNoStoreTraceHeaders(response, 'showcase-publish-auth-1');
    expect(createServiceClientMock).not.toHaveBeenCalled();
    expect(ensureDurableGenerationMediaMock).not.toHaveBeenCalled();
  });

  it('rate limits showcase publishing before generation or publish work', async () => {
    rateLimitResult = {
      allowed: false,
      limit: 20,
      remaining: 0,
      retryAfterSeconds: 51,
      resetAt: '2026-06-21T06:30:00.000Z',
    };

    const { POST } = await import('@/app/api/showcase/publish/route');
    const response = await POST(new Request('http://localhost/api/showcase/publish', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token',
        'x-request-id': 'showcase-publish-rate-limit-1',
      },
      body: JSON.stringify({
        generationId: 'gen-1',
        visibility: 'public',
      }),
    }) as NextRequest);

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('51');
    expectPrivateNoStoreTraceHeaders(response, 'showcase-publish-rate-limit-1');
    await expect(response.json()).resolves.toMatchObject({ code: 'RATE_LIMITED' });
    expect(rateLimitRpcCalls).toContainEqual({
      p_scope: 'showcase:publish',
      p_subject_key: 'user-1',
      p_limit: 20,
      p_window_seconds: 600,
    });
    expect(publishRpcCalls).toHaveLength(0);
    expect(ensureDurableGenerationMediaMock).not.toHaveBeenCalled();
    expect(downloadMock).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('publishes showcase posts after passing the backend rate limit', async () => {
    const { POST } = await import('@/app/api/showcase/publish/route');
    const response = await POST(new Request('http://localhost/api/showcase/publish', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token',
        'x-request-id': 'showcase-publish-success-1',
      },
      body: JSON.stringify({
        generationId: 'gen-1',
        visibility: 'private',
      }),
    }) as NextRequest);

    const data = await response.json();

    expect(response.status, JSON.stringify(data)).toBe(200);
    expectPrivateNoStoreTraceHeaders(response, 'showcase-publish-success-1');
    expect(rateLimitRpcCalls).toContainEqual({
      p_scope: 'showcase:publish',
      p_subject_key: 'user-1',
      p_limit: 20,
      p_window_seconds: 600,
    });
    expect(publishRpcCalls).toHaveLength(1);
  });

  it('downgrades attached active listings to unlisted when a generation-backed post is unpublished', async () => {
    const { POST } = await import('@/app/api/showcase/publish/route');
    const response = await POST(new Request('http://localhost/api/showcase/publish', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token',
      },
      body: JSON.stringify({
        generationId: 'gen-1',
        isPublic: false,
      }),
    }) as NextRequest);

    const data = await response.json();

    expect(response.status, JSON.stringify(data)).toBe(200);
    expect(data.success).toBe(true);
    expect(generationUpdates[0]).toMatchObject({
      is_public: false,
      share_input_media_for_remix: false,
      showcase_asset_path: null,
    });
    expect(postUpserts[0]).toMatchObject({
      generation_id: 'gen-1',
      source_kind: 'magicbooklet',
      visibility: 'private',
    });
    expect(bundleUpdateCalls).toHaveLength(0);
    expect(listingUpdateCalls).toHaveLength(0);
    expect(publishRpcCalls[0]).toMatchObject({
      p_generation_id: 'gen-1',
      p_owner_user_id: 'user-1',
      p_has_bundle: false,
    });
  });

  it('secures legacy provider media before making a generation-backed post private', async () => {
    generationState = {
      ...generationState!,
      output_url: 'https://provider.example.com/expired.jpg',
    };
    ensureDurableGenerationMediaMock.mockResolvedValue({
      outputUrl: 'generated_images/user-1/restored-gen-1.jpg',
      createdLocation: {
        bucket: 'generated_images',
        filePath: 'user-1/restored-gen-1.jpg',
      },
    });

    const { POST } = await import('@/app/api/showcase/publish/route');
    const response = await POST(new Request('http://localhost/api/showcase/publish', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token',
      },
      body: JSON.stringify({
        generationId: 'gen-1',
        visibility: 'private',
      }),
    }) as NextRequest);

    const data = await response.json();

    expect(response.status, JSON.stringify(data)).toBe(200);
    expect(ensureDurableGenerationMediaMock).toHaveBeenCalledWith(expect.objectContaining({
      generation: {
        id: 'gen-1',
        userId: 'user-1',
        model: 'nano-banana-2',
        category: 'image',
        outputUrl: 'https://provider.example.com/expired.jpg',
        showcaseAssetPath: 'showcase/gen-1/example.jpg',
      },
    }));
    expect(generationUpdates[0]).toMatchObject({
      output_url: 'generated_images/user-1/restored-gen-1.jpg',
      showcase_asset_path: null,
    });
    expect(postUpserts[0]).toMatchObject({
      output_url: 'generated_images/user-1/restored-gen-1.jpg',
      showcase_asset_path: null,
      visibility: 'private',
    });
    expect(removeMock).toHaveBeenCalledWith(['showcase/gen-1/example.jpg']);
  });

  it('keeps the public state untouched when private media cannot be secured', async () => {
    generationState = {
      ...generationState!,
      output_url: 'https://provider.example.com/expired.jpg',
    };
    ensureDurableGenerationMediaMock.mockRejectedValue(new Error('source missing'));

    const { POST } = await import('@/app/api/showcase/publish/route');
    const response = await POST(new Request('http://localhost/api/showcase/publish', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token',
      },
      body: JSON.stringify({
        generationId: 'gen-1',
        visibility: 'private',
      }),
    }) as NextRequest);
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data.error).toMatch(/could not be secured/i);
    expect(publishRpcCalls).toHaveLength(0);
    expect(removeMock).not.toHaveBeenCalled();
  });

  it('removes a newly copied private object and keeps the showcase derivative when the atomic update fails', async () => {
    generationState = {
      ...generationState!,
      output_url: 'https://provider.example.com/expired.jpg',
    };
    ensureDurableGenerationMediaMock.mockResolvedValue({
      outputUrl: 'generated_images/user-1/restored-gen-1.jpg',
      createdLocation: {
        bucket: 'generated_images',
        filePath: 'user-1/restored-gen-1.jpg',
      },
    });
    publishRpcError = { message: 'atomic update failed' };

    const { POST } = await import('@/app/api/showcase/publish/route');
    const response = await POST(new Request('http://localhost/api/showcase/publish', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token',
      },
      body: JSON.stringify({
        generationId: 'gen-1',
        visibility: 'private',
      }),
    }) as NextRequest);

    expect(response.status).toBe(500);
    expect(removeMock).toHaveBeenCalledWith(['user-1/restored-gen-1.jpg']);
    expect(removeMock).not.toHaveBeenCalledWith(['showcase/gen-1/example.jpg']);
  });

  it('persists input-media remix sharing only for public publishes', async () => {
    const timeoutSignal = AbortSignal.abort();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutSignal);
    let requestInit: RequestInit | undefined;
    generationState = {
      ...generationState!,
      output_url: 'https://cdn.example.com/generated.jpg',
      showcase_asset_path: null,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestInit = init;
        return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        });
      })
    );

    const { POST } = await import('@/app/api/showcase/publish/route');
    const response = await POST(new Request('http://localhost/api/showcase/publish', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token',
      },
      body: JSON.stringify({
        generationId: 'gen-1',
        isPublic: true,
        shareInputMediaForRemix: true,
        title: 'Shared remix source',
        resourceBundle: { accessMode: 'none' },
      }),
    }) as NextRequest);

    const data = await response.json();

    expect(response.status, JSON.stringify(data)).toBe(200);
    expect(data.success).toBe(true);
    expect(generationUpdates[0]).toMatchObject({
      is_public: true,
      share_input_media_for_remix: true,
      title: 'Shared remix source',
    });
    expect(postUpserts[0]).toMatchObject({
      generation_id: 'gen-1',
      visibility: 'public',
    });
    expect(timeoutSpy).toHaveBeenCalledWith(60_000);
    expect(requestInit?.signal).toBe(timeoutSignal);
  });

  it('saves generated paid unlocks as private drafts when requested', async () => {
    generationState = {
      ...generationState!,
      output_url: 'https://cdn.example.com/generated.jpg',
      showcase_asset_path: null,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      }))
    );

    const { POST } = await import('@/app/api/showcase/publish/route');
    const response = await POST(new Request('http://localhost/api/showcase/publish', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token',
      },
      body: JSON.stringify({
        generationId: 'gen-1',
        visibility: 'private',
        title: 'Helpful launch proof',
        resourceBundle: {
          accessMode: 'paid',
          summary: 'A reusable prompt bundle for launch stills.',
          previewText: 'Includes the prompt and setup notes for recreating the look.',
          priceUsdCents: 900,
          resources: {
            promptText: 'Make a creator-style launch still with warm product light.',
            attachments: [],
            allowRemix: false,
          },
        },
      }),
    }) as NextRequest);

    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.visibility).toBe('private');
    expect(data.resourceBundleStatus).toBe('draft');
    expect(data.showcasePath).toBeNull();
    expect(data.resourceBundlePath).toBe('/post/post-1/edit#recipe');
    expect(postUpserts[0]).toMatchObject({
      generation_id: 'gen-1',
      visibility: 'private',
    });
    expect(publishRpcCalls[0]).toMatchObject({
      p_has_bundle: true,
    });
  });

  it('returns published bundle status for public generated unlocks', async () => {
    generationState = {
      ...generationState!,
      output_url: 'https://cdn.example.com/generated.jpg',
      showcase_asset_path: null,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      }))
    );

    const { POST } = await import('@/app/api/showcase/publish/route');
    const response = await POST(new Request('http://localhost/api/showcase/publish', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token',
      },
      body: JSON.stringify({
        generationId: 'gen-1',
        visibility: 'public',
        title: 'Helpful launch proof',
        resourceBundle: {
          accessMode: 'free',
          summary: 'A reusable prompt bundle for launch stills.',
          previewText: 'Includes the prompt and setup notes for recreating the look.',
          resources: {
            promptText: 'Make a creator-style launch still with warm product light.',
            attachments: [],
            allowRemix: false,
          },
        },
      }),
    }) as NextRequest);

    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.visibility).toBe('public');
    expect(data.resourceBundleStatus).toBe('published');
    expect(data.showcasePath).toBe('/showcase/post-1');
    expect(data.resourceBundlePath).toBe('/showcase/post-1#recipe');
  });

  it('creates one free reference unlock when a public generated post has saved references and no paid bundle', async () => {
    generationInputMediaRows = [{
      id: 'input-1',
      generation_id: 'gen-1',
      user_id: 'user-1',
      media_type: 'image',
      role: 'reference_image',
      label: 'Hero reference',
      storage_path: 'generation_inputs/user-1/gen-1/00-reference_image.png',
      source_generation_id: null,
      sort_order: 0,
      metadata: { handle: '@hero' },
    }];

    const { POST } = await import('@/app/api/showcase/publish/route');
    const response = await POST(new Request('http://localhost/api/showcase/publish', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token',
      },
      body: JSON.stringify({
        generationId: 'gen-1',
        visibility: 'public',
        title: 'Reference-led portrait',
        includeGenerationReferences: true,
        resourceBundle: { accessMode: 'none' },
      }),
    }) as NextRequest);

    const data = await response.json();
    const publishedBundle = publishRpcCalls[0]?.p_bundle as Record<string, unknown>;
    const resources = publishedBundle.resources as Record<string, unknown>;
    const items = resources.items as Array<Record<string, unknown>>;

    expect(response.status).toBe(200);
    expect(data.resourceBundleStatus).toBe('published');
    expect(publishRpcCalls[0]).toMatchObject({
      p_has_bundle: true,
    });
    expect(publishedBundle).toMatchObject({
      accessMode: 'free',
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: 'reference_image',
      role: 'style_reference',
      title: 'Hero reference',
      storagePath: expect.stringMatching(/^user-1\/generation-references\/gen-1\/00-reference-image-input-1\.png$/),
      remixUse: 'reference_only',
    });
    expect(JSON.stringify(publishedBundle)).not.toContain('generation_inputs/');
    expect(downloadMock).toHaveBeenCalledWith('user-1/gen-1/00-reference_image.png');
    expect(uploadMock).toHaveBeenCalledWith(
      'user-1/generation-references/gen-1/00-reference-image-input-1.png',
      expect.any(Blob),
      expect.objectContaining({
        contentType: 'image/png',
        upsert: true,
      })
    );
  });

  it('enriches paid generated unlocks with saved references', async () => {
    generationInputMediaRows = [{
      id: 'input-2',
      generation_id: 'gen-1',
      user_id: 'user-1',
      media_type: 'video',
      role: 'reference_video',
      label: 'Timing reference',
      storage_path: 'generation_inputs/user-1/gen-1/01-reference_video.mp4',
      source_generation_id: null,
      sort_order: 1,
      metadata: null,
    }];
    downloadMock.mockResolvedValueOnce({
      data: new Blob(['reference-video'], { type: 'video/mp4' }),
      error: null,
    });

    const { POST } = await import('@/app/api/showcase/publish/route');
    const response = await POST(new Request('http://localhost/api/showcase/publish', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token',
      },
      body: JSON.stringify({
        generationId: 'gen-1',
        visibility: 'public',
        title: 'Reference-led video',
        includeGenerationReferences: true,
        resourceBundle: {
          accessMode: 'paid',
          summary: 'Reusable setup with saved references',
          previewText: 'Includes prompt, notes, remix, and saved references.',
          priceUsdCents: 900,
          resources: {
            promptText: 'Make a dramatic scene using the saved timing reference.',
            notesMarkdown: 'Saved generation setup',
            attachments: [],
            allowRemix: true,
          },
        },
      }),
    }) as NextRequest);

    const data = await response.json();

    expect(response.status, JSON.stringify(data)).toBe(200);
    const publishedBundle = publishRpcCalls[0]?.p_bundle as Record<string, unknown>;
    const resources = publishedBundle.resources as Record<string, unknown>;
    const items = resources.items as Array<Record<string, unknown>>;

    expect(publishedBundle).toMatchObject({
      accessMode: 'paid',
      priceUsdCents: 900,
    });
    expect((publishRpcCalls[0]?.p_post as Record<string, unknown>).description).toBeNull();
    expect(resources).toMatchObject({
      promptText: 'Make a dramatic scene using the saved timing reference.',
      notesMarkdown: 'Saved generation setup',
      allowRemix: true,
    });
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'prompt' }),
      expect.objectContaining({ type: 'note' }),
      expect.objectContaining({ type: 'remix_access' }),
    ]));
    expect(items).toContainEqual(expect.objectContaining({
      type: 'source_file',
      role: 'supporting_workflow',
      title: 'Timing reference',
      contentType: 'video/mp4',
      storagePath: 'user-1/generation-references/gen-1/01-reference-video-input-2.mp4',
    }));
  });

  it('keeps references creator-only for private publishes without paid unlocks', async () => {
    generationInputMediaRows = [{
      id: 'input-3',
      generation_id: 'gen-1',
      user_id: 'user-1',
      media_type: 'image',
      role: 'reference_image',
      label: 'Private reference',
      storage_path: 'generation_inputs/user-1/gen-1/00-reference_image.png',
      source_generation_id: null,
      sort_order: 0,
      metadata: null,
    }];

    const { POST } = await import('@/app/api/showcase/publish/route');
    const response = await POST(new Request('http://localhost/api/showcase/publish', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token',
      },
      body: JSON.stringify({
        generationId: 'gen-1',
        visibility: 'private',
        includeGenerationReferences: true,
        resourceBundle: { accessMode: 'none' },
      }),
    }) as NextRequest);

    expect(response.status).toBe(200);
    expect(publishRpcCalls[0]).toMatchObject({
      p_bundle: {
        accessMode: 'none',
      },
    });
    expect(downloadMock).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
  });
});
