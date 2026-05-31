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

let generationState: GenerationRow | null = null;
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
const removeMock = vi.fn(async () => ({ data: null, error: null }));
const createUserClientMock = vi.fn();

vi.mock('@/lib/posts-server', () => ({
  deriveTitleFromBody: vi.fn((value: string | null | undefined) => value?.split('\n')[0] ?? null),
  isMissingPostsSchemaError: vi.fn(() => false),
  isMissingMarketplaceSchemaError: vi.fn(() => false),
  isMissingPostResourceBundlesSchemaError: vi.fn(() => false),
}));

vi.mock('@/lib/server-helpers', () => ({
  createUserClient: (request: NextRequest) => createUserClientMock(request),
  createServiceClient: () => ({
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
              },
              error: null,
            };
          },
        };

        return query;
      }

      throw new Error(`Unexpected service table access: ${table}`);
    },
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name !== 'publish_generation_post_with_resource_bundle') {
        throw new Error(`Unexpected rpc call: ${name}`);
      }

      publishRpcCalls.push(args);
      generationUpdates.push(args.p_generation_update as Record<string, unknown>);
      postUpserts.push(args.p_post as Record<string, unknown>);

      return {
        data: [{
          post_id: 'post-1',
          visibility: (args.p_post as Record<string, unknown>).visibility,
          bundle_id: args.p_has_bundle ? 'bundle-1' : null,
          bundle_status: args.p_has_bundle
            ? (args.p_post as Record<string, unknown>).visibility === 'public'
              ? 'published'
              : 'draft'
            : null,
        }],
        error: null,
      };
    }),
    storage: {
      from: vi.fn(() => ({
        remove: removeMock,
        upload: vi.fn(async () => ({ data: null, error: null })),
      })),
    },
  }),
  getStoredMediaLocation: vi.fn(),
}));

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
    generationUpdates.length = 0;
    postUpserts.length = 0;
    listingUpdateCalls.length = 0;
    bundleUpdateCalls.length = 0;
    publishRpcCalls.length = 0;
    removeMock.mockClear();
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

    expect(response.status).toBe(200);
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

  it('persists input-media remix sharing only for public publishes', async () => {
    generationState = {
      ...generationState!,
      output_url: 'https://cdn.example.com/generated.jpg',
      showcase_asset_path: null,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        headers: new Headers({ 'content-type': 'image/jpeg' }),
        blob: async () => new Blob(['image'], { type: 'image/jpeg' }),
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
        isPublic: true,
        shareInputMediaForRemix: true,
        title: 'Shared remix source',
        resourceBundle: { accessMode: 'none' },
      }),
    }) as NextRequest);

    const data = await response.json();

    expect(response.status).toBe(200);
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
  });

  it('saves generated paid unlocks as private drafts when requested', async () => {
    generationState = {
      ...generationState!,
      output_url: 'https://cdn.example.com/generated.jpg',
      showcase_asset_path: null,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        headers: new Headers({ 'content-type': 'image/jpeg' }),
        blob: async () => new Blob(['image'], { type: 'image/jpeg' }),
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
    expect(data.resourceBundlePath).toBe('/post/post-1/edit#resources');
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
      vi.fn(async () => ({
        ok: true,
        headers: new Headers({ 'content-type': 'image/jpeg' }),
        blob: async () => new Blob(['image'], { type: 'image/jpeg' }),
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
    expect(data.resourceBundlePath).toBe('/showcase/post-1#resources');
  });
});
