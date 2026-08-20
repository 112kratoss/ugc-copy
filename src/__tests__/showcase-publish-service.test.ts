import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const cacheMocks = vi.hoisted(() => ({
  SHOWCASE_FEED_CACHE_TAG: 'showcase-feed:v2',
  invalidateShowcaseFeedCache: vi.fn(),
}));

const logBackendErrorMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/showcase-feed-cache', () => cacheMocks);
vi.mock('@/lib/backend-logger', () => ({
  logBackendError: logBackendErrorMock,
}));

import {
  getCanonicalGenerationShowcaseAssetPath,
  publishGenerationToShowcaseForRoute,
  type ShowcasePublishServiceDependencies,
} from '@/lib/showcase-publish-service';
import { PUBLIC_UGC_SAFETY_ERROR } from '@/lib/public-ugc-safety';

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

/**
 * Admin client for ordinary (non-template) publishes. Serves the generation
 * read — the service reads with the service client on purpose, because the
 * authenticated Data API grant on `generations` is column-scoped and cannot
 * see the publish columns — and deliberately throws on `template_runs`:
 * an unlinked row must never pay for the canonical-run lookup.
 */
function createAdminClientMock(generation: Record<string, unknown> | null = null, loadError: { message: string; code?: string } | null = null) {
  const removeMock = vi.fn(async () => ({ data: null, error: null }));
  const selects: string[] = [];
  const eqs: Array<{ column: string; value: unknown }> = [];

  return {
    client: {
      from(table: string) {
        if (table === 'posts' || table === 'post_resource_bundles') {
          const query = {
            eq: vi.fn(() => query),
            maybeSingle: vi.fn(async () => ({ data: null, error: null })),
          };
          return { select: vi.fn(() => query) };
        }

        if (table !== 'generations') {
          throw new Error(`Unexpected admin table: ${table}`);
        }

        return {
          select(columns = '') {
            selects.push(columns);
            return {
              eq(column: string, value: unknown) {
                eqs.push({ column, value });
                return {
                  single() {
                    if (loadError) {
                      return Promise.resolve({ data: null, error: loadError });
                    }
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
      storage: {
        from: vi.fn(() => ({
          remove: removeMock,
        })),
      },
    } as unknown as SupabaseClient,
    eqs,
    removeMock,
    selects,
  };
}

describe('publishGenerationToShowcaseForRoute', () => {
  beforeEach(() => {
    cacheMocks.invalidateShowcaseFeedCache.mockClear();
    logBackendErrorMock.mockClear();
  });

  it('canonicalizes only the selected generation showcase prefix before removal', () => {
    expect(getCanonicalGenerationShowcaseAssetPath(
      'showcase/gen-1/output.webp',
      'gen-1',
    )).toBe('showcase/gen-1/output.webp');
    for (const storagePath of [
      'showcase/gen-2/private.webp',
      'showcase/gen-1/../gen-2/private.webp',
      'showcase/gen-1/%252fgen-2/private.webp',
      'showcase/gen-1/%255cgen-2/private.webp',
    ]) {
      expect(getCanonicalGenerationShowcaseAssetPath(storagePath, 'gen-1')).toBeNull();
    }
  });

  it('logs a failed generation load instead of silently reporting not found', async () => {
    // The four days this path was broken in production, a permission error on
    // the read surfaced as a bare "Generation not found" with no trace. The
    // 404 stays (the caller cannot use a half-loaded row), but the failure
    // must be observable.
    const loadError = { message: 'permission denied for table generations', code: '42501' };

    const result = await publishGenerationToShowcaseForRoute({
      adminSupabase: createAdminClientMock(null, loadError).client,
      body: { generationId: 'gen-1', visibility: 'public' },
      userId: 'user-1',
      dependencies: {},
    });

    expect(result).toEqual({ ok: false, status: 404, body: { error: 'Generation not found' } });
    expect(logBackendErrorMock).toHaveBeenCalledWith(
      'failed_to_load_generation_for_publish',
      { error: loadError },
    );
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
      template_run_id: 'run-1',
      template_run_step_id: null,
    };
    const adminClient = createCanonicalTemplateAdminClientMock({ generation });
    const publishGenerationPostWithResourceBundleAtomically = vi.fn(async () => ({
      postId: 'post-template-1',
      visibility: 'private' as const,
      bundleId: null,
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
      userId: 'user-1',
      dependencies: {
        ensureDurableGenerationMedia: vi.fn(async ({ generation: mediaGeneration }) => ({
          outputUrl: mediaGeneration.outputUrl,
          createdLocation: null,
        })),
        listSourceToolsCatalog: vi.fn(async () => [
          {
            slug: 'magicbooklet',
            label: 'magicbooklet',
            models: [],
            supportedMediaKinds: ['image' as const, 'video' as const],
          },
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
    ['an intermediate step generation', { user_id: 'user-1', status: 'succeeded', template_run_id: null, template_run_step_id: 'step-1' }, false],
    ['a creator test result', { user_id: 'user-1', status: 'succeeded', template_run_id: 'run-test', template_run_step_id: null }, false],
    ['another user\'s result', { user_id: 'user-2', status: 'succeeded', template_run_id: 'run-1', template_run_step_id: null }, true],
    ['a failed result', { user_id: 'user-1', status: 'failed', template_run_id: 'run-1', template_run_step_id: null }, true],
  ])('reports a backend-private template generation as not found for %s', async (_label, overrides, canonicalRun) => {
    const generation = {
      id: 'hidden-generation-1',
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
      userId: 'user-1',
      dependencies: { publishGenerationPostWithResourceBundleAtomically },
    });

    // Template-linked rows reveal nothing — not ownership, not status —
    // preserving the row-level invisibility they had under
    // 20260711154500_private_template_generations.sql.
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
      template_run_id: 'run-1',
      template_run_step_id: null,
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
    const adminClient = createAdminClientMock(generation);
    const publishGenerationPostWithResourceBundleAtomically = vi.fn(async () => ({
      postId: 'post-1',
      visibility: 'private' as const,
      bundleId: null,
      bundleStatus: null,
    }));
    const dependencies = {
      ensureDurableGenerationMedia: vi.fn(async ({ generation: mediaGeneration }) => ({
        outputUrl: mediaGeneration.outputUrl,
        createdLocation: null,
      })),
      listSourceToolsCatalog: vi.fn(async () => [
        {
          slug: 'magicbooklet',
          label: 'magicbooklet',
          models: [],
          supportedMediaKinds: ['image' as const, 'video' as const],
        },
      ]),
      publishGenerationPostWithResourceBundleAtomically,
    } satisfies Partial<ShowcasePublishServiceDependencies>;

    const result = await publishGenerationToShowcaseForRoute({
      adminSupabase: adminClient.client,
      body: {
        generationId: 'gen-1',
        visibility: 'private',
      },
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
    // The read goes through the service client — the authenticated Data API
    // grant is column-scoped and cannot see the publish columns — and asks for
    // the template linkage so backend-private rows are recognized from the row.
    expect(adminClient.selects[0]).toContain('showcase_asset_path');
    expect(adminClient.selects[0]).toContain('template_run_id');
    expect(adminClient.eqs).toEqual([{ column: 'id', value: 'gen-1' }]);
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

  // This endpoint serves the composer and Studio's visibility switch. Only the
  // first is composing a post, so only the first has to name one — otherwise
  // flipping an old untitled generation to private would start failing.
  it('rejects a compose submission that resolves to no title at all', async () => {
    const generation = {
      id: 'gen-1',
      user_id: 'user-1',
      status: 'succeeded',
      model: 'nano-banana-2',
      category: 'image',
      creation_mode: null,
      output_url: 'generated_images/user-1/example.jpg',
      showcase_asset_path: null,
      title: null,
      description: null,
      prompt: 'Original prompt',
    };
    const adminClient = createAdminClientMock(generation);
    const publishGenerationPostWithResourceBundleAtomically = vi.fn();

    const result = await publishGenerationToShowcaseForRoute({
      adminSupabase: adminClient.client,
      body: {
        generationId: 'gen-1',
        visibility: 'private',
        // Carrying post content is what marks this a compose submission; the
        // composer always sends a resource bundle, even an empty one.
        resourceBundle: { accessMode: 'none' },
      },
      userId: 'user-1',
      dependencies: {
        ensureDurableGenerationMedia: vi.fn(async ({ generation: mediaGeneration }) => ({
          outputUrl: mediaGeneration.outputUrl,
          createdLocation: null,
        })),
        publishGenerationPostWithResourceBundleAtomically,
      } satisfies Partial<ShowcasePublishServiceDependencies>,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 400,
      body: { error: 'Add a title for your post.', field: 'title' },
    });
    expect(publishGenerationPostWithResourceBundleAtomically).not.toHaveBeenCalled();
  });

  it('still flips visibility on an untitled generation, because that is not composing', async () => {
    const generation = {
      id: 'gen-1',
      user_id: 'user-1',
      status: 'succeeded',
      model: 'nano-banana-2',
      category: 'image',
      creation_mode: null,
      output_url: 'generated_images/user-1/example.jpg',
      showcase_asset_path: null,
      title: null,
      description: null,
      prompt: 'Original prompt',
    };
    const adminClient = createAdminClientMock(generation);
    const publishGenerationPostWithResourceBundleAtomically = vi.fn(async () => ({
      postId: 'post-1',
      visibility: 'private' as const,
      bundleId: null,
      bundleStatus: null,
    }));

    const result = await publishGenerationToShowcaseForRoute({
      adminSupabase: adminClient.client,
      // Exactly what Studio sends: no title, no body, no bundle.
      body: {
        generationId: 'gen-1',
        visibility: 'private',
      },
      userId: 'user-1',
      dependencies: {
        ensureDurableGenerationMedia: vi.fn(async ({ generation: mediaGeneration }) => ({
          outputUrl: mediaGeneration.outputUrl,
          createdLocation: null,
        })),
        listSourceToolsCatalog: vi.fn(async () => [
          {
            slug: 'magicbooklet',
            label: 'magicbooklet',
            models: [],
            supportedMediaKinds: ['image' as const, 'video' as const],
          },
        ]),
        publishGenerationPostWithResourceBundleAtomically,
      } satisfies Partial<ShowcasePublishServiceDependencies>,
    });

    expect(result).toMatchObject({ ok: true });
    expect(publishGenerationPostWithResourceBundleAtomically).toHaveBeenCalledTimes(1);
  });

  it('maps a sold-package mutation rejected inside the generation transaction to a conflict', async () => {
    const generation = {
      id: 'gen-sold',
      user_id: 'user-1',
      status: 'succeeded',
      model: 'nano-banana-2',
      category: 'image',
      creation_mode: null,
      output_url: 'generated_images/user-1/example.jpg',
      showcase_asset_path: null,
      title: 'Purchased generation post',
      description: null,
      prompt: 'Original prompt',
    };
    const publishGenerationPostWithResourceBundleAtomically = vi.fn(async () => {
      throw {
        message: 'RESOURCE_BUNDLE_LOCKED: this package has already been purchased',
        hint: 'RESOURCE_BUNDLE_LOCKED',
      };
    });

    const result = await publishGenerationToShowcaseForRoute({
      adminSupabase: createAdminClientMock(generation).client,
      body: {
        generationId: 'gen-sold',
        visibility: 'private',
        // A stale generation composer used to delist the package with this.
        resourceBundle: { accessMode: 'none' },
      },
      userId: 'user-1',
      dependencies: {
        ensureDurableGenerationMedia: vi.fn(async ({ generation: mediaGeneration }) => ({
          outputUrl: mediaGeneration.outputUrl,
          createdLocation: null,
        })),
        listSourceToolsCatalog: vi.fn(async () => [
          {
            slug: 'magicbooklet',
            label: 'magicbooklet',
            models: [],
            supportedMediaKinds: ['image' as const, 'video' as const],
          },
        ]),
        publishGenerationPostWithResourceBundleAtomically,
      },
    });

    expect(result).toEqual({
      ok: false,
      status: 409,
      body: {
        error: 'People have already purchased this package, so its contents, price, and access mode are locked.',
        code: 'RESOURCE_BUNDLE_LOCKED',
      },
    });
    expect(cacheMocks.invalidateShowcaseFeedCache).not.toHaveBeenCalled();
  });

  it('revalidates a frozen sold generation package before status-only republish', async () => {
    const generation = {
      id: 'gen-sold',
      user_id: 'user-1',
      status: 'succeeded',
      model: 'nano-banana-2',
      category: 'image',
      creation_mode: null,
      output_url: 'generated_images/user-1/example.jpg',
      showcase_asset_path: null,
      title: 'Purchased generation post',
      description: null,
      prompt: 'Original prompt',
    };
    const frozenBundle = {
      accessMode: 'paid' as const,
      summary: 'Reusable generation package.',
      previewText: 'Includes the exact prompt and workflow.',
      priceUsdCents: 500,
      resources: {
        promptText: 'Build the original proof sequence.',
        attachments: [],
        allowRemix: false,
      },
    };
    const marketplaceQuality = vi.fn(async () => (
      'Complete your creator profile name or username before publishing a marketplace unlock.'
    ));
    const publishGenerationPostWithResourceBundleAtomically = vi.fn();

    const result = await publishGenerationToShowcaseForRoute({
      adminSupabase: createAdminClientMock(generation).client,
      body: {
        generationId: 'gen-sold',
        visibility: 'public',
        exposePromptPublic: true,
      },
      userId: 'user-1',
      dependencies: {
        loadFrozenSoldGenerationBundleForQuality: vi.fn(async () => frozenBundle),
        getMarketplaceQualityErrorForPostBundle: marketplaceQuality,
        publishGenerationPostWithResourceBundleAtomically,
      },
    });

    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(marketplaceQuality).toHaveBeenCalledWith(expect.objectContaining({
      bundle: frozenBundle,
    }));
    expect(publishGenerationPostWithResourceBundleAtomically).not.toHaveBeenCalled();
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
    const adminClient = createAdminClientMock(generation);
    const publishGenerationPostWithResourceBundleAtomically = vi.fn();

    const result = await publishGenerationToShowcaseForRoute({
      adminSupabase: adminClient.client,
      body: {
        generationId: 'gen-1',
        visibility: 'public',
      },
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

  it('blocks an unsafe originating prompt even when the prompt would stay hidden', async () => {
    const generation = {
      id: 'gen-unsafe',
      user_id: 'user-1',
      status: 'succeeded',
      model: 'nano-banana-2',
      category: 'image',
      creation_mode: null,
      output_url: 'generated_images/user-1/example.jpg',
      showcase_asset_path: null,
      title: 'Generated portrait',
      description: 'A generated portrait.',
      prompt: 'Generate a nude portrait of an underage child.',
    };
    const publishGenerationPostWithResourceBundleAtomically = vi.fn();
    const marketplaceCheck = vi.fn();

    const result = await publishGenerationToShowcaseForRoute({
      adminSupabase: createAdminClientMock(generation).client,
      body: {
        generationId: 'gen-unsafe',
        visibility: 'public',
        exposePromptPublic: false,
      },
      userId: 'user-1',
      dependencies: {
        getMarketplaceQualityErrorForPostBundle: marketplaceCheck,
        publishGenerationPostWithResourceBundleAtomically,
      },
    });

    expect(result).toEqual({
      ok: false,
      status: 400,
      body: { error: PUBLIC_UGC_SAFETY_ERROR, field: 'prompt' },
    });
    expect(marketplaceCheck).not.toHaveBeenCalled();
    expect(publishGenerationPostWithResourceBundleAtomically).not.toHaveBeenCalled();
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
    const adminClient = createAdminClientMock(generation);

    const result = await publishGenerationToShowcaseForRoute({
      adminSupabase: adminClient.client,
      body: { generationId: 'gen-1', visibility: 'public' },
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
