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

/** A single staged (already-uploaded) media item, the shape both clients send. */
async function prepareStagedMediaSubmission({
  fileName,
  contentType,
  category = 'image',
}: {
  fileName: string;
  contentType: string;
  category?: string;
}) {
  const formData = new FormData();
  formData.set('postFormat', 'media');
  formData.set('category', category);
  formData.set('visibility', 'public');
  formData.set('sourceTool', 'magicbooklet');
  formData.set('mediaStoragePath', `uploads/user-1/${fileName}`);
  formData.set('mediaOriginalName', fileName);
  formData.set('mediaContentType', contentType);

  const prepared = await preparePostCreationSubmission({
    formData,
    userId: 'user-1',
    sourceToolCatalog,
  });
  if (!prepared.ok) throw new Error('Expected prepared submission');
  return prepared;
}

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

    const info = vi.fn(async () => ({
      data: { size: 26 * 1024 * 1024, contentType: 'image/png' },
      error: null,
    }));
    const download = vi.fn(async () => ({ data: new Blob(['should never be read']), error: null }));
    const copy = vi.fn(async () => ({ data: { path: 'unused' }, error: null }));
    const removedBatches: string[][] = [];
    const remove = vi.fn(async (paths: string[]) => {
      removedBatches.push(paths);
      return { data: paths.map((name) => ({ name })), error: null };
    });
    const clearedIntents = vi.fn(async () => ({ error: null }));

    const result = await publishPreparedPost({
      adminSupabase: adminSupabaseDouble({
        storage: {
          from: vi.fn(() => ({
            info,
            download,
            copy,
            remove,
          })),
        },
        from: vi.fn(() => ({
          delete: vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) })),
          update: vi.fn(() => ({ in: vi.fn(() => ({ is: clearedIntents })) })),
        })),
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
    expect(info).toHaveBeenCalledWith('user-1/oversized.png');
    // The point of the metadata check: the oversized object is neither read nor
    // promoted into the public bucket.
    expect(download).not.toHaveBeenCalled();
    expect(copy).not.toHaveBeenCalled();
    // The rejection is permanent, so the staged object is rolled back rather
    // than left to leak in the staging bucket until the sweep. The destination
    // was registered pessimistically but never written, so its remove is a
    // harmless no-op.
    expect(removedBatches).toEqual([
      ['posts/post-1/0/oversized.png'],
      ['user-1/oversized.png'],
    ]);
    expect(clearedIntents).toHaveBeenCalled();
  });

  it('fails closed when staged media metadata carries no size', async () => {
    const prepared = await prepareStagedMediaSubmission({
      fileName: 'clip.mp4',
      contentType: 'video/mp4',
      category: 'video',
    });
    const info = vi.fn(async () => ({ data: { contentType: 'video/mp4' }, error: null }));
    const copy = vi.fn(async () => ({ data: { path: 'unused' }, error: null }));
    const remove = vi.fn(async () => ({ data: [], error: null }));

    const result = await publishPreparedPost({
      adminSupabase: adminSupabaseDouble({
        storage: {
          from: vi.fn(() => ({
            info,
            copy,
            download: vi.fn(),
            remove,
          })),
        },
        from: vi.fn(() => ({
          delete: vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) })),
          update: vi.fn(() => ({ in: vi.fn(() => ({ is: vi.fn(async () => ({ error: null })) })) })),
        })),
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

    // Without a size there is no authoritative cap left, so nothing is promoted.
    expect(result).toMatchObject({ ok: false, status: 500 });
    expect(copy).not.toHaveBeenCalled();
    // Metadata absence is retryable: deleting the staged object here would turn
    // the retry into a permanent failure, so it is left for the reclaim sweep.
    expect(remove).not.toHaveBeenCalled();
  });

  it('copies staged video into the public bucket without reading the bytes', async () => {
    const prepared = await prepareStagedMediaSubmission({
      fileName: 'clip.mp4',
      contentType: 'video/mp4',
      category: 'video',
    });
    const info = vi.fn(async () => ({
      data: { size: 13 * 1024 * 1024, contentType: 'video/mp4' },
      error: null,
    }));
    const copy = vi.fn(async () => ({ data: { path: 'posts/post-1/0/clip.mp4' }, error: null }));
    const download = vi.fn();
    const insertPostMediaItems = vi.fn();
    const createPostMediaRendition = vi.fn();

    const result = await publishPreparedPost({
      adminSupabase: adminSupabaseDouble({
        storage: {
          from: vi.fn(() => ({
            info,
            copy,
            download,
            remove: vi.fn(async () => ({ data: [], error: null })),
          })),
        },
        from: vi.fn(() => ({
          update: vi.fn(() => ({ in: vi.fn(() => ({ is: vi.fn(async () => ({ error: null })) })) })),
        })),
      }),
      ownerUserId: 'user-1',
      postId: 'post-1',
      submission: prepared.submission,
      dependencies: {
        getMarketplaceQualityErrorForPostBundle: vi.fn(async () => null),
        createPostWithResourceBundleAtomically: vi.fn(async () => ({
          postId: 'post-1',
          visibility: 'private' as const,
          bundleId: null,
          bundleStatus: null,
        })),
        updatePostWithResourceBundleAtomically: vi.fn(async () => ({
          postId: 'post-1',
          visibility: 'public' as const,
          bundleId: null,
          bundleStatus: null,
        })),
        insertPostMediaItems,
        insertPostSourceTools: vi.fn(),
        createPostMediaPreview: vi.fn(),
        createPostMediaRendition,
      },
    });

    expect(result).toMatchObject({ ok: true });
    // Cross-bucket server-side move: no bytes enter the function at all.
    expect(copy).toHaveBeenCalledWith(
      'user-1/clip.mp4',
      'posts/post-1/0/clip.mp4',
      { destinationBucket: 'showcase_media' },
    );
    expect(download).not.toHaveBeenCalled();
    expect(createPostMediaRendition).not.toHaveBeenCalled();

    // Omitted, not marked failed: insertPostMediaItems defaults these to
    // pending/0, which is exactly what the repair sweep picks up.
    const [{ mediaItems }] = insertPostMediaItems.mock.calls[0];
    expect(mediaItems[0]).not.toHaveProperty('previewStatus');
    expect(mediaItems[0]).not.toHaveProperty('renditionStatus');
    expect(mediaItems[0]).toMatchObject({
      storagePath: 'posts/post-1/0/clip.mp4',
      mediaKind: 'video',
      contentType: 'video/mp4',
    });
  });

  it('previews a staged image inline but leaves the row pending when that fails', async () => {
    const prepared = await prepareStagedMediaSubmission({ fileName: 'shot.png', contentType: 'image/png' });
    const info = vi.fn(async () => ({
      data: { size: 2 * 1024 * 1024, contentType: 'image/png' },
      error: null,
    }));
    const download = vi.fn(async () => ({ data: new Blob(['png'], { type: 'image/png' }), error: null }));
    const insertPostMediaItems = vi.fn();

    const result = await publishPreparedPost({
      adminSupabase: adminSupabaseDouble({
        storage: {
          from: vi.fn(() => ({
            info,
            download,
            copy: vi.fn(async () => ({ data: { path: 'ok' }, error: null })),
            remove: vi.fn(async () => ({ data: [], error: null })),
          })),
        },
        from: vi.fn(() => ({
          update: vi.fn(() => ({ in: vi.fn(() => ({ is: vi.fn(async () => ({ error: null })) })) })),
        })),
      }),
      ownerUserId: 'user-1',
      postId: 'post-1',
      submission: prepared.submission,
      dependencies: {
        getMarketplaceQualityErrorForPostBundle: vi.fn(async () => null),
        createPostWithResourceBundleAtomically: vi.fn(async () => ({
          postId: 'post-1',
          visibility: 'private' as const,
          bundleId: null,
          bundleStatus: null,
        })),
        updatePostWithResourceBundleAtomically: vi.fn(async () => ({
          postId: 'post-1',
          visibility: 'public' as const,
          bundleId: null,
          bundleStatus: null,
        })),
        insertPostMediaItems,
        insertPostSourceTools: vi.fn(),
        // The inline attempt throws; publishing must still succeed.
        createPostMediaPreview: vi.fn(async () => { throw new Error('sharp failed'); }),
      },
    });

    expect(result).toMatchObject({ ok: true });
    // An image is small enough to read once for its thumbhash placeholder.
    expect(download).toHaveBeenCalledTimes(1);

    // A failed inline attempt must not spend one of the sweep's three retries.
    const [{ mediaItems }] = insertPostMediaItems.mock.calls[0];
    expect(mediaItems[0]).not.toHaveProperty('previewStatus');
    expect(mediaItems[0]).not.toHaveProperty('previewAttemptCount');
  });

  it('cleans up both the copy and the staged source when the copy fails', async () => {
    const prepared = await prepareStagedMediaSubmission({ fileName: 'shot.png', contentType: 'image/png' });
    const removedBatches: string[][] = [];
    const remove = vi.fn(async (paths: string[]) => {
      removedBatches.push(paths);
      return { data: paths.map((name) => ({ name })), error: null };
    });
    const clearedIntents = vi.fn(async () => ({ error: null }));

    const result = await publishPreparedPost({
      adminSupabase: adminSupabaseDouble({
        storage: {
          from: vi.fn(() => ({
            info: vi.fn(async () => ({
              data: { size: 1024, contentType: 'image/png' },
              error: null,
            })),
            copy: vi.fn(async () => ({ data: null, error: new Error('destination already exists') })),
            download: vi.fn(),
            remove,
          })),
        },
        from: vi.fn(() => ({
          update: vi.fn(() => ({ in: vi.fn(() => ({ is: clearedIntents })) })),
        })),
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

    expect(result).toMatchObject({ ok: false, status: 500 });
    // The destination is registered before the copy runs, so an ambiguous
    // failure still cleans up whatever may have materialized.
    expect(removedBatches).toEqual([
      ['posts/post-1/0/shot.png'],
      ['user-1/shot.png'],
    ]);
    // Rolled back, so the staged bytes are marked cleared rather than consumed.
    expect(clearedIntents).toHaveBeenCalled();
  });
});
