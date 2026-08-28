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
import { TITLE_MAX_LENGTH } from '@/lib/posts-server';
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
    it('secures the private copy, drops the public derivative, and takes the generation off show when going private', async () => {
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
      expect(generationUpdates).toEqual([{
        is_public: false,
        showcase_asset_path: null,
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

    it('creates the public copy and puts the generation on show when going public', async () => {
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
      expect(generationUpdates).toEqual([{
        showcase_asset_path: 'showcase/generation-1/example.abc123.jpg',
        is_public: true,
      }]);
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

  it('preserves stable media keys when existing proof media is reordered', async () => {
    const postMedia = [
      {
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
        expect.objectContaining({ mediaKey: 'proof-a', sortOrder: 1 }),
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
      body: { error: 'New uploads must use a new post media key.' },
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

  it('copies edited video into the public bucket without reading the bytes', async () => {
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
      to: expect.stringMatching(/^posts\/post-1\/.+\/clip\.mp4$/),
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

  describe('title length', () => {
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
