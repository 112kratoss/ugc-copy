import { describe, expect, it, vi } from 'vitest';

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
        resourceBundlePath: '/showcase/post-1#resources',
        resourceBundleStatus: null,
      },
    });
  });
});
