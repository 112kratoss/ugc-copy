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
    storage: {
      from: vi.fn(() => ({
        remove: removeMock,
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
      showcase_asset_path: null,
    });
    expect(postUpserts[0]).toMatchObject({
      generation_id: 'gen-1',
      visibility: 'private',
    });
    expect(bundleUpdateCalls).toHaveLength(1);
    expect(bundleUpdateCalls[0]).toEqual({
      payload: {
        status: 'draft',
      },
      filters: {
        post_id: 'post-1',
        owner_user_id: 'user-1',
        status: 'published',
      },
    });
    expect(listingUpdateCalls).toHaveLength(1);
    expect(listingUpdateCalls[0]).toEqual({
      payload: {
        status: 'unlisted',
      },
      filters: {
        post_id: 'post-1',
        seller_user_id: 'user-1',
        status: 'active',
      },
    });
  });
});
