import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const cacheMocks = vi.hoisted(() => ({
  SHOWCASE_FEED_CACHE_TAG: 'showcase-feed:v2',
  invalidateShowcaseFeedCache: vi.fn(),
}));

/**
 * A deliberate partial double: the publish path only touches `storage.from`
 * and `from`, against a SupabaseClient interface with dozens of members.
 * Widening once here keeps the assertion in one place instead of repeating an
 * inline cast at each of the six call sites.
 */
function adminSupabaseDouble(overrides: Record<string, unknown> = {}): SupabaseClient {
  return {
    storage: { from: vi.fn() },
    from: vi.fn(),
    ...overrides,
  } as unknown as SupabaseClient;
}

vi.mock('@/lib/showcase-feed-cache', () => cacheMocks);

import { preparePostCreationSubmission } from '@/lib/post-creation-submission-service';
import {
  publishPreparedPost,
  type PostPublishDependencies,
} from '@/lib/post-publish-service';
import type { SourceToolOption } from '@/lib/source-tools';
import { PUBLIC_UGC_SAFETY_ERROR } from '@/lib/public-ugc-safety';

const sourceToolCatalog: SourceToolOption[] = [
  { slug: 'magicbooklet', label: 'magicbooklet', models: [], supportedMediaKinds: ['image', 'video'] },
];

