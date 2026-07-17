import { beforeEach, describe, expect, it, vi } from 'vitest';

const cacheMocks = vi.hoisted(() => ({
  SHOWCASE_FEED_CACHE_TAG: 'showcase-feed:v2',
  invalidateShowcaseFeedCache: vi.fn(),
}));

vi.mock('@/lib/showcase-feed-cache', () => cacheMocks);

import { preparePostCreationSubmission } from '@/lib/post-creation-submission-service';
import {
  publishPreparedPost,
  type PostPublishDependencies,
} from '@/lib/post-publish-service';
import type { SourceToolOption } from '@/lib/source-tools';

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
        visibility: post.visibility as 'public',
        bundleId: null,
        bundleStatus: null,
      })),
      insertPostMediaItems: vi.fn(async () => undefined),
      insertPostSourceTools: vi.fn(async () => undefined),
      createPostMediaPreview: vi.fn(async () => null),
    } satisfies PostPublishDependencies;

    const result = await publishPreparedPost({
      adminSupabase: { storage: { from: vi.fn() }, from: vi.fn() },
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
    expect(dependencies.createPostWithResourceBundleAtomically).toHaveBeenCalledWith(expect.objectContaining({
      post: expect.objectContaining({
        id: 'post-1',
        user_id: 'user-1',
        category: 'text',
        post_format: 'text',
        source_kind: 'manual',
        showcase_asset_path: null,
      }),
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

  it('invalidates after a public post commit when follow-up media persistence fails', async () => {
    const formData = new FormData();
    formData.set('postFormat', 'text');
    formData.set('body', 'A public post that commits before its metadata write fails.');
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
      createPostWithResourceBundleAtomically: vi.fn(async () => ({
        postId: 'post-1',
        visibility: 'public' as const,
        bundleId: null,
        bundleStatus: null,
      })),
      insertPostMediaItems: vi.fn(async () => {
        throw new Error('post media insert failed');
      }),
      insertPostSourceTools: vi.fn(async () => undefined),
      createPostMediaPreview: vi.fn(async () => null),
    } satisfies PostPublishDependencies;

    const result = await publishPreparedPost({
      adminSupabase: {
        storage: { from: vi.fn() },
        from: vi.fn(() => ({
          delete: vi.fn(() => ({ eq: deleteEq })),
        })),
      },
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
    expect(dependencies.createPostWithResourceBundleAtomically).toHaveBeenCalledTimes(1);
    expect(deleteEq).toHaveBeenCalledWith('id', 'post-1');
    expect(cacheMocks.invalidateShowcaseFeedCache).toHaveBeenCalledTimes(1);
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
      adminSupabase: { storage: { from: vi.fn() }, from: vi.fn() },
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
      adminSupabase: { storage: { from: vi.fn() }, from: vi.fn() },
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
});
