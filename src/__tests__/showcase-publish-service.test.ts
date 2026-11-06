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
// No case here reaches the database for the post's Made with: the ones about
// that row pass a writer of their own.
vi.mock('@/lib/post-source-tools-server', () => ({
  replacePostSourceTools: vi.fn(async () => undefined),
}));
// A creation here remixed nobody's post unless a case says so: the cases about
// a remix's terms pass a reader of their own.
vi.mock('@/lib/remix-recipe-terms', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/remix-recipe-terms')>();
  return { ...actual, loadRemixRecipeTerms: vi.fn(async () => actual.NO_REMIX_RECIPE_TERMS) };
});

import {
  getCanonicalGenerationShowcaseAssetPath,
  publishGenerationToShowcaseForRoute,
  type ShowcasePublishRequestBody,
  type ShowcasePublishServiceDependencies,
} from '@/lib/showcase-publish-service';
import { PUBLIC_UGC_SAFETY_ERROR } from '@/lib/public-ugc-safety';
import { BODY_MAX_LENGTH, TITLE_MAX_LENGTH } from '@/lib/posts-server';
import type { PostResourceBundleInput, PostResourceItem } from '@/lib/post-resource-bundles';
import { REMIX_RECIPE_TERMS_UNREADABLE_ERROR } from '@/lib/remix-recipe-terms';

import mobileApiContract from '../../contracts/mobile-api-v1.json';
import {
  REMIX_RECIPE_MUST_BE_PAID,
  REMIX_RECIPE_MUST_BE_PAID_CODE,
  REMIX_RECIPE_STAYS_FREE,
  REMIX_RECIPE_STAYS_FREE_CODE,
} from '../../ugc-mobile/lib/creation-recipe/creation-recipe';

/** The linked-identity lookup: the guest ids merged into the caller's account. */
function linkedProfilesQuery(linkedGuestIds: string[]) {
  return {
    select: vi.fn(() => ({
      eq: vi.fn(async () => ({ data: linkedGuestIds.map((id) => ({ id })), error: null })),
    })),
  };
}

function createCanonicalTemplateAdminClientMock({
  generation,
  canonicalRun = true,
  linkedGuestIds = [],
}: {
  generation: Record<string, unknown> | null;
  canonicalRun?: boolean;
  linkedGuestIds?: string[];
}) {
  const runFilters: Array<{ column: string; value: unknown }> = [];
  const removeMock = vi.fn(async () => ({ data: null, error: null }));

  const client = {
    from(table: string) {
      if (table === 'profiles') return linkedProfilesQuery(linkedGuestIds);
      if (table === 'posts') {
        const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: null, error: null }) };
        return query;
      }
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
      from: vi.fn(() => ({ remove: removeMock, exists: vi.fn(async () => ({ data: false, error: { status: 404 } })) })),
    },
  } as unknown as SupabaseClient;

  return { client, removeMock, runFilters };
}

/**
 * Admin client for ordinary (non-template) publishes. Serves the generation
 * read — the service reads with the service client on purpose, because the
 * authenticated Data API has no SELECT on `generations` — and deliberately
 * throws on `template_runs`:
 * an unlinked row must never pay for the canonical-run lookup.
 */
function createAdminClientMock(
  generation: Record<string, unknown> | null = null,
  loadError: { message: string; code?: string } | null = null,
  options: {
    postMediaRows?: Array<Record<string, unknown>>;
    /** The rows as the removal's delete finds them, when a sweep recorded on one after the read. */
    postMediaRowsAtDelete?: Array<Record<string, unknown>>;
    linkedGuestIds?: string[];
    /** The creation's existing post and its stored recipe row. */
    storedPost?: Record<string, unknown> | null;
    storedBundle?: Record<string, unknown> | null;
  } = {},
) {
  const removeMock = vi.fn(async () => ({ data: null, error: null }));
  const downloadMock = vi.fn(async () => ({
    data: new Blob(['media-bytes'], { type: 'image/jpeg' }),
    error: null,
  }));
  const uploadMock = vi.fn(async () => ({ data: null, error: null }));
  const selects: string[] = [];
  const eqs: Array<{ column: string; value: unknown }> = [];
  const deletedMediaRowIds: string[][] = [];
  const queued: unknown[] = [];

  return {
    client: {
      rpc: vi.fn(async (name: string, args: unknown) => {
        if (name !== 'queue_unrecorded_showcase_media') throw new Error(`Unexpected admin rpc: ${name}`);
        queued.push(args);
        return { data: 1, error: null };
      }),
      from(table: string) {
        if (table === 'profiles') return linkedProfilesQuery(options.linkedGuestIds ?? []);
        if (table === 'posts' || table === 'post_resource_bundles') {
          const row = (table === 'posts' ? options.storedPost : options.storedBundle) ?? null;
          return {
            select: vi.fn((columns: string = '') => {
              // Only the selected columns come back, as from PostgREST, so a
              // reader that forgets a column sees it missing.
              const selected = row
                ? Object.fromEntries(columns.split(',').map((column) => column.trim())
                  .filter((column) => column in row)
                  .map((column) => [column, row[column]]))
                : null;
              const query = {
                eq: vi.fn(() => query),
                maybeSingle: vi.fn(async () => ({ data: selected, error: null })),
              };
              return query;
            }),
          };
        }

        // A private publish retires the legacy media rows that still point at
        // the derivative (see removeGenerationShowcaseDerivative).
        if (table === 'post_media') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(async () => ({ data: options.postMediaRows ?? [], error: null })),
            })),
            delete: vi.fn(() => ({
              in: vi.fn((_column: string, ids: string[]) => ({
                // The deleted rows, as `.select()` answers them.
                select: vi.fn(async () => {
                  deletedMediaRowIds.push(ids);
                  const rows = options.postMediaRowsAtDelete ?? options.postMediaRows ?? [];
                  return { data: rows.filter((row) => ids.includes(String(row.id))), error: null };
                }),
              })),
            })),
          };
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
          exists: vi.fn(async () => ({ data: false, error: { status: 404 } })),
          // An exposed publish copies the generation's output into the public
          // bucket before it writes the post; a private one never gets here.
          download: downloadMock,
          upload: uploadMock,
        })),
      },
    } as unknown as SupabaseClient,
    deletedMediaRowIds,
    downloadMock,
    eqs,
    queued,
    removeMock,
    selects,
    uploadMock,
  };
}

