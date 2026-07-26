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
}: {
  post?: Record<string, unknown> | null;
  bundle?: Record<string, unknown> | null;
  postMedia?: Array<Record<string, unknown>>;
} = {}) {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = {
    from(table: string) {
      const query = {
        select() {
          return query;
        },
        eq() {
          return query;
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
      from: vi.fn(),
    },
  };

  return {
    client: client as unknown as SupabaseClient,
    rpcCalls,
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
});
