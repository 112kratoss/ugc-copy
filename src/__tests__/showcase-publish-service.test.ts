import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const cacheMocks = vi.hoisted(() => ({
  SHOWCASE_FEED_CACHE_TAG: 'showcase-feed:v2',
  invalidateShowcaseFeedCache: vi.fn(),
}));

vi.mock('@/lib/showcase-feed-cache', () => cacheMocks);

import {
  publishGenerationToShowcaseForRoute,
  type ShowcasePublishServiceDependencies,
} from '@/lib/showcase-publish-service';

function createUserClientMock(generation: Record<string, unknown> | null) {
  const selects: string[] = [];
  const eqs: Array<{ column: string; value: unknown }> = [];

  return {
    client: {
      from(table: string) {
        if (table !== 'generations') {
          throw new Error(`Unexpected user table: ${table}`);
        }

        return {
          select(columns = '') {
            selects.push(columns);
            return {
              eq(column: string, value: unknown) {
                eqs.push({ column, value });
                return {
                  single() {
                    return Promise.resolve({
                      data: generation?.id === value ? generation : null,
                      error: generation?.id === value ? null : { message: 'not found' },
                    });
                  },
                };
              },
            };
          },
        };
      },
    } as unknown as SupabaseClient,
    eqs,
    selects,
  };
}

function createCanonicalTemplateAdminClientMock({
  generation,
  canonicalRun = true,
}: {
  generation: Record<string, unknown> | null;
  canonicalRun?: boolean;
}) {
  const runFilters: Array<{ column: string; value: unknown }> = [];
  const removeMock = vi.fn(async () => ({ data: null, error: null }));

  const client = {
    from(table: string) {
      if (table === 'generations') {
        return {
          select() {
            return {
              eq(_column: string, value: unknown) {
                return {
                  single: vi.fn(async () => ({
                    data: generation?.id === value ? generation : null,
                    error: generation?.id === value ? null : { message: 'not found' },
                  })),
                };
              },
            };
          },
        };
      }

      if (table === 'template_runs') {
        const query = {
          eq(column: string, value: unknown) {
            runFilters.push({ column, value });
            return query;
          },
          maybeSingle: vi.fn(async () => ({
            data: canonicalRun ? { id: 'run-1' } : null,
            error: null,
          })),
        };
        return { select: vi.fn(() => query) };
      }

      throw new Error(`Unexpected admin table: ${table}`);
    },
    storage: {
      from: vi.fn(() => ({ remove: removeMock })),
    },
  } as unknown as SupabaseClient;

  return { client, removeMock, runFilters };
}

function createAdminClientMock() {
  const removeMock = vi.fn(async () => ({ data: null, error: null }));

  return {
    client: {
      storage: {
        from: vi.fn(() => ({
          remove: removeMock,
        })),
      },
    } as unknown as SupabaseClient,
    removeMock,
  };
}