/** A recipe as both composers send it: one card, the legacy prompt and notes empty. */
function cardRecipe({
  cardText = 'Soft key light from the left, warm rim light behind.',
  cardDescription = 'The prompt behind the portrait.',
  previewText = 'Includes the prompt and the light plan.',
}: { cardText?: string; cardDescription?: string; previewText?: string } = {}): PostResourceBundleInput {
  return {
    accessMode: 'free',
    summary: 'A reusable lighting setup for portraits.',
    previewText,
    resources: {
      promptText: null,
      notesMarkdown: null,
      attachments: [],
      allowRemix: false,
      sections: [{
        id: 'card-1',
        title: 'Portrait prompt',
        publicTitle: 'Portrait prompt',
        kind: 'global',
        description: cardDescription,
        sortOrder: 0,
        resourceType: 'prompt',
      }],
      items: [{
        id: 'card-1-item-1',
        type: 'prompt',
        role: 'primary',
        sectionId: 'card-1',
        title: 'Portrait prompt',
        description: null,
        textContent: cardText,
        externalUrl: null,
        storagePath: null,
        contentType: null,
        sizeBytes: null,
        workflowSnapshot: null,
        sortOrder: 0,
        isPrimary: true,
        remixUse: 'none',
      }],
    },
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

  // The merge moves balances only: a creation made as a guest keeps the guest's
  // id, and Studio lists it through the linked id. The person who registered
  // in order to share it was told "You do not own this creation".
  describe('a creation made as a guest before registering', () => {
    const madeAsGuest = {
      id: 'gen-guest',
      user_id: 'guest-1',
      status: 'succeeded',
      model: 'nano-banana-2',
      category: 'image',
      creation_mode: null,
      output_url: 'generated_images/guest-1/made-as-guest.jpg',
      showcase_asset_path: null,
      title: 'Made as a guest',
      description: null,
      prompt: 'A lighthouse at dusk',
    };

    function publishDependencies() {
      return {
        ensureDurableGenerationMedia: vi.fn(async ({ generation: mediaGeneration }) => ({
          outputUrl: mediaGeneration.outputUrl,
          createdLocation: null,
        })),
        listSourceToolsCatalog: vi.fn(async () => [
          { slug: 'magicbooklet', label: 'magicbooklet', models: [], supportedMediaKinds: ['image' as const, 'video' as const] },
        ]),
        getMarketplaceQualityErrorForPostBundle: vi.fn(async () => null),
        publishGenerationPostWithResourceBundleAtomically: vi.fn(async () => ({
          postId: 'post-guest',
          visibility: 'public' as const,
          bundleId: null,
          bundleStatus: null,
        })),
        ensureGenerationPostCoverMedia: vi.fn(async () => ({ outcome: 'created' as const, error: null })),
        requestPostEmbedding: vi.fn(async () => undefined),
      } satisfies Partial<ShowcasePublishServiceDependencies>;
    }

    it("publishes it for the account the guest was linked to, as the account's own post", async () => {
      const adminClient = createAdminClientMock(madeAsGuest, null, { linkedGuestIds: ['guest-1'] });
      const dependencies = publishDependencies();

      const result = await publishGenerationToShowcaseForRoute({
        adminSupabase: adminClient.client,
        body: { generationId: 'gen-guest', visibility: 'public' },
        userId: 'user-1',
        dependencies,
      });

      expect(result).toMatchObject({ ok: true, body: { postId: 'post-guest', visibility: 'public' } });
      expect(dependencies.publishGenerationPostWithResourceBundleAtomically).toHaveBeenCalledWith(expect.objectContaining({
        generationId: 'gen-guest',
        ownerUserId: 'user-1',
        post: expect.objectContaining({ user_id: 'user-1', generation_id: 'gen-guest' }),
      }));
      // The output is read where the guest's run stored it.
      expect(adminClient.downloadMock).toHaveBeenCalledWith('guest-1/made-as-guest.jpg');
    });

    it("still refuses a creation of someone the account is not linked to", async () => {
      const adminClient = createAdminClientMock(
        { ...madeAsGuest, user_id: 'user-2', output_url: 'generated_images/user-2/theirs.jpg' },
        null,
        { linkedGuestIds: ['guest-1'] },
      );
      const dependencies = publishDependencies();

      const result = await publishGenerationToShowcaseForRoute({
        adminSupabase: adminClient.client,
        body: { generationId: 'gen-guest', visibility: 'public' },
        userId: 'user-1',
        dependencies,
      });

      expect(result).toEqual({
        ok: false,
        status: 403,
        body: { error: 'Unauthorized: You do not own this creation' },
      });
      expect(dependencies.publishGenerationPostWithResourceBundleAtomically).not.toHaveBeenCalled();
      expect(adminClient.downloadMock).not.toHaveBeenCalled();
    });

    it("publishes the canonical result of the guest's own template run", async () => {
      const generation = { ...madeAsGuest, template_run_id: 'run-1', template_run_step_id: null };
      const adminClient = createCanonicalTemplateAdminClientMock({ generation, linkedGuestIds: ['guest-1'] });
      const publishGenerationPostWithResourceBundleAtomically = vi.fn(async () => ({
        postId: 'post-guest-template',
        visibility: 'private' as const,
        bundleId: null,
        bundleStatus: null,
      }));

      const result = await publishGenerationToShowcaseForRoute({
        adminSupabase: adminClient.client,
        body: { generationId: 'gen-guest', visibility: 'private' },
        userId: 'user-1',
        dependencies: { ...publishDependencies(), publishGenerationPostWithResourceBundleAtomically },
      });

      expect(result).toMatchObject({ ok: true, body: { postId: 'post-guest-template' } });
      // The run is the guest's, as its result is.
      expect(adminClient.runFilters).toContainEqual({ column: 'user_id', value: 'guest-1' });
      expect(publishGenerationPostWithResourceBundleAtomically).toHaveBeenCalledWith(expect.objectContaining({
        ownerUserId: 'user-1',
        post: expect.objectContaining({ user_id: 'user-1' }),
      }));
    });
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
    // A post from before the 2026-06 gallery backfill: its media row and the
    // row's preview both live in the public bucket next to the derivative.
    const adminClient = createAdminClientMock(generation, null, {
      postMediaRows: [{
        id: 'media-row-1',
        storage_path: 'showcase/gen-1/example.jpg',
        preview_storage_path: 'showcase/gen-1/example.preview.1234.webp',
        rendition_storage_path: null,
        teaser_storage_path: null,
      }],
    });
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
    // has no SELECT on `generations` — and asks for
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
    expect(adminClient.deletedMediaRowIds).toEqual([['media-row-1']]);
    expect(adminClient.removeMock).toHaveBeenCalledWith([
      'showcase/gen-1/example.jpg',
      'showcase/gen-1/example.preview.1234.webp',
    ]);
    expect(adminClient.queued).toEqual([]);
    expect(cacheMocks.invalidateShowcaseFeedCache).toHaveBeenCalledTimes(1);
  });

  // The removal reads the legacy rows, removes what they name, then deletes the
  // rows: a sweep that records on one in between named its upload only there.
  it('hands the revocation queue what a sweep recorded on a legacy row while a private publish removed it', async () => {
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
    const legacyRow = {
      id: 'media-row-1',
      storage_path: 'showcase/gen-1/example.jpg',
      preview_storage_path: null,
      rendition_storage_path: null,
      teaser_storage_path: null,
    };
    const adminClient = createAdminClientMock(generation, null, {
      postMediaRows: [legacyRow],
      postMediaRowsAtDelete: [{ ...legacyRow, preview_storage_path: 'showcase/gen-1/example.preview.late.webp' }],
    });

    const result = await publishGenerationToShowcaseForRoute({
      adminSupabase: adminClient.client,
      body: { generationId: 'gen-1', visibility: 'private' },
      userId: 'user-1',
      dependencies: {
        ensureDurableGenerationMedia: vi.fn(async ({ generation: mediaGeneration }) => ({
          outputUrl: mediaGeneration.outputUrl,
          createdLocation: null,
        })),
        listSourceToolsCatalog: vi.fn(async () => [{
          slug: 'magicbooklet',
          label: 'magicbooklet',
          models: [],
          supportedMediaKinds: ['image' as const, 'video' as const],
        }]),
        publishGenerationPostWithResourceBundleAtomically: vi.fn(async () => ({
          postId: 'post-1',
          visibility: 'private' as const,
          bundleId: null,
          bundleStatus: null,
        })),
      } satisfies Partial<ShowcasePublishServiceDependencies>,
    });

    expect(result).toMatchObject({ ok: true, body: { visibility: 'private', postId: 'post-1' } });
    expect(adminClient.removeMock).toHaveBeenCalledWith(['showcase/gen-1/example.jpg']);
    expect(adminClient.queued).toEqual([{ p_paths: ['showcase/gen-1/example.preview.late.webp'] }]);
  });

  // Product decision 12 (2026-10-17): a post is public or private. Installed
  // apps and Studio's old menu can still ask for unlisted; it is stored and
  // answered as private, the safe reading of "only people with the link".
  it('stores and answers a requested unlisted post as private, taking its derivative down', async () => {
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
    const ensureGenerationPostCoverMedia = vi.fn();
    const requestPostEmbedding = vi.fn(async () => undefined);

    const result = await publishGenerationToShowcaseForRoute({
      adminSupabase: adminClient.client,
      body: { generationId: 'gen-1', visibility: 'unlisted' },
      userId: 'user-1',
      dependencies: {
        ensureDurableGenerationMedia: vi.fn(async ({ generation: mediaGeneration }) => ({
          outputUrl: mediaGeneration.outputUrl,
          createdLocation: null,
        })),
        listSourceToolsCatalog: vi.fn(async () => [
          { slug: 'magicbooklet', label: 'magicbooklet', models: [], supportedMediaKinds: ['image' as const, 'video' as const] },
        ]),
        publishGenerationPostWithResourceBundleAtomically,
        ensureGenerationPostCoverMedia,
        requestPostEmbedding,
      } satisfies Partial<ShowcasePublishServiceDependencies>,
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
    expect(publishGenerationPostWithResourceBundleAtomically).toHaveBeenCalledWith(expect.objectContaining({
      generationUpdate: expect.objectContaining({ is_public: false, showcase_asset_path: null }),
      post: expect.objectContaining({ visibility: 'private', showcase_asset_path: null }),
    }));
    expect(adminClient.removeMock).toHaveBeenCalledWith(['showcase/gen-1/example.jpg']);
    expect(ensureGenerationPostCoverMedia).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(requestPostEmbedding).not.toHaveBeenCalled();
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

  describe('title and text length', () => {
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
    const dependencies = (publish: ShowcasePublishServiceDependencies['publishGenerationPostWithResourceBundleAtomically']) => ({
      ensureDurableGenerationMedia: vi.fn(async ({ generation: mediaGeneration }) => ({
        outputUrl: mediaGeneration.outputUrl,
        createdLocation: null,
      })),
      listSourceToolsCatalog: vi.fn(async () => []),
      publishGenerationPostWithResourceBundleAtomically: publish,
    }) satisfies Partial<ShowcasePublishServiceDependencies>;

    it('rejects a compose submission whose title is over the limit', async () => {
      const publish = vi.fn();
      const result = await publishGenerationToShowcaseForRoute({
        adminSupabase: createAdminClientMock(generation).client,
        body: {
          generationId: 'gen-1',
          visibility: 'private',
          title: 't'.repeat(TITLE_MAX_LENGTH + 1),
          resourceBundle: { accessMode: 'none' },
        },
        userId: 'user-1',
        dependencies: dependencies(publish),
      });

      expect(result).toMatchObject({
        ok: false,
        status: 400,
        body: { error: `Titles are limited to ${TITLE_MAX_LENGTH} characters.`, field: 'title' },
      });
      expect(publish).not.toHaveBeenCalled();
    });

    it('rejects a compose submission whose text is over the limit', async () => {
      const publish = vi.fn();
      const result = await publishGenerationToShowcaseForRoute({
        adminSupabase: createAdminClientMock(generation).client,
        body: {
          generationId: 'gen-1',
          visibility: 'private',
          title: 'Golden hour study',
          body: 'b'.repeat(BODY_MAX_LENGTH + 1),
          resourceBundle: { accessMode: 'none' },
        },
        userId: 'user-1',
        dependencies: dependencies(publish),
      });

      expect(result).toMatchObject({
        ok: false,
        status: 400,
        body: { error: `Post text is limited to ${BODY_MAX_LENGTH} characters.`, field: 'body' },
      });
      expect(publish).not.toHaveBeenCalled();
    });

    // The quick-publish dialog caps the caption it sends as the description at
    // 1,000; the server held it to nothing.
    it('rejects a compose submission whose description is over the limit', async () => {
      const publish = vi.fn();
      const result = await publishGenerationToShowcaseForRoute({
        adminSupabase: createAdminClientMock(generation).client,
        body: {
          generationId: 'gen-1',
          visibility: 'private',
          title: 'Golden hour study',
          description: 'd'.repeat(1001),
          resourceBundle: { accessMode: 'none' },
        },
        userId: 'user-1',
        dependencies: dependencies(publish),
      });

      expect(result).toMatchObject({
        ok: false,
        status: 400,
        body: { error: 'Descriptions are limited to 1000 characters.', field: 'description' },
      });
      expect(publish).not.toHaveBeenCalled();
    });

    // Both composers cap these; a client that does not must not get past them.
    it.each([
      ['public summary', { ...cardRecipe(), summary: 's'.repeat(181) }, 'resourceSummary', 'Public summaries are limited to 180 characters.'],
      ['package preview', cardRecipe({ previewText: 'p'.repeat(181) }), 'resourcePreview', 'Package previews are limited to 180 characters.'],
      ["card's unlocked description", cardRecipe({ cardDescription: 'u'.repeat(121) }), 'resourceCards', 'Unlocked descriptions are limited to 120 characters.'],
    ] as const)('rejects a recipe whose %s is longer than the composers allow', async (_label, resourceBundle, field, error) => {
      const publish = vi.fn();
      const result = await publishGenerationToShowcaseForRoute({
        adminSupabase: createAdminClientMock(generation).client,
        body: {
          generationId: 'gen-1',
          visibility: 'private',
          title: 'Golden hour study',
          resourceBundle,
        },
        userId: 'user-1',
        dependencies: dependencies(publish),
      });

      expect(result).toEqual({ ok: false, status: 400, body: { error, field } });
      expect(publish).not.toHaveBeenCalled();
    });

    // A flip writes nothing new; an older post may carry what is now too long.
    it('still flips the visibility of a post whose stored title and text predate the limits', async () => {
      const publish = vi.fn(async () => ({
        postId: 'post-1',
        visibility: 'private' as const,
        bundleId: null,
        bundleStatus: null,
      }));
      const result = await publishGenerationToShowcaseForRoute({
        adminSupabase: createAdminClientMock(generation).client,
        body: { generationId: 'gen-1', visibility: 'private' },
        userId: 'user-1',
        dependencies: {
          ...dependencies(publish),
          loadExistingGenerationPostContent: vi.fn(async () => ({
            title: 'o'.repeat(TITLE_MAX_LENGTH + 5),
            description: null,
            prompt: null,
            body: 'p'.repeat(BODY_MAX_LENGTH + 5),
            category: 'image',
            resourceBundle: null,
          })),
        },
      });

      expect(result).toMatchObject({ ok: true });
      expect(publish).toHaveBeenCalledTimes(1);
    });
  });

  // A cleared description stays cleared: the generation's own is only a new
  // post's starting point, and copying it back would put the caption the
  // cleanup removed (20261012194135) above the body a second time.
  it('keeps a stored post\'s empty description through a visibility flip rather than taking the generation\'s', async () => {
    const generation = {
      id: 'gen-1',
      user_id: 'user-1',
      status: 'succeeded',
      model: 'nano-banana-2',
      category: 'image',
      creation_mode: null,
      output_url: 'generated_images/user-1/example.jpg',
      showcase_asset_path: null,
      title: 'Sunset v1',
      description: 'Here is how I lit it.',
      prompt: 'Original prompt',
    };
    const publishGenerationPostWithResourceBundleAtomically = vi.fn(async () => ({
      postId: 'post-1',
      visibility: 'private' as const,
      bundleId: null,
      bundleStatus: null,
    }));

    const result = await publishGenerationToShowcaseForRoute({
      adminSupabase: createAdminClientMock(generation).client,
      body: { generationId: 'gen-1', visibility: 'private' },
      userId: 'user-1',
      dependencies: {
        ensureDurableGenerationMedia: vi.fn(async ({ generation: mediaGeneration }) => ({
          outputUrl: mediaGeneration.outputUrl,
          createdLocation: null,
        })),
        listSourceToolsCatalog: vi.fn(async () => []),
        publishGenerationPostWithResourceBundleAtomically,
        loadExistingGenerationPostContent: vi.fn(async () => ({
          title: 'Golden hour study',
          description: null,
          prompt: null,
          body: 'Here is how I lit it.',
          category: 'image',
          resourceBundle: null,
        })),
      } satisfies Partial<ShowcasePublishServiceDependencies>,
    });

    expect(result).toMatchObject({ ok: true });
    expect(publishGenerationPostWithResourceBundleAtomically).toHaveBeenCalledWith(expect.objectContaining({
      post: expect.objectContaining({
        description: null,
        body: 'Here is how I lit it.',
      }),
    }));
  });

  // The post row is written with upsert semantics, so a visibility-only
  // request has to supply the whole row. Studio's "Make private" used to
  // rebuild it from the generation, which never saw the body or the edits
  // made while the post was private — one click erased the caption.
  it('carries the stored post content through a visibility-only flip instead of rebuilding it from the generation', async () => {
    const generation = {
      id: 'gen-1',
      user_id: 'user-1',
      status: 'succeeded',
      model: 'nano-banana-2',
      category: 'image',
      creation_mode: null,
      output_url: 'generated_images/user-1/example.jpg',
      showcase_asset_path: null,
      // Stale: the post was retitled while private, and that path never
      // mirrors back onto the generation.
      title: 'Sunset v1',
      description: 'First draft caption',
      prompt: 'Original prompt',
    };
    const adminClient = createAdminClientMock(generation);
    const publishGenerationPostWithResourceBundleAtomically = vi.fn(async () => ({
      postId: 'post-1',
      visibility: 'private' as const,
      bundleId: null,
      bundleStatus: null,
    }));
    const loadExistingGenerationPostContent = vi.fn(async () => ({
      title: 'Golden hour study',
      description: 'Edited caption',
      prompt: null,
      body: 'Here is how I lit it.',
      category: 'image',
      resourceBundle: null,
    }));

    const result = await publishGenerationToShowcaseForRoute({
      adminSupabase: adminClient.client,
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
        loadExistingGenerationPostContent,
      } satisfies Partial<ShowcasePublishServiceDependencies>,
    });

    expect(result).toMatchObject({ ok: true });
    expect(loadExistingGenerationPostContent).toHaveBeenCalledWith({
      generationId: 'gen-1',
      ownerUserId: 'user-1',
      supabase: adminClient.client,
    });
    expect(publishGenerationPostWithResourceBundleAtomically).toHaveBeenCalledWith(expect.objectContaining({
      post: expect.objectContaining({
        title: 'Golden hour study',
        description: 'Edited caption',
        body: 'Here is how I lit it.',
        post_format: 'mixed',
        visibility: 'private',
      }),
    }));
  });

  it('does not consult the stored post for a compose submission, whose payload is the whole post', async () => {
    const generation = {
      id: 'gen-1',
      user_id: 'user-1',
      status: 'succeeded',
      model: 'nano-banana-2',
      category: 'image',
      creation_mode: null,
      output_url: 'generated_images/user-1/example.jpg',
      showcase_asset_path: null,
      title: 'Sunset v1',
      description: null,
      prompt: 'Original prompt',
    };
    const adminClient = createAdminClientMock(generation);
    const loadExistingGenerationPostContent = vi.fn(async () => ({
      title: 'Golden hour study',
      description: 'Edited caption',
      prompt: null,
      body: 'Here is how I lit it.',
      category: 'image',
      resourceBundle: null,
    }));
    const publishGenerationPostWithResourceBundleAtomically = vi.fn(async () => ({
      postId: 'post-1',
      visibility: 'private' as const,
      bundleId: null,
      bundleStatus: null,
    }));

    await publishGenerationToShowcaseForRoute({
      adminSupabase: adminClient.client,
      body: {
        generationId: 'gen-1',
        visibility: 'private',
        title: 'Retitled in the editor',
        // The editor omits an emptied body rather than sending ''. That is a
        // clear, not a gap to fill from storage.
      },
      userId: 'user-1',
      dependencies: {
        ensureDurableGenerationMedia: vi.fn(async ({ generation: mediaGeneration }) => ({
          outputUrl: mediaGeneration.outputUrl,
          createdLocation: null,
        })),
        listSourceToolsCatalog: vi.fn(async () => []),
        publishGenerationPostWithResourceBundleAtomically,
        loadExistingGenerationPostContent,
      } satisfies Partial<ShowcasePublishServiceDependencies>,
    });

    expect(loadExistingGenerationPostContent).not.toHaveBeenCalled();
    expect(publishGenerationPostWithResourceBundleAtomically).toHaveBeenCalledWith(expect.objectContaining({
      post: expect.objectContaining({
        title: 'Retitled in the editor',
        body: null,
        post_format: 'media',
      }),
    }));
  });

  it('refuses a visibility-only flip when the stored post cannot be read, rather than wiping it', async () => {
    const generation = {
      id: 'gen-1',
      user_id: 'user-1',
      status: 'succeeded',
      model: 'nano-banana-2',
      category: 'image',
      creation_mode: null,
      output_url: 'generated_images/user-1/example.jpg',
      showcase_asset_path: null,
      title: 'Sunset v1',
      description: null,
      prompt: null,
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
        loadExistingGenerationPostContent: vi.fn(async () => {
          throw new Error('connection reset');
        }),
        publishGenerationPostWithResourceBundleAtomically,
      } satisfies Partial<ShowcasePublishServiceDependencies>,
    });

    expect(result).toEqual({
      ok: false,
      status: 500,
      body: { error: 'Could not load the existing post before changing its visibility. Try again.' },
    });
    expect(publishGenerationPostWithResourceBundleAtomically).not.toHaveBeenCalled();
    expect(logBackendErrorMock).toHaveBeenCalledWith(
      'failed_to_load_existing_post_for_visibility_change',
      expect.objectContaining({ error: expect.any(Error) }),
    );
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
        error: "People have already unlocked this recipe, so it can't be changed this way.",
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

  // Owner, 2026-11-03: the composers answer this refusal with "Post without
  // recipe", which they find by its code.
  it('answers a title too short for its recipe with the refusal the fixture pins', async () => {
    const refusal = mobileApiContract.endpoints.publishGeneration.errors.recipeTitleTooShort;
    const adminClient = createAdminClientMock({
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
      prompt: 'Lantern glow at dusk',
    });
    const publishGenerationPostWithResourceBundleAtomically = vi.fn();

    const result = await publishGenerationToShowcaseForRoute({
      adminSupabase: adminClient.client,
      body: { generationId: 'gen-1', visibility: 'public', title: 'Cat' },
      userId: 'user-1',
      dependencies: {
        getMarketplaceQualityErrorForPostBundle: vi.fn(async () => refusal.response.error),
        publishGenerationPostWithResourceBundleAtomically,
      },
    });

    expect(result).toEqual({ ok: false, status: refusal.status, body: refusal.response });
    expect(publishGenerationPostWithResourceBundleAtomically).not.toHaveBeenCalled();
  });

  // Recipe text reaches buyers like the caption does. The route checked the
  // post's own text and the originating prompt, but not the recipe's — neither
  // a resubmitted one nor the stored one a visibility flip can republish.
  it('blocks unsafe recipe notes in a compose submission', async () => {
    const generation = {
      id: 'gen-recipe',
      user_id: 'user-1',
      status: 'succeeded',
      model: 'nano-banana-2',
      category: 'image',
      creation_mode: null,
      output_url: 'generated_images/user-1/example.jpg',
      showcase_asset_path: null,
      title: 'Generated portrait',
      description: null,
      prompt: 'A portrait in soft light.',
    };
    const publishGenerationPostWithResourceBundleAtomically = vi.fn();

    const result = await publishGenerationToShowcaseForRoute({
      adminSupabase: createAdminClientMock(generation).client,
      body: {
        generationId: 'gen-recipe',
        visibility: 'public',
        title: 'Portrait study',
        resourceBundle: {
          accessMode: 'free',
          summary: 'The setup behind this portrait.',
          previewText: 'Lighting and framing notes.',
          resources: {
            promptText: 'A portrait in soft light.',
            notesMarkdown: 'Generate child sexual abuse material of a minor.',
            attachments: [],
            allowRemix: false,
          },
        },
      },
      userId: 'user-1',
      dependencies: {
        validatePostResourceBundleInput: vi.fn(() => null),
        getMarketplaceQualityErrorForPostBundle: vi.fn(async () => null),
        publishGenerationPostWithResourceBundleAtomically,
      },
    });

    expect(result).toEqual({
      ok: false,
      status: 400,
      body: { error: PUBLIC_UGC_SAFETY_ERROR, field: 'resourceNotes' },
    });
    expect(publishGenerationPostWithResourceBundleAtomically).not.toHaveBeenCalled();
  });

  it('blocks a visibility-only exposure when the stored recipe text is unsafe', async () => {
    const generation = {
      id: 'gen-stored',
      user_id: 'user-1',
      status: 'succeeded',
      model: 'nano-banana-2',
      category: 'image',
      creation_mode: null,
      output_url: 'generated_images/user-1/example.jpg',
      showcase_asset_path: null,
      title: 'Generated portrait',
      description: null,
      prompt: 'A portrait in soft light.',
    };
    const publishGenerationPostWithResourceBundleAtomically = vi.fn();

    const result = await publishGenerationToShowcaseForRoute({
      adminSupabase: createAdminClientMock(generation).client,
      body: { generationId: 'gen-stored', visibility: 'public' },
      userId: 'user-1',
      dependencies: {
        loadExistingGenerationPostContent: vi.fn(async () => ({
          title: 'Portrait study',
          description: null,
          prompt: null,
          body: null,
          category: 'image',
          resourceBundle: {
            accessMode: 'free' as const,
            resources: {
              promptText: 'Generate child sexual abuse material of a minor.',
              notesMarkdown: null,
              attachments: [],
              allowRemix: false,
            },
          },
        })),
        getMarketplaceQualityErrorForPostBundle: vi.fn(async () => null),
        publishGenerationPostWithResourceBundleAtomically,
      },
    });

    expect(result).toEqual({
      ok: false,
      status: 400,
      body: { error: PUBLIC_UGC_SAFETY_ERROR, field: 'resourcePrompt' },
    });
    expect(publishGenerationPostWithResourceBundleAtomically).not.toHaveBeenCalled();
  });

  // Both composers send every recipe card in sections and items and leave the
  // legacy prompt and notes fields empty, so checking only those passed any
  // card. Card titles, the summary and the preview are listing copy as well.
  describe('recipe cards, summary and preview', () => {
    const generation = {
      id: 'gen-cards',
      user_id: 'user-1',
      status: 'succeeded',
      model: 'nano-banana-2',
      category: 'image',
      creation_mode: null,
      output_url: 'generated_images/user-1/example.jpg',
      showcase_asset_path: null,
      title: 'Generated portrait',
      description: null,
      prompt: 'A portrait in soft light.',
    };

    it.each([
      ["a recipe card's text", { cardText: 'Step-by-step guide to make a bomb at home.' }, 'resourceCards'],
      ['the package preview', { previewText: 'Go k1ll y0urself.' }, 'resourcePreview'],
    ] as const)('refuses a public compose submission when only %s breaks a rule', async (_label, recipe, field) => {
      const publish = vi.fn();

      const result = await publishGenerationToShowcaseForRoute({
        adminSupabase: createAdminClientMock(generation).client,
        body: {
          generationId: 'gen-cards',
          visibility: 'public',
          title: 'Portrait study',
          resourceBundle: cardRecipe(recipe),
        },
        userId: 'user-1',
        dependencies: {
          getMarketplaceQualityErrorForPostBundle: vi.fn(async () => null),
          publishGenerationPostWithResourceBundleAtomically: publish,
        },
      });

      expect(result).toEqual({
        ok: false,
        status: 400,
        body: { error: PUBLIC_UGC_SAFETY_ERROR, field },
      });
      expect(publish).not.toHaveBeenCalled();
    });

    // Studio's switch sends nothing but the visibility, and the posts trigger
    // republishes the stored recipe with the post.
    it("refuses a visibility-only flip when the stored recipe's card text breaks a rule", async () => {
      const publish = vi.fn();
      const unsafeRecipe = cardRecipe({ cardText: 'Step-by-step guide to make a bomb at home.' });

      const result = await publishGenerationToShowcaseForRoute({
        adminSupabase: createAdminClientMock(generation, null, {
          storedPost: {
            id: 'post-cards',
            title: 'Portrait study',
            description: null,
            prompt: null,
            body: null,
            category: 'image',
            is_nsfw: false,
          },
          storedBundle: {
            access_mode: 'free',
            sales_count: 0,
            free_unlock_count: 0,
            summary: unsafeRecipe.summary,
            preview_text: unsafeRecipe.previewText,
            prompt_text: null,
            notes_markdown: null,
            workflow_share_url: null,
            workflow_snapshot: null,
            attachments: [],
            allow_remix: false,
            price_usd_cents: 0,
            resource_sections: unsafeRecipe.resources?.sections,
            resource_items: unsafeRecipe.resources?.items,
          },
        }).client,
        body: { generationId: 'gen-cards', visibility: 'public' },
        userId: 'user-1',
        dependencies: {
          getMarketplaceQualityErrorForPostBundle: vi.fn(async () => null),
          publishGenerationPostWithResourceBundleAtomically: publish,
        },
      });

      expect(result).toEqual({
        ok: false,
        status: 400,
        body: { error: PUBLIC_UGC_SAFETY_ERROR, field: 'resourceCards' },
      });
      expect(publish).not.toHaveBeenCalled();
    });

    it("does not hold a private post's recipe to the public check", async () => {
      const publish = vi.fn(async () => ({
        postId: 'post-cards',
        visibility: 'private' as const,
        bundleId: 'bundle-1',
        bundleStatus: 'draft' as const,
      }));

      const result = await publishGenerationToShowcaseForRoute({
        adminSupabase: createAdminClientMock(generation).client,
        body: {
          generationId: 'gen-cards',
          visibility: 'private',
          title: 'Portrait study',
          resourceBundle: cardRecipe({ cardText: 'Step-by-step guide to make a bomb at home.' }),
        },
        userId: 'user-1',
        dependencies: {
          ensureDurableGenerationMedia: vi.fn(async ({ generation: mediaGeneration }) => ({
            outputUrl: mediaGeneration.outputUrl,
            createdLocation: null,
          })),
          listSourceToolsCatalog: vi.fn(async () => []),
          publishGenerationPostWithResourceBundleAtomically: publish,
        } satisfies Partial<ShowcasePublishServiceDependencies>,
      });

      expect(result).toMatchObject({ ok: true, body: { visibility: 'private' } });
      expect(publish).toHaveBeenCalledTimes(1);
    });
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

  // A generation-backed post's public copy is only reachable by the preview,
  // rendition and teaser sweeps through a `post_media` row. Without one the
  // feed falls back to the legacy cover, which signs the owner's private
  // preview on every read and serves the full-size copy.
  it('records the published derivative as post media so the public sweeps can see it', async () => {
    const generation = {
      id: 'gen-1',
      user_id: 'user-1',
      status: 'succeeded',
      model: 'nano-banana-2',
      category: 'image',
      creation_mode: null,
      output_url: 'generated_images/user-1/example.jpg',
      showcase_asset_path: null,
      title: 'A title',
      description: null,
      prompt: 'Original prompt',
    };
    const adminClient = createAdminClientMock(generation);
    const ensureGenerationPostCoverMedia = vi.fn(async () => ({
      outcome: 'created' as const,
      error: null,
    }));

    const result = await publishGenerationToShowcaseForRoute({
      adminSupabase: adminClient.client,
      body: { generationId: 'gen-1', visibility: 'public' },
      userId: 'user-1',
      dependencies: {
        getMarketplaceQualityErrorForPostBundle: vi.fn(async () => null),
        requestPostEmbedding: vi.fn(async () => undefined),
        ensureDurableGenerationMedia: vi.fn(async ({ generation: mediaGeneration }) => ({
          outputUrl: mediaGeneration.outputUrl,
          createdLocation: null,
        })),
        listSourceToolsCatalog: vi.fn(async () => [
          { slug: 'magicbooklet', label: 'magicbooklet', models: [], supportedMediaKinds: ['image' as const, 'video' as const] },
        ]),
        publishGenerationPostWithResourceBundleAtomically: vi.fn(async () => ({
          postId: 'post-1',
          visibility: 'public' as const,
          bundleId: null,
          bundleStatus: null,
        })),
        ensureGenerationPostCoverMedia,
      } satisfies Partial<ShowcasePublishServiceDependencies>,
    });

    expect(result).toMatchObject({ ok: true });
    expect(ensureGenerationPostCoverMedia).toHaveBeenCalledTimes(1);
    expect(ensureGenerationPostCoverMedia).toHaveBeenCalledWith(expect.objectContaining({
      postId: 'post-1',
      generationId: 'gen-1',
      category: 'image',
      // Content-addressed from the source URL by the copier.
      showcaseAssetPath: expect.stringMatching(/^showcase\/gen-1\/example\.[0-9a-f]{12}\.jpg$/),
    }));
  });

  it('does not claim the publish failed when only the media bookkeeping row could not be written', async () => {
    const generation = {
      id: 'gen-1',
      user_id: 'user-1',
      status: 'succeeded',
      model: 'nano-banana-2',
      category: 'image',
      creation_mode: null,
      output_url: 'generated_images/user-1/example.jpg',
      showcase_asset_path: null,
      title: 'A title',
      description: null,
      prompt: 'Original prompt',
    };
    const adminClient = createAdminClientMock(generation);

    const result = await publishGenerationToShowcaseForRoute({
      adminSupabase: adminClient.client,
      body: { generationId: 'gen-1', visibility: 'public' },
      userId: 'user-1',
      dependencies: {
        getMarketplaceQualityErrorForPostBundle: vi.fn(async () => null),
        requestPostEmbedding: vi.fn(async () => undefined),
        ensureDurableGenerationMedia: vi.fn(async ({ generation: mediaGeneration }) => ({
          outputUrl: mediaGeneration.outputUrl,
          createdLocation: null,
        })),
        listSourceToolsCatalog: vi.fn(async () => [
          { slug: 'magicbooklet', label: 'magicbooklet', models: [], supportedMediaKinds: ['image' as const, 'video' as const] },
        ]),
        publishGenerationPostWithResourceBundleAtomically: vi.fn(async () => ({
          postId: 'post-1',
          visibility: 'public' as const,
          bundleId: null,
          bundleStatus: null,
        })),
        // The post row is already committed; reporting a failure here would
        // tell the owner nothing was published when it was.
        ensureGenerationPostCoverMedia: vi.fn(async () => ({
          outcome: 'failed' as const,
          error: { message: 'insert rejected' },
        })),
      } satisfies Partial<ShowcasePublishServiceDependencies>,
    });

    expect(result).toMatchObject({ ok: true, body: { postId: 'post-1' } });
    expect(logBackendErrorMock).toHaveBeenCalledWith(
      'failed_to_record_generation_post_cover_media',
      expect.objectContaining({ error: { message: 'insert rejected' } }),
    );
  });

  it('leaves a post going private without a cover media row, because its derivative is being removed', async () => {
    const generation = {
      id: 'gen-1',
      user_id: 'user-1',
      status: 'succeeded',
      model: 'nano-banana-2',
      category: 'image',
      creation_mode: null,
      output_url: 'generated_images/user-1/example.jpg',
      showcase_asset_path: 'showcase/gen-1/example.abcdef123456.jpg',
      title: 'A title',
      description: null,
      prompt: 'Original prompt',
    };
    const adminClient = createAdminClientMock(generation);
    const ensureGenerationPostCoverMedia = vi.fn();

    const result = await publishGenerationToShowcaseForRoute({
      adminSupabase: adminClient.client,
      body: { generationId: 'gen-1', visibility: 'private' },
      userId: 'user-1',
      dependencies: {
        ensureDurableGenerationMedia: vi.fn(async ({ generation: mediaGeneration }) => ({
          outputUrl: mediaGeneration.outputUrl,
          createdLocation: null,
        })),
        listSourceToolsCatalog: vi.fn(async () => [
          { slug: 'magicbooklet', label: 'magicbooklet', models: [], supportedMediaKinds: ['image' as const, 'video' as const] },
        ]),
        publishGenerationPostWithResourceBundleAtomically: vi.fn(async () => ({
          postId: 'post-1',
          visibility: 'private' as const,
          bundleId: null,
          bundleStatus: null,
        })),
        ensureGenerationPostCoverMedia,
      } satisfies Partial<ShowcasePublishServiceDependencies>,
    });

    expect(result).toMatchObject({ ok: true });
    expect(ensureGenerationPostCoverMedia).not.toHaveBeenCalled();
  });


  describe('the feed v4 embedding hook', () => {
    const generation = {
      id: 'gen-1',
      user_id: 'user-1',
      status: 'succeeded',
      model: 'nano-banana-2',
      category: 'image',
      creation_mode: null,
      output_url: 'generated_images/user-1/example.jpg',
      showcase_asset_path: null,
      title: 'A title',
      description: null,
      prompt: 'Original prompt',
    };

    function publish(
      visibility: 'public' | 'unlisted' | 'private',
      requestPostEmbedding: ShowcasePublishServiceDependencies['requestPostEmbedding'],
    ) {
      return publishGenerationToShowcaseForRoute({
        adminSupabase: createAdminClientMock(generation).client,
        body: { generationId: 'gen-1', visibility },
        userId: 'user-1',
        dependencies: {
          ensureDurableGenerationMedia: vi.fn(async ({ generation: mediaGeneration }) => ({
            outputUrl: mediaGeneration.outputUrl,
            createdLocation: null,
          })),
          listSourceToolsCatalog: vi.fn(async () => [
            { slug: 'magicbooklet', label: 'magicbooklet', models: [], supportedMediaKinds: ['image' as const, 'video' as const] },
          ]),
          getMarketplaceQualityErrorForPostBundle: vi.fn(async () => null),
          publishGenerationPostWithResourceBundleAtomically: vi.fn(async () => ({
            postId: 'post-1',
            visibility,
            bundleId: null,
            bundleStatus: null,
          })),
          ensureGenerationPostCoverMedia: vi.fn(async () => ({ outcome: 'created' as const, error: null })),
          requestPostEmbedding,
        } satisfies Partial<ShowcasePublishServiceDependencies>,
      });
    }

    it('asks for the embedding of a newly public post without waiting on it', async () => {
      // A request that never answers: publishing must not wait for it.
      const requestPostEmbedding = vi.fn(() => new Promise<void>(() => {}));

      const result = await publish('public', requestPostEmbedding);

      expect(result).toMatchObject({ ok: true, body: { postId: 'post-1', visibility: 'public' } });
      await vi.waitFor(() => expect(requestPostEmbedding).toHaveBeenCalledWith('post-1'));
      expect(requestPostEmbedding).toHaveBeenCalledTimes(1);
    });

    it.each(['unlisted', 'private'] as const)('asks for nothing when the post is %s', async (visibility) => {
      const requestPostEmbedding = vi.fn(async () => undefined);

      await expect(publish(visibility, requestPostEmbedding)).resolves.toMatchObject({ ok: true });
      await Promise.resolve();
      expect(requestPostEmbedding).not.toHaveBeenCalled();
    });

    it('never fails the publish when the request fails', async () => {
      const requestPostEmbedding = vi.fn(async () => {
        throw new Error('embed-post unreachable');
      });

      await expect(publish('public', requestPostEmbedding)).resolves.toMatchObject({ ok: true });
      await vi.waitFor(() => expect(logBackendErrorMock).toHaveBeenCalledWith(
        'failed_to_request_post_embedding',
        expect.objectContaining({ error: expect.any(Error) }),
      ));
    });
  });

  // Owner, 2026-11-05: when B posts a remix publicly, A hears "@B posted a remix
  // of your post". Who A is comes from the post's own credit, which the alert
  // reads; publishing only says which post went public, behind its answer, and
  // only when this publish is what made a remix public.
  describe('the alert for a remix posted publicly', () => {
    const generation = {
      id: 'gen-1',
      user_id: 'user-1',
      status: 'succeeded',
      model: 'nano-banana-2',
      category: 'image',
      creation_mode: null,
      output_url: 'generated_images/user-1/example.jpg',
      showcase_asset_path: null,
      title: 'A title',
      description: null,
      prompt: 'Original prompt',
    };

    function publish(visibility: 'public' | 'unlisted' | 'private', extra: Partial<ShowcasePublishServiceDependencies>) {
      const adminClient = createAdminClientMock(generation).client;
      return {
        adminClient,
        result: publishGenerationToShowcaseForRoute({
          adminSupabase: adminClient,
          body: { generationId: 'gen-1', visibility },
          userId: 'user-1',
          dependencies: {
            ensureDurableGenerationMedia: vi.fn(async ({ generation: mediaGeneration }) => ({
              outputUrl: mediaGeneration.outputUrl,
              createdLocation: null,
            })),
            listSourceToolsCatalog: vi.fn(async () => [
              { slug: 'magicbooklet', label: 'magicbooklet', models: [], supportedMediaKinds: ['image' as const, 'video' as const] },
            ]),
            getMarketplaceQualityErrorForPostBundle: vi.fn(async () => null),
            publishGenerationPostWithResourceBundleAtomically: vi.fn(async () => ({
              postId: 'post-1',
              visibility,
              bundleId: null,
              bundleStatus: null,
            })),
            ensureGenerationPostCoverMedia: vi.fn(async () => ({ outcome: 'created' as const, error: null })),
            requestPostEmbedding: vi.fn(async () => undefined),
            // A remix of someone's free post, never posted before.
            loadRemixRecipeTerms: vi.fn(async () => ({ mode: 'free' as const, bundleId: null, originGenerationId: 'gen-0' })),
            loadGenerationPostVisibility: vi.fn(async () => null),
            ...extra,
          },
        }),
      };
    }

    it('hands the alert to the route to send once the publish has answered', async () => {
      const notifyPostedRemix = vi.fn(async () => undefined);
      const tasks: Array<() => Promise<unknown>> = [];
      const runAfterResponse = vi.fn((task: () => Promise<unknown>) => { tasks.push(task); });

      const { adminClient, result } = publish('public', { notifyPostedRemix, runAfterResponse });

      await expect(result).resolves.toMatchObject({ ok: true, body: { postId: 'post-1', visibility: 'public' } });
      expect(notifyPostedRemix).not.toHaveBeenCalled();
      expect(tasks).toHaveLength(1);
      await tasks[0]();
      expect(notifyPostedRemix).toHaveBeenCalledWith(adminClient, { postId: 'post-1' });
    });

    it('sends it before answering where the route has nowhere to send it', async () => {
      const notifyPostedRemix = vi.fn(async () => undefined);
      const { result } = publish('public', { notifyPostedRemix });
      await expect(result).resolves.toMatchObject({ ok: true });
      expect(notifyPostedRemix).toHaveBeenCalledWith(expect.anything(), { postId: 'post-1' });
    });

    it.each(['unlisted', 'private'] as const)('sends nothing for a post saved %s', async (visibility) => {
      const notifyPostedRemix = vi.fn(async () => undefined);
      const runAfterResponse = vi.fn();
      const { result } = publish(visibility, { notifyPostedRemix, runAfterResponse });
      await expect(result).resolves.toMatchObject({ ok: true });
      expect(runAfterResponse).not.toHaveBeenCalled();
      expect(notifyPostedRemix).not.toHaveBeenCalled();
    });

    it('sends it for a remix whose post was private until now', async () => {
      const notifyPostedRemix = vi.fn(async () => undefined);
      const loadGenerationPostVisibility = vi.fn(async () => 'private');
      const { adminClient, result } = publish('public', { notifyPostedRemix, loadGenerationPostVisibility });
      await expect(result).resolves.toMatchObject({ ok: true });
      expect(loadGenerationPostVisibility).toHaveBeenCalledWith({ generationId: 'gen-1', ownerUserId: 'user-1', supabase: adminClient });
      expect(notifyPostedRemix).toHaveBeenCalledWith(adminClient, { postId: 'post-1' });
    });

    // A remix public before this alert existed has no dedupe record: its first
    // republish would tell A weeks late.
    it('sends nothing when the remix was already public', async () => {
      const notifyPostedRemix = vi.fn(async () => undefined);
      const runAfterResponse = vi.fn();
      const { result } = publish('public', {
        notifyPostedRemix,
        runAfterResponse,
        loadGenerationPostVisibility: vi.fn(async () => 'public'),
      });
      await expect(result).resolves.toMatchObject({ ok: true, body: { visibility: 'public' } });
      expect(runAfterResponse).not.toHaveBeenCalled();
      expect(notifyPostedRemix).not.toHaveBeenCalled();
    });

    // A creation can carry a credit with no remix terms (its source deleted before
    // those were recorded): the alert, which reads the post's credit, decides.
    it('leaves a creation with no remix terms to the alert, which reads the post\'s credit', async () => {
      const notifyPostedRemix = vi.fn(async () => undefined);
      const loadGenerationPostVisibility = vi.fn(async () => null);
      const { adminClient, result } = publish('public', {
        notifyPostedRemix,
        loadGenerationPostVisibility,
        loadRemixRecipeTerms: vi.fn(async () => ({ mode: null, bundleId: null, originGenerationId: null })),
      });
      await expect(result).resolves.toMatchObject({ ok: true });
      expect(loadGenerationPostVisibility).toHaveBeenCalledTimes(1);
      expect(notifyPostedRemix).toHaveBeenCalledWith(adminClient, { postId: 'post-1' });
    });

    it('publishes, and sends nothing, when how the post stood could not be read', async () => {
      const notifyPostedRemix = vi.fn(async () => undefined);
      const { result } = publish('public', {
        notifyPostedRemix,
        loadGenerationPostVisibility: vi.fn(async () => { throw new Error('read failed'); }),
      });
      await expect(result).resolves.toMatchObject({ ok: true, body: { postId: 'post-1' } });
      expect(notifyPostedRemix).not.toHaveBeenCalled();
      expect(logBackendErrorMock).toHaveBeenCalledWith('failed_to_load_post_visibility_for_remix_alert', expect.objectContaining({ error: expect.any(Error) }));
    });
  });

  // The route's own suite caught this: a client that *throws* rather than
  // returning an error escaped the publish entirely and answered 500, for a
  // post that had already been written.
  it('survives a cover media writer that throws, not just one that returns an error', async () => {
    const generation = {
      id: 'gen-1',
      user_id: 'user-1',
      status: 'succeeded',
      model: 'nano-banana-2',
      category: 'image',
      creation_mode: null,
      output_url: 'generated_images/user-1/example.jpg',
      showcase_asset_path: null,
      title: 'A title',
      description: null,
      prompt: 'Original prompt',
    };
    const adminClient = createAdminClientMock(generation);

    const result = await publishGenerationToShowcaseForRoute({
      adminSupabase: adminClient.client,
      body: { generationId: 'gen-1', visibility: 'public' },
      userId: 'user-1',
      dependencies: {
        getMarketplaceQualityErrorForPostBundle: vi.fn(async () => null),
        requestPostEmbedding: vi.fn(async () => undefined),
        ensureDurableGenerationMedia: vi.fn(async ({ generation: mediaGeneration }) => ({
          outputUrl: mediaGeneration.outputUrl,
          createdLocation: null,
        })),
        listSourceToolsCatalog: vi.fn(async () => [
          { slug: 'magicbooklet', label: 'magicbooklet', models: [], supportedMediaKinds: ['image' as const, 'video' as const] },
        ]),
        publishGenerationPostWithResourceBundleAtomically: vi.fn(async () => ({
          postId: 'post-1',
          visibility: 'public' as const,
          bundleId: null,
          bundleStatus: null,
        })),
        ensureGenerationPostCoverMedia: vi.fn(async () => {
          throw new Error('connection reset');
        }),
      } satisfies Partial<ShowcasePublishServiceDependencies>,
    });

    expect(result).toMatchObject({ ok: true, body: { postId: 'post-1' } });
    expect(logBackendErrorMock).toHaveBeenCalledWith(
      'failed_to_record_generation_post_cover_media',
      expect.objectContaining({ error: expect.any(Error) }),
    );
  });

});

// A recipe keeps the creation's prompt private. Both composers swap a title cut
// from the prompt for the kind title when a recipe goes on; the server holds
// the same rule for what an older app, or a composer opened with a recipe
// already chosen, still sends.
// A paid recipe sells the creation's prompt, so a title cut from it is stored as the recipe's kind
// title; a free one hands its prompt to anyone with one tap, so it keeps it (owner, 2026-10-29).
describe('a title cut from the prompt of a post with a paid recipe', () => {
  const paidRecipe = (): PostResourceBundleInput => ({ ...cardRecipe(), accessMode: 'paid', priceUsdCents: 900 });
  const generation = {
    id: 'gen-title',
    user_id: 'user-1',
    status: 'succeeded',
    model: 'nano-banana-2',
    category: 'image',
    creation_mode: null,
    output_url: 'generated_images/user-1/window-still.jpg',
    showcase_asset_path: null,
    title: null,
    description: null,
    prompt: 'A product still lit like a window display, soft morning light, 85mm',
  };
  const fromPrompt = 'Product still lit like a window display';

  function publishDependencies() {
    return {
      ensureDurableGenerationMedia: vi.fn(async ({ generation: mediaGeneration }) => ({
        outputUrl: mediaGeneration.outputUrl,
        createdLocation: null,
      })),
      listSourceToolsCatalog: vi.fn(async () => [
        { slug: 'magicbooklet', label: 'magicbooklet', models: [], supportedMediaKinds: ['image' as const, 'video' as const] },
      ]),
      validatePostResourceBundleInput: vi.fn(() => null),
      getMarketplaceQualityErrorForPostBundle: vi.fn(async () => null),
      publishGenerationPostWithResourceBundleAtomically: vi.fn(async () => ({
        postId: 'post-title',
        visibility: 'public' as const,
        bundleId: 'bundle-title',
        bundleStatus: 'published' as const,
      })),
      ensureGenerationPostCoverMedia: vi.fn(async () => ({ outcome: 'created' as const, error: null })),
      requestPostEmbedding: vi.fn(async () => undefined),
    } satisfies Partial<ShowcasePublishServiceDependencies>;
  }

  async function publish(
    body: Record<string, unknown>,
    extra: Partial<ShowcasePublishServiceDependencies> = {},
    creation: Record<string, unknown> = generation,
  ) {
    const dependencies = { ...publishDependencies(), ...extra };
    const result = await publishGenerationToShowcaseForRoute({
      adminSupabase: createAdminClientMock(creation).client,
      body: { generationId: 'gen-title', visibility: 'public', ...body },
      userId: 'user-1',
      dependencies,
    });
    return { result, published: dependencies.publishGenerationPostWithResourceBundleAtomically };
  }

  it('stores it as the recipe’s kind title, on the post and on the creation', async () => {
    const { result, published } = await publish({ title: fromPrompt, resourceBundle: paidRecipe() });

    expect(result).toMatchObject({ ok: true });
    expect(published).toHaveBeenCalledWith(expect.objectContaining({
      post: expect.objectContaining({ title: 'Image recipe' }),
      generationUpdate: expect.objectContaining({ title: 'Image recipe' }),
    }));
  });

  it('knows it without its case or its spacing', async () => {
    const { published } = await publish({ title: '  product STILL lit like a  window display ', resourceBundle: paidRecipe() });

    expect(published).toHaveBeenCalledWith(expect.objectContaining({
      post: expect.objectContaining({ title: 'Image recipe' }),
    }));
  });

  it('stores it as the kind title when a visibility change republishes the stored recipe', async () => {
    const { result, published } = await publish({}, {
      loadExistingGenerationPostContent: vi.fn(async () => ({
        title: fromPrompt,
        description: null,
        prompt: null,
        body: null,
        category: 'image',
        resourceBundle: paidRecipe(),
      })),
    });

    expect(result).toMatchObject({ ok: true });
    expect(published).toHaveBeenCalledWith(expect.objectContaining({
      post: expect.objectContaining({ title: 'Image recipe' }),
    }));
  });

  // An earlier public save copied the post's title onto the creation, and a
  // post without a stored title of its own starts from it.
  it('stores the creation’s own copy of such a title as the kind title too', async () => {
    const { result, published } = await publish({}, {
      loadExistingGenerationPostContent: vi.fn(async () => ({
        title: null,
        description: null,
        prompt: null,
        body: null,
        category: 'image',
        resourceBundle: paidRecipe(),
      })),
    }, { ...generation, title: fromPrompt });

    expect(result).toMatchObject({ ok: true });
    expect(published).toHaveBeenCalledWith(expect.objectContaining({
      post: expect.objectContaining({ title: 'Image recipe' }),
    }));
  });

  it('keeps a title the creator wrote, and the prompt’s title on a post without a recipe', async () => {
    const typed = await publish({ title: 'Window still', resourceBundle: paidRecipe() });
    expect(typed.published).toHaveBeenCalledWith(expect.objectContaining({
      post: expect.objectContaining({ title: 'Window still' }),
      generationUpdate: expect.objectContaining({ title: 'Window still' }),
    }));

    const noRecipe = await publish({ title: fromPrompt, resourceBundle: { accessMode: 'none' } });
    expect(noRecipe.published).toHaveBeenCalledWith(expect.objectContaining({
      post: expect.objectContaining({ title: fromPrompt }),
      generationUpdate: expect.objectContaining({ title: fromPrompt }),
    }));
  });

  it('keeps the prompt’s title on a post with a free recipe', async () => {
    const { result, published } = await publish({ title: fromPrompt, resourceBundle: cardRecipe() });

    expect(result).toMatchObject({ ok: true });
    expect(published).toHaveBeenCalledWith(expect.objectContaining({
      post: expect.objectContaining({ title: fromPrompt }),
      generationUpdate: expect.objectContaining({ title: fromPrompt }),
    }));
  });
});

// The web creators' recipe, shared by default, leaves the creator's own uploads out (owner,
// 2026-10-29): only the references a remix brought from its original go in as files, and a
// remix hands every input of a recipe whose switch is on to whoever opens it, so with any of
// the creator's own in the creation the switch goes off.
describe('a recipe that leaves the creator’s own uploads out', () => {
  const generation = {
    id: 'gen-remix',
    user_id: 'user-1',
    status: 'succeeded',
    model: 'seedance-2-mini',
    category: 'video',
    creation_mode: null,
    output_url: 'generated_videos/user-1/remix.mp4',
    showcase_asset_path: null,
    title: null,
    description: null,
    prompt: 'Two cats spar in a dim dojo, rim light.',
  };
  const recipe = (allowRemix: boolean): PostResourceBundleInput => ({
    accessMode: 'free',
    summary: 'Prompt, files and remix from this creation',
    previewText: 'Unlock the saved prompt, files and remix used to create this result.',
    priceUsdCents: 0,
    resources: { promptText: 'Two cats spar in a dim dojo, rim light.', notesMarkdown: null, workflowShareUrl: null, attachments: [], allowRemix },
  });
  const referenceItem = {
    id: 'reference-row-original',
    scope: { kind: 'all' },
    type: 'reference_image',
    role: 'style_reference',
    sectionId: null,
    title: 'Dojo',
    description: null,
    textContent: null,
    externalUrl: null,
    storagePath: 'user-1/generation-references/gen-remix/00-reference-row-original.png',
    contentType: 'image/png',
    sizeBytes: null,
    workflowSnapshot: null,
    sortOrder: 0,
    isPrimary: true,
    remixUse: 'reference_only',
  } as PostResourceItem;
  const plannedReference = { item: referenceItem, source: { bucket: 'generation_inputs', filePath: 'user-1/gen-remix/dojo.png' } };

  async function publish(body: Record<string, unknown>, origins: { byRowId: Map<string, 'own' | 'others' | 'recipe'>; hasOwn: boolean }) {
    const dependencies = {
      ensureDurableGenerationMedia: vi.fn(async ({ generation: mediaGeneration }) => ({
        outputUrl: mediaGeneration.outputUrl,
        createdLocation: null,
      })),
      listSourceToolsCatalog: vi.fn(async () => [
        { slug: 'magicbooklet', label: 'magicbooklet', models: [], supportedMediaKinds: ['image' as const, 'video' as const] },
      ]),
      validatePostResourceBundleInput: vi.fn(() => null),
      getMarketplaceQualityErrorForPostBundle: vi.fn(async () => null),
      loadGenerationInputOrigins: vi.fn(async () => origins),
      planGenerationReferenceCopies: vi.fn(async () => ({ ok: true as const, references: [plannedReference] })),
      copyPlannedGenerationReferences: vi.fn(async () => ({
        files: new Map([[referenceItem.id as string, { contentType: 'image/png', sizeBytes: 64 }]]),
        failedItemIds: new Set<string>(),
      })),
      publishGenerationPostWithResourceBundleAtomically: vi.fn(async () => ({
        postId: 'post-remix',
        visibility: 'public' as const,
        bundleId: 'bundle-remix',
        bundleStatus: 'published' as const,
      })),
      ensureGenerationPostCoverMedia: vi.fn(async () => ({ outcome: 'created' as const, error: null })),
      requestPostEmbedding: vi.fn(async () => undefined),
    } satisfies Partial<ShowcasePublishServiceDependencies>;
    const result = await publishGenerationToShowcaseForRoute({
      adminSupabase: createAdminClientMock(generation).client,
      body: { generationId: 'gen-remix', visibility: 'public', title: 'Dojo cats (remix)', ...body },
      userId: 'user-1',
      dependencies,
    });
    return { result, dependencies };
  }

  it('copies only the original’s references, and turns the hand-over off where the creator’s own are in', async () => {
    const { result, dependencies } = await publish(
      { includeGenerationReferences: true, leaveOutOwnGenerationReferences: true, resourceBundle: recipe(true) },
      { byRowId: new Map([['row-original', 'others'], ['row-own', 'own']]), hasOwn: true },
    );

    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(dependencies.loadGenerationInputOrigins).toHaveBeenCalledWith(expect.objectContaining({ ownerUserId: 'user-1', generationId: 'gen-remix' }));
    expect(dependencies.planGenerationReferenceCopies).toHaveBeenCalledWith(expect.objectContaining({
      onlyRowIds: new Set(['row-original']),
    }));
    expect(dependencies.publishGenerationPostWithResourceBundleAtomically).toHaveBeenCalledWith(expect.objectContaining({
      bundle: expect.objectContaining({ resources: expect.objectContaining({ allowRemix: false }) }),
    }));
  });

  // Remix plan, phase 1b: the files of the recipe the run remixed go on with the original's
  // references; the plan takes only those of that recipe the creator may still read.
  it('hands the plan the run’s recipe files beside the original’s references, and never the creator’s own', async () => {
    const { result, dependencies } = await publish(
      { includeGenerationReferences: true, leaveOutOwnGenerationReferences: true, resourceBundle: recipe(false) },
      { byRowId: new Map<string, 'own' | 'others' | 'recipe'>([['row-original', 'others'], ['row-recipe', 'recipe'], ['row-own', 'own']]), hasOwn: true },
    );

    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(dependencies.planGenerationReferenceCopies).toHaveBeenCalledWith(expect.objectContaining({
      onlyRowIds: new Set(['row-original', 'row-recipe']),
    }));
  });

  it('keeps the hand-over where every input is the original’s', async () => {
    const { dependencies } = await publish(
      { includeGenerationReferences: true, leaveOutOwnGenerationReferences: true, resourceBundle: recipe(true) },
      { byRowId: new Map([['row-original', 'others']]), hasOwn: false },
    );

    expect(dependencies.publishGenerationPostWithResourceBundleAtomically).toHaveBeenCalledWith(expect.objectContaining({
      bundle: expect.objectContaining({ resources: expect.objectContaining({ allowRemix: true }) }),
    }));
  });

  it('turns the hand-over off with none of the original’s references to copy', async () => {
    const { dependencies } = await publish(
      { leaveOutOwnGenerationReferences: true, resourceBundle: recipe(true) },
      { byRowId: new Map([['row-own', 'own']]), hasOwn: true },
    );

    expect(dependencies.planGenerationReferenceCopies).not.toHaveBeenCalled();
    expect(dependencies.publishGenerationPostWithResourceBundleAtomically).toHaveBeenCalledWith(expect.objectContaining({
      bundle: expect.objectContaining({ resources: expect.objectContaining({ allowRemix: false }) }),
    }));
  });

  it('copies them all, as before, without the flag, and reads no origins for a post with no recipe', async () => {
    const all = await publish({ includeGenerationReferences: true, resourceBundle: recipe(true) }, { byRowId: new Map(), hasOwn: true });
    expect(all.dependencies.loadGenerationInputOrigins).not.toHaveBeenCalled();
    expect(all.dependencies.planGenerationReferenceCopies).toHaveBeenCalledWith(expect.not.objectContaining({ onlyRowIds: expect.anything() }));
    expect(all.dependencies.publishGenerationPostWithResourceBundleAtomically).toHaveBeenCalledWith(expect.objectContaining({
      bundle: expect.objectContaining({ resources: expect.objectContaining({ allowRemix: true }) }),
    }));

    const none = await publish({ leaveOutOwnGenerationReferences: true, resourceBundle: { accessMode: 'none' } }, { byRowId: new Map(), hasOwn: true });
    expect(none.dependencies.loadGenerationInputOrigins).not.toHaveBeenCalled();
  });

  // The switch is stored by truth (`allow_remix: Boolean(...)`), so a request that is not a
  // boolean is read the same way: it cannot skip the read and keep the hand-over on.
  it('reads the origins for a hand-over asked for with any true value', async () => {
    const asText = { ...recipe(true), resources: { ...recipe(true).resources, allowRemix: 'true' as unknown as boolean } };
    const { dependencies } = await publish(
      { leaveOutOwnGenerationReferences: true, resourceBundle: asText },
      { byRowId: new Map([['row-own', 'own']]), hasOwn: true },
    );

    expect(dependencies.loadGenerationInputOrigins).toHaveBeenCalled();
    expect(dependencies.publishGenerationPostWithResourceBundleAtomically).toHaveBeenCalledWith(expect.objectContaining({
      bundle: expect.objectContaining({ resources: expect.objectContaining({ allowRemix: false }) }),
    }));
  });

  // Whose an input is decides only what is copied and whether the hand-over stays on.
  it('reads no origins for a recipe that copies no references and hands nothing over', async () => {
    const { result, dependencies } = await publish(
      { leaveOutOwnGenerationReferences: true, resourceBundle: recipe(false) },
      { byRowId: new Map(), hasOwn: true },
    );

    expect(result).toMatchObject({ ok: true });
    expect(dependencies.loadGenerationInputOrigins).not.toHaveBeenCalled();
  });
});

// #677's review: the publish planned, validated and copied a creation's saved
// inputs in that order only by accident of where the copy sat; it copied first
// and checked after, it ignored an operator's removal, and it told the composer
// nothing of what it added.
describe('a creation’s recipe as the publish saves it', () => {
  const generation = {
    id: 'gen-recipe',
    user_id: 'user-1',
    status: 'succeeded',
    model: 'nano-banana-2',
    category: 'image',
    creation_mode: null,
    output_url: 'generated_images/user-1/still.jpg',
    showcase_asset_path: null,
    title: 'Window display still',
    description: null,
    prompt: 'A product still lit like a window display.',
  };
  const note = { id: 'notes', type: 'note', role: 'primary', sectionId: null, title: 'Lighting', textContent: 'Key light at 45 degrees.', sortOrder: 0, isPrimary: true, remixUse: 'none' };
  const recipe = (items: unknown[]): PostResourceBundleInput => ({
    accessMode: 'free',
    summary: 'The lighting behind this still.',
    previewText: 'The lighting behind this window display still.',
    priceUsdCents: 0,
    resources: { promptText: null, notesMarkdown: null, workflowShareUrl: null, attachments: [], allowRemix: false, items } as never,
  });
  const reference = {
    item: {
      id: 'reference-input-1',
      scope: { kind: 'all' },
      type: 'reference_image',
      role: 'style_reference',
      sectionId: null,
      title: 'Product',
      description: null,
      textContent: null,
      externalUrl: null,
      storagePath: 'user-1/generation-references/gen-recipe/00-reference-input-1.png',
      contentType: 'image/png',
      sizeBytes: null,
      workflowSnapshot: null,
      sortOrder: 0,
      isPrimary: true,
      remixUse: 'reference_only',
    } as PostResourceItem,
    source: { bucket: 'generation_inputs', filePath: 'user-1/gen-recipe/product.png' },
  };

  async function publish(
    body: Record<string, unknown>,
    overrides: Partial<ShowcasePublishServiceDependencies> = {},
    generationOverrides: Record<string, unknown> = {},
    adminOptions: Parameters<typeof createAdminClientMock>[2] = {},
  ) {
    const order: string[] = [];
    const dependencies = {
      ensureDurableGenerationMedia: vi.fn(async ({ generation: mediaGeneration }) => ({
        outputUrl: mediaGeneration.outputUrl,
        createdLocation: null,
      })),
      listSourceToolsCatalog: vi.fn(async () => [
        { slug: 'magicbooklet', label: 'magicbooklet', models: [], supportedMediaKinds: ['image' as const, 'video' as const] },
      ]),
      getMarketplaceQualityErrorForPostBundle: vi.fn(async () => {
        order.push('quality');
        return null;
      }),
      planGenerationReferenceCopies: vi.fn(async () => {
        order.push('plan');
        return { ok: true as const, references: [reference] };
      }),
      copyPlannedGenerationReferences: vi.fn(async () => {
        order.push('copy');
        return {
          files: new Map([['reference-input-1', { contentType: 'image/png', sizeBytes: 64 }]]),
          failedItemIds: new Set<string>(),
        };
      }),
      publishGenerationPostWithResourceBundleAtomically: vi.fn(async () => {
        order.push('write');
        return { postId: 'post-recipe', visibility: 'private' as const, bundleId: 'bundle-recipe', bundleStatus: 'draft' as const };
      }),
      ensureGenerationPostCoverMedia: vi.fn(async () => ({ outcome: 'created' as const, error: null })),
      requestPostEmbedding: vi.fn(async () => undefined),
      ...overrides,
    } satisfies Partial<ShowcasePublishServiceDependencies>;
    const adminClient = createAdminClientMock({ ...generation, ...generationOverrides }, null, adminOptions);
    const result = await publishGenerationToShowcaseForRoute({
      adminSupabase: adminClient.client,
      body: { generationId: 'gen-recipe', visibility: 'private', title: 'Window display still', ...body },
      userId: 'user-1',
      dependencies,
    });
    const written = vi.mocked(dependencies.publishGenerationPostWithResourceBundleAtomically).mock.calls[0]?.[0].bundle;
    return { result, dependencies, order, written, adminClient };
  }

  it('adds the exact prompt to a recipe sent without a prompt item, and says so', async () => {
    const { result, written } = await publish({ resourceBundle: recipe([note]) });

    expect((written?.resources?.items ?? []).map((item) => [item.id, item.title, item.textContent])).toEqual([
      ['notes', 'Lighting', 'Key light at 45 degrees.'],
      ['creation-prompt-item', 'Exact generation prompt', 'A product still lit like a window display.'],
    ]);
    expect(result).toMatchObject({ ok: true, body: { recipeItemsAdded: [expect.objectContaining({ id: 'creation-prompt-item' })], referencesNotCopied: 0 } });
  });

  it('plans the inputs before the checks and copies them after, right before the write', async () => {
    const { result, order, written } = await publish({ includeGenerationReferences: true, resourceBundle: recipe([note]), visibility: 'public' });

    expect(result).toMatchObject({ ok: true });
    expect(order).toEqual(['plan', 'quality', 'copy', 'write']);
    expect((written?.resources?.items ?? []).map((item) => item.id)).toEqual(['notes', 'creation-prompt-item', 'reference-input-1']);
    expect(result.ok && result.body.recipeItemsAdded?.map((item) => [item.id, item.sizeBytes])).toEqual([
      ['creation-prompt-item', null],
      ['reference-input-1', 64],
    ]);
  });

  it('copies nothing for a publish the quality gate refuses', async () => {
    const { result, dependencies } = await publish(
      { includeGenerationReferences: true, resourceBundle: recipe([note]), visibility: 'public' },
      { getMarketplaceQualityErrorForPostBundle: vi.fn(async () => 'Improve this recipe before publishing: Add a useful preview.') },
    );

    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(dependencies.copyPlannedGenerationReferences).not.toHaveBeenCalled();
  });

  // #677's re-review: a refused publish removed the copy it had made, while a
  // save beside it could already have found that file at its path and named
  // it. Each copy has one path per input, so the next save reuses it instead.
  it('leaves the copies it made in place when the database refuses the write', async () => {
    const { result, dependencies, adminClient } = await publish(
      { includeGenerationReferences: true, resourceBundle: recipe([note]) },
      {
        publishGenerationPostWithResourceBundleAtomically: vi.fn(async () => {
          throw { code: 'P0001', message: 'Improve this unlock before publishing' };
        }),
      },
    );

    expect(result).toMatchObject({ ok: false, status: 500 });
    expect(dependencies.copyPlannedGenerationReferences).toHaveBeenCalledTimes(1);
    expect(adminClient.removeMock).not.toHaveBeenCalledWith(
      expect.arrayContaining(['user-1/generation-references/gen-recipe/00-reference-input-1.png']),
    );
  });

  // The app reads these fields by the shared contract's example.
  it('answers with what the shared contract documents of a creation’s recipe', async () => {
    const { result } = await publish({ includeGenerationReferences: true, resourceBundle: recipe([note]) });
    const documented = mobileApiContract.endpoints.publishGeneration.response;
    for (const key of ['recipeItemsAdded', 'referencesNotCopied'] as const) {
      expect(documented, `the contract lacks "${key}"`).toHaveProperty(key);
      expect(result.ok && result.body, `the publish lacks "${key}"`).toHaveProperty(key);
    }
    expect(Object.keys(documented.recipeItemsAdded[0]).sort())
      .toEqual(Object.keys((result.ok && result.body.recipeItemsAdded?.[1]) || {}).sort());
  });

  // #677's re-reviews: the inputs were held back, but the exact prompt, which
  // Remix withholds from such a creation, still went in, added by the server
  // or sent as the composer's locked card.
  it('adds nothing of a creation an operator removed, takes out the locked card sent for it, and says so', async () => {
    const lockedCard = {
      id: 'creation-prompt', type: 'prompt', role: 'primary', sectionId: null, title: 'Exact generation prompt',
      textContent: 'A product still lit like a window display.', sortOrder: 1, isPrimary: false, remixUse: 'text_template',
    };
    const { result, dependencies, written } = await publish(
      { includeGenerationReferences: true, resourceBundle: recipe([note, lockedCard]) },
      {},
      { moderation_removed_at: '2026-11-02T00:00:00.000Z', archived_at: '2026-11-02T00:00:00.000Z' },
    );

    expect(result).toMatchObject({ ok: true, body: { recipeItemsAdded: [], referencesNotCopied: 1 } });
    expect(dependencies.copyPlannedGenerationReferences).not.toHaveBeenCalled();
    expect((written?.resources?.items ?? []).map((item) => item.id)).toEqual(['notes']);
  });

  // #677's re-reviews: a publish writes over the creation's post as an edit
  // does, so a recipe people have or had gains no exact prompt from it either.
  it('adds no prompt where the creation’s post has a recipe people have or had, and one where nobody has', async () => {
    const held = await publish(
      { resourceBundle: recipe([note]) },
      {},
      {},
      // Retired while people had it: the row keeps their count.
      { storedPost: { id: 'post-recipe' }, storedBundle: { sales_count: 0, free_unlock_count: 2, retired_at: '2026-10-30T00:00:00.000Z' } },
    );
    expect(held.result).toMatchObject({ ok: true, body: { recipeItemsAdded: [] } });
    expect((held.written?.resources?.items ?? []).map((item) => item.id)).toEqual(['notes']);

    const unread = await publish(
      { resourceBundle: recipe([note]) },
      { loadGenerationRecipeHolders: vi.fn(async () => { throw new Error('connection reset'); }) },
    );
    expect((unread.written?.resources?.items ?? []).map((item) => item.id)).toEqual(['notes']);

    const nobody = await publish(
      { resourceBundle: recipe([note]) },
      {},
      {},
      { storedPost: { id: 'post-recipe' }, storedBundle: { sales_count: 0, free_unlock_count: 0 } },
    );
    expect((nobody.written?.resources?.items ?? []).map((item) => item.id)).toEqual(['notes', 'creation-prompt-item']);
  });

  // #677's re-review: the database counts a title in characters, and refused
  // one the route's count had let through ("Cat 🐱") with a 500.
  it('answers the database’s refusal of the title as its own, with the code the composers offer Post without recipe on', async () => {
    const refusal = mobileApiContract.endpoints.publishGeneration.errors.recipeTitleTooShort;
    const { result } = await publish(
      { includeGenerationReferences: true, resourceBundle: recipe([note]) },
      {
        publishGenerationPostWithResourceBundleAtomically: vi.fn(async () => {
          throw { code: 'P0001', message: 'Improve this unlock before publishing: Add a clear listing title with at least 6 characters.' };
        }),
      },
    );

    expect(result).toEqual({ ok: false, status: refusal.status, body: refusal.response });
  });
});

// The publish route stored no Made with for a creation, so both editors opened
// its post on the app alone. The row is the creation's, never the request's
// (generation-post-source-tools.ts): both composers show it locked.
describe('the Made with row of a published creation', () => {
  const generation = {
    id: 'gen-made-with',
    user_id: 'user-1',
    status: 'succeeded',
    model: 'nano-banana-pro',
    category: 'image',
    creation_mode: null,
    output_url: 'generated_images/user-1/harbour.jpg',
    showcase_asset_path: null,
    title: 'Harbour at dawn',
    description: null,
    prompt: 'A harbour at dawn, fog over the water',
  };
  const app = { toolLabel: 'magicbooklet', toolSlug: 'magicbooklet' };

  beforeEach(() => {
    logBackendErrorMock.mockClear();
  });

  function publishDependencies() {
    return {
      ensureDurableGenerationMedia: vi.fn(async ({ generation: mediaGeneration }) => ({
        outputUrl: mediaGeneration.outputUrl,
        createdLocation: null,
      })),
      listSourceToolsCatalog: vi.fn(async () => [
        { slug: 'magicbooklet', label: 'magicbooklet', models: [], supportedMediaKinds: ['image' as const, 'video' as const] },
      ]),
      getMarketplaceQualityErrorForPostBundle: vi.fn(async () => null),
      publishGenerationPostWithResourceBundleAtomically: vi.fn(async () => ({
        postId: 'post-made-with',
        visibility: 'public' as const,
        bundleId: null,
        bundleStatus: null,
      })),
      ensureGenerationPostCoverMedia: vi.fn(async () => ({ outcome: 'created' as const, error: null })),
      requestPostEmbedding: vi.fn(async () => undefined),
      replacePostSourceTools: vi.fn(async () => undefined),
    } satisfies Partial<ShowcasePublishServiceDependencies>;
  }

  async function publish(
    body: Partial<ShowcasePublishRequestBody> & Record<string, unknown>,
    {
      adminSupabase = createAdminClientMock(generation).client,
      dependencies = publishDependencies(),
    }: { adminSupabase?: SupabaseClient; dependencies?: ReturnType<typeof publishDependencies> } = {},
  ) {
    const result = await publishGenerationToShowcaseForRoute({
      adminSupabase,
      body: { generationId: 'gen-made-with', ...body },
      userId: 'user-1',
      dependencies,
    });
    return { result, replacePostSourceTools: dependencies.replacePostSourceTools };
  }

  it('stores the app and the creation’s model, whatever the request sends', async () => {
    const { result, replacePostSourceTools } = await publish({
      visibility: 'public',
      title: 'Harbour at dawn',
      resourceBundle: { accessMode: 'none' },
      // The app's composer sends the model's id as its name; neither composer
      // lets a creator add a tool to a creation.
      sourceTool: 'Adobe Photoshop',
      sourceTools: [
        { toolLabel: 'Adobe Photoshop', toolSlug: 'adobe-photoshop' },
        { toolLabel: 'Magicbooklet', toolSlug: 'magicbooklet', modelLabel: 'nano-banana-pro', modelSlug: 'nano-banana-pro' },
      ],
    });

    expect(result).toMatchObject({ ok: true, body: { postId: 'post-made-with', visibility: 'public' } });
    expect(replacePostSourceTools).toHaveBeenCalledTimes(1);
    expect(replacePostSourceTools).toHaveBeenCalledWith({
      supabase: expect.anything(),
      postId: 'post-made-with',
      ownerUserId: 'user-1',
      mediaKind: 'image',
      sourceTools: [{ ...app, modelLabel: 'Nano Banana Pro', modelSlug: 'nano-banana-pro' }],
    });
  });

  it.each([
    ['a video', { model: 'veo-3.1', category: 'video', output_url: 'generated_videos/user-1/harbour.mp4' }, 'video', 'Veo 3.1', 'veo-3.1'],
    // As its post page and feed card leave it out, rather than print the id.
    ['a model with no name', { model: 'retired-model-9' }, 'image', null, null],
  ])('names the model of %s as its post does', async (_label, creation, mediaKind, modelLabel, modelSlug) => {
    const { replacePostSourceTools } = await publish(
      { visibility: 'private', title: 'Harbour at dawn' },
      { adminSupabase: createAdminClientMock({ ...generation, ...creation }).client },
    );

    expect(replacePostSourceTools).toHaveBeenCalledWith(expect.objectContaining({
      mediaKind,
      sourceTools: [{ ...app, modelLabel, modelSlug }],
    }));
  });

  // Its model is the template author's, which no read gives out
  // (template-result.ts): its composer shows `template-workflow`.
  it('leaves a template result’s model out', async () => {
    const { result, replacePostSourceTools } = await publish(
      { visibility: 'private', title: 'My final image' },
      {
        adminSupabase: createCanonicalTemplateAdminClientMock({
          generation: { ...generation, model: 'nano-banana-2', template_run_id: 'run-1', template_run_step_id: null },
        }).client,
      },
    );

    expect(result).toMatchObject({ ok: true });
    expect(replacePostSourceTools).toHaveBeenCalledWith(expect.objectContaining({
      sourceTools: [{ ...app, modelLabel: null, modelSlug: null }],
    }));
  });

  // Studio's old switch sends the creation and the visibility alone, and the
  // stored post is carried forward, its Made with with it.
  it('leaves a stored post’s rows alone on a visibility-only request', async () => {
    const { result, replacePostSourceTools } = await publish({ visibility: 'private' }, {
      adminSupabase: createAdminClientMock(generation, null, {
        storedPost: {
          id: 'post-made-with',
          title: 'Harbour at dawn',
          description: null,
          prompt: null,
          body: null,
          category: 'image',
          is_nsfw: false,
        },
      }).client,
    });

    expect(result).toMatchObject({ ok: true });
    expect(replacePostSourceTools).not.toHaveBeenCalled();
  });

  it('writes the row when a visibility-only request creates the post', async () => {
    const { replacePostSourceTools } = await publish({ visibility: 'private' });

    expect(replacePostSourceTools).toHaveBeenCalledWith(expect.objectContaining({
      sourceTools: [{ ...app, modelLabel: 'Nano Banana Pro', modelSlug: 'nano-banana-pro' }],
    }));
  });

  // The post is committed by then, as with its cover media row: answering the
  // publish as failed would tell the creator nothing was posted.
  it('logs a failed save and still answers the publish as done', async () => {
    const dependencies = publishDependencies();
    dependencies.replacePostSourceTools.mockRejectedValueOnce(new Error('connection reset'));

    const { result } = await publish(
      { visibility: 'public', title: 'Harbour at dawn', resourceBundle: { accessMode: 'none' } },
      { dependencies },
    );

    expect(result).toMatchObject({ ok: true, body: { postId: 'post-made-with', visibility: 'public' } });
    expect(logBackendErrorMock).toHaveBeenCalledWith(
      'failed_to_save_generation_post_source_tools',
      { error: expect.objectContaining({ message: 'connection reset' }) },
    );
  });
});

// A remix's recipe keeps the terms of the post it remixed (owner, 2026-11-05):
// paid stays paid, at a price its creator sets, and free stays free.
describe('a remix\'s recipe terms', () => {
  const generation = {
    id: 'gen-remix',
    user_id: 'user-1',
    status: 'succeeded',
    model: 'nano-banana-2',
    category: 'image',
    creation_mode: null,
    output_url: 'generated_images/user-1/remix.jpg',
    showcase_asset_path: null,
    title: 'Lantern remix',
    description: null,
    prompt: 'A lantern at dusk, warmer.',
  };
  const recipe = (accessMode: 'none' | 'free' | 'paid') => ({
    accessMode,
    summary: 'The setup behind this remix.',
    previewText: 'Prompt and settings for the lantern remix.',
    ...(accessMode === 'paid' ? { priceUsdCents: 10 } : {}),
    resources: { promptText: 'A lantern at dusk, warmer.', attachments: [], allowRemix: false },
  });
  const terms = (mode: 'free' | 'paid' | null) => vi.fn(async () => ({
    mode,
    bundleId: mode ? 'bundle-original' : null,
    originGenerationId: mode ? 'gen-original' : null,
  }));
  const publish = (
    accessMode: 'none' | 'free' | 'paid',
    loadRemixRecipeTerms: ShowcasePublishServiceDependencies['loadRemixRecipeTerms'],
    visibility: 'public' | 'private' = 'public',
  ) => {
    const publishGenerationPostWithResourceBundleAtomically = vi.fn(async () => {
      throw new Error('stopped after the checks');
    });
    const run = publishGenerationToShowcaseForRoute({
      adminSupabase: createAdminClientMock(generation).client,
      body: { generationId: 'gen-remix', visibility, title: 'Lantern remix', resourceBundle: recipe(accessMode) },
      userId: 'user-1',
      dependencies: {
        validatePostResourceBundleInput: vi.fn(() => null),
        // Stops a public post that kept its terms right after them, so a case
        // reads only whether the terms let it through.
        getMarketplaceQualityErrorForPostBundle: vi.fn(async () => 'quality checked'),
        loadRemixRecipeTerms,
        publishGenerationPostWithResourceBundleAtomically,
      },
    });
    return { run, publishGenerationPostWithResourceBundleAtomically };
  };

  it.each(['free', 'none'] as const)('refuses a remix of a paid recipe going public with a %s recipe', async (accessMode) => {
    const { run, publishGenerationPostWithResourceBundleAtomically } = publish(accessMode, terms('paid'));

    const refusal = mobileApiContract.endpoints.publishGeneration.errors.remixRecipeMustBePaid;
    expect(await run).toEqual({ ok: false, status: refusal.status, body: refusal.response });
    expect(refusal.response).toEqual({ error: REMIX_RECIPE_MUST_BE_PAID, code: REMIX_RECIPE_MUST_BE_PAID_CODE, field: 'resourceBundle' });
    expect(publishGenerationPostWithResourceBundleAtomically).not.toHaveBeenCalled();
  });

  it('refuses to sell a remix of a free recipe', async () => {
    const { run } = publish('paid', terms('free'));

    const refusal = mobileApiContract.endpoints.publishGeneration.errors.remixRecipeStaysFree;
    expect(await run).toEqual({ ok: false, status: refusal.status, body: refusal.response });
    expect(refusal.response).toEqual({ error: REMIX_RECIPE_STAYS_FREE, code: REMIX_RECIPE_STAYS_FREE_CODE, field: 'resourceBundle' });
  });

  it.each([
    ['paid', 'paid'],
    ['free', 'free'],
    ['free', 'none'],
    [null, 'paid'],
    [null, 'none'],
  ] as const)('lets a %s remix go public with a %s recipe', async (mode, accessMode) => {
    const loadRemixRecipeTerms = terms(mode);
    const { run } = publish(accessMode, loadRemixRecipeTerms);

    expect(await run).toMatchObject({ ok: false, status: 400, body: { error: 'quality checked' } });
    expect(loadRemixRecipeTerms).toHaveBeenCalledWith(expect.anything(), 'gen-remix');
  });

  it('holds a private post to nothing yet: its recipe is a draft until it goes public', async () => {
    const loadRemixRecipeTerms = terms('paid');
    await publish('free', loadRemixRecipeTerms, 'private').run.catch(() => undefined);

    expect(loadRemixRecipeTerms).not.toHaveBeenCalled();
  });

  it('refuses rather than guess when the terms cannot be read', async () => {
    const { run, publishGenerationPostWithResourceBundleAtomically } = publish(
      'free',
      vi.fn(async () => { throw new Error('connection reset'); }),
    );

    expect(await run).toEqual({ ok: false, status: 500, body: { error: REMIX_RECIPE_TERMS_UNREADABLE_ERROR } });
    expect(publishGenerationPostWithResourceBundleAtomically).not.toHaveBeenCalled();
  });

  it.each([
    ['paid', null],
    [null, 'A lantern at dusk, warmer.'],
  ] as const)('shows the prompt on the post for a %s remix only where its terms allow', async (mode, shown) => {
    const publishGenerationPostWithResourceBundleAtomically = vi.fn(async () => {
      throw new Error('stopped after the checks');
    });
    await publishGenerationToShowcaseForRoute({
      adminSupabase: createAdminClientMock(generation).client,
      // Private, so nothing holds the post to its terms yet: only the prompt rule acts.
      body: { generationId: 'gen-remix', visibility: 'private', title: 'Lantern remix', exposePromptPublic: true },
      userId: 'user-1',
      dependencies: {
        loadRemixRecipeTerms: terms(mode),
        ensureDurableGenerationMedia: vi.fn(async ({ generation: mediaGeneration }) => ({
          outputUrl: mediaGeneration.outputUrl,
          createdLocation: null,
        })),
        listSourceToolsCatalog: vi.fn(async () => [
          { slug: 'magicbooklet', label: 'magicbooklet', models: [], supportedMediaKinds: ['image' as const, 'video' as const] },
        ]),
        publishGenerationPostWithResourceBundleAtomically,
      },
    });

    expect(publishGenerationPostWithResourceBundleAtomically).toHaveBeenCalledWith(expect.objectContaining({
      post: expect.objectContaining({ prompt: shown }),
    }));
  });

  it('holds a visibility change to the stored recipe it republishes', async () => {
    const result = await publishGenerationToShowcaseForRoute({
      adminSupabase: createAdminClientMock(generation).client,
      body: { generationId: 'gen-remix', visibility: 'public' },
      userId: 'user-1',
      dependencies: {
        loadExistingGenerationPostContent: vi.fn(async () => ({
          title: 'Lantern remix',
          description: null,
          prompt: null,
          body: null,
          category: 'image',
          resourceBundle: recipe('free'),
        })),
        getMarketplaceQualityErrorForPostBundle: vi.fn(async () => null),
        loadRemixRecipeTerms: terms('paid'),
        publishGenerationPostWithResourceBundleAtomically: vi.fn(),
      },
    });

    expect(result).toMatchObject({ ok: false, status: 400, body: { code: REMIX_RECIPE_MUST_BE_PAID_CODE } });
  });
});
