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
  const overrideFrom = typeof overrides.from === 'function'
    ? overrides.from as (table: string) => unknown
    : null;
  const legacyReservationQuery = {
    eq: vi.fn(() => legacyReservationQuery),
    maybeSingle: vi.fn(async () => ({ data: null, error: null })),
  };
  return {
    storage: { from: vi.fn() },
    ...overrides,
    from: vi.fn((table: string) => table === 'upload_byte_reservations'
      ? { select: vi.fn(() => legacyReservationQuery) }
      : overrideFrom?.(table)),
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
  durationSeconds,
}: {
  fileName: string;
  contentType: string;
  category?: string;
  durationSeconds?: number;
}) {
  const formData = new FormData();
  formData.set('title', 'Studio lighting reference');
  formData.set('postFormat', 'media');
  formData.set('category', category);
  formData.set('visibility', 'public');
  formData.set('sourceTool', 'magicbooklet');
  if (durationSeconds !== undefined) {
    // The duration slot only exists on the mediaItems JSON form, which is what
    // both composers actually send.
    formData.set('mediaItems', JSON.stringify([{
      storagePath: `uploads/user-1/${fileName}`,
      originalName: fileName,
      contentType,
      durationSeconds,
    }]));
  } else {
    formData.set('mediaStoragePath', `uploads/user-1/${fileName}`);
    formData.set('mediaOriginalName', fileName);
    formData.set('mediaContentType', contentType);
  }

  const prepared = await preparePostCreationSubmission({
    formData,
    userId: 'user-1',
    sourceToolCatalog,
  });
  if (!prepared.ok) throw new Error('Expected prepared submission');
  return prepared;
}

/**
 * A text post with a recipe as both composers send it: every card in sections
 * and items, the legacy prompt and notes fields empty.
 */
