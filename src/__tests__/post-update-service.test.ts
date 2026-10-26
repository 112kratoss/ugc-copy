import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const cacheMocks = vi.hoisted(() => ({
  SHOWCASE_FEED_CACHE_TAG: 'showcase-feed:v2',
  invalidateShowcaseFeedCache: vi.fn(),
}));

vi.mock('@/lib/showcase-feed-cache', () => cacheMocks);

import {
  getCanonicalPostMediaStoragePath,
  updateOwnerPostForRoute,
  type PostUpdateDependencies,
} from '@/lib/post-update-service';
import type { SourceToolOption } from '@/lib/source-tools';
import { BODY_MAX_LENGTH, TITLE_MAX_LENGTH } from '@/lib/posts-server';
import { PUBLIC_UGC_SAFETY_ERROR } from '@/lib/public-ugc-safety';
import { DefinitiveSupabaseMutationRejection } from '@/lib/upload-byte-admission';

const sourceToolCatalog: SourceToolOption[] = [
  { slug: 'magicbooklet', label: 'magicbooklet', models: [], supportedMediaKinds: ['image', 'video'] },
];

function createSupabaseMock({
  post = {
    id: 'post-1',
    user_id: 'user-1',
    generation_id: null,
    visibility: 'private',
    title: 'Draft post',
    description: null,
    prompt: null,
    body: 'A draft post with an unlock package.',
    category: 'text',
    post_format: 'text',
    source_tool: null,
    source_tool_slug: null,
    source_kind: 'manual',
    archived_at: null,
    showcase_asset_path: null,
    output_url: null,
    review_status: 'visible',
  },
  bundle = {
    id: 'bundle-1',
    access_mode: 'paid',
    status: 'draft',
  },
  postMedia = [] as Array<Record<string, unknown>>,
  purchasedMediaRows = [] as Array<Record<string, unknown>>,
  pendingOrderRows = [] as Array<Record<string, unknown>>,
  downloadedMedia = null as Blob | null,
  stagedInfo = { size: 1024, contentType: 'image/jpeg' } as Record<string, unknown> | null,
  generation = null as Record<string, unknown> | null,
}: {
  post?: Record<string, unknown> | null;
  bundle?: Record<string, unknown> | null;
  postMedia?: Array<Record<string, unknown>>;
  purchasedMediaRows?: Array<Record<string, unknown>>;
  pendingOrderRows?: Array<Record<string, unknown>>;
  downloadedMedia?: Blob | null;
  /** Storage metadata for the staged object; the authoritative size check. */
  stagedInfo?: Record<string, unknown> | null;
  /** The linked generation row, for generation-backed posts. */
  generation?: Record<string, unknown> | null;
} = {}) {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const generationUpdates: Array<Record<string, unknown>> = [];
  const uploaded: string[] = [];
  const copied: Array<{ from: string; to: string }> = [];
  const downloads: string[] = [];
  const removals: string[][] = [];
  const client = {
    from(table: string) {
      const query = {
        select() {
          return query;
        },
        eq() {
          return query;
        },
        // media_upload_intents bookkeeping after a successful media replace,
        // and the linked generation's exposure flags after a post update.
        update(values?: Record<string, unknown>) {
          if (table === 'generations' && values) {
            generationUpdates.push(values);
          }
          return query;
        },
        then(resolve: (value: { error: null }) => unknown) {
          return Promise.resolve({ error: null }).then(resolve);
        },
        in() {
          return query;
        },
        not() {
          return query;
        },
        is() {
          return Promise.resolve({ error: null });
        },
        order() {
          return Promise.resolve({
            data: table === 'post_media'
              ? postMedia
              : table === 'post_resource_purchase_media'
                ? purchasedMediaRows
                : table === 'post_resource_bundle_orders'
                  ? pendingOrderRows
                : [],
            error: null,
          });
        },
        maybeSingle() {
          if (table === 'posts') {
            return Promise.resolve({ data: post, error: null });
          }

          if (table === 'post_resource_bundles') {
            return Promise.resolve({ data: bundle, error: null });
          }

          if (table === 'generations') {
            return Promise.resolve({ data: generation, error: null });
          }

          return Promise.resolve({ data: null, error: null });
        },
      };

      return query;
    },
    rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      return Promise.resolve({
        data: {
          allowed: true,
          limit: 60,
          remaining: 59,
          retryAfterSeconds: 0,
          resetAt: '2026-06-22T06:30:00.000Z',
        },
        error: null,
      });
    },
    storage: {
      from: vi.fn(() => ({
        info: vi.fn(async () => ({
          data: stagedInfo,
          error: stagedInfo ? null : new Error('missing'),
        })),
        copy: vi.fn(async (from: string, to: string) => {
          copied.push({ from, to });
          return { data: { path: to }, error: null };
        }),
        download: vi.fn(async (storagePath: string) => {
          downloads.push(storagePath);
          return { data: downloadedMedia, error: downloadedMedia ? null : new Error('missing') };
        }),
        upload: vi.fn(async (storagePath: string) => {
          uploaded.push(storagePath);
          return { error: null };
        }),
        remove: vi.fn(async (paths: string[]) => {
          removals.push(paths);
          return { data: paths.map((name) => ({ name })), error: null };
        }),
      })),
    },
  };

  return {
    client: client as unknown as SupabaseClient,
    rpcCalls,
    uploaded,
    copied,
    downloads,
    removals,
    generationUpdates,
  };
}

/** A Blob whose reported size is decoupled from its actual bytes. */
function blobOfSize(sizeBytes: number, type: string): Blob {
  const blob = new Blob(['x'], { type });
  Object.defineProperty(blob, 'size', { value: sizeBytes });
  return blob;
}

/** A recipe as both composers send it: one card, the legacy prompt and notes empty. */
function composerRecipe({
  cardText = 'Soft key light from the left, warm rim light behind.',
  cardDescription = 'The prompt behind the portrait.',
  summary = 'A reusable lighting setup for portraits.',
  previewText = 'Includes the prompt and the light plan.',
}: { cardText?: string; cardDescription?: string; summary?: string; previewText?: string } = {}) {
  return {
    accessMode: 'free' as const,
    summary,
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
        textContent: cardText,
        sortOrder: 0,
        remixUse: 'none',
      }],
    },
  };
}

/** The `post_resource_bundles` row that recipe is stored as. */
function storedRecipeRow(recipe: ReturnType<typeof composerRecipe>) {
  return {
    id: 'bundle-1',
    access_mode: recipe.accessMode,
    status: 'draft',
    sales_count: 0,
    free_unlock_count: 0,
    summary: recipe.summary,
    preview_text: recipe.previewText,
    prompt_text: null,
    notes_markdown: null,
    workflow_share_url: null,
    workflow_snapshot: null,
    attachments: [],
    allow_remix: false,
    price_usd_cents: 0,
    resource_sections: recipe.resources.sections,
    resource_items: recipe.resources.items,
  };
}