describe('publishGenerationToShowcaseForRoute', () => {
  beforeEach(() => {
    cacheMocks.invalidateShowcaseFeedCache.mockClear();
  });

  it('publishes a backend-private generation only when it is the canonical result of the owner\'s successful consumer run', async () => {
    const generation = {
      id: 'template-result-1',
      user_id: 'user-1',
      status: 'succeeded',
      model: 'nano-banana-2',
      category: 'image',
      creation_mode: null,
      output_url: 'generated_images/user-1/template-result.jpg',
      showcase_asset_path: null,
      title: 'Template result',
      description: null,
      prompt: null,
    };
    const userClient = createUserClientMock(null);
    const adminClient = createCanonicalTemplateAdminClientMock({ generation });
    const publishGenerationPostWithResourceBundleAtomically = vi.fn(async () => ({
      postId: 'post-template-1',
      visibility: 'private' as const,
      bundleStatus: null,
    }));

    const result = await publishGenerationToShowcaseForRoute({
      adminSupabase: adminClient.client,
      body: {
        generationId: 'template-result-1',
        visibility: 'private',
        title: 'My final image',
        prompt: 'This must not be copied to the published generation',
        workflowSettings: { secret: 'recipe' },
        resourceBundle: { accessMode: 'none' },
      },
      supabase: userClient.client,
      userId: 'user-1',
      dependencies: {
        ensureDurableGenerationMedia: vi.fn(async ({ generation: mediaGeneration }) => ({
          outputUrl: mediaGeneration.outputUrl,
          createdLocation: null,
        })),
        listSourceToolsCatalog: vi.fn(async () => [
          { slug: 'magicbooklet', label: 'magicbooklet', models: [], supportedMediaKinds: ['image', 'video'] },
        ]),
        publishGenerationPostWithResourceBundleAtomically,
      },
    });

    expect(result).toMatchObject({
      ok: true,
      body: {
        postId: 'post-template-1',
        visibility: 'private',
      },
    });
    expect(adminClient.runFilters).toEqual([
      { column: 'user_id', value: 'user-1' },
      { column: 'status', value: 'succeeded' },
      { column: 'is_test', value: false },
      { column: 'result_generation_id', value: 'template-result-1' },
    ]);
    expect(publishGenerationPostWithResourceBundleAtomically).toHaveBeenCalledWith(expect.objectContaining({
      generationId: 'template-result-1',
      ownerUserId: 'user-1',
      generationUpdate: expect.not.objectContaining({
        prompt: expect.anything(),
        workflow_settings: expect.anything(),
      }),
      bundle: null,
      hasBundlePayload: false,
      post: expect.objectContaining({
        generation_id: 'template-result-1',
        prompt: null,
      }),
    }));
  });

  it.each([
    ['an intermediate generation', { user_id: 'user-1', status: 'succeeded' }, false],
    ['a creator test result', { user_id: 'user-1', status: 'succeeded' }, false],
    ['another user\'s result', { user_id: 'user-2', status: 'succeeded' }, true],
    ['a failed result', { user_id: 'user-1', status: 'failed' }, true],
  ])('rejects %s when the ordinary owner query cannot see it', async (_label, overrides, canonicalRun) => {
    const generation = {
      id: 'hidden-generation-1',
      user_id: 'user-1',
      status: 'succeeded',
      model: 'nano-banana-2',
      category: 'image',
      creation_mode: null,
      output_url: 'generated_images/user-1/hidden.jpg',
      showcase_asset_path: null,
      title: null,
      description: null,
      prompt: null,
      ...overrides,
    };
    const publishGenerationPostWithResourceBundleAtomically = vi.fn();

    const result = await publishGenerationToShowcaseForRoute({
      adminSupabase: createCanonicalTemplateAdminClientMock({ generation, canonicalRun }).client,
      body: { generationId: 'hidden-generation-1', visibility: 'public' },
      supabase: createUserClientMock(null).client,
      userId: 'user-1',
      dependencies: { publishGenerationPostWithResourceBundleAtomically },
    });

    expect(result).toEqual({ ok: false, status: 404, body: { error: 'Generation not found' } });
    expect(publishGenerationPostWithResourceBundleAtomically).not.toHaveBeenCalled();
  });

  it('rejects recipe, input, reference, and paid resource sharing for canonical template results', async () => {
    const generation = {
      id: 'template-result-1',
      user_id: 'user-1',
      status: 'succeeded',
      model: 'nano-banana-2',
      category: 'image',
      creation_mode: null,
      output_url: 'generated_images/user-1/template-result.jpg',
      showcase_asset_path: null,
      title: null,
      description: null,
      prompt: null,
    };
    const publishGenerationPostWithResourceBundleAtomically = vi.fn();

    const result = await publishGenerationToShowcaseForRoute({
      adminSupabase: createCanonicalTemplateAdminClientMock({ generation }).client,
      body: {
        generationId: 'template-result-1',
        visibility: 'public',
        shareInputMediaForRemix: true,
        includeGenerationReferences: true,
        exposePromptPublic: true,
        resourceBundle: { accessMode: 'paid', priceUsdCents: 900 },
      },
      supabase: createUserClientMock(null).client,
      userId: 'user-1',
      dependencies: { publishGenerationPostWithResourceBundleAtomically },
    });

    expect(result).toEqual({
      ok: false,
      status: 400,
      body: { error: 'Template results can publish media and a caption, but cannot share the private recipe or input files.' },
    });
    expect(publishGenerationPostWithResourceBundleAtomically).not.toHaveBeenCalled();
  });

  it('publishes a generation-backed post as private and removes the old showcase derivative', async () => {
    const generation = {
      id: 'gen-1',
      user_id: 'user-1',
      status: 'succeeded',
      model: 'nano-banana-2',
      category: 'image',
      creation_mode: null,
      output_url: 'generated_images/user-1/example.jpg',
      showcase_asset_path: 'showcase/gen-1/example.jpg',
      title: 'Original title',
      description: 'Original description',
      prompt: 'Original prompt',
    };
    const userClient = createUserClientMock(generation);
    const adminClient = createAdminClientMock();
    const publishGenerationPostWithResourceBundleAtomically = vi.fn(async () => ({
      postId: 'post-1',
      visibility: 'private' as const,
      bundleStatus: null,
    }));
    const dependencies = {
      ensureDurableGenerationMedia: vi.fn(async ({ generation: mediaGeneration }) => ({
        outputUrl: mediaGeneration.outputUrl,
        createdLocation: null,
      })),
      listSourceToolsCatalog: vi.fn(async () => [
        { slug: 'magicbooklet', label: 'magicbooklet', models: [], supportedMediaKinds: ['image', 'video'] },
      ]),
      publishGenerationPostWithResourceBundleAtomically,
    } satisfies Partial<ShowcasePublishServiceDependencies>;

    const result = await publishGenerationToShowcaseForRoute({
      adminSupabase: adminClient.client,
      body: {
        generationId: 'gen-1',
        visibility: 'private',
      },
      supabase: userClient.client,
      userId: 'user-1',
      dependencies,
    });

    expect(result).toEqual({
      ok: true,
      body: {
        success: true,
        isPublic: false,
        visibility: 'private',
        postId: 'post-1',
        showcasePath: null,
        ownerPath: '/post/post-1/edit',
        resourceBundlePath: '/post/post-1/edit#recipe',
        resourceBundleStatus: null,
        message: 'Saved as a private post',
      },
    });
    expect(userClient.selects[0]).toContain('showcase_asset_path');
    expect(userClient.eqs).toEqual([{ column: 'id', value: 'gen-1' }]);
    expect(publishGenerationPostWithResourceBundleAtomically).toHaveBeenCalledWith(expect.objectContaining({
      generationId: 'gen-1',
      ownerUserId: 'user-1',
      generationUpdate: expect.objectContaining({
        is_public: false,
        share_input_media_for_remix: false,
        showcase_asset_path: null,
      }),
      post: expect.objectContaining({
        generation_id: 'gen-1',
        output_url: 'generated_images/user-1/example.jpg',
        showcase_asset_path: null,
        visibility: 'private',
      }),
      hasBundlePayload: false,
    }));
    expect(adminClient.removeMock).toHaveBeenCalledWith(['showcase/gen-1/example.jpg']);
    expect(cacheMocks.invalidateShowcaseFeedCache).toHaveBeenCalledTimes(1);
  });

  it('returns an actionable profile repair response for public publishing', async () => {
    const generation = {
      id: 'gen-1',
      user_id: 'user-1',
      status: 'succeeded',
      model: 'nano-banana-2',
      category: 'image',
      creation_mode: null,
      output_url: 'generated_images/user-1/example.jpg',
      showcase_asset_path: null,
      title: 'Original title',
      description: 'Original description',
      prompt: 'Original prompt',
    };
    const userClient = createUserClientMock(generation);
    const adminClient = createAdminClientMock();
    const publishGenerationPostWithResourceBundleAtomically = vi.fn();

    const result = await publishGenerationToShowcaseForRoute({
      adminSupabase: adminClient.client,
      body: {
        generationId: 'gen-1',
        visibility: 'public',
      },
      supabase: userClient.client,
      userId: 'user-1',
      dependencies: {
        getMarketplaceQualityErrorForPostBundle: vi.fn(async () => (
          'Complete your profile before publishing publicly: choose a custom handle and add your display name.'
        )),
        publishGenerationPostWithResourceBundleAtomically,
      },
    });

    expect(result).toEqual({
      ok: false,
      status: 400,
      body: {
        error: 'Complete your profile before publishing publicly: choose a custom handle and add your display name.',
        field: 'profile',
        actionHref: '/profile',
        actionLabel: 'Complete profile and return',
      },
    });
    expect(publishGenerationPostWithResourceBundleAtomically).not.toHaveBeenCalled();
    expect(cacheMocks.invalidateShowcaseFeedCache).not.toHaveBeenCalled();
  });

  it('returns a retryable server failure when profile verification is unavailable', async () => {
    const generation = {
      id: 'gen-1',
      user_id: 'user-1',
      status: 'succeeded',
      model: 'nano-banana-2',
      category: 'image',
      creation_mode: null,
      output_url: 'generated_images/user-1/example.jpg',
      showcase_asset_path: null,
      title: 'Original title',
      description: 'Original description',
      prompt: 'Original prompt',
    };
    const userClient = createUserClientMock(generation);
    const adminClient = createAdminClientMock();

    const result = await publishGenerationToShowcaseForRoute({
      adminSupabase: adminClient.client,
      body: { generationId: 'gen-1', visibility: 'public' },
      supabase: userClient.client,
      userId: 'user-1',
      dependencies: {
        getMarketplaceQualityErrorForPostBundle: vi.fn(async () => (
          'Could not verify your creator profile right now. Try again.'
        )),
      },
    });

    expect(result).toEqual({
      ok: false,
      status: 500,
      body: { error: 'Could not verify your creator profile right now. Try again.' },
    });
  });
});