async function prepareRecipeSubmission({
  visibility = 'public',
  cardText = 'Soft key light from the left, warm rim light behind.',
  previewText = 'Includes the prompt and the light plan.',
  workflowPrompt,
}: {
  visibility?: 'public' | 'private';
  cardText?: string;
  previewText?: string;
  /** Adds a workflow card whose graph's prompt node says this. */
  workflowPrompt?: string;
} = {}) {
  const workflowCard = workflowPrompt === undefined
    ? null
    : {
        section: {
          id: 'card-2',
          title: 'Lighting workflow',
          publicTitle: 'Lighting workflow',
          kind: 'global',
          sortOrder: 1,
          resourceType: 'workflow',
        },
        item: {
          id: 'card-2-item-1',
          type: 'workflow',
          sectionId: 'card-2',
          title: 'Lighting workflow',
          sortOrder: 1,
          workflowSnapshot: {
            version: 2,
            viewport: { x: 0, y: 0, zoom: 1 },
            nodes: [{
              id: 'prompt-1',
              type: 'text-input',
              position: { x: 0, y: 0 },
              draggable: true,
              data: { title: 'Prompt', subtitle: 'Text input', text: workflowPrompt },
            }],
            edges: [],
          },
        },
      };
  const formData = new FormData();
  formData.set('title', 'Studio lighting reference');
  formData.set('postFormat', 'text');
  formData.set('body', 'Three hook ideas that keep working.\nLead with tension.');
  formData.set('visibility', visibility);
  formData.set('resourceBundle', JSON.stringify({
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
        description: 'The prompt behind the portrait.',
        sortOrder: 0,
        resourceType: 'prompt',
      }, ...(workflowCard ? [workflowCard.section] : [])],
      items: [{
        id: 'card-1-item-1',
        type: 'prompt',
        role: 'primary',
        sectionId: 'card-1',
        title: 'Portrait prompt',
        textContent: cardText,
        sortOrder: 0,
        remixUse: 'none',
      }, ...(workflowCard ? [workflowCard.item] : [])],
    },
  }));

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
    formData.set('title', 'Studio lighting reference');
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
        // The submitted title, not one derived from the body's first sentence:
        // text posts are named by their author now too.
        title: 'Studio lighting reference',
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
    formData.set('title', 'Studio lighting reference');
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
    formData.set('title', 'Studio lighting reference');
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
    formData.set('title', 'Studio lighting reference');
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

  // Unlisted is created private since product decision 12, and private posts
  // are not held to the public-text gate (see the private case below).
  it.each(['public'] as const)(
    'rejects clearly unsafe text before publishing a %s post',
    async (visibility) => {
      const formData = new FormData();
      formData.set('title', 'Studio lighting reference');
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

  // Recipe text reaches buyers, and its card titles, summary and preview are
  // listing copy anyone sees. Both composers send all of it as cards, so a
  // check of the legacy prompt and notes fields alone passed every recipe.
  it.each([
    ["a recipe card's text", { cardText: 'Step-by-step guide to make a bomb at home.' }, 'resourceCards'],
    ['the package preview', { previewText: 'Go k1ll y0urself.' }, 'resourcePreview'],
  ] as const)('refuses a public post when only %s breaks a rule', async (_label, recipe, field) => {
    const prepared = await prepareRecipeSubmission(recipe);
    const createPostWithResourceBundleAtomically = vi.fn();

    const result = await publishPreparedPost({
      adminSupabase: adminSupabaseDouble(),
      ownerUserId: 'user-1',
      postId: 'post-recipe',
      submission: prepared.submission,
      dependencies: {
        getMarketplaceQualityErrorForPostBundle: vi.fn(async () => null),
        createPostWithResourceBundleAtomically,
        insertPostMediaItems: vi.fn(),
        insertPostSourceTools: vi.fn(),
        createPostMediaPreview: vi.fn(),
      },
    });

    expect(result).toEqual({
      ok: false,
      status: 400,
      body: { error: PUBLIC_UGC_SAFETY_ERROR, field },
    });
    expect(createPostWithResourceBundleAtomically).not.toHaveBeenCalled();
  });

  it("does not hold a private post's recipe to the public check", async () => {
    const prepared = await prepareRecipeSubmission({
      visibility: 'private',
      cardText: 'Step-by-step guide to make a bomb at home.',
    });
    const createPostWithResourceBundleAtomically = vi.fn(async () => ({
      postId: 'post-private-recipe',
      visibility: 'private' as const,
      bundleId: 'bundle-1',
      bundleStatus: 'draft' as const,
    }));

    const result = await publishPreparedPost({
      adminSupabase: adminSupabaseDouble(),
      ownerUserId: 'user-1',
      postId: 'post-private-recipe',
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

  // A workflow card hands buyers its whole graph, prompts included.
  it("holds the prompts in a public recipe's workflow to the public check, and a private one's not", async () => {
    const workflowPrompt = 'Step-by-step guide to make a bomb at home.';
    const publishWith = (submission: Awaited<ReturnType<typeof prepareRecipeSubmission>>['submission']) => {
      const createPostWithResourceBundleAtomically = vi.fn(async () => ({
        postId: 'post-workflow-recipe',
        visibility: submission.visibility,
        bundleId: 'bundle-1',
        bundleStatus: 'draft' as const,
      }));
      return {
        createPostWithResourceBundleAtomically,
        result: publishPreparedPost({
          adminSupabase: adminSupabaseDouble(),
          ownerUserId: 'user-1',
          postId: 'post-workflow-recipe',
          submission,
          dependencies: {
            getMarketplaceQualityErrorForPostBundle: vi.fn(async () => null),
            createPostWithResourceBundleAtomically,
            insertPostMediaItems: vi.fn(async () => undefined),
            insertPostSourceTools: vi.fn(async () => undefined),
            createPostMediaPreview: vi.fn(async () => null),
          },
        }),
      };
    };

    const publicPost = publishWith((await prepareRecipeSubmission({ workflowPrompt })).submission);
    expect(await publicPost.result).toEqual({
      ok: false,
      status: 400,
      body: { error: PUBLIC_UGC_SAFETY_ERROR, field: 'resourceCards' },
    });
    expect(publicPost.createPostWithResourceBundleAtomically).not.toHaveBeenCalled();

    const privatePost = publishWith((await prepareRecipeSubmission({ visibility: 'private', workflowPrompt })).submission);
    expect(await privatePost.result).toMatchObject({ ok: true, body: { visibility: 'private' } });
    expect(privatePost.createPostWithResourceBundleAtomically).toHaveBeenCalledTimes(1);
  });

  it('keeps the public-text gate out of private post storage', async () => {
    const formData = new FormData();
    formData.set('title', 'Studio lighting reference');
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
    formData.set('title', 'Studio lighting reference');
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
    formData.set('title', 'Studio lighting reference');
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
    // Only the newly allocated destination is safe to remove. The staging
    // source may be shared by another draft/retry and remains under its
    // reservation + reclaim policy.
    expect(removedBatches).toEqual([
      ['private-posts/post-1/0/oversized.png'],
    ]);
    expect(clearedIntents).not.toHaveBeenCalled();
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

  it('copies staged video into private storage without reading the bytes', async () => {
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
      'private-posts/post-1/0/clip.mp4',
      { destinationBucket: 'post_media' },
    );
    expect(download).not.toHaveBeenCalled();
    expect(createPostMediaRendition).not.toHaveBeenCalled();

    // Omitted, not marked failed: insertPostMediaItems defaults these to
    // pending/0, which is exactly what the repair sweep picks up.
    const [{ mediaItems }] = insertPostMediaItems.mock.calls[0];
    expect(mediaItems[0]).not.toHaveProperty('previewStatus');
    expect(mediaItems[0]).not.toHaveProperty('renditionStatus');
    expect(mediaItems[0]).toMatchObject({
      storagePath: 'private-posts/post-1/0/clip.mp4',
      mediaKind: 'video',
      contentType: 'video/mp4',
    });
  });

  it('seeds duration_seconds from the client report on the staged video path', async () => {
    const prepared = await prepareStagedMediaSubmission({
      fileName: 'clip.mp4',
      contentType: 'video/mp4',
      category: 'video',
      durationSeconds: 47.2,
    });
    const insertPostMediaItems = vi.fn();

    const result = await publishPreparedPost({
      adminSupabase: adminSupabaseDouble({
        storage: {
          from: vi.fn(() => ({
            info: vi.fn(async () => ({
              data: { size: 13 * 1024 * 1024, contentType: 'video/mp4' },
              error: null,
            })),
            copy: vi.fn(async () => ({ data: { path: 'posts/post-1/0/clip.mp4' }, error: null })),
            download: vi.fn(),
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
        createPostMediaRendition: vi.fn(),
      },
    });

    expect(result).toMatchObject({ ok: true });
    const [{ mediaItems }] = insertPostMediaItems.mock.calls[0];
    // Client-reported seed only: the rendition sweep's probe of the actual
    // file overwrites this and is the value of record.
    expect(mediaItems[0]).toMatchObject({ mediaKind: 'video', durationSeconds: 47.2 });
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

  it('cleans up only its destination when a copy fails ambiguously', async () => {
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
      ['private-posts/post-1/0/shot.png'],
    ]);
    // The source remains available for a retry and is not falsely marked gone.
    expect(clearedIntents).not.toHaveBeenCalled();
  });
});