describe('updateOwnerPostForRoute', () => {
  beforeEach(() => {
    cacheMocks.invalidateShowcaseFeedCache.mockClear();
  });

  it('does not let an owner edit or republish a moderated post', async () => {
    const { client } = createSupabaseMock({
      post: {
        id: 'post-1',
        user_id: 'user-1',
        generation_id: null,
        visibility: 'private',
        title: 'Taken down',
        description: null,
        prompt: null,
        body: 'Moderated content',
        category: 'text',
        post_format: 'text',
        source_tool: null,
        source_tool_slug: null,
        source_kind: 'manual',
        archived_at: null,
        showcase_asset_path: null,
        output_url: null,
        review_status: 'hidden',
      },
    });
    const dependencies = {
      listSourceToolsCatalog: vi.fn(async () => sourceToolCatalog),
      getMarketplaceQualityErrorForPostBundle: vi.fn(async () => null),
      updatePostWithResourceBundleAtomically: vi.fn(),
      replacePostSourceTools: vi.fn(),
      replacePostMediaItems: vi.fn(),
      createPostMediaPreview: vi.fn(),
    } satisfies PostUpdateDependencies;

    const result = await updateOwnerPostForRoute({
      adminSupabase: client,
      ownerUserId: 'user-1',
      postId: 'post-1',
      body: { visibility: 'public', title: 'Republished' },
      dependencies,
    });

    expect(result).toEqual({
      ok: false,
      status: 409,
      body: { error: 'This post is locked while a moderation decision is in effect.' },
    });
    expect(dependencies.updatePostWithResourceBundleAtomically).not.toHaveBeenCalled();
  });

  // 03-4: deleting a post that has buyers tombstones it (private + archived)
  // and keeps it only for them; both dashboards still offered its editor.
  it('refuses to edit a post its owner deleted while it had buyers', async () => {
    const { client } = createSupabaseMock({
      post: {
        id: 'post-1',
        user_id: 'user-1',
        generation_id: null,
        visibility: 'private',
        title: 'Deleted recipe post',
        description: null,
        prompt: null,
        body: 'Kept for the people who bought it.',
        category: 'text',
        post_format: 'text',
        source_tool: null,
        source_tool_slug: null,
        source_kind: 'manual',
        archived_at: '2026-07-02T00:00:00.000Z',
        tombstoned_at: '2026-07-02T00:00:00.000Z',
        showcase_asset_path: null,
        output_url: null,
        review_status: 'visible',
      },
      bundle: { id: 'bundle-1', access_mode: 'paid', status: 'draft', sales_count: 3 },
    });
    const dependencies = {
      listSourceToolsCatalog: vi.fn(async () => sourceToolCatalog),
      getMarketplaceQualityErrorForPostBundle: vi.fn(async () => null),
      updatePostWithResourceBundleAtomically: vi.fn(),
      replacePostSourceTools: vi.fn(),
      replacePostMediaItems: vi.fn(),
      createPostMediaPreview: vi.fn(),
    } satisfies PostUpdateDependencies;

    const result = await updateOwnerPostForRoute({
      adminSupabase: client,
      ownerUserId: 'user-1',
      postId: 'post-1',
      body: { visibility: 'public', title: 'Brought back' },
      dependencies,
    });

    expect(result).toEqual({
      ok: false,
      status: 409,
      body: { error: 'This post was deleted. Buyers keep their copy.', code: 'POST_DELETED' },
    });
    expect(dependencies.updatePostWithResourceBundleAtomically).not.toHaveBeenCalled();
    expect(dependencies.replacePostSourceTools).not.toHaveBeenCalled();
    expect(dependencies.replacePostMediaItems).not.toHaveBeenCalled();
    expect(cacheMocks.invalidateShowcaseFeedCache).not.toHaveBeenCalled();
  });

  it('updates private posts with draft unlock bundles without marketplace quality gating', async () => {
    const { client, rpcCalls } = createSupabaseMock();
    const dependencies = {
      listSourceToolsCatalog: vi.fn(async () => sourceToolCatalog),
      getMarketplaceQualityErrorForPostBundle: vi.fn(async () => 'Quality gate should not run for private updates.'),
      updatePostWithResourceBundleAtomically: vi.fn(async ({ patch }) => ({
        postId: 'post-1',
        visibility: patch.visibility as 'private',
        bundleId: 'bundle-1',
        bundleStatus: 'draft' as const,
      })),
      replacePostSourceTools: vi.fn(async () => undefined),
      replacePostMediaItems: vi.fn(async () => undefined),
      createPostMediaPreview: vi.fn(async () => null),
    } satisfies PostUpdateDependencies;

    const result = await updateOwnerPostForRoute({
      adminSupabase: client,
      ownerUserId: 'user-1',
      postId: 'post-1',
      body: {
        title: 'Helpful launch proof',
        body: 'A draft post with an unlock package.',
        visibility: 'private',
        resourceBundle: {
          accessMode: 'paid',
          summary: 'A reusable launch prompt for a proof-led product hook.',
          previewText: 'Includes the prompt structure and CTA guidance buyers can reuse.',
          priceUsdCents: 500,
          resources: {
            promptText: 'Use a before and after hook with one product proof frame and a short CTA.',
            attachments: [],
            allowRemix: false,
          },
        },
      },
      dependencies,
    });

    expect(result).toEqual({
      ok: true,
      body: {
        success: true,
        postId: 'post-1',
        visibility: 'private',
        showcasePath: null,
        ownerPath: '/post/post-1/edit',
        resourceBundlePath: '/post/post-1/edit#recipe',
        resourceBundleStatus: 'draft',
        mediaItems: [],
      },
    });
    expect(rpcCalls).toEqual([
      {
        name: 'check_backend_rate_limit',
        args: {
          p_scope: 'post:mutate',
          p_subject_key: 'user-1',
          p_limit: 60,
          p_window_seconds: 600,
        },
      },
    ]);
    expect(dependencies.getMarketplaceQualityErrorForPostBundle).not.toHaveBeenCalled();
    expect(dependencies.updatePostWithResourceBundleAtomically).toHaveBeenCalledWith(expect.objectContaining({
      postId: 'post-1',
      ownerUserId: 'user-1',
      patch: expect.objectContaining({
        title: 'Helpful launch proof',
        body: 'A draft post with an unlock package.',
        visibility: 'private',
        category: 'text',
      }),
      hasBundlePayload: true,
    }));
    expect(cacheMocks.invalidateShowcaseFeedCache).toHaveBeenCalledTimes(1);
  });

  // Product decision 12 (2026-10-17): a post is public or private. An installed
  // app's menu can still ask for unlisted, and a post saved before the
  // decision may still hold it: either way the save stores and answers private.
  describe('unlisted', () => {
    function createDependencies() {
      return {
        listSourceToolsCatalog: vi.fn(async () => sourceToolCatalog),
        getMarketplaceQualityErrorForPostBundle: vi.fn(async () => null),
        updatePostWithResourceBundleAtomically: vi.fn(async ({ patch }) => ({
          postId: 'post-1',
          visibility: patch.visibility as 'public' | 'unlisted' | 'private',
          bundleId: null,
          bundleStatus: null,
        })),
        replacePostSourceTools: vi.fn(async () => undefined),
        replacePostMediaItems: vi.fn(async () => undefined),
        createPostMediaPreview: vi.fn(async () => null),
      } satisfies PostUpdateDependencies;
    }

    it('stores and answers a requested unlisted as private', async () => {
      const { client } = createSupabaseMock({ bundle: null });
      const dependencies = createDependencies();

      const result = await updateOwnerPostForRoute({
        adminSupabase: client,
        ownerUserId: 'user-1',
        postId: 'post-1',
        body: { visibility: 'unlisted' },
        dependencies,
      });

      expect(result).toMatchObject({
        ok: true,
        body: { visibility: 'private', showcasePath: null, resourceBundlePath: '/post/post-1/edit#recipe' },
      });
      expect(dependencies.updatePostWithResourceBundleAtomically).toHaveBeenCalledWith(expect.objectContaining({
        patch: expect.objectContaining({ visibility: 'private' }),
      }));
    });

    it('moves a post still stored unlisted to private on a save that names no visibility', async () => {
      const { client } = createSupabaseMock({
        post: {
          id: 'post-1',
          user_id: 'user-1',
          generation_id: null,
          visibility: 'unlisted',
          title: 'Old unlisted note',
          description: null,
          prompt: null,
          body: 'Saved before unlisted was dropped.',
          category: 'text',
          post_format: 'text',
          source_tool: null,
          source_tool_slug: null,
          source_kind: 'manual',
          archived_at: null,
          showcase_asset_path: null,
          output_url: null,
          review_status: 'visible',
        },
        bundle: null,
      });
      const dependencies = createDependencies();

      const result = await updateOwnerPostForRoute({
        adminSupabase: client,
        ownerUserId: 'user-1',
        postId: 'post-1',
        body: { title: 'Old unlisted note, retitled' },
        dependencies,
      });

      expect(result).toMatchObject({ ok: true, body: { visibility: 'private', showcasePath: null } });
      expect(dependencies.updatePostWithResourceBundleAtomically).toHaveBeenCalledWith(expect.objectContaining({
        patch: expect.objectContaining({ visibility: 'private', title: 'Old unlisted note, retitled' }),
      }));
    });
  });

  // The owner read APIs substitute "Untitled post"/"Untitled note" for an empty
  // title, and both composers PATCH the whole hydrated draft back. Without the
  // echo shim the fallback becomes the stored title, which the marketplace
  // placeholder gate then rejects on every public save — the post is stuck.
  describe('fallback title echo', () => {
    function createDependencies() {
      return {
        listSourceToolsCatalog: vi.fn(async () => sourceToolCatalog),
        getMarketplaceQualityErrorForPostBundle: vi.fn(async () => null),
        updatePostWithResourceBundleAtomically: vi.fn(async ({ patch }: { patch: Record<string, unknown> }) => ({
          postId: 'post-1',
          visibility: patch.visibility as 'public',
          bundleId: 'bundle-1',
          bundleStatus: 'published' as const,
        })),
        replacePostSourceTools: vi.fn(async () => undefined),
        replacePostMediaItems: vi.fn(async () => undefined),
        createPostMediaPreview: vi.fn(async () => null),
      } satisfies PostUpdateDependencies;
    }

    it('treats a fallback title echoed over an empty stored title as unchanged', async () => {
      const { client } = createSupabaseMock({
        post: {
          id: 'post-1',
          user_id: 'user-1',
          generation_id: null,
          visibility: 'private',
          title: null,
          description: null,
          prompt: null,
          body: 'A useful note about the recipe.',
          category: 'text',
          post_format: 'text',
          source_tool: null,
          source_tool_slug: null,
          source_kind: 'manual',
          archived_at: null,
          showcase_asset_path: null,
          output_url: null,
          review_status: 'visible',
        },
        bundle: { id: 'bundle-1', access_mode: 'free', status: 'draft' },
      });
      const dependencies = createDependencies();

      const result = await updateOwnerPostForRoute({
        adminSupabase: client,
        ownerUserId: 'user-1',
        postId: 'post-1',
        body: { visibility: 'public', title: 'Untitled post' },
        dependencies,
      });

      expect(result.ok).toBe(true);
      expect(dependencies.getMarketplaceQualityErrorForPostBundle).toHaveBeenCalledWith(
        expect.objectContaining({ post: expect.objectContaining({ title: null }) })
      );
      expect(dependencies.updatePostWithResourceBundleAtomically).toHaveBeenCalledWith(
        expect.objectContaining({ patch: expect.objectContaining({ title: null }) })
      );
    });

    it('keeps a deliberate rename to a fallback string when a real title is stored', async () => {
      const { client } = createSupabaseMock({
        bundle: { id: 'bundle-1', access_mode: 'free', status: 'draft' },
      });
      const dependencies = createDependencies();

      const result = await updateOwnerPostForRoute({
        adminSupabase: client,
        ownerUserId: 'user-1',
        postId: 'post-1',
        body: { visibility: 'private', title: 'Untitled note' },
        dependencies,
      });

      expect(result.ok).toBe(true);
      expect(dependencies.updatePostWithResourceBundleAtomically).toHaveBeenCalledWith(
        expect.objectContaining({ patch: expect.objectContaining({ title: 'Untitled note' }) })
      );
    });
  });

  // Owner reads merge the linked generation's reference media into
  // resources.items with generation_inputs paths, and both composers echo the
  // hydrated items back on save. Those derived items must be dropped, not
  // bounced off the file-ownership check — rejecting them made every save of a
  // recipe post fail with "Resource files must belong to the authenticated
  // user".
  it('drops re-echoed generation-derived reference items instead of rejecting the save', async () => {
    const { client } = createSupabaseMock({
      bundle: { id: 'bundle-1', access_mode: 'free', status: 'draft' },
    });
    const dependencies = {
      listSourceToolsCatalog: vi.fn(async () => sourceToolCatalog),
      getMarketplaceQualityErrorForPostBundle: vi.fn(async () => null),
      updatePostWithResourceBundleAtomically: vi.fn<
        NonNullable<PostUpdateDependencies['updatePostWithResourceBundleAtomically']>
      >(async () => ({
        postId: 'post-1',
        visibility: 'private' as const,
        bundleId: 'bundle-1',
        bundleStatus: 'draft' as const,
      })),
      replacePostSourceTools: vi.fn(async () => undefined),
      replacePostMediaItems: vi.fn(async () => undefined),
      createPostMediaPreview: vi.fn(async () => null),
    } satisfies PostUpdateDependencies;

    const result = await updateOwnerPostForRoute({
      adminSupabase: client,
      ownerUserId: 'user-1',
      postId: 'post-1',
      body: {
        visibility: 'private',
        resourceBundle: {
          accessMode: 'free',
          resources: {
            promptText: null,
            notesMarkdown: null,
            workflowShareUrl: null,
            attachments: [],
            allowRemix: true,
            items: [
              {
                id: 'recipe-prompt',
                type: 'prompt',
                role: 'primary',
                sectionId: null,
                title: 'Prompt',
                textContent: 'A useful reusable prompt.',
                sortOrder: 0,
                isPrimary: true,
                remixUse: 'text_template',
              },
              {
                id: 'gen-input-1',
                type: 'reference_image',
                role: 'style_reference',
                sectionId: null,
                title: 'Reference image 1',
                storagePath: 'generation_inputs/user-1/gen-7/00-reference_image.jpg',
                sortOrder: 1,
                isPrimary: false,
                remixUse: 'none',
              },
              // A legacy recipe merges the creator's own generated output as a
              // reference, and a persisted composer draft can echo the signed
              // URL form — both shapes must be recognised as derived.
              {
                id: 'gen-input-2',
                type: 'reference_image',
                role: 'style_reference',
                sectionId: null,
                title: 'Workflow input',
                storagePath: 'generated_images/user-1/workflow-input-b.jpeg',
                sortOrder: 2,
                isPrimary: false,
                remixUse: 'none',
              },
              {
                id: 'gen-input-3',
                type: 'reference_image',
                role: 'style_reference',
                sectionId: null,
                title: 'Signed reference',
                storagePath: 'https://project.supabase.co/storage/v1/object/sign/generation_inputs/user-1/gen-7/01-reference_image.jpg?token=abc',
                sortOrder: 3,
                isPrimary: false,
                remixUse: 'none',
              },
            ],
          },
        },
      },
      dependencies,
    });

    expect(result.ok).toBe(true);
    const atomicCall = dependencies.updatePostWithResourceBundleAtomically.mock.calls[0]?.[0];
    const persistedItems = atomicCall?.bundle?.resources?.items ?? [];
    expect(persistedItems.map((item) => item.id)).toEqual(['recipe-prompt']);
    expect(persistedItems.some((item) => item.storagePath)).toBe(false);
  });

  // Both composers already refuse to edit a sold package, but that is a rule
  // about what buyers paid for, so a stale client or a direct API call must not
  // be able to rewrite, reprice, or retire it either.
  describe('sold resource bundles', () => {
    const SOLD_BUNDLE = { access_mode: 'paid', status: 'published', sales_count: 3 };

    function createDependencies() {
      return {
        listSourceToolsCatalog: vi.fn(async () => sourceToolCatalog),
        getMarketplaceQualityErrorForPostBundle: vi.fn<
          NonNullable<PostUpdateDependencies['getMarketplaceQualityErrorForPostBundle']>
        >(async () => null),
        updatePostWithResourceBundleAtomically: vi.fn<
          NonNullable<PostUpdateDependencies['updatePostWithResourceBundleAtomically']>
        >(async () => ({
          postId: 'post-1',
          visibility: 'private' as const,
          bundleId: 'bundle-1',
          bundleStatus: 'published' as const,
        })),
        replacePostSourceTools: vi.fn(async () => undefined),
        replacePostMediaItems: vi.fn(async () => undefined),
        createPostMediaPreview: vi.fn(async () => null),
      } satisfies PostUpdateDependencies;
    }

    it('rejects a bundle payload once the package has sales', async () => {
      const { client } = createSupabaseMock({ bundle: SOLD_BUNDLE });
      const dependencies = createDependencies();

      const result = await updateOwnerPostForRoute({
        adminSupabase: client,
        ownerUserId: 'user-1',
        postId: 'post-1',
        body: {
          title: 'Helpful launch proof',
          body: 'A draft post with an unlock package.',
          visibility: 'private',
          resourceBundle: {
            accessMode: 'paid',
            summary: 'A hollowed-out package.',
            previewText: 'Nothing like what buyers paid for.',
            priceUsdCents: 100,
            resources: { promptText: 'Gutted.', attachments: [], allowRemix: false },
          },
        },
        dependencies,
      });

      expect(result).toEqual({
        ok: false,
        status: 409,
        body: {
          error: 'People have already purchased this package, so its contents, price, and access mode are locked.',
          code: 'RESOURCE_BUNDLE_LOCKED',
        },
      });
      expect(dependencies.updatePostWithResourceBundleAtomically).not.toHaveBeenCalled();
      expect(cacheMocks.invalidateShowcaseFeedCache).not.toHaveBeenCalled();
    });

    // Free unlocks left sales_count on 2026-10-17 (decision 6); a paid recipe
    // whose unlocks came while it was free stays locked, as it was before.
    it('rejects a bundle payload when its only unlocks were free ones', async () => {
      const { client } = createSupabaseMock({
        bundle: { access_mode: 'paid', status: 'published', sales_count: 0, free_unlock_count: 2 },
      });
      const dependencies = createDependencies();

      const result = await updateOwnerPostForRoute({
        adminSupabase: client,
        ownerUserId: 'user-1',
        postId: 'post-1',
        body: {
          title: 'Helpful launch proof',
          body: 'A draft post with an unlock package.',
          visibility: 'private',
          resourceBundle: {
            accessMode: 'paid',
            summary: 'A hollowed-out package.',
            previewText: 'Nothing like what buyers paid for.',
            priceUsdCents: 100,
            resources: { promptText: 'Gutted.', attachments: [], allowRemix: false },
          },
        },
        dependencies,
      });

      expect(result).toMatchObject({ ok: false, status: 409, body: { code: 'RESOURCE_BUNDLE_LOCKED' } });
      expect(dependencies.updatePostWithResourceBundleAtomically).not.toHaveBeenCalled();
    });

    // Without this the delete is caught by a trigger that retires the bundle
    // instead, so the storefront listing disappears with no error at all.
    it('rejects retiring a sold package through an accessMode none payload', async () => {
      const { client } = createSupabaseMock({ bundle: SOLD_BUNDLE });
      const dependencies = createDependencies();

      const result = await updateOwnerPostForRoute({
        adminSupabase: client,
        ownerUserId: 'user-1',
        postId: 'post-1',
        body: { visibility: 'private', resourceBundle: { accessMode: 'none' } },
        dependencies,
      });

      expect(result).toMatchObject({ ok: false, status: 409, body: { code: 'RESOURCE_BUNDLE_LOCKED' } });
      expect(dependencies.updatePostWithResourceBundleAtomically).not.toHaveBeenCalled();
    });

    // The guard freezes the package, not the post: everything else stays editable.
    it('updates a sold post normally when no bundle payload is sent', async () => {
      const { client } = createSupabaseMock({ bundle: SOLD_BUNDLE });
      const dependencies = createDependencies();

      const result = await updateOwnerPostForRoute({
        adminSupabase: client,
        ownerUserId: 'user-1',
        postId: 'post-1',
        body: { title: 'A retitled but still sold post', visibility: 'private' },
        dependencies,
      });

      expect(result.ok).toBe(true);
      expect(dependencies.updatePostWithResourceBundleAtomically).toHaveBeenCalledWith(
        expect.objectContaining({ hasBundlePayload: false })
      );
    });

    it('republishes a frozen sold package without resubmitting its content', async () => {
      const { client } = createSupabaseMock({
        bundle: { ...SOLD_BUNDLE, status: 'draft' },
      });
      const dependencies = createDependencies();
      dependencies.updatePostWithResourceBundleAtomically.mockResolvedValueOnce({
        postId: 'post-1',
        visibility: 'public',
        bundleId: 'bundle-1',
        bundleStatus: 'published',
      });

      const result = await updateOwnerPostForRoute({
        adminSupabase: client,
        ownerUserId: 'user-1',
        postId: 'post-1',
        body: { visibility: 'public' },
        dependencies,
      });

      expect(result).toMatchObject({
        ok: true,
        body: { visibility: 'public', resourceBundleStatus: 'published' },
      });
      expect(dependencies.updatePostWithResourceBundleAtomically).toHaveBeenCalledWith(
        expect.objectContaining({ hasBundlePayload: false, bundle: null })
      );
      expect(dependencies.getMarketplaceQualityErrorForPostBundle).toHaveBeenCalledWith(
        expect.objectContaining({
          bundle: expect.objectContaining({ accessMode: 'paid' }),
        }),
      );
    });

    it('revalidates the frozen listing and creator profile before republishing it', async () => {
      const { client } = createSupabaseMock({
        bundle: {
          ...SOLD_BUNDLE,
          status: 'draft',
          summary: 'Reusable launch package.',
          preview_text: 'Includes the exact prompt and workflow.',
          prompt_text: 'Build the launch proof sequence.',
          attachments: [],
          allow_remix: false,
          price_usd_cents: 500,
          resource_items: [],
          resource_sections: [],
        },
      });
      const dependencies = createDependencies();
      dependencies.getMarketplaceQualityErrorForPostBundle.mockResolvedValueOnce(
        'Complete your creator profile name or username before publishing a marketplace unlock.',
      );

      const result = await updateOwnerPostForRoute({
        adminSupabase: client,
        ownerUserId: 'user-1',
        postId: 'post-1',
        body: { visibility: 'public' },
        dependencies,
      });

      expect(result).toMatchObject({ ok: false, status: 400 });
      expect(dependencies.getMarketplaceQualityErrorForPostBundle).toHaveBeenCalledWith(
        expect.objectContaining({
          bundle: expect.objectContaining({
            accessMode: 'paid',
            summary: 'Reusable launch package.',
            priceUsdCents: 500,
          }),
        }),
      );
      expect(dependencies.updatePostWithResourceBundleAtomically).not.toHaveBeenCalled();
    });

    it('maps a checkout race rejected by the database to a bundle conflict', async () => {
      const { client } = createSupabaseMock({
        // The stale route read saw no sale; the transaction-level guard wins.
        bundle: { access_mode: 'paid', status: 'published', sales_count: 0 },
      });
      const dependencies = createDependencies();
      dependencies.updatePostWithResourceBundleAtomically.mockRejectedValueOnce({
        message: 'RESOURCE_BUNDLE_LOCKED: this package has already been purchased',
        hint: 'RESOURCE_BUNDLE_LOCKED',
      });

      const result = await updateOwnerPostForRoute({
        adminSupabase: client,
        ownerUserId: 'user-1',
        postId: 'post-1',
        body: {
          visibility: 'private',
          resourceBundle: { accessMode: 'none' },
        },
        dependencies,
      });

      expect(result).toMatchObject({
        ok: false,
        status: 409,
        body: { code: 'RESOURCE_BUNDLE_LOCKED' },
      });
      expect(cacheMocks.invalidateShowcaseFeedCache).not.toHaveBeenCalled();
    });

    it('keeps an unsold paid package editable', async () => {
      const { client } = createSupabaseMock({
        bundle: { access_mode: 'paid', status: 'published', sales_count: 0 },
      });
      const dependencies = createDependencies();

      const result = await updateOwnerPostForRoute({
        adminSupabase: client,
        ownerUserId: 'user-1',
        postId: 'post-1',
        body: {
          title: 'Helpful launch proof',
          body: 'A draft post with an unlock package.',
          visibility: 'private',
          resourceBundle: {
            accessMode: 'paid',
            summary: 'A reusable launch prompt for a proof-led product hook.',
            previewText: 'Includes the prompt structure and CTA guidance buyers can reuse.',
            priceUsdCents: 500,
            resources: {
              promptText: 'Use a before and after hook with one product proof frame and a short CTA.',
              attachments: [],
              allowRemix: false,
            },
          },
        },
        dependencies,
      });

      expect(result.ok).toBe(true);
      expect(dependencies.updatePostWithResourceBundleAtomically).toHaveBeenCalledWith(
        expect.objectContaining({ hasBundlePayload: true })
      );
    });
  });

  // A stored draft recipe no longer blocks making the post public. The posts
  // trigger promotes it if it passes the quality gate and leaves it a draft
  // otherwise; refusing here is what left a mobile user with a free recipe
  // unable to make their post public again.
  it('lets a post with a stored draft recipe go public and leaves promotion to the database', async () => {
    const { client } = createSupabaseMock();
    const dependencies = {
      listSourceToolsCatalog: vi.fn(async () => sourceToolCatalog),
      getMarketplaceQualityErrorForPostBundle: vi.fn(async () => null),
      updatePostWithResourceBundleAtomically: vi.fn(async () => ({
        postId: 'post-1',
        visibility: 'public' as const,
        bundleId: 'bundle-1',
        bundleStatus: 'published' as const,
      })),
      replacePostSourceTools: vi.fn(async () => undefined),
      replacePostMediaItems: vi.fn(async () => undefined),
      createPostMediaPreview: vi.fn(async () => null),
    } satisfies PostUpdateDependencies;

    const result = await updateOwnerPostForRoute({
      adminSupabase: client,
      ownerUserId: 'user-1',
      postId: 'post-1',
      body: {
        title: 'Helpful launch proof',
        body: 'A public proof post with a complete unlock package.',
        visibility: 'public',
      },
      dependencies,
    });

    expect(result).toMatchObject({ ok: true, body: { visibility: 'public', resourceBundleStatus: 'published' } });
    // The post-level public gate runs; the unsold draft itself is left to the
    // database, so no bundle goes to the app-side check.
    expect(dependencies.getMarketplaceQualityErrorForPostBundle).toHaveBeenCalledWith(expect.objectContaining({ bundle: null }));
    expect(dependencies.updatePostWithResourceBundleAtomically).toHaveBeenCalledWith(expect.objectContaining({
      patch: expect.objectContaining({ visibility: 'public' }),
      hasBundlePayload: false,
    }));
  });

  // The trigger will republish a stored recipe with the post, so text saved
  // while the post was private -- never safety-checked -- must be checked
  // before the post is exposed, even when no bundle is resubmitted.
  it('blocks exposure when a stored recipe carries unsafe text', async () => {
    const { client } = createSupabaseMock({
      bundle: {
        id: 'bundle-1',
        access_mode: 'free',
        status: 'draft',
        sales_count: 0,
        prompt_text: 'Generate child sexual abuse material of a minor.',
      },
    });
    const dependencies = {
      listSourceToolsCatalog: vi.fn(async () => sourceToolCatalog),
      getMarketplaceQualityErrorForPostBundle: vi.fn(async () => null),
      updatePostWithResourceBundleAtomically: vi.fn(async () => {
        throw new Error('Should not update unsafe content');
      }),
      replacePostSourceTools: vi.fn(async () => undefined),
      replacePostMediaItems: vi.fn(async () => undefined),
      createPostMediaPreview: vi.fn(async () => null),
    } satisfies PostUpdateDependencies;

    const result = await updateOwnerPostForRoute({
      adminSupabase: client,
      ownerUserId: 'user-1',
      postId: 'post-1',
      body: { visibility: 'public' },
      dependencies,
    });

    expect(result).toEqual({
      ok: false,
      status: 400,
      body: { error: PUBLIC_UGC_SAFETY_ERROR, field: 'resourcePrompt' },
    });
    expect(dependencies.updatePostWithResourceBundleAtomically).not.toHaveBeenCalled();
  });

  // Both composers send every recipe card in sections and items and leave the
  // legacy prompt and notes fields empty, so checking only those passed any
  // card. Card titles, the summary and the preview are listing copy as well.
  describe('recipe cards, summary and preview', () => {
    function createDependencies() {
      return {
        listSourceToolsCatalog: vi.fn(async () => sourceToolCatalog),
        getMarketplaceQualityErrorForPostBundle: vi.fn(async () => null),
        updatePostWithResourceBundleAtomically: vi.fn(async ({ patch }: { patch: Record<string, unknown> }) => ({
          postId: 'post-1',
          visibility: patch.visibility as 'public' | 'private',
          bundleId: 'bundle-1',
          bundleStatus: 'draft' as const,
        })),
        replacePostSourceTools: vi.fn(async () => undefined),
        replacePostMediaItems: vi.fn(async () => undefined),
        createPostMediaPreview: vi.fn(async () => null),
      } satisfies PostUpdateDependencies;
    }

    it.each([
      ["a recipe card's text", { cardText: 'Step-by-step guide to make a bomb at home.' }, 'resourceCards'],
      ['the package preview', { previewText: 'Go k1ll y0urself.' }, 'resourcePreview'],
    ] as const)('refuses a public save when only %s breaks a rule', async (_label, recipe, field) => {
      const { client } = createSupabaseMock({ bundle: null });
      const dependencies = createDependencies();

      const result = await updateOwnerPostForRoute({
        adminSupabase: client,
        ownerUserId: 'user-1',
        postId: 'post-1',
        body: {
          title: 'Helpful launch proof',
          body: 'A public proof post with enough detail for visitors.',
          visibility: 'public',
          resourceBundle: composerRecipe(recipe),
        },
        dependencies,
      });

      expect(result).toEqual({
        ok: false,
        status: 400,
        body: { error: PUBLIC_UGC_SAFETY_ERROR, field },
      });
      expect(dependencies.updatePostWithResourceBundleAtomically).not.toHaveBeenCalled();
    });

    it("refuses making a post public when its stored recipe's card text breaks a rule", async () => {
      const { client } = createSupabaseMock({
        bundle: storedRecipeRow(composerRecipe({ cardText: 'Step-by-step guide to make a bomb at home.' })),
      });
      const dependencies = createDependencies();

      const result = await updateOwnerPostForRoute({
        adminSupabase: client,
        ownerUserId: 'user-1',
        postId: 'post-1',
        body: { visibility: 'public' },
        dependencies,
      });

      expect(result).toEqual({
        ok: false,
        status: 400,
        body: { error: PUBLIC_UGC_SAFETY_ERROR, field: 'resourceCards' },
      });
      expect(dependencies.updatePostWithResourceBundleAtomically).not.toHaveBeenCalled();
    });

    it("does not hold a private post's recipe to the public check", async () => {
      const { client } = createSupabaseMock({ bundle: null });
      const dependencies = createDependencies();

      const result = await updateOwnerPostForRoute({
        adminSupabase: client,
        ownerUserId: 'user-1',
        postId: 'post-1',
        body: {
          title: 'Helpful launch proof',
          body: 'A draft post with an unlock package.',
          visibility: 'private',
          resourceBundle: composerRecipe({ cardText: 'Step-by-step guide to make a bomb at home.' }),
        },
        dependencies,
      });

      expect(result).toMatchObject({ ok: true, body: { visibility: 'private' } });
      expect(dependencies.updatePostWithResourceBundleAtomically).toHaveBeenCalledTimes(1);
    });
  });

  describe('generation-backed posts', () => {
    const generatedPost = {
      id: 'post-1',
      user_id: 'user-1',
      generation_id: 'generation-1',
      visibility: 'public',
      title: 'Sunset study',
      description: 'Golden hour.',
      prompt: null,
      body: null,
      category: 'image',
      post_format: 'media',
      source_tool: 'magicbooklet',
      source_tool_slug: 'magicbooklet',
      source_kind: 'magicbooklet',
      archived_at: null,
      showcase_asset_path: 'showcase/generation-1/example.abc123.jpg',
      output_url: 'generated_images/user-1/example.jpg',
      review_status: 'visible',
    };
    const generationRow = {
      id: 'generation-1',
      user_id: 'user-1',
      model: 'nano-banana-2',
      category: 'image',
      output_url: 'generated_images/user-1/example.jpg',
      showcase_asset_path: 'showcase/generation-1/example.abc123.jpg',
    };

    function createDependencies(overrides: Partial<PostUpdateDependencies> = {}) {
      return {
        listSourceToolsCatalog: vi.fn(async () => sourceToolCatalog),
        getMarketplaceQualityErrorForPostBundle: vi.fn(async () => null),
        updatePostWithResourceBundleAtomically: vi.fn(async () => ({
          postId: 'post-1',
          visibility: 'private' as const,
          bundleId: null,
          bundleStatus: null,
        })),
        replacePostSourceTools: vi.fn(async () => undefined),
        replacePostMediaItems: vi.fn(async () => undefined),
        createPostMediaPreview: vi.fn(async () => null),
        createGenerationShowcaseDerivative: vi.fn(async () => 'showcase/generation-1/example.abc123.jpg'),
        removeGenerationShowcaseDerivative: vi.fn(async () => ({ removed: true, removedPaths: [], removedMediaRows: 0, error: null })),
        ensureDurableGenerationMedia: vi.fn(async () => ({
          outputUrl: 'generated_images/user-1/durable/example.jpg',
          createdLocation: null,
        })),
        ...overrides,
      } satisfies PostUpdateDependencies;
    }

    // The public bucket serves whatever is in it. A private post must stop
    // pointing at its public copy and the copy must go; this route used to
    // change the visibility column alone, which is how a post made private
    // from the phone stayed fetchable at its old URL.
    it('secures the private copy and drops the public derivative when going private, leaving exposure to the posts trigger', async () => {
      const { client, generationUpdates } = createSupabaseMock({
        post: generatedPost,
        bundle: null,
        generation: generationRow,
      });
      const dependencies = createDependencies();

      const result = await updateOwnerPostForRoute({
        adminSupabase: client,
        ownerUserId: 'user-1',
        postId: 'post-1',
        body: { visibility: 'private' },
        dependencies,
      });

      expect(result).toMatchObject({ ok: true, body: { visibility: 'private' } });
      expect(dependencies.ensureDurableGenerationMedia).toHaveBeenCalledWith(expect.objectContaining({
        generation: expect.objectContaining({ id: 'generation-1', outputUrl: 'generated_images/user-1/example.jpg' }),
      }));
      expect(dependencies.updatePostWithResourceBundleAtomically).toHaveBeenCalledWith(expect.objectContaining({
        patch: expect.objectContaining({
          visibility: 'private',
          showcase_asset_path: null,
          output_url: 'generated_images/user-1/durable/example.jpg',
        }),
      }));
      // is_public and showcase_asset_path follow the post inside the RPC's own
      // transaction (posts_sync_generation_exposure). Writing them here, after
      // the commit, is what used to let a private post keep a public generation.
      expect(generationUpdates).toEqual([{
        output_url: 'generated_images/user-1/durable/example.jpg',
      }]);
      // Removed only after the post row no longer points at it, together with
      // any legacy media row of this post that still serves the same copy.
      expect(dependencies.removeGenerationShowcaseDerivative).toHaveBeenCalledWith(expect.objectContaining({
        generationId: 'generation-1',
        showcaseAssetPath: 'showcase/generation-1/example.abc123.jpg',
        postId: 'post-1',
      }));
      expect(dependencies.createGenerationShowcaseDerivative).not.toHaveBeenCalled();
    });

    // Unlisted is stored private (product decision 12), so it takes the
    // going-private path: no public copy is made for it, and the one the
    // public post had is taken down.
    it('takes a public post asked to go unlisted private, media included', async () => {
      const { client } = createSupabaseMock({
        post: generatedPost,
        bundle: null,
        generation: generationRow,
      });
      const dependencies = createDependencies();

      const result = await updateOwnerPostForRoute({
        adminSupabase: client,
        ownerUserId: 'user-1',
        postId: 'post-1',
        body: { visibility: 'unlisted' },
        dependencies,
      });

      expect(result).toMatchObject({ ok: true, body: { visibility: 'private', showcasePath: null } });
      expect(dependencies.createGenerationShowcaseDerivative).not.toHaveBeenCalled();
      expect(dependencies.ensureDurableGenerationMedia).toHaveBeenCalledTimes(1);
      expect(dependencies.updatePostWithResourceBundleAtomically).toHaveBeenCalledWith(expect.objectContaining({
        patch: expect.objectContaining({ visibility: 'private', showcase_asset_path: null }),
      }));
      expect(dependencies.removeGenerationShowcaseDerivative).toHaveBeenCalledWith(expect.objectContaining({
        showcaseAssetPath: 'showcase/generation-1/example.abc123.jpg',
      }));
    });

    it('keeps the current visibility when the private copy cannot be secured', async () => {
      const { client, generationUpdates } = createSupabaseMock({
        post: generatedPost,
        bundle: null,
        generation: generationRow,
      });
      const dependencies = createDependencies({
        ensureDurableGenerationMedia: vi.fn(async () => {
          throw new Error('storage unavailable');
        }),
      });

      const result = await updateOwnerPostForRoute({
        adminSupabase: client,
        ownerUserId: 'user-1',
        postId: 'post-1',
        body: { visibility: 'private' },
        dependencies,
      });

      expect(result).toEqual({
        ok: false,
        status: 500,
        body: { error: 'This post could not be made private because its preview could not be secured. The current visibility was kept.' },
      });
      expect(dependencies.updatePostWithResourceBundleAtomically).not.toHaveBeenCalled();
      expect(dependencies.removeGenerationShowcaseDerivative).not.toHaveBeenCalled();
      expect(generationUpdates).toEqual([]);
    });

    it('creates the public copy when going public, leaving the generation\'s exposure to the posts trigger', async () => {
      const { client, generationUpdates } = createSupabaseMock({
        post: { ...generatedPost, visibility: 'private', showcase_asset_path: null },
        bundle: null,
        generation: { ...generationRow, showcase_asset_path: null },
      });
      const dependencies = createDependencies({
        updatePostWithResourceBundleAtomically: vi.fn(async () => ({
          postId: 'post-1',
          visibility: 'public' as const,
          bundleId: null,
          bundleStatus: null,
        })),
      });

      const result = await updateOwnerPostForRoute({
        adminSupabase: client,
        ownerUserId: 'user-1',
        postId: 'post-1',
        body: { visibility: 'public' },
        dependencies,
      });

      expect(result).toMatchObject({ ok: true, body: { visibility: 'public', showcasePath: '/showcase/post-1' } });
      expect(dependencies.createGenerationShowcaseDerivative).toHaveBeenCalledWith(expect.objectContaining({
        generationId: 'generation-1',
        ownerUserId: 'user-1',
        outputUrl: 'generated_images/user-1/example.jpg',
        category: 'image',
      }));
      expect(dependencies.updatePostWithResourceBundleAtomically).toHaveBeenCalledWith(expect.objectContaining({
        patch: expect.objectContaining({
          visibility: 'public',
          showcase_asset_path: 'showcase/generation-1/example.abc123.jpg',
        }),
      }));
      expect(generationUpdates).toEqual([]);
      expect(dependencies.ensureDurableGenerationMedia).not.toHaveBeenCalled();
      expect(dependencies.removeGenerationShowcaseDerivative).not.toHaveBeenCalled();
    });

    // The generation card shows the generation's own title and caption, and
    // the publish route has always mirrored edits onto it while the post is
    // exposed. Editing here now does the same, so the two surfaces agree.
    it('edits the title and caption of a generation-backed post and mirrors them to the generation', async () => {
      const { client, generationUpdates } = createSupabaseMock({
        post: generatedPost,
        bundle: null,
        generation: generationRow,
      });
      const updatePostWithResourceBundleAtomically = vi.fn<
        NonNullable<PostUpdateDependencies['updatePostWithResourceBundleAtomically']>
      >(async () => ({
        postId: 'post-1',
        visibility: 'public' as const,
        bundleId: null,
        bundleStatus: null,
      }));
      const dependencies = createDependencies({ updatePostWithResourceBundleAtomically });

      const result = await updateOwnerPostForRoute({
        adminSupabase: client,
        ownerUserId: 'user-1',
        postId: 'post-1',
        body: {
          title: 'Golden hour study',
          description: 'Shot at golden hour.',
          body: 'Here is how I lit it.',
          // Dropped, not refused: the source of a creation post is this product.
          sourceTools: [{ toolLabel: 'Runway', toolSlug: 'runway' }],
          category: 'video',
        },
        dependencies,
      });

      expect(result).toMatchObject({ ok: true });
      const patch = updatePostWithResourceBundleAtomically.mock.calls[0]?.[0].patch ?? {};
      expect(patch).toMatchObject({
        title: 'Golden hour study',
        description: 'Shot at golden hour.',
        body: 'Here is how I lit it.',
        category: 'image',
      });
      expect(patch).not.toHaveProperty('source_tool');
      expect(dependencies.replacePostSourceTools).not.toHaveBeenCalled();
      expect(generationUpdates).toEqual([{ title: 'Golden hour study', description: 'Shot at golden hour.' }]);
      // No exposure change: no media work.
      expect(dependencies.createGenerationShowcaseDerivative).not.toHaveBeenCalled();
      expect(dependencies.ensureDurableGenerationMedia).not.toHaveBeenCalled();
    });

    it('mirrors a title edited while the post is private, so the creation card does not go stale', async () => {
      const { client, generationUpdates } = createSupabaseMock({
        post: { ...generatedPost, visibility: 'private', showcase_asset_path: null },
        bundle: null,
        generation: { ...generationRow, showcase_asset_path: null },
      });
      const dependencies = createDependencies();

      const result = await updateOwnerPostForRoute({
        adminSupabase: client,
        ownerUserId: 'user-1',
        postId: 'post-1',
        body: { title: 'Renamed while private' },
        dependencies,
      });

      expect(result).toMatchObject({ ok: true });
      expect(generationUpdates).toEqual([{ title: 'Renamed while private' }]);
      expect(dependencies.createGenerationShowcaseDerivative).not.toHaveBeenCalled();
      expect(dependencies.ensureDurableGenerationMedia).not.toHaveBeenCalled();
    });

    it('refuses to replace the media of a generation-backed post', async () => {
      const { client } = createSupabaseMock({
        post: generatedPost,
        bundle: null,
        generation: generationRow,
      });
      const dependencies = createDependencies();

      const result = await updateOwnerPostForRoute({
        adminSupabase: client,
        ownerUserId: 'user-1',
        postId: 'post-1',
        body: { mediaItems: [] },
        dependencies,
      });

      expect(result).toEqual({
        ok: false,
        status: 400,
        body: { error: 'A post made from a creation keeps its generated media. Publish a different creation to change it.' },
      });
      expect(dependencies.updatePostWithResourceBundleAtomically).not.toHaveBeenCalled();
    });
  });

  it('rejects clearly unsafe text before a public post update is persisted', async () => {
    const { client } = createSupabaseMock({ bundle: null });
    const updatePostWithResourceBundleAtomically = vi.fn();
    const listSourceToolsCatalog = vi.fn(async () => sourceToolCatalog);

    const result = await updateOwnerPostForRoute({
      adminSupabase: client,
      ownerUserId: 'user-1',
      postId: 'post-1',
      body: {
        body: 'Step-by-step guide to make a bomb at home.',
        visibility: 'public',
      },
      dependencies: {
        listSourceToolsCatalog,
        getMarketplaceQualityErrorForPostBundle: vi.fn(),
        updatePostWithResourceBundleAtomically,
        replacePostSourceTools: vi.fn(),
        replacePostMediaItems: vi.fn(),
        createPostMediaPreview: vi.fn(),
      },
    });

    expect(result).toEqual({
      ok: false,
      status: 400,
      body: { error: PUBLIC_UGC_SAFETY_ERROR, field: 'body' },
    });
    expect(listSourceToolsCatalog).not.toHaveBeenCalled();
    expect(updatePostWithResourceBundleAtomically).not.toHaveBeenCalled();
  });

  it('invalidates the feed when follow-up metadata fails after the atomic post update commits', async () => {
    const { client } = createSupabaseMock({ bundle: null });
    const updatePostWithResourceBundleAtomically = vi.fn<
      NonNullable<PostUpdateDependencies['updatePostWithResourceBundleAtomically']>
    >(async () => ({
      postId: 'post-1',
      visibility: 'private' as const,
      bundleId: null,
      bundleStatus: null,
    }));
    const dependencies = {
      listSourceToolsCatalog: vi.fn(async () => sourceToolCatalog),
      getMarketplaceQualityErrorForPostBundle: vi.fn(async () => null),
      updatePostWithResourceBundleAtomically,
      replacePostSourceTools: vi.fn(async () => {
        throw new Error('source tool insert failed');
      }),
      replacePostMediaItems: vi.fn(async () => undefined),
      createPostMediaPreview: vi.fn(async () => null),
    } satisfies PostUpdateDependencies;

    const result = await updateOwnerPostForRoute({
      adminSupabase: client,
      ownerUserId: 'user-1',
      postId: 'post-1',
      body: {
        title: 'Updated before metadata failure',
        visibility: 'private',
        sourceTools: [{
          toolLabel: 'magicbooklet',
          toolSlug: 'magicbooklet',
        }],
      },
      dependencies,
    });

    expect(result).toEqual({
      ok: false,
      status: 500,
      body: {
        error: 'Failed to save source tool metadata.',
        field: undefined,
      },
    });
    expect(updatePostWithResourceBundleAtomically).toHaveBeenCalledTimes(1);
    expect(cacheMocks.invalidateShowcaseFeedCache).toHaveBeenCalledTimes(1);
  });

  it('maps unavailable profile verification to a server failure', async () => {
    const { client } = createSupabaseMock({ bundle: null });
    const dependencies = {
      listSourceToolsCatalog: vi.fn(async () => sourceToolCatalog),
      getMarketplaceQualityErrorForPostBundle: vi.fn(async () => (
        'Could not verify your creator profile right now. Try again.'
      )),
      updatePostWithResourceBundleAtomically: vi.fn(),
      replacePostSourceTools: vi.fn(async () => undefined),
      replacePostMediaItems: vi.fn(async () => undefined),
      createPostMediaPreview: vi.fn(async () => null),
    } satisfies PostUpdateDependencies;

    const result = await updateOwnerPostForRoute({
      adminSupabase: client,
      ownerUserId: 'user-1',
      postId: 'post-1',
      body: {
        title: 'Helpful launch proof',
        body: 'A public proof post with enough detail for visitors.',
        visibility: 'public',
      },
      dependencies,
    });

    expect(result).toEqual({
      ok: false,
      status: 500,
      body: { error: 'Could not verify your creator profile right now. Try again.' },
    });
    expect(dependencies.updatePostWithResourceBundleAtomically).not.toHaveBeenCalled();
  });

  // Create and publish already name the field and the way to fix it; an edit
  // that makes a post public sent the sentence alone, so a client had nothing
  // to offer but the text.
  it('answers an incomplete profile with the same repair action create and publish send', async () => {
    const { client } = createSupabaseMock({ bundle: null });
    const dependencies = {
      listSourceToolsCatalog: vi.fn(async () => sourceToolCatalog),
      getMarketplaceQualityErrorForPostBundle: vi.fn(async () => (
        'Complete your profile before publishing publicly: choose a custom handle and add your display name.'
      )),
      updatePostWithResourceBundleAtomically: vi.fn(),
      replacePostSourceTools: vi.fn(async () => undefined),
      replacePostMediaItems: vi.fn(async () => undefined),
      createPostMediaPreview: vi.fn(async () => null),
    } satisfies PostUpdateDependencies;

    const result = await updateOwnerPostForRoute({
      adminSupabase: client,
      ownerUserId: 'user-1',
      postId: 'post-1',
      body: {
        title: 'Helpful launch proof',
        body: 'A public proof post with enough detail for visitors.',
        visibility: 'public',
      },
      dependencies,
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
    expect(dependencies.updatePostWithResourceBundleAtomically).not.toHaveBeenCalled();
  });

  // replace_post_media deletes and re-inserts every row, so a save gives each
  // item a new id. A page that stays open after saving needs those ids, and to
  // know which new upload became which row, for its next save.
  it("answers a saved edit with the post's media rows as they now are, in order", async () => {
    const postMedia: Array<Record<string, unknown>> = [{
      id: 'media-a',
      media_key: 'proof-a',
      storage_path: 'posts/post-1/a.jpg',
      preview_storage_path: null,
      external_url: null,
      media_kind: 'image',
      content_type: 'image/jpeg',
      original_name: 'a.jpg',
      width: null,
      height: null,
      duration_seconds: null,
      sort_order: 0,
    }];
    const { client } = createSupabaseMock({
      bundle: null,
      postMedia,
      downloadedMedia: blobOfSize(1024, 'image/jpeg'),
      post: {
        id: 'post-1',
        user_id: 'user-1',
        generation_id: null,
        visibility: 'private',
        title: 'Proof post',
        description: null,
        prompt: null,
        body: null,
        category: 'image',
        post_format: 'media',
        source_tool: null,
        source_tool_slug: null,
        source_kind: 'external',
        archived_at: null,
        showcase_asset_path: 'posts/post-1/a.jpg',
        output_url: null,
        review_status: 'visible',
      },
    });
    const updatePostWithResourceBundleAtomically = vi.fn<
      NonNullable<PostUpdateDependencies['updatePostWithResourceBundleAtomically']>
    >(async ({ mediaItems }) => {
      // What the RPC leaves behind: the same keys and order, every row new.
      postMedia.splice(0, postMedia.length, ...(mediaItems ?? []).map((item) => ({
        id: `saved-${item.mediaKey}`,
        media_key: item.mediaKey,
        storage_path: item.storagePath,
        external_url: null,
        media_kind: item.mediaKind,
        content_type: item.contentType,
        original_name: item.originalName,
        width: null,
        height: null,
        duration_seconds: null,
        sort_order: item.sortOrder,
      })));
      return {
        postId: 'post-1',
        visibility: 'private' as const,
        bundleId: null,
        bundleStatus: null,
      };
    });

    const result = await updateOwnerPostForRoute({
      adminSupabase: client,
      ownerUserId: 'user-1',
      postId: 'post-1',
      body: {
        mediaItems: [
          {
            mediaKey: 'proof-new',
            storagePath: 'uploads/user-1/new.jpg',
            contentType: 'image/jpeg',
            originalName: 'new.jpg',
          },
          { existingId: 'media-a', mediaKey: 'proof-a' },
        ],
      },
      dependencies: {
        listSourceToolsCatalog: vi.fn(async () => sourceToolCatalog),
        getMarketplaceQualityErrorForPostBundle: vi.fn(async () => null),
        updatePostWithResourceBundleAtomically,
        replacePostSourceTools: vi.fn(async () => undefined),
        replacePostMediaItems: vi.fn(async () => undefined),
        createPostMediaPreview: vi.fn(async () => null),
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected the edit to save');
    expect(result.body.mediaItems).toEqual([
      { id: 'saved-proof-new', mediaKey: 'proof-new' },
      { id: 'saved-proof-a', mediaKey: 'proof-a' },
    ]);
  });

  it('preserves stable media keys when existing proof media is reordered', async () => {
    const postMedia = [
      {
        id: 'media-a',
        media_key: 'proof-a',
        storage_path: 'posts/post-1/a.jpg',
        display_storage_path: 'posts/post-1/a.display.webp',
        preview_storage_path: null,
        external_url: null,
        media_kind: 'image',
        content_type: 'image/jpeg',
        original_name: 'a.jpg',
        width: null,
        height: null,
        duration_seconds: null,
        sort_order: 0,
      },
      {
        id: 'media-b',
        media_key: 'proof-b',
        storage_path: 'posts/post-1/b.jpg',
        preview_storage_path: null,
        external_url: null,
        media_kind: 'image',
        content_type: 'image/jpeg',
        original_name: 'b.jpg',
        width: null,
        height: null,
        duration_seconds: null,
        sort_order: 1,
      },
    ];
    const { client } = createSupabaseMock({
      bundle: null,
      postMedia,
      post: {
        id: 'post-1',
        user_id: 'user-1',
        generation_id: null,
        visibility: 'private',
        title: 'Proof post',
        description: null,
        prompt: null,
        body: null,
        category: 'image',
        post_format: 'media',
        source_tool: null,
        source_tool_slug: null,
        source_kind: 'external',
        archived_at: null,
        showcase_asset_path: 'posts/post-1/a.jpg',
        output_url: null,
        review_status: 'visible',
      },
    });
    const updatePostWithResourceBundleAtomically = vi.fn<
      NonNullable<PostUpdateDependencies['updatePostWithResourceBundleAtomically']>
    >(async () => ({
      postId: 'post-1',
      visibility: 'private' as const,
      bundleId: 'bundle-1',
      bundleStatus: 'draft' as const,
    }));

    const result = await updateOwnerPostForRoute({
      adminSupabase: client,
      ownerUserId: 'user-1',
      postId: 'post-1',
      body: {
        mediaItems: [
          { existingId: 'media-b', mediaKey: 'proof-b' },
          { existingId: 'media-a', mediaKey: 'proof-a' },
        ],
        resourceBundle: {
          accessMode: 'free',
          resources: {
            items: [{
              id: 'prompt-a',
              scope: { kind: 'media', mediaKeys: ['proof-a'] },
              type: 'prompt',
              title: 'Proof A prompt',
              textContent: 'Use the prompt for proof A.',
            }],
          },
        },
      },
      dependencies: {
        listSourceToolsCatalog: vi.fn(async () => sourceToolCatalog),
        getMarketplaceQualityErrorForPostBundle: vi.fn(async () => null),
        updatePostWithResourceBundleAtomically,
        replacePostSourceTools: vi.fn(async () => undefined),
        replacePostMediaItems: vi.fn(async () => undefined),
        createPostMediaPreview: vi.fn(async () => null),
      },
    });

    expect(result.ok).toBe(true);
    expect(updatePostWithResourceBundleAtomically).toHaveBeenCalledWith(expect.objectContaining({
      mediaItems: [
        expect.objectContaining({ mediaKey: 'proof-b', sortOrder: 0 }),
        expect.objectContaining({ mediaKey: 'proof-a', sortOrder: 1, displayStoragePath: 'posts/post-1/a.display.webp' }),
      ],
    }));
  });

  it('rejects a new upload that reuses the stable key of removed proof media', async () => {
    const postMedia = [{
      id: 'media-old',
      media_key: 'proof-old',
      storage_path: 'posts/post-1/old.jpg',
      external_url: null,
      media_kind: 'image',
      content_type: 'image/jpeg',
      original_name: 'old.jpg',
      width: null,
      height: null,
      duration_seconds: null,
      sort_order: 0,
    }];
    const { client, copied } = createSupabaseMock({ bundle: null, postMedia });
    const updatePostWithResourceBundleAtomically = vi.fn();

    const result = await updateOwnerPostForRoute({
      adminSupabase: client,
      ownerUserId: 'user-1',
      postId: 'post-1',
      body: {
        mediaItems: [{
          mediaKey: 'proof-old',
          storagePath: 'uploads/user-1/replacement.jpg',
          contentType: 'image/jpeg',
          originalName: 'replacement.jpg',
        }],
      },
      dependencies: {
        listSourceToolsCatalog: vi.fn(async () => sourceToolCatalog),
        getMarketplaceQualityErrorForPostBundle: vi.fn(async () => null),
        updatePostWithResourceBundleAtomically,
        replacePostSourceTools: vi.fn(async () => undefined),
        replacePostMediaItems: vi.fn(async () => undefined),
        createPostMediaPreview: vi.fn(async () => null),
      },
    });

    expect(result).toEqual({
      ok: false,
      status: 400,
      // A key the post already holds is a client naming its media by stale
      // rows: the field tells it to read them back before saving again.
      body: { error: 'New uploads must use a new post media key.', field: 'mediaItems' },
    });
    expect(copied).toEqual([]);
    expect(updatePostWithResourceBundleAtomically).not.toHaveBeenCalled();
  });

  it('tells a client its media ids are stale when it names a row the post no longer has', async () => {
    const postMedia = [{
      id: 'media-reinserted',
      media_key: 'proof-a',
      storage_path: 'posts/post-1/a.jpg',
      external_url: null,
      media_kind: 'image',
      content_type: 'image/jpeg',
      original_name: 'a.jpg',
      width: null,
      height: null,
      duration_seconds: null,
      sort_order: 0,
    }];
    const { client, copied } = createSupabaseMock({ bundle: null, postMedia });
    const updatePostWithResourceBundleAtomically = vi.fn();

    const result = await updateOwnerPostForRoute({
      adminSupabase: client,
      ownerUserId: 'user-1',
      postId: 'post-1',
      // The id this row had before a save re-inserted it.
      body: { mediaItems: [{ existingId: 'media-before-the-save' }] },
      dependencies: {
        listSourceToolsCatalog: vi.fn(async () => sourceToolCatalog),
        getMarketplaceQualityErrorForPostBundle: vi.fn(async () => null),
        updatePostWithResourceBundleAtomically,
        replacePostSourceTools: vi.fn(async () => undefined),
        replacePostMediaItems: vi.fn(async () => undefined),
        createPostMediaPreview: vi.fn(async () => null),
      },
    });

    expect(result).toEqual({
      ok: false,
      status: 400,
      body: { error: 'An existing media item no longer belongs to this post.', field: 'mediaItems' },
    });
    expect(copied).toEqual([]);
    expect(updatePostWithResourceBundleAtomically).not.toHaveBeenCalled();
  });

  it('rolls back promoted storage when the atomic media commit is definitively rejected', async () => {
    const oldStoragePath = 'posts/post-1/old.jpg';
    const { client, copied, removals } = createSupabaseMock({
      bundle: null,
      stagedInfo: { size: 1024, contentType: 'video/mp4' },
      postMedia: [{
        id: 'media-old',
        media_key: 'proof-old',
        storage_path: oldStoragePath,
        external_url: null,
        media_kind: 'image',
        content_type: 'image/jpeg',
        original_name: 'old.jpg',
        width: null,
        height: null,
        duration_seconds: null,
        sort_order: 0,
      }],
    });
    const updatePostWithResourceBundleAtomically = vi.fn(async () => {
      throw new DefinitiveSupabaseMutationRejection(
        { code: '23514', message: 'replace_post_media rejected the write' },
        409,
      );
    });

    const result = await updateOwnerPostForRoute({
      adminSupabase: client,
      ownerUserId: 'user-1',
      postId: 'post-1',
      body: {
        title: 'This must roll back with media',
        mediaItems: [{
          mediaKey: 'proof-new',
          storagePath: 'uploads/user-1/replacement.mp4',
          contentType: 'video/mp4',
          originalName: 'replacement.mp4',
        }],
        resourceBundle: { accessMode: 'none' },
      },
      dependencies: {
        listSourceToolsCatalog: vi.fn(async () => sourceToolCatalog),
        getMarketplaceQualityErrorForPostBundle: vi.fn(async () => null),
        updatePostWithResourceBundleAtomically,
        replacePostSourceTools: vi.fn(async () => undefined),
        replacePostMediaItems: vi.fn(async () => undefined),
        createPostMediaPreview: vi.fn(async () => null),
      },
    });

    expect(result).toMatchObject({
      ok: false,
      status: 500,
      body: { error: 'Failed to update post.' },
    });
    expect(updatePostWithResourceBundleAtomically).toHaveBeenCalledWith(
      expect.objectContaining({
        patch: expect.objectContaining({ title: 'This must roll back with media' }),
        mediaItems: [expect.objectContaining({ mediaKey: 'proof-new' })],
      }),
    );
    expect(copied).toHaveLength(1);
    expect(removals).toContainEqual([copied[0].to]);
    expect(removals.flat()).not.toContain(oldStoragePath);
    expect(cacheMocks.invalidateShowcaseFeedCache).not.toHaveBeenCalled();
  });

  it('removes a dropped video item together with its preview and feed rendition', async () => {
    const { client, removals } = createSupabaseMock({
      bundle: null,
      stagedInfo: { size: 13 * 1024 * 1024, contentType: 'video/mp4' },
      postMedia: [{
        id: 'media-old',
        media_key: 'proof-old',
        storage_path: 'posts/post-1/a/clip.mp4',
        preview_storage_path: 'posts/post-1/a/clip.preview.webp',
        rendition_storage_path: 'posts/post-1/a/clip.feed.mp4',
        external_url: null,
        media_kind: 'video',
        content_type: 'video/mp4',
        original_name: 'clip.mp4',
        width: null,
        height: null,
        duration_seconds: null,
        sort_order: 0,
      }],
      post: {
        id: 'post-1',
        user_id: 'user-1',
        generation_id: null,
        visibility: 'private',
        title: 'Proof post',
        description: null,
        prompt: null,
        body: null,
        category: 'video',
        post_format: 'media',
        source_tool: null,
        source_tool_slug: null,
        source_kind: 'external',
        archived_at: null,
        showcase_asset_path: 'posts/post-1/a/clip.mp4',
        output_url: null,
        review_status: 'visible',
      },
    });

    const result = await updateOwnerPostForRoute({
      adminSupabase: client,
      ownerUserId: 'user-1',
      postId: 'post-1',
      body: {
        mediaItems: [{
          mediaKey: 'proof-new',
          storagePath: 'uploads/user-1/new.mp4',
          contentType: 'video/mp4',
          originalName: 'new.mp4',
        }],
        resourceBundle: { accessMode: 'none' },
      },
      dependencies: {
        listSourceToolsCatalog: vi.fn(async () => sourceToolCatalog),
        getMarketplaceQualityErrorForPostBundle: vi.fn(async () => null),
        updatePostWithResourceBundleAtomically: vi.fn(async () => ({
          postId: 'post-1',
          visibility: 'private' as const,
          bundleId: null,
          bundleStatus: null,
        })),
        replacePostSourceTools: vi.fn(async () => undefined),
        replacePostMediaItems: vi.fn(async () => undefined),
        createPostMediaPreview: vi.fn(async () => null),
      },
    });

    expect(result.ok).toBe(true);
    // The dropped item's feed rendition is its own public object: leaving it
    // behind keeps the exact URL the feed was serving fetchable forever.
    expect(removals).toContainEqual([
      'posts/post-1/a/clip.mp4',
      'posts/post-1/a/clip.preview.webp',
      'posts/post-1/a/clip.feed.mp4',
    ]);
  });

  it('never passes foreign or encoded post media paths to service-role removal', async () => {
    const unsafePaths = [
      'posts/post-2/private.mp4',
      'posts/post-1/%252e%252e/post-2/private.preview.webp',
      'posts%252fpost-1%252fprivate.feed.mp4',
      'posts\\post-1\\private.teaser.mp4',
    ];
    const { client, removals } = createSupabaseMock({
      bundle: null,
      stagedInfo: { size: 13 * 1024 * 1024, contentType: 'video/mp4' },
      postMedia: [{
        id: 'media-unsafe',
        media_key: 'proof-unsafe',
        storage_path: unsafePaths[0],
        preview_storage_path: unsafePaths[1],
        rendition_storage_path: unsafePaths[2],
        teaser_storage_path: unsafePaths[3],
        external_url: null,
        media_kind: 'video',
        content_type: 'video/mp4',
        original_name: 'private.mp4',
        width: null,
        height: null,
        duration_seconds: null,
        sort_order: 0,
      }],
    });

    const result = await updateOwnerPostForRoute({
      adminSupabase: client,
      ownerUserId: 'user-1',
      postId: 'post-1',
      body: {
        mediaItems: [{
          mediaKey: 'proof-new',
          storagePath: 'uploads/user-1/new.mp4',
          contentType: 'video/mp4',
          originalName: 'new.mp4',
        }],
        resourceBundle: { accessMode: 'none' },
      },
      dependencies: {
        listSourceToolsCatalog: vi.fn(async () => sourceToolCatalog),
        getMarketplaceQualityErrorForPostBundle: vi.fn(async () => null),
        updatePostWithResourceBundleAtomically: vi.fn(async () => ({
          postId: 'post-1',
          visibility: 'private' as const,
          bundleId: null,
          bundleStatus: null,
        })),
        replacePostSourceTools: vi.fn(async () => undefined),
        replacePostMediaItems: vi.fn(async () => undefined),
        createPostMediaPreview: vi.fn(async () => null),
      },
    });

    expect(result.ok).toBe(true);
    for (const unsafePath of unsafePaths) {
      expect(removals.flat()).not.toContain(unsafePath);
    }
  });

  it('keeps original, preview, and rendition objects pinned by a purchased revision', async () => {
    const purchasedPaths = {
      storage_path: 'posts/post-1/a/clip.mp4',
      preview_storage_path: 'posts/post-1/a/clip.preview.webp',
      rendition_storage_path: 'posts/post-1/a/clip.feed.mp4',
    };
    const { client, removals } = createSupabaseMock({
      bundle: null,
      stagedInfo: { size: 13 * 1024 * 1024, contentType: 'video/mp4' },
      purchasedMediaRows: [{ ...purchasedPaths, sort_order: 0 }],
      postMedia: [{
        id: 'media-old',
        media_key: 'proof-old',
        ...purchasedPaths,
        external_url: null,
        media_kind: 'video',
        content_type: 'video/mp4',
        original_name: 'clip.mp4',
        width: null,
        height: null,
        duration_seconds: null,
        sort_order: 0,
      }],
      post: {
        id: 'post-1',
        user_id: 'user-1',
        generation_id: null,
        visibility: 'private',
        title: 'Proof post',
        description: null,
        prompt: null,
        body: null,
        category: 'video',
        post_format: 'media',
        source_tool: null,
        source_tool_slug: null,
        source_kind: 'external',
        archived_at: null,
        showcase_asset_path: purchasedPaths.storage_path,
        output_url: null,
        review_status: 'visible',
      },
    });

    const result = await updateOwnerPostForRoute({
      adminSupabase: client,
      ownerUserId: 'user-1',
      postId: 'post-1',
      body: {
        mediaItems: [{
          mediaKey: 'proof-new',
          storagePath: 'uploads/user-1/new.mp4',
          contentType: 'video/mp4',
          originalName: 'new.mp4',
        }],
        resourceBundle: { accessMode: 'none' },
      },
      dependencies: {
        listSourceToolsCatalog: vi.fn(async () => sourceToolCatalog),
        getMarketplaceQualityErrorForPostBundle: vi.fn(async () => null),
        updatePostWithResourceBundleAtomically: vi.fn(async () => ({
          postId: 'post-1',
          visibility: 'private' as const,
          bundleId: null,
          bundleStatus: null,
        })),
        replacePostSourceTools: vi.fn(async () => undefined),
        replacePostMediaItems: vi.fn(async () => undefined),
        createPostMediaPreview: vi.fn(async () => null),
      },
    });

    expect(result.ok).toBe(true);
    expect(removals.flat()).not.toEqual(expect.arrayContaining(Object.values(purchasedPaths)));
  });

  it('keeps order-quoted proof objects while a cash checkout is still pending', async () => {
    const quotedPaths = {
      storage_path: 'posts/post-1/a/quoted.mp4',
      preview_storage_path: 'posts/post-1/a/quoted.preview.webp',
      rendition_storage_path: 'posts/post-1/a/quoted.feed.mp4',
    };
    const { client, removals } = createSupabaseMock({
      bundle: { id: 'bundle-1', access_mode: 'paid', status: 'draft' },
      pendingOrderRows: [{
        quoted_media: [{ ...quotedPaths, media_kind: 'video', sort_order: 0 }],
      }],
      postMedia: [{
        id: 'media-old',
        media_key: 'proof-old',
        ...quotedPaths,
        external_url: null,
        media_kind: 'video',
        content_type: 'video/mp4',
        original_name: 'quoted.mp4',
        width: null,
        height: null,
        duration_seconds: null,
        sort_order: 0,
      }],
      post: {
        id: 'post-1',
        user_id: 'user-1',
        generation_id: null,
        visibility: 'private',
        title: 'Proof post',
        description: null,
        prompt: null,
        body: null,
        category: 'video',
        post_format: 'media',
        source_tool: null,
        source_tool_slug: null,
        source_kind: 'external',
        archived_at: null,
        showcase_asset_path: quotedPaths.storage_path,
        output_url: null,
        review_status: 'visible',
      },
    });

    const result = await updateOwnerPostForRoute({
      adminSupabase: client,
      ownerUserId: 'user-1',
      postId: 'post-1',
      body: {
        mediaItems: [{
          mediaKey: 'proof-new',
          storagePath: 'uploads/user-1/new.mp4',
          contentType: 'video/mp4',
          originalName: 'new.mp4',
        }],
        resourceBundle: { accessMode: 'none' },
      },
      dependencies: {
        listSourceToolsCatalog: vi.fn(async () => sourceToolCatalog),
        getMarketplaceQualityErrorForPostBundle: vi.fn(async () => null),
        updatePostWithResourceBundleAtomically: vi.fn(async () => ({
          postId: 'post-1',
          visibility: 'private' as const,
          bundleId: null,
          bundleStatus: null,
        })),
        replacePostSourceTools: vi.fn(async () => undefined),
        replacePostMediaItems: vi.fn(async () => undefined),
        createPostMediaPreview: vi.fn(async () => null),
      },
    });

    expect(result.ok).toBe(true);
    expect(removals.flat()).not.toEqual(expect.arrayContaining(Object.values(quotedPaths)));
  });

  it('rejects edited media larger than its kind allows before it reaches the public bucket', async () => {
    // The signed upload could only check a client-declared size, and the
    // uploads bucket's own ceiling is 250 MB for every kind -- so without this
    // check an oversized image reaches showcase_media through edit even though
    // the create path would have rejected the same bytes.
    const { client, uploaded, copied, downloads } = createSupabaseMock({
      bundle: null,
      stagedInfo: { size: 26 * 1024 * 1024, contentType: 'image/jpeg' },
      downloadedMedia: blobOfSize(26 * 1024 * 1024, 'image/jpeg'),
      post: {
        id: 'post-1',
        user_id: 'user-1',
        generation_id: null,
        visibility: 'private',
        title: 'Proof post',
        description: null,
        prompt: null,
        body: null,
        category: 'image',
        post_format: 'media',
        source_tool: null,
        source_tool_slug: null,
        source_kind: 'external',
        archived_at: null,
        showcase_asset_path: 'posts/post-1/a.jpg',
        output_url: null,
        review_status: 'visible',
      },
    });

    const result = await updateOwnerPostForRoute({
      adminSupabase: client,
      ownerUserId: 'user-1',
      postId: 'post-1',
      body: {
        mediaItems: [{
          mediaKey: 'proof-a',
          storagePath: 'uploads/user-1/oversized.jpg',
          contentType: 'image/jpeg',
          originalName: 'oversized.jpg',
        }],
        resourceBundle: { accessMode: 'none' },
      },
      dependencies: {
        listSourceToolsCatalog: vi.fn(async () => sourceToolCatalog),
        getMarketplaceQualityErrorForPostBundle: vi.fn(async () => null),
        updatePostWithResourceBundleAtomically: vi.fn(async () => ({
          postId: 'post-1',
          visibility: 'private' as const,
          bundleId: null,
          bundleStatus: null,
        })),
        replacePostSourceTools: vi.fn(async () => undefined),
        replacePostMediaItems: vi.fn(async () => undefined),
        createPostMediaPreview: vi.fn(async () => null),
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected the oversized edit to be rejected');
    expect(result.status).toBe(400);
    expect(result.body.error).toContain('25 MB');
    expect(uploaded).toEqual([]);
    // Rejected from storage metadata, so the oversized bytes are never read and
    // never promoted into the public bucket.
    expect(copied).toEqual([]);
    expect(downloads).toEqual([]);
  });

  it('rejects an edit whose new video reports a duration over the ceiling', async () => {
    const { client, copied } = createSupabaseMock({
      bundle: null,
      stagedInfo: { size: 13 * 1024 * 1024, contentType: 'video/mp4' },
      downloadedMedia: blobOfSize(13 * 1024 * 1024, 'video/mp4'),
      post: {
        id: 'post-1',
        user_id: 'user-1',
        generation_id: null,
        visibility: 'private',
        title: 'Proof post',
        description: null,
        prompt: null,
        body: null,
        category: 'video',
        post_format: 'media',
        source_tool: null,
        source_tool_slug: null,
        source_kind: 'external',
        archived_at: null,
        showcase_asset_path: 'posts/post-1/a.mp4',
        output_url: null,
        review_status: 'visible',
      },
    });

    const result = await updateOwnerPostForRoute({
      adminSupabase: client,
      ownerUserId: 'user-1',
      postId: 'post-1',
      body: {
        mediaItems: [{
          mediaKey: 'proof-a',
          storagePath: 'uploads/user-1/marathon.mp4',
          contentType: 'video/mp4',
          originalName: 'marathon.mp4',
          durationSeconds: 601,
        }],
        resourceBundle: { accessMode: 'none' },
      },
      dependencies: {
        listSourceToolsCatalog: vi.fn(async () => sourceToolCatalog),
        getMarketplaceQualityErrorForPostBundle: vi.fn(async () => null),
        updatePostWithResourceBundleAtomically: vi.fn(async () => ({
          postId: 'post-1',
          visibility: 'private' as const,
          bundleId: null,
          bundleStatus: null,
        })),
        replacePostSourceTools: vi.fn(async () => undefined),
        replacePostMediaItems: vi.fn(async () => undefined),
        createPostMediaPreview: vi.fn(async () => null),
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected the over-ceiling edit to be rejected');
    expect(result.status).toBe(400);
    expect(result.body.error).toBe('Videos must be 10 minutes or shorter.');
    // Advisory check runs at parse time, before any storage promotion.
    expect(copied).toEqual([]);
  });

  it('copies edited video into private storage without reading the bytes', async () => {
    const { client, copied, downloads, uploaded } = createSupabaseMock({
      bundle: null,
      stagedInfo: { size: 13 * 1024 * 1024, contentType: 'video/mp4' },
      post: {
        id: 'post-1',
        user_id: 'user-1',
        generation_id: null,
        visibility: 'private',
        title: 'Proof post',
        description: null,
        prompt: null,
        body: null,
        category: 'video',
        post_format: 'media',
        source_tool: null,
        source_tool_slug: null,
        source_kind: 'external',
        archived_at: null,
        showcase_asset_path: 'posts/post-1/a.mp4',
        output_url: null,
        review_status: 'visible',
      },
    });
    const updatePostWithResourceBundleAtomically = vi.fn<
      NonNullable<PostUpdateDependencies['updatePostWithResourceBundleAtomically']>
    >(async () => ({
      postId: 'post-1',
      visibility: 'private' as const,
      bundleId: null,
      bundleStatus: null,
    }));

    const result = await updateOwnerPostForRoute({
      adminSupabase: client,
      ownerUserId: 'user-1',
      postId: 'post-1',
      body: {
        mediaItems: [{
          mediaKey: 'proof-a',
          storagePath: 'uploads/user-1/clip.mp4',
          contentType: 'video/mp4',
          originalName: 'clip.mp4',
        }],
        resourceBundle: { accessMode: 'none' },
      },
      dependencies: {
        listSourceToolsCatalog: vi.fn(async () => sourceToolCatalog),
        getMarketplaceQualityErrorForPostBundle: vi.fn(async () => null),
        updatePostWithResourceBundleAtomically,
        replacePostSourceTools: vi.fn(async () => undefined),
        replacePostMediaItems: vi.fn(),
        createPostMediaPreview: vi.fn(async () => null),
      },
    });

    expect(result.ok).toBe(true);
    expect(copied).toEqual([{
      from: 'user-1/clip.mp4',
      to: expect.stringMatching(/^private-posts\/post-1\/.+\/clip\.mp4$/),
    }]);
    // No bytes enter the function, and nothing is re-uploaded.
    expect(downloads).toEqual([]);
    expect(uploaded).toEqual([]);

    // Omitted, not marked failed: replace_post_media defaults these to pending
    // with zero attempts, which is what the repair sweep acts on.
    const [{ mediaItems }] = updatePostWithResourceBundleAtomically.mock.calls[0];
    if (!mediaItems) throw new Error('Expected media to be committed atomically');
    expect(mediaItems[0]).not.toHaveProperty('previewStatus');
    expect(mediaItems[0]).not.toHaveProperty('renditionStatus');
    expect(mediaItems[0]).toMatchObject({ mediaKind: 'video', contentType: 'video/mp4' });
  });

  it('previews an edited image inline and reads it exactly once', async () => {
    const { client, copied, downloads } = createSupabaseMock({
      bundle: null,
      stagedInfo: { size: 2 * 1024 * 1024, contentType: 'image/jpeg' },
      downloadedMedia: blobOfSize(2 * 1024 * 1024, 'image/jpeg'),
      post: {
        id: 'post-1',
        user_id: 'user-1',
        generation_id: null,
        visibility: 'private',
        title: 'Proof post',
        description: null,
        prompt: null,
        body: null,
        category: 'image',
        post_format: 'media',
        source_tool: null,
        source_tool_slug: null,
        source_kind: 'external',
        archived_at: null,
        showcase_asset_path: 'posts/post-1/a.jpg',
        output_url: null,
        review_status: 'visible',
      },
    });
    const updatePostWithResourceBundleAtomically = vi.fn<
      NonNullable<PostUpdateDependencies['updatePostWithResourceBundleAtomically']>
    >(async () => ({
      postId: 'post-1',
      visibility: 'private' as const,
      bundleId: null,
      bundleStatus: null,
    }));

    const result = await updateOwnerPostForRoute({
      adminSupabase: client,
      ownerUserId: 'user-1',
      postId: 'post-1',
      body: {
        mediaItems: [{
          mediaKey: 'proof-a',
          storagePath: 'uploads/user-1/shot.jpg',
          contentType: 'image/jpeg',
          originalName: 'shot.jpg',
        }],
        resourceBundle: { accessMode: 'none' },
      },
      dependencies: {
        listSourceToolsCatalog: vi.fn(async () => sourceToolCatalog),
        getMarketplaceQualityErrorForPostBundle: vi.fn(async () => null),
        updatePostWithResourceBundleAtomically,
        replacePostSourceTools: vi.fn(async () => undefined),
        replacePostMediaItems: vi.fn(),
        createPostMediaPreview: vi.fn(async () => ({
          previewStoragePath: 'posts/post-1/x/shot.preview.webp',
          previewThumbhash: 'hash',
          previewStatus: 'ready' as const,
          width: 800,
          height: 600,
          displayStoragePath: null,
        })),
      },
    });

    expect(result.ok).toBe(true);
    expect(copied).toHaveLength(1);
    // An image is small enough to read once, for its thumbhash placeholder.
    expect(downloads).toEqual(['user-1/shot.jpg']);

    const [{ mediaItems }] = updatePostWithResourceBundleAtomically.mock.calls[0];
    if (!mediaItems) throw new Error('Expected media to be committed atomically');
    expect(mediaItems[0]).toMatchObject({
      previewStatus: 'ready',
      previewThumbhash: 'hash',
      width: 800,
      height: 600,
    });
  });

  describe('title and body length', () => {
    const grandfatheredTitle = 'g'.repeat(TITLE_MAX_LENGTH + 9);

    function buildDependencies() {
      return {
        listSourceToolsCatalog: vi.fn(async () => sourceToolCatalog),
        getMarketplaceQualityErrorForPostBundle: vi.fn(async () => null),
        updatePostWithResourceBundleAtomically: vi.fn(async () => ({
          postId: 'post-1',
          visibility: 'private' as const,
          bundleId: null,
          bundleStatus: null,
        })),
        replacePostSourceTools: vi.fn(async () => undefined),
        replacePostMediaItems: vi.fn(async () => undefined),
        createPostMediaPreview: vi.fn(async () => null),
      } satisfies PostUpdateDependencies;
    }

    function postWithTitle(title: string) {
      return {
        id: 'post-1',
        user_id: 'user-1',
        generation_id: null,
        visibility: 'private',
        title,
        description: null,
        prompt: null,
        body: 'A draft post with an unlock package.',
        category: 'text',
        post_format: 'text',
        source_tool: null,
        source_tool_slug: null,
        source_kind: 'manual',
        archived_at: null,
        showcase_asset_path: null,
        output_url: null,
        review_status: 'visible',
      };
    }

    it('rejects an edit that sets a title longer than the limit', async () => {
      const { client } = createSupabaseMock({ post: postWithTitle('Short enough') });
      const dependencies = buildDependencies();

      const result = await updateOwnerPostForRoute({
        adminSupabase: client,
        ownerUserId: 'user-1',
        postId: 'post-1',
        body: {
          title: 'x'.repeat(TITLE_MAX_LENGTH + 1),
          body: 'A draft post with an unlock package.',
          visibility: 'private',
          resourceBundle: { accessMode: 'none' },
        },
        dependencies,
      });

      expect(result).toMatchObject({
        ok: false,
        status: 400,
        body: { error: `Titles are limited to ${TITLE_MAX_LENGTH} characters.`, field: 'title' },
      });
      expect(dependencies.updatePostWithResourceBundleAtomically).not.toHaveBeenCalled();
    });

    // Grandfathering: composers PATCH the whole draft, so an over-limit title
    // written before the cap existed is resent verbatim on every edit. It must
    // not block its author from changing some other field.
    it('still saves a post whose pre-existing title exceeds the limit when the title is unchanged', async () => {
      const { client } = createSupabaseMock({ post: postWithTitle(grandfatheredTitle) });
      const dependencies = buildDependencies();

      const result = await updateOwnerPostForRoute({
        adminSupabase: client,
        ownerUserId: 'user-1',
        postId: 'post-1',
        body: {
          title: grandfatheredTitle,
          description: 'Fixing a typo in the description only.',
          body: 'A draft post with an unlock package.',
          visibility: 'private',
          resourceBundle: { accessMode: 'none' },
        },
        dependencies,
      });

      expect(result.ok).toBe(true);
      expect(dependencies.updatePostWithResourceBundleAtomically).toHaveBeenCalled();
    });

    // The mobile viewer flips visibility with a sparse patch that omits `title`
    // entirely (ugc-mobile/app/viewer.tsx). A grandfathered post must stay
    // toggleable from there.
    it('allows a sparse patch that never mentions the title of a grandfathered post', async () => {
      const { client } = createSupabaseMock({ post: postWithTitle(grandfatheredTitle) });
      const dependencies = buildDependencies();

      const result = await updateOwnerPostForRoute({
        adminSupabase: client,
        ownerUserId: 'user-1',
        postId: 'post-1',
        body: { visibility: 'private' },
        dependencies,
      });

      expect(result.ok).toBe(true);
      expect(dependencies.updatePostWithResourceBundleAtomically).toHaveBeenCalled();
    });

    it('rejects a grandfathered title once the author edits it into a different over-limit value', async () => {
      const { client } = createSupabaseMock({ post: postWithTitle(grandfatheredTitle) });
      const dependencies = buildDependencies();

      const result = await updateOwnerPostForRoute({
        adminSupabase: client,
        ownerUserId: 'user-1',
        postId: 'post-1',
        body: {
          title: `${grandfatheredTitle} and then some`,
          body: 'A draft post with an unlock package.',
          visibility: 'private',
          resourceBundle: { accessMode: 'none' },
        },
        dependencies,
      });

      expect(result).toMatchObject({ ok: false, status: 400, body: { field: 'title' } });
      expect(dependencies.updatePostWithResourceBundleAtomically).not.toHaveBeenCalled();
    });

    it('rejects an edit that sets a post text longer than the limit', async () => {
      const { client } = createSupabaseMock({ post: postWithTitle('Short enough') });
      const dependencies = buildDependencies();

      const result = await updateOwnerPostForRoute({
        adminSupabase: client,
        ownerUserId: 'user-1',
        postId: 'post-1',
        body: {
          title: 'Short enough',
          body: 'x'.repeat(BODY_MAX_LENGTH + 1),
          visibility: 'private',
          resourceBundle: { accessMode: 'none' },
        },
        dependencies,
      });

      expect(result).toMatchObject({
        ok: false,
        status: 400,
        body: { error: `Post text is limited to ${BODY_MAX_LENGTH} characters.`, field: 'body' },
      });
      expect(dependencies.updatePostWithResourceBundleAtomically).not.toHaveBeenCalled();
    });

    it('accepts a post text of exactly the limit', async () => {
      const { client } = createSupabaseMock({ post: postWithTitle('Short enough') });
      const dependencies = buildDependencies();

      const result = await updateOwnerPostForRoute({
        adminSupabase: client,
        ownerUserId: 'user-1',
        postId: 'post-1',
        body: {
          title: 'Short enough',
          body: 'x'.repeat(BODY_MAX_LENGTH),
          visibility: 'private',
          resourceBundle: { accessMode: 'none' },
        },
        dependencies,
      });

      expect(result.ok).toBe(true);
    });

    // Edits never checked the text before, so a longer one may be stored; the
    // whole-draft PATCH resends it and must not block a change elsewhere.
    it('still saves a post whose stored text exceeds the limit when the text is unchanged', async () => {
      const longStoredText = 'b'.repeat(BODY_MAX_LENGTH + 40);
      const { client } = createSupabaseMock({
        post: { ...postWithTitle('Short enough'), body: longStoredText },
      });
      const dependencies = buildDependencies();

      const result = await updateOwnerPostForRoute({
        adminSupabase: client,
        ownerUserId: 'user-1',
        postId: 'post-1',
        body: {
          title: 'Short enough, now retitled',
          body: longStoredText,
          visibility: 'private',
          resourceBundle: { accessMode: 'none' },
        },
        dependencies,
      });

      expect(result.ok).toBe(true);
      expect(dependencies.updatePostWithResourceBundleAtomically).toHaveBeenCalled();
    });
  });

  // Limits the clients enforce, held on the server too. As with titles, a value
  // stored before them comes back unchanged in every whole-draft save and must
  // never block one.
  describe('description and recipe copy length', () => {
    function buildDependencies() {
      return {
        listSourceToolsCatalog: vi.fn(async () => sourceToolCatalog),
        getMarketplaceQualityErrorForPostBundle: vi.fn(async () => null),
        updatePostWithResourceBundleAtomically: vi.fn(async () => ({
          postId: 'post-1',
          visibility: 'private' as const,
          bundleId: 'bundle-1',
          bundleStatus: 'draft' as const,
        })),
        replacePostSourceTools: vi.fn(async () => undefined),
        replacePostMediaItems: vi.fn(async () => undefined),
        createPostMediaPreview: vi.fn(async () => null),
      } satisfies PostUpdateDependencies;
    }

    function postWithDescription(description: string | null) {
      return {
        id: 'post-1',
        user_id: 'user-1',
        generation_id: null,
        visibility: 'private',
        title: 'Lighting notes',
        description,
        prompt: null,
        body: 'A draft post with an unlock package.',
        category: 'text',
        post_format: 'text',
        source_tool: null,
        source_tool_slug: null,
        source_kind: 'manual',
        archived_at: null,
        showcase_asset_path: null,
        output_url: null,
        review_status: 'visible',
      };
    }

    it('rejects an edit that sets a description longer than the limit', async () => {
      const { client } = createSupabaseMock({ post: postWithDescription(null), bundle: null });
      const dependencies = buildDependencies();

      const result = await updateOwnerPostForRoute({
        adminSupabase: client,
        ownerUserId: 'user-1',
        postId: 'post-1',
        body: { description: 'd'.repeat(1001), visibility: 'private' },
        dependencies,
      });

      expect(result).toEqual({
        ok: false,
        status: 400,
        body: { error: 'Descriptions are limited to 1000 characters.', field: 'description' },
      });
      expect(dependencies.updatePostWithResourceBundleAtomically).not.toHaveBeenCalled();
    });

    it('still saves a post whose stored description exceeds the limit when it comes back unchanged', async () => {
      const longStoredDescription = 'd'.repeat(1040);
      const { client } = createSupabaseMock({ post: postWithDescription(longStoredDescription), bundle: null });
      const dependencies = buildDependencies();

      const result = await updateOwnerPostForRoute({
        adminSupabase: client,
        ownerUserId: 'user-1',
        postId: 'post-1',
        body: { title: 'Lighting notes, retitled', description: longStoredDescription, visibility: 'private' },
        dependencies,
      });

      expect(result.ok).toBe(true);
      expect(dependencies.updatePostWithResourceBundleAtomically).toHaveBeenCalled();
    });

    // An older row may keep the whitespace a submitted value is trimmed of.
    it.each([
      ['a save that leaves the description out', {}],
      ['a save that sends it back trimmed', { description: 'd'.repeat(1040) }],
    ])('still saves a stored over-limit description with surrounding whitespace on %s', async (_label, sent) => {
      const { client } = createSupabaseMock({ post: postWithDescription(` ${'d'.repeat(1040)}\n`), bundle: null });
      const dependencies = buildDependencies();

      const result = await updateOwnerPostForRoute({
        adminSupabase: client,
        ownerUserId: 'user-1',
        postId: 'post-1',
        body: { title: 'Lighting notes, retitled', visibility: 'private', ...sent },
        dependencies,
      });

      expect(result.ok).toBe(true);
    });

    it.each([
      ['public summary', composerRecipe({ summary: 's'.repeat(181) }), 'resourceSummary', 'Public summaries are limited to 180 characters.'],
      ['package preview', composerRecipe({ previewText: 'p'.repeat(181) }), 'resourcePreview', 'Package previews are limited to 180 characters.'],
      ["card's unlocked description", composerRecipe({ cardDescription: 'u'.repeat(121) }), 'resourceCards', 'Unlocked descriptions are limited to 120 characters.'],
    ] as const)('rejects a recipe whose %s is longer than the composers allow', async (_label, resourceBundle, field, error) => {
      const { client } = createSupabaseMock({ bundle: storedRecipeRow(composerRecipe()) });
      const dependencies = buildDependencies();

      const result = await updateOwnerPostForRoute({
        adminSupabase: client,
        ownerUserId: 'user-1',
        postId: 'post-1',
        body: { visibility: 'private', resourceBundle },
        dependencies,
      });

      expect(result).toEqual({ ok: false, status: 400, body: { error, field } });
      expect(dependencies.updatePostWithResourceBundleAtomically).not.toHaveBeenCalled();
    });

    it('still saves a recipe whose stored copy exceeds those limits when it comes back unchanged', async () => {
      const storedRecipe = composerRecipe({
        summary: 's'.repeat(200),
        previewText: 'p'.repeat(200),
        cardDescription: 'u'.repeat(150),
      });
      const { client } = createSupabaseMock({ bundle: storedRecipeRow(storedRecipe) });
      const dependencies = buildDependencies();

      const result = await updateOwnerPostForRoute({
        adminSupabase: client,
        ownerUserId: 'user-1',
        postId: 'post-1',
        body: {
          visibility: 'private',
          resourceBundle: { ...storedRecipe, resources: { ...storedRecipe.resources, allowRemix: true } },
        },
        dependencies,
      });

      expect(result.ok).toBe(true);
      expect(dependencies.updatePostWithResourceBundleAtomically).toHaveBeenCalled();
    });

    // A composer whose summary field is blank sends the preview in its place,
    // so a stored preview can come back as the summary without anyone typing.
    it('still saves a stored preview that comes back as the summary', async () => {
      const longStoredPreview = 'p'.repeat(200);
      const { client } = createSupabaseMock({
        bundle: storedRecipeRow(composerRecipe({ summary: '', previewText: longStoredPreview })),
      });
      const dependencies = buildDependencies();

      const result = await updateOwnerPostForRoute({
        adminSupabase: client,
        ownerUserId: 'user-1',
        postId: 'post-1',
        body: {
          visibility: 'private',
          resourceBundle: composerRecipe({ summary: longStoredPreview, previewText: longStoredPreview }),
        },
        dependencies,
      });

      expect(result.ok).toBe(true);
    });

    it('rejects a stored over-limit value once it is changed into a different over-limit one', async () => {
      const { client } = createSupabaseMock({
        bundle: storedRecipeRow(composerRecipe({ cardDescription: 'u'.repeat(150) })),
      });
      const dependencies = buildDependencies();

      const result = await updateOwnerPostForRoute({
        adminSupabase: client,
        ownerUserId: 'user-1',
        postId: 'post-1',
        body: {
          visibility: 'private',
          resourceBundle: composerRecipe({ cardDescription: 'v'.repeat(150) }),
        },
        dependencies,
      });

      expect(result).toMatchObject({ ok: false, status: 400, body: { field: 'resourceCards' } });
      expect(dependencies.updatePostWithResourceBundleAtomically).not.toHaveBeenCalled();
    });
  });
});

describe('getCanonicalPostMediaStoragePath', () => {
  it('returns only a canonical object path under the exact post scope', () => {
    expect(getCanonicalPostMediaStoragePath(
      'posts/post-1/assets/clip.mp4',
      'post-1',
    )).toBe('posts/post-1/assets/clip.mp4');

    for (const unsafePath of [
      'posts/post-2/assets/clip.mp4',
      'posts/post-1/%252e%252e/post-2/clip.mp4',
      'posts%252fpost-1%252fassets%252fclip.mp4',
      'posts\\post-1\\assets\\clip.mp4',
      'posts/post-1//clip.mp4',
    ]) {
      expect(getCanonicalPostMediaStoragePath(unsafePath, 'post-1')).toBeNull();
    }
  });
});

// A recipe keeps the creation's prompt private. Both composers swap a title cut
// from the prompt for the kind title when a recipe goes on; an edit holds the
// same rule for what an older app sends, and for a title stored before a
// recipe was added.
describe('a title cut from the prompt of a post with a recipe', () => {
  const prompt = 'A product still lit like a window display, soft morning light, 85mm';
  const fromPrompt = 'Product still lit like a window display';
  const creationPost = (title: string) => ({
    id: 'post-1',
    user_id: 'user-1',
    generation_id: 'generation-1',
    visibility: 'private',
    title,
    description: null,
    prompt: null,
    body: null,
    category: 'image',
    post_format: 'media',
    source_tool: 'magicbooklet',
    source_tool_slug: 'magicbooklet',
    source_kind: 'magicbooklet',
    archived_at: null,
    showcase_asset_path: null,
    output_url: 'generated_images/user-1/example.jpg',
    review_status: 'visible',
  });
  const generation = {
    id: 'generation-1',
    user_id: 'user-1',
    model: 'nano-banana-2',
    category: 'image',
    creation_mode: null,
    prompt,
    output_url: 'generated_images/user-1/example.jpg',
    showcase_asset_path: null,
  };

  function createDependencies() {
    return {
      listSourceToolsCatalog: vi.fn(async () => sourceToolCatalog),
      getMarketplaceQualityErrorForPostBundle: vi.fn(async () => null),
      updatePostWithResourceBundleAtomically: vi.fn(async ({ patch }: { patch: Record<string, unknown> }) => ({
        postId: 'post-1',
        visibility: (patch.visibility ?? 'private') as 'public' | 'private',
        bundleId: 'bundle-1',
        bundleStatus: 'draft' as const,
      })),
      replacePostSourceTools: vi.fn(async () => undefined),
      replacePostMediaItems: vi.fn(async () => undefined),
      createPostMediaPreview: vi.fn(async () => null),
      createGenerationShowcaseDerivative: vi.fn(async () => 'showcase/generation-1/example.abc123.jpg'),
      ensureGenerationPostCoverMedia: vi.fn(async () => ({ outcome: 'created' as const, error: null })),
      removeGenerationShowcaseDerivative: vi.fn(async () => ({ removed: true, removedPaths: [], removedMediaRows: 0, error: null })),
      ensureDurableGenerationMedia: vi.fn(async () => ({ outputUrl: 'generated_images/user-1/example.jpg', createdLocation: null })),
    } satisfies PostUpdateDependencies;
  }

  async function save(postTitle: string, bundle: Record<string, unknown> | null, body: Record<string, unknown>) {
    const mock = createSupabaseMock({ post: creationPost(postTitle), bundle, generation });
    const dependencies = createDependencies();
    const result = await updateOwnerPostForRoute({
      adminSupabase: mock.client,
      ownerUserId: 'user-1',
      postId: 'post-1',
      body,
      dependencies,
    });
    return { result, dependencies, generationUpdates: mock.generationUpdates };
  }

  it('stores it as the kind title when a save sends it with a recipe, on the post and the creation', async () => {
    const { result, dependencies, generationUpdates } = await save('Window still', null, {
      title: fromPrompt,
      visibility: 'private',
      resourceBundle: composerRecipe(),
    });

    expect(result).toMatchObject({ ok: true });
    expect(dependencies.updatePostWithResourceBundleAtomically).toHaveBeenCalledWith(expect.objectContaining({
      patch: expect.objectContaining({ title: 'Image recipe' }),
    }));
    expect(generationUpdates).toContainEqual(expect.objectContaining({ title: 'Image recipe' }));
  });

  it('stores a stored one as the kind title when the post goes public with its stored recipe', async () => {
    const { result, dependencies, generationUpdates } = await save(fromPrompt, storedRecipeRow(composerRecipe()), { visibility: 'public' });

    expect(result).toMatchObject({ ok: true });
    expect(dependencies.updatePostWithResourceBundleAtomically).toHaveBeenCalledWith(expect.objectContaining({
      patch: expect.objectContaining({ title: 'Image recipe' }),
    }));
    // The save sent no title, and the creation still follows the post's.
    expect(generationUpdates).toContainEqual(expect.objectContaining({ title: 'Image recipe' }));
  });

  // The composers hold the same rule, so a save is not refused because the
  // creation's prompt could not be read; the title goes as it was given.
  it('keeps the title as given, and saves, when the creation cannot be read', async () => {
    const mock = createSupabaseMock({ post: creationPost('Window still'), bundle: null, generation });
    const dependencies = {
      ...createDependencies(),
      loadGenerationTitleSource: vi.fn(async () => {
        throw new Error('connection reset');
      }),
    };

    const result = await updateOwnerPostForRoute({
      adminSupabase: mock.client,
      ownerUserId: 'user-1',
      postId: 'post-1',
      body: { title: fromPrompt, resourceBundle: composerRecipe() },
      dependencies,
    });

    expect(result).toMatchObject({ ok: true });
    expect(dependencies.updatePostWithResourceBundleAtomically).toHaveBeenCalledWith(expect.objectContaining({
      patch: expect.objectContaining({ title: fromPrompt }),
    }));
  });

  it('keeps a title the creator wrote, and the prompt’s title once the recipe is off', async () => {
    const typed = await save('Window still', null, { title: 'Window still', resourceBundle: composerRecipe() });
    expect(typed.dependencies.updatePostWithResourceBundleAtomically).toHaveBeenCalledWith(expect.objectContaining({
      patch: expect.objectContaining({ title: 'Window still' }),
    }));

    const off = await save('Window still', storedRecipeRow(composerRecipe()), { title: fromPrompt, resourceBundle: { accessMode: 'none' } });
    expect(off.dependencies.updatePostWithResourceBundleAtomically).toHaveBeenCalledWith(expect.objectContaining({
      patch: expect.objectContaining({ title: fromPrompt }),
    }));
  });
});

// A template result shares its media and a caption only. The publish route has
// always refused a recipe on one; an edit used to save it.
describe('the post of a template result', () => {
  const templateResultPost = {
    id: 'post-1',
    user_id: 'user-1',
    generation_id: 'generation-1',
    visibility: 'private',
    title: 'Window still',
    description: null,
    prompt: null,
    body: null,
    category: 'image',
    post_format: 'media',
    source_tool: 'magicbooklet',
    source_tool_slug: 'magicbooklet',
    source_kind: 'magicbooklet',
    archived_at: null,
    showcase_asset_path: null,
    output_url: 'generated_images/user-1/example.jpg',
    review_status: 'visible',
  };
  // As start_template_generation stores a step's creation: no prompt, no settings.
  const templateGeneration = {
    id: 'generation-1',
    user_id: 'user-1',
    model: 'nano-banana-2',
    category: 'image',
    creation_mode: null,
    prompt: null,
    output_url: 'generated_images/user-1/example.jpg',
    showcase_asset_path: null,
    template_run_id: 'run-1',
    template_run_step_id: 'step-1',
  };

  function createDependencies() {
    return {
      listSourceToolsCatalog: vi.fn(async () => sourceToolCatalog),
      getMarketplaceQualityErrorForPostBundle: vi.fn(async () => null),
      updatePostWithResourceBundleAtomically: vi.fn(async ({ patch }: { patch: Record<string, unknown> }) => ({
        postId: 'post-1',
        visibility: (patch.visibility ?? 'private') as 'public' | 'private',
        bundleId: 'bundle-1',
        bundleStatus: 'draft' as const,
      })),
      replacePostSourceTools: vi.fn(async () => undefined),
      replacePostMediaItems: vi.fn(async () => undefined),
      createPostMediaPreview: vi.fn(async () => null),
      createGenerationShowcaseDerivative: vi.fn(async () => 'showcase/generation-1/example.abc123.jpg'),
      ensureGenerationPostCoverMedia: vi.fn(async () => ({ outcome: 'created' as const, error: null })),
      removeGenerationShowcaseDerivative: vi.fn(async () => ({ removed: true, removedPaths: [], removedMediaRows: 0, error: null })),
      ensureDurableGenerationMedia: vi.fn(async () => ({ outputUrl: 'generated_images/user-1/example.jpg', createdLocation: null })),
    } satisfies PostUpdateDependencies;
  }

  async function save(body: Record<string, unknown>, generation: Record<string, unknown> = templateGeneration) {
    const mock = createSupabaseMock({ post: templateResultPost, bundle: null, generation });
    const dependencies = createDependencies();
    const result = await updateOwnerPostForRoute({
      adminSupabase: mock.client,
      ownerUserId: 'user-1',
      postId: 'post-1',
      body,
      dependencies,
    });
    return { result, dependencies };
  }

  it('refuses a recipe in the publish route’s words', async () => {
    const { result, dependencies } = await save({ title: 'Window still', resourceBundle: composerRecipe() });

    expect(result).toEqual({
      ok: false,
      status: 400,
      body: { error: 'Template results can publish media and a caption, but cannot share the private recipe or input files.' },
    });
    expect(dependencies.updatePostWithResourceBundleAtomically).not.toHaveBeenCalled();
  });

  it('refuses a paid one, and one whose creation names only its run step', async () => {
    const paid = await save({ resourceBundle: { ...composerRecipe(), accessMode: 'paid', priceUsdCents: 500 } });
    expect(paid.result).toMatchObject({ ok: false, status: 400 });

    const stepOnly = await save(
      { resourceBundle: composerRecipe() },
      { ...templateGeneration, template_run_id: null },
    );
    expect(stepOnly.result).toMatchObject({ ok: false, status: 400 });
    expect(stepOnly.dependencies.updatePostWithResourceBundleAtomically).not.toHaveBeenCalled();
  });

  // Both composers send `{ accessMode: 'none' }` with every save that has no recipe.
  it('still saves its title, caption and visibility with no recipe', async () => {
    const { result, dependencies } = await save({
      title: 'Window still at dawn',
      body: 'Made with a template.',
      visibility: 'private',
      resourceBundle: { accessMode: 'none' },
    });

    expect(result).toMatchObject({ ok: true });
    expect(dependencies.updatePostWithResourceBundleAtomically).toHaveBeenCalledWith(expect.objectContaining({
      patch: expect.objectContaining({ title: 'Window still at dawn', body: 'Made with a template.' }),
    }));
  });

  it('takes a recipe on a creation made without a template', async () => {
    const { result } = await save(
      { resourceBundle: composerRecipe() },
      { ...templateGeneration, template_run_id: null, template_run_step_id: null },
    );

    expect(result).toMatchObject({ ok: true });
  });

  it('refuses the save when the creation cannot be read', async () => {
    const mock = createSupabaseMock({ post: templateResultPost, bundle: null, generation: templateGeneration });
    const dependencies = {
      ...createDependencies(),
      isTemplateLinkedGeneration: vi.fn(async () => {
        throw new Error('connection reset');
      }),
    };

    const result = await updateOwnerPostForRoute({
      adminSupabase: mock.client,
      ownerUserId: 'user-1',
      postId: 'post-1',
      body: { resourceBundle: composerRecipe() },
      dependencies,
    });

    expect(result).toEqual({ ok: false, status: 500, body: { error: 'Failed to update post.' } });
    expect(dependencies.updatePostWithResourceBundleAtomically).not.toHaveBeenCalled();
  });
});
