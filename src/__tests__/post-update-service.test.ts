import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const cacheMocks = vi.hoisted(() => ({
  SHOWCASE_FEED_CACHE_TAG: 'showcase-feed:v2',
  invalidateShowcaseFeedCache: vi.fn(),
}));

vi.mock('@/lib/showcase-feed-cache', () => cacheMocks);

import {
  updateOwnerPostForRoute,
  type PostUpdateDependencies,
} from '@/lib/post-update-service';
import type { SourceToolOption } from '@/lib/source-tools';
import { TITLE_MAX_LENGTH } from '@/lib/posts-server';
import { PUBLIC_UGC_SAFETY_ERROR } from '@/lib/public-ugc-safety';

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
    access_mode: 'paid',
    status: 'draft',
  },
  postMedia = [] as Array<Record<string, unknown>>,
  downloadedMedia = null as Blob | null,
  stagedInfo = { size: 1024, contentType: 'image/jpeg' } as Record<string, unknown> | null,
}: {
  post?: Record<string, unknown> | null;
  bundle?: Record<string, unknown> | null;
  postMedia?: Array<Record<string, unknown>>;
  downloadedMedia?: Blob | null;
  /** Storage metadata for the staged object; the authoritative size check. */
  stagedInfo?: Record<string, unknown> | null;
} = {}) {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
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
        // media_upload_intents bookkeeping after a successful media replace.
        update() {
          return query;
        },
        in() {
          return query;
        },
        is() {
          return Promise.resolve({ error: null });
        },
        order() {
          return Promise.resolve({ data: table === 'post_media' ? postMedia : [], error: null });
        },
        maybeSingle() {
          if (table === 'posts') {
            return Promise.resolve({ data: post, error: null });
          }

          if (table === 'post_resource_bundles') {
            return Promise.resolve({ data: bundle, error: null });
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

  it('rejects publishing an existing draft unlock unless the bundle payload is resubmitted', async () => {
    const { client } = createSupabaseMock();
    const dependencies = {
      listSourceToolsCatalog: vi.fn(async () => sourceToolCatalog),
      getMarketplaceQualityErrorForPostBundle: vi.fn(async () => null),
      updatePostWithResourceBundleAtomically: vi.fn(async () => {
        throw new Error('Should not update without bundle payload');
      }),
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

    expect(result).toEqual({
      ok: false,
      status: 400,
      body: {
        error: 'This post already has a draft unlock. Please resubmit the unlock payload when publishing so we can validate and publish it together.',
      },
    });
    expect(dependencies.getMarketplaceQualityErrorForPostBundle).not.toHaveBeenCalled();
    expect(dependencies.updatePostWithResourceBundleAtomically).not.toHaveBeenCalled();
    expect(cacheMocks.invalidateShowcaseFeedCache).not.toHaveBeenCalled();
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
    const updatePostWithResourceBundleAtomically = vi.fn(async () => ({
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
    const replacePostMediaItems = vi.fn(async () => undefined);

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
        updatePostWithResourceBundleAtomically: vi.fn(async () => ({
          postId: 'post-1',
          visibility: 'private' as const,
          bundleId: 'bundle-1',
          bundleStatus: 'draft' as const,
        })),
        replacePostSourceTools: vi.fn(async () => undefined),
        replacePostMediaItems,
        createPostMediaPreview: vi.fn(async () => null),
      },
    });

    expect(result.ok).toBe(true);
    expect(replacePostMediaItems).toHaveBeenCalledWith(expect.objectContaining({
      mediaItems: [
        expect.objectContaining({ mediaKey: 'proof-b', sortOrder: 0 }),
        expect.objectContaining({ mediaKey: 'proof-a', sortOrder: 1 }),
      ],
    }));
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
    const replacePostMediaItems = vi.fn();

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
        updatePostWithResourceBundleAtomically: vi.fn(async () => ({
          postId: 'post-1',
          visibility: 'private' as const,
          bundleId: null,
          bundleStatus: null,
        })),
        replacePostSourceTools: vi.fn(async () => undefined),
        replacePostMediaItems,
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
    const [{ mediaItems }] = replacePostMediaItems.mock.calls[0];
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
    const replacePostMediaItems = vi.fn();

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
        updatePostWithResourceBundleAtomically: vi.fn(async () => ({
          postId: 'post-1',
          visibility: 'private' as const,
          bundleId: null,
          bundleStatus: null,
        })),
        replacePostSourceTools: vi.fn(async () => undefined),
        replacePostMediaItems,
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

    const [{ mediaItems }] = replacePostMediaItems.mock.calls[0];
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