describe('publishPreparedPost', () => {
  beforeEach(() => {
    cacheMocks.invalidateShowcaseFeedCache.mockClear();
  });

  it('publishes prepared text posts with marketplace checks and route payload paths', async () => {
    const formData = new FormData();
    formData.set('postFormat', 'text');
    formData.set('body', 'Three hook ideas that keep working.\nLead with tension.');
    formData.set('visibility', 'public');
    const prepared = await preparePostCreationSubmission({
      formData,
      userId: 'user-1',
      sourceToolCatalog,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error('Expected prepared submission');

    const dependencies = {
      getMarketplaceQualityErrorForPostBundle: vi.fn(async () => null),
      createPostWithResourceBundleAtomically: vi.fn(async ({ post }) => ({
        postId: String(post.id),
        visibility: post.visibility as 'private',
        bundleId: null,
        bundleStatus: null,
      })),
      updatePostWithResourceBundleAtomically: vi.fn(async ({ patch }) => ({
        postId: 'post-1',
        visibility: patch.visibility as 'public',
        bundleId: null,
        bundleStatus: null,
      })),
      insertPostMediaItems: vi.fn(async () => undefined),
      insertPostSourceTools: vi.fn(async () => undefined),
      createPostMediaPreview: vi.fn(async () => null),
    } satisfies PostPublishDependencies;

    const result = await publishPreparedPost({
      adminSupabase: adminSupabaseDouble(),
      ownerUserId: 'user-1',
      postId: 'post-1',
      submission: prepared.submission,
      dependencies,
    });

    expect(dependencies.getMarketplaceQualityErrorForPostBundle).toHaveBeenCalledWith(expect.objectContaining({
      ownerUserId: 'user-1',
      post: expect.objectContaining({
        title: 'Three hook ideas that keep working.',
        visibility: 'public',
        hasMedia: false,
      }),
      bundle: null,
    }));
    // Created private regardless of the requested visibility: nothing public
    // may exist until media and source tools are in place.
    expect(dependencies.createPostWithResourceBundleAtomically).toHaveBeenCalledWith(expect.objectContaining({
      post: expect.objectContaining({
        id: 'post-1',
        user_id: 'user-1',
        visibility: 'private',
        category: 'text',
        post_format: 'text',
        source_kind: 'manual',
        showcase_asset_path: null,
      }),
      bundle: null,
    }));
    // Promotion happens last, through the update RPC with the bundle payload so
    // bundle status is recomputed against the now-public post.
    expect(dependencies.updatePostWithResourceBundleAtomically).toHaveBeenCalledWith(expect.objectContaining({
      postId: 'post-1',
      ownerUserId: 'user-1',
      patch: { visibility: 'public' },
      hasBundlePayload: true,
      bundle: null,
    }));
    expect(dependencies.insertPostMediaItems).toHaveBeenCalledWith(expect.objectContaining({
      postId: 'post-1',
      mediaItems: [],
    }));
    expect(dependencies.insertPostSourceTools).toHaveBeenCalledWith(expect.objectContaining({
      postId: 'post-1',
      ownerUserId: 'user-1',
      mediaKind: null,
      sourceTools: [],
    }));
    expect(result).toEqual({
      ok: true,
      body: {
        success: true,
        postId: 'post-1',
        visibility: 'public',
        showcasePath: '/showcase/post-1',
        ownerPath: '/post/post-1/edit',
        resourceBundlePath: '/showcase/post-1#recipe',
        resourceBundleStatus: null,
      },
    });
    expect(cacheMocks.invalidateShowcaseFeedCache).toHaveBeenCalledTimes(1);
  });

  it('never had a public post to invalidate when media persistence fails', async () => {
    // The old flow created the post at its requested visibility, so a media
    // failure whose compensating delete also failed left a public post with no
    // media rows. Creating private-first makes that state unreachable: the
    // shared feed was never touched, so there is nothing to invalidate.
    const formData = new FormData();
    formData.set('postFormat', 'text');
    formData.set('body', 'A public post whose media write fails before promotion.');
    formData.set('visibility', 'public');
    const prepared = await preparePostCreationSubmission({
      formData,
      userId: 'user-1',
      sourceToolCatalog,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error('Expected prepared submission');

    const deleteEq = vi.fn(async () => ({ error: null }));
    const dependencies = {
      getMarketplaceQualityErrorForPostBundle: vi.fn(async () => null),
      createPostWithResourceBundleAtomically: vi.fn(async ({ post }) => ({
        postId: 'post-1',
        visibility: post.visibility as 'private',
        bundleId: null,
        bundleStatus: null,
      })),
      updatePostWithResourceBundleAtomically: vi.fn(async () => {
        throw new Error('Promotion must not run when media persistence failed.');
      }),
      insertPostMediaItems: vi.fn(async () => {
        throw new Error('post media insert failed');
      }),
      insertPostSourceTools: vi.fn(async () => undefined),
      createPostMediaPreview: vi.fn(async () => null),
    } satisfies PostPublishDependencies;

    const result = await publishPreparedPost({
      adminSupabase: adminSupabaseDouble({
        from: vi.fn(() => ({
          delete: vi.fn(() => ({ eq: deleteEq })),
        })),
      }),
      ownerUserId: 'user-1',
      postId: 'post-1',
      submission: prepared.submission,
      dependencies,
    });

    expect(result).toEqual({
      ok: false,
      status: 500,
      body: { error: 'Failed to save post media.' },
    });
    expect(dependencies.createPostWithResourceBundleAtomically).toHaveBeenCalledWith(expect.objectContaining({
      post: expect.objectContaining({ visibility: 'private' }),
    }));
    expect(dependencies.updatePostWithResourceBundleAtomically).not.toHaveBeenCalled();
    expect(deleteEq).toHaveBeenCalledWith('id', 'post-1');
    expect(cacheMocks.invalidateShowcaseFeedCache).not.toHaveBeenCalled();
  });

  it('keeps the finished post as a private draft when promotion fails', async () => {
    const formData = new FormData();
    formData.set('postFormat', 'text');
    formData.set('body', 'A post whose final visibility flip fails.');
    formData.set('visibility', 'public');
    const prepared = await preparePostCreationSubmission({
      formData,
      userId: 'user-1',
      sourceToolCatalog,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error('Expected prepared submission');

    const dependencies = {
      getMarketplaceQualityErrorForPostBundle: vi.fn(async () => null),
      createPostWithResourceBundleAtomically: vi.fn(async ({ post }) => ({
        postId: 'post-1',
        visibility: post.visibility as 'private',
        bundleId: null,
        bundleStatus: null,
      })),
      updatePostWithResourceBundleAtomically: vi.fn(async () => {
        throw new Error('visibility flip failed');
      }),
      insertPostMediaItems: vi.fn(async () => undefined),
      insertPostSourceTools: vi.fn(async () => undefined),
      createPostMediaPreview: vi.fn(async () => null),
    } satisfies PostPublishDependencies;

    const result = await publishPreparedPost({
      adminSupabase: adminSupabaseDouble(),
      ownerUserId: 'user-1',
      postId: 'post-1',
      submission: prepared.submission,
      dependencies,
    });

    expect(result).toEqual({
      ok: false,
      status: 500,
      body: {
        error: 'Your post was saved as a private draft, but publishing failed. Open it from your posts to publish again.',
      },
    });
    // The draft survives — promotion failure must not tear down finished work —
    // and the never-public post never invalidates the shared feed.
    expect(cacheMocks.invalidateShowcaseFeedCache).not.toHaveBeenCalled();
  });

  it('returns a profile repair action before creating an incomplete public post', async () => {
    const formData = new FormData();
    formData.set('postFormat', 'text');
    formData.set('body', 'A useful public creator story with enough context.');
    formData.set('visibility', 'public');
    const prepared = await preparePostCreationSubmission({
      formData,
      userId: 'user-1',
      sourceToolCatalog,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error('Expected prepared submission');

    const createPostWithResourceBundleAtomically = vi.fn();
    const result = await publishPreparedPost({
      adminSupabase: adminSupabaseDouble(),
      ownerUserId: 'user-1',
      postId: 'post-1',
      submission: prepared.submission,
      dependencies: {
        getMarketplaceQualityErrorForPostBundle: vi.fn(async () => (
          'Complete your profile before publishing publicly: choose a custom handle and add your display name.'
        )),
        createPostWithResourceBundleAtomically,
        insertPostMediaItems: vi.fn(),
        insertPostSourceTools: vi.fn(),
        createPostMediaPreview: vi.fn(),
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
    expect(createPostWithResourceBundleAtomically).not.toHaveBeenCalled();
    expect(cacheMocks.invalidateShowcaseFeedCache).not.toHaveBeenCalled();
  });

  it.each(['public', 'unlisted'] as const)(
    'rejects clearly unsafe text before publishing a %s post',
    async (visibility) => {
      const formData = new FormData();
      formData.set('postFormat', 'text');
      formData.set('body', 'Go k1ll y0urself.');
      formData.set('visibility', visibility);
      const prepared = await preparePostCreationSubmission({
        formData,
        userId: 'user-1',
        sourceToolCatalog,
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) throw new Error('Expected prepared submission');

      const createPostWithResourceBundleAtomically = vi.fn();
      const result = await publishPreparedPost({
        adminSupabase: adminSupabaseDouble(),
        ownerUserId: 'user-1',
        postId: 'post-unsafe',
        submission: prepared.submission,
        dependencies: {
          getMarketplaceQualityErrorForPostBundle: vi.fn(),
          createPostWithResourceBundleAtomically,
          insertPostMediaItems: vi.fn(),
          insertPostSourceTools: vi.fn(),
          createPostMediaPreview: vi.fn(),
        },
      });

      expect(result).toEqual({
        ok: false,
        status: 400,
        body: { error: PUBLIC_UGC_SAFETY_ERROR, field: 'body' },
      });
      expect(createPostWithResourceBundleAtomically).not.toHaveBeenCalled();
    },
  );

  it('keeps the public-text gate out of private post storage', async () => {
    const formData = new FormData();
    formData.set('postFormat', 'text');
    formData.set('body', 'Go k1ll y0urself.');
    formData.set('visibility', 'private');
    const prepared = await preparePostCreationSubmission({
      formData,
      userId: 'user-1',
      sourceToolCatalog,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error('Expected prepared submission');

    const createPostWithResourceBundleAtomically = vi.fn(async () => ({
      postId: 'post-private',
      visibility: 'private' as const,
      bundleId: null,
      bundleStatus: null,
    }));
    const result = await publishPreparedPost({
      adminSupabase: adminSupabaseDouble(),
      ownerUserId: 'user-1',
      postId: 'post-private',
      submission: prepared.submission,
      dependencies: {
        getMarketplaceQualityErrorForPostBundle: vi.fn(),
        createPostWithResourceBundleAtomically,
        insertPostMediaItems: vi.fn(async () => undefined),
        insertPostSourceTools: vi.fn(async () => undefined),
        createPostMediaPreview: vi.fn(async () => null),
      },
    });

    expect(result).toMatchObject({ ok: true, body: { visibility: 'private' } });
    expect(createPostWithResourceBundleAtomically).toHaveBeenCalledTimes(1);
  });

  it('treats a failed profile check as a retryable server failure', async () => {
    const formData = new FormData();
    formData.set('postFormat', 'text');
    formData.set('body', 'A useful public creator story with enough context.');
    formData.set('visibility', 'public');
    const prepared = await preparePostCreationSubmission({
      formData,
      userId: 'user-1',
      sourceToolCatalog,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error('Expected prepared submission');

    const result = await publishPreparedPost({
      adminSupabase: adminSupabaseDouble(),
      ownerUserId: 'user-1',
      postId: 'post-1',
      submission: prepared.submission,
      dependencies: {
        getMarketplaceQualityErrorForPostBundle: vi.fn(async () => (
          'Could not verify your creator profile right now. Try again.'
        )),
        createPostWithResourceBundleAtomically: vi.fn(),
        insertPostMediaItems: vi.fn(),
        insertPostSourceTools: vi.fn(),
        createPostMediaPreview: vi.fn(),
      },
    });

    expect(result).toEqual({
      ok: false,
      status: 500,
      body: { error: 'Could not verify your creator profile right now. Try again.' },
    });
  });

  it('rejects an oversized staged object from its metadata without downloading the bytes', async () => {
    const formData = new FormData();
    formData.set('postFormat', 'media');
    formData.set('category', 'image');
    formData.set('visibility', 'public');
    formData.set('sourceTool', 'magicbooklet');
    formData.set('mediaStoragePath', 'uploads/user-1/oversized.png');
    formData.set('mediaOriginalName', 'oversized.png');
    formData.set('mediaContentType', 'image/png');
    const prepared = await preparePostCreationSubmission({
      formData,
      userId: 'user-1',
      sourceToolCatalog,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error('Expected prepared submission');

    const list = vi.fn(async () => ({
      data: [{ name: 'oversized.png', metadata: { size: 26 * 1024 * 1024 } }],
      error: null,
    }));
    const download = vi.fn(async () => ({ data: new Blob(['should never be read']), error: null }));

    const result = await publishPreparedPost({
      adminSupabase: adminSupabaseDouble({
        storage: { from: vi.fn(() => ({ list, download, remove: vi.fn(async () => ({ data: [], error: null })) })) },
        from: vi.fn(() => ({ delete: vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) })) })),
      }),
      ownerUserId: 'user-1',
      postId: 'post-1',
      submission: prepared.submission,
      dependencies: {
        getMarketplaceQualityErrorForPostBundle: vi.fn(async () => null),
        createPostWithResourceBundleAtomically: vi.fn(),
        insertPostMediaItems: vi.fn(),
        insertPostSourceTools: vi.fn(),
        createPostMediaPreview: vi.fn(),
      },
    });

    expect(result).toMatchObject({
      ok: false,
      status: 400,
      body: { error: expect.stringContaining('25 MB') },
    });
    // filePath carries the in-bucket path (bucket prefix already stripped).
    expect(list).toHaveBeenCalledWith('user-1', { search: 'oversized.png' });
    // The point of the precheck: the oversized bytes never enter the function.
    expect(download).not.toHaveBeenCalled();
  });
});
