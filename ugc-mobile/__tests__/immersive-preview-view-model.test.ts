import { describe, expect, it } from 'vitest';

import {
  buildImmersiveGenerationItems,
  buildImmersiveOwnerPostItems,
  buildImmersiveShowcaseItems,
  getImmersiveHorizontalPageIndex,
  getImmersiveInitialIndex,
  hasImmersiveDetailsPage,
  immersivePreviewOpenHref,
  isImmersiveDetailsHorizontalPage,
  immersiveViewerHref,
  immersiveViewerReturnPath,
  selectActiveImmersiveVideoId,
  textPostViewerHref,
} from '../lib/immersive-preview-view-model';
import type { GenerationListItem, OwnerPostListItem, ShowcaseFeedItem } from '../lib/types';

function showcaseItem(overrides: Partial<ShowcaseFeedItem>): ShowcaseFeedItem {
  return {
    id: 'post-1',
    mediaUrl: null,
    mediaKind: null,
    model: 'manual',
    title: 'Beauty hook',
    prompt: 'Launch the serum with an opening shelf shot',
    body: 'Reusable creator prompt',
    category: 'image',
    postFormat: 'media',
    saveCount: 1200,
    remixCount: 92,
    commentCount: 0,
    createdAt: '2026-05-13T10:00:00.000Z',
    creator: { id: 'creator-1', username: 'luna', name: 'Luna', avatar: null },
    generationId: null,
    asset: null,
    canRemix: false,
    ...overrides,
  };
}

function generation(overrides: Partial<GenerationListItem>): GenerationListItem {
  return {
    id: 'gen-1',
    output_url: null,
    status: 'succeeded',
    created_at: '2026-05-13T10:00:00.000Z',
    completed_at: '2026-05-13T10:05:00.000Z',
    cost: 2,
    model: 'test-model',
    category: 'image',
    title: 'Portrait',
    prompt: 'Create a cinematic portrait',
    ...overrides,
  };
}

function ownerPost(overrides: Partial<OwnerPostListItem>): OwnerPostListItem {
  const id = overrides.id ?? 'owner-post-1';
  return {
    id,
    title: 'Launch post',
    createdAt: '2026-05-13T10:00:00.000Z',
    visibility: 'public',
    mediaUrl: null,
    mediaKind: null,
    commentCount: 0,
    description: 'Description',
    prompt: 'Prompt',
    body: 'Body copy',
    category: 'text',
    postFormat: 'text',
    publicPath: `/showcase/${id}`,
    bundle: null,
    ...overrides,
  };
}

describe('immersive preview view model', () => {
  it('builds the shared text-post viewer route for public and owner posts', () => {
    expect(textPostViewerHref({ postId: 'post-1' })).toBe('/post/post-1');
    expect(textPostViewerHref({ postId: 'private/post', source: 'profile-posts' }))
      .toBe('/post/private%2Fpost?source=profile-posts');
    expect(textPostViewerHref({ postId: 'saved-post', source: 'profile-saved' }))
      .toBe('/post/saved-post?source=profile-saved');
    expect(textPostViewerHref({ postId: 'saved/post', source: 'profile-saved', comments: true }))
      .toBe('/post/saved%2Fpost?source=profile-saved&comments=saved%2Fpost');
  });

  it('opens profile text posts in the reading screen and media in the reel', () => {
    const [savedText] = buildImmersiveShowcaseItems('profile-saved', [showcaseItem({
      id: 'saved-text',
      category: 'text',
      postFormat: 'text',
    })]);
    const [ownerText] = buildImmersiveOwnerPostItems('profile-posts', [ownerPost({
      id: 'owner-text',
      visibility: 'private',
    })], { creatorLabel: '@luna' });
    const [savedImage] = buildImmersiveShowcaseItems('profile-saved', [showcaseItem({
      id: 'saved-image',
      mediaUrl: 'https://cdn.example.com/image.jpg',
      mediaKind: 'image',
    })]);

    expect(immersivePreviewOpenHref(savedText!)).toBe('/post/saved-text?source=profile-saved');
    expect(immersivePreviewOpenHref(savedText!, { comments: true }))
      .toBe('/post/saved-text?source=profile-saved&comments=saved-text');
    expect(immersivePreviewOpenHref(ownerText!)).toBe('/post/owner-text?source=profile-posts');
    expect(immersivePreviewOpenHref(savedImage!)).toEqual({
      pathname: '/viewer',
      params: { source: 'profile-saved', initialId: 'saved-image' },
    });
  });

  it('maps showcase image, video, and text posts into viewer items', () => {
    const items = buildImmersiveShowcaseItems('showcase-feed', [
      showcaseItem({
        id: 'image-post',
        mediaUrl: 'https://cdn.example.com/image.jpg',
        mediaKind: 'image',
        title: 'Image post',
        saveCount: 1200,
        canRemix: true,
      }),
      showcaseItem({
        id: 'video-post',
        mediaUrl: 'https://cdn.example.com/video.mp4',
        mediaKind: 'video',
        category: 'video',
        title: '',
        prompt: 'Make a video',
      }),
      showcaseItem({
        id: 'text-post',
        mediaUrl: null,
        mediaKind: null,
        category: 'text',
        postFormat: 'text',
        body: 'Caption framework',
      }),
    ]);

    expect(items.map((item) => item.id)).toEqual(['image-post', 'video-post', 'text-post']);
    expect(items[0]).toMatchObject({
      source: 'showcase-feed',
      sourceType: 'showcase',
      mediaKind: 'image',
      title: 'Image post',
      creatorLabel: '@luna',
      creatorUsername: 'luna',
      saveLabel: '1.2K',
      canSave: true,
      canShare: true,
      recreateTool: 'image',
      recreatePrompt: 'Launch the serum with an opening shelf shot',
      details: {
        title: 'Image post',
        prompt: 'Launch the serum with an opening shelf shot',
        body: 'Reusable creator prompt',
        categoryLabel: 'Image',
        creatorLabel: '@luna',
        saveCount: 1200,
        remixCount: 92,
        unlock: null,
      },
    });
    expect(items[1]).toMatchObject({
      mediaKind: 'video',
      title: 'Make a video',
      badge: 'Video',
      recreateTool: 'video',
    });
    expect(items[2]).toMatchObject({
      mediaKind: null,
      previewKind: 'text',
      displayText: 'Caption framework',
      badge: 'Prompt',
      recreateTool: 'image',
    });
  });

  it('maps showcase resource metadata for viewer details', () => {
    const [item] = buildImmersiveShowcaseItems('showcase-feed', [
      showcaseItem({
        id: 'unlock-post',
        asset: {
          id: 'resource-1',
          postId: 'unlock-post',
          title: 'Creator prompt pack',
          accessMode: 'paid',
          priceUsdCents: 900,
          previewText: 'Unlock the reusable prompt.',
          allowRemix: true,
          resourceKinds: ['prompt', 'notes'],
          priceQuote: { formatted: '₹863 unlock' },
        },
      }),
    ]);

    expect(item.resource).toEqual({
      resourceId: 'resource-1',
      postId: 'unlock-post',
      title: 'Creator prompt pack',
      accessMode: 'paid',
      priceUsdCents: 900,
      previewText: 'Unlock the reusable prompt.',
      allowRemix: true,
      resourceKinds: ['prompt', 'notes'],
      priceQuote: { formatted: '₹863 unlock' },
    });
    expect(hasImmersiveDetailsPage(item)).toBe(true);
    expect(item.details?.unlock).toEqual({
      resourceId: 'resource-1',
      postId: 'unlock-post',
      title: 'Creator prompt pack',
      accessMode: 'paid',
      priceLabel: '₹863 unlock',
      previewText: 'Unlock the reusable prompt.',
      resourceKinds: ['prompt', 'notes'],
      allowRemix: true,
    });
  });

  it('uses save or unsave actions based on the current showcase saved state', () => {
    const items = buildImmersiveShowcaseItems('showcase-feed', [
      showcaseItem({ id: 'unsaved-post', isSaved: false }),
      showcaseItem({ id: 'saved-post', isSaved: true }),
    ]);

    expect(items[0].availableActions[0]).toBe('save');
    expect(items[1].availableActions[0]).toBe('unsave');
  });

  it('maps owner post bundle metadata for viewer details', () => {
    const [item] = buildImmersiveOwnerPostItems('profile-posts', [
      ownerPost({
        id: 'owner-unlock',
        bundle: {
          id: 'bundle-1',
          accessMode: 'free',
          status: 'published',
          priceUsdCents: 0,
          salesCount: 3,
          earningsUsdCents: 0,
          resourceKinds: ['prompt'],
        },
      }),
    ], {
      creatorLabel: '@batman',
      creatorAvatar: null,
    });

    expect(item.resource).toEqual({
      resourceId: 'bundle-1',
      postId: 'owner-unlock',
      title: 'Launch post',
      accessMode: 'free',
      priceUsdCents: 0,
      previewText: 'Body copy',
      allowRemix: false,
      resourceKinds: ['prompt'],
      priceQuote: undefined,
    });
    expect(hasImmersiveDetailsPage(item)).toBe(true);
    expect(item.details?.unlock).toMatchObject({
      resourceId: 'bundle-1',
      postId: 'owner-unlock',
      title: 'Launch post',
      accessMode: 'free',
      priceLabel: 'Free',
      resourceKinds: ['prompt'],
    });
  });

  it('maps generations with recreate metadata and unsupported save actions', () => {
    const items = buildImmersiveGenerationItems('profile-creations', [
      generation({
        id: 'motion-1',
        category: 'motion',
        output_url: 'https://cdn.example.com/motion.mp4',
        title: null,
        prompt: 'Animate the subject',
      }),
      generation({
        id: 'text-1',
        category: 'text',
        output_url: null,
        title: 'Caption set',
        prompt: 'Write three captions',
      }),
    ], {
      creatorLabel: '@batman',
      creatorAvatar: 'https://cdn.example.com/avatar.png',
    });

    expect(items[0]).toMatchObject({
      id: 'motion-1',
      sourceType: 'generation',
      mediaKind: 'video',
      badge: 'Motion',
      creatorLabel: '@batman',
      creatorAvatar: 'https://cdn.example.com/avatar.png',
      saveLabel: 'Saved',
      isSaved: true,
      canSave: false,
      canShare: true,
      sharePath: null,
      recreateTool: 'motion',
      recreatePrompt: 'Animate the subject',
    });
    expect(items[0].details).toBeDefined();
    expect(items[0].details?.generationInfo).toBeDefined();
    // Generations render in the reel now, so their details page carries the
    // generationInfo block the old card screen used to show inline.
    expect(hasImmersiveDetailsPage(items[0])).toBe(true);
    expect(items[1]).toMatchObject({
      previewKind: 'text',
      displayText: 'Write three captions',
      recreateTool: 'image',
    });
  });

  it('treats ugc-ad generations as video viewer items', () => {
    const [item] = buildImmersiveGenerationItems('profile-creations', [
      generation({
        id: 'ugc-ad-1',
        category: 'ugc-ad',
        output_url: 'https://cdn.example.com/ugc-ad.mp4',
        title: 'Creator ad',
        prompt: 'A creator ad spot',
      }),
    ], {
      creatorLabel: '@batman',
      creatorAvatar: null,
    });

    expect(item).toMatchObject({
      id: 'ugc-ad-1',
      mediaKind: 'video',
      badge: 'Video',
      recreateTool: 'video',
      details: {
        categoryLabel: 'Video',
      },
    });
  });

  it('maps owner posts with body, prompt, and title fallback for display text', () => {
    const items = buildImmersiveOwnerPostItems('profile-posts', [
      ownerPost({ id: 'body-post', body: 'Body wins', prompt: 'Prompt', title: 'Title' }),
      ownerPost({ id: 'prompt-post', body: '', prompt: 'Prompt wins', title: 'Title' }),
      ownerPost({ id: 'title-post', body: '', prompt: '', title: 'Title wins' }),
    ], {
      creatorLabel: '@batman',
      creatorAvatar: null,
    });

    expect(items.map((item) => item.displayText)).toEqual(['Body wins', 'Prompt wins', 'Title wins']);
    expect(items[0]).toMatchObject({
      sourceType: 'owner-post',
      creatorLabel: '@batman',
      commentCount: 0,
      canComment: true,
      canSave: false,
      canShare: true,
      sharePath: '/showcase/body-post',
      recreateTool: 'image',
      recreatePrompt: 'Prompt',
      details: {
        title: 'Title',
        prompt: 'Prompt',
        body: 'Body wins',
        categoryLabel: 'Prompt',
        sourceLabel: 'Post',
        creatorLabel: '@batman',
        unlock: null,
      },
    });

    const privateItems = buildImmersiveOwnerPostItems('profile-posts', [
      ownerPost({ id: 'private-post', visibility: 'private', publicPath: null }),
    ], {
      creatorLabel: '@batman',
      creatorAvatar: null,
    });

    expect(privateItems[0]).toMatchObject({
      canComment: false,
      canShare: true,
      sharePath: null,
    });
  });

  it('exposes real comments on active public owner posts', () => {
    const [item] = buildImmersiveOwnerPostItems('profile-posts', [
      ownerPost({ commentCount: 27, visibility: 'public' }),
    ], {
      creatorLabel: '@batman',
      creatorId: 'owner-1',
    });

    expect(item).toMatchObject({
      creatorId: 'owner-1',
      commentCount: 27,
      commentLabel: '27',
      canComment: true,
    });
  });

  it('resolves initial page index, source order, and active video id', () => {
    const items = buildImmersiveShowcaseItems('profile-saved', [
      showcaseItem({ id: 'first', mediaUrl: 'https://cdn.example.com/first.jpg', mediaKind: 'image' }),
      showcaseItem({ id: 'video', mediaUrl: 'https://cdn.example.com/video.mp4', mediaKind: 'video', category: 'video' }),
      showcaseItem({ id: 'last', mediaUrl: 'https://cdn.example.com/last.jpg', mediaKind: 'image' }),
    ]);

    expect(getImmersiveInitialIndex(items, 'video')).toBe(1);
    expect(getImmersiveInitialIndex(items, 'missing')).toBe(0);
    expect(items.map((item) => item.id)).toEqual(['first', 'video', 'last']);
    expect(selectActiveImmersiveVideoId(items, 1)).toBe('video');
    expect(selectActiveImmersiveVideoId(items, 1, 'video')).toBeNull();
    expect(selectActiveImmersiveVideoId(items, 0)).toBeNull();
  });

  it('keeps horizontal details paging on the left-swipe side of the media page', () => {
    expect(getImmersiveHorizontalPageIndex(false)).toBe(0);
    expect(getImmersiveHorizontalPageIndex(true)).toBe(1);
    expect(isImmersiveDetailsHorizontalPage(0)).toBe(false);
    expect(isImmersiveDetailsHorizontalPage(1)).toBe(true);
  });

  it('builds stable viewer hrefs with source context', () => {
    expect(immersiveViewerHref({ source: 'creator-profile', initialId: 'post-1' })).toEqual({
      pathname: '/viewer',
      params: {
        source: 'creator-profile',
        initialId: 'post-1',
      },
    });
    expect(immersiveViewerHref({ source: 'studio-creations', initialId: 'gen-1' })).toEqual({
      pathname: '/viewer',
      params: {
        source: 'studio-creations',
        initialId: 'gen-1',
      },
    });
    expect(immersiveViewerHref({
      source: 'showcase-feed',
      initialId: 'post-2',
      feedSessionId: 'session-1',
      algorithmVersion: 'hybrid-v1',
    })).toEqual({
      pathname: '/viewer',
      params: {
        source: 'showcase-feed',
        initialId: 'post-2',
        feedSessionId: 'session-1',
        algorithmVersion: 'hybrid-v1',
      },
    });
    expect(immersiveViewerReturnPath({
      source: 'showcase-feed',
      initialId: 'post 2',
      feedSessionId: 'session/1',
    })).toBe('/viewer?source=showcase-feed&initialId=post%202&feedSessionId=session%2F1');
  });

  describe('action builder available and disabled actions', () => {
    it('returns correct actions for saved media', () => {
      const [item] = buildImmersiveShowcaseItems('profile-saved', [showcaseItem({ id: 'saved-item', generationId: 'gen-saved', canRemix: true })]);
      expect(item.availableActions).toEqual(['unsave', 'comment', 'share', 'recreate', 'view-details', 'open-original']);
      expect(item.disabledActions).toEqual({});
    });

    it('keeps recreate locked for paid remix unlocks until the viewer has access', () => {
      const [lockedItem, unlockedItem] = buildImmersiveShowcaseItems('showcase-feed', [
        showcaseItem({
          id: 'locked-paid-remix-post',
          generationId: 'gen-paid',
          canRemix: false,
          asset: {
            id: 'asset-paid-remix',
            postId: 'locked-paid-remix-post',
            title: 'Paid remix kit',
            accessMode: 'paid',
            priceUsdCents: 900,
            previewText: 'Unlock remix access.',
            allowRemix: true,
            resourceKinds: ['prompt', 'remix'],
            priceQuote: { formatted: '$9' },
          },
        }),
        showcaseItem({
          id: 'unlocked-paid-remix-post',
          generationId: 'gen-paid-unlocked',
          canRemix: true,
          asset: {
            id: 'asset-paid-remix-unlocked',
            postId: 'unlocked-paid-remix-post',
            title: 'Paid remix kit',
            accessMode: 'paid',
            priceUsdCents: 900,
            previewText: 'Unlock remix access.',
            allowRemix: true,
            resourceKinds: ['prompt', 'remix'],
            priceQuote: { formatted: '$9' },
          },
        }),
      ]);

      expect(lockedItem.availableActions).toEqual(['save', 'comment', 'share', 'unlock-remix', 'view-details', 'open-original']);
      expect(unlockedItem.availableActions).toContain('recreate');
    });

    it('does not offer recreate for showcase posts that were not created in the app', () => {
      const [item] = buildImmersiveShowcaseItems('showcase-feed', [
        showcaseItem({ id: 'manual-showcase-post', generationId: null, canRemix: true }),
      ]);

      expect(item.availableActions).toEqual(['save', 'comment', 'share', 'view-details', 'open-original']);
      expect(item.generationId).toBeNull();
    });

    it('returns correct actions for unposted creation', () => {
      const [item] = buildImmersiveGenerationItems('profile-creations', [
        generation({ id: 'unposted-gen', linked_post_id: null, archived_at: null }),
      ], { creatorLabel: '@batman' });
      expect(item.availableActions).toEqual(['publish', 'recreate', 'archive', 'share', 'view-details']);
      expect(item.disabledActions).toEqual({});
    });

    it('returns web-parity actions for a public linked creation with an unlock', () => {
      const [item] = buildImmersiveGenerationItems('profile-creations', [
        generation({ id: 'linked-gen', linked_post_id: 'post-123', archived_at: null }),
      ], { creatorLabel: '@batman' }, [
        ownerPost({
          id: 'post-123',
          generationId: 'linked-gen',
          visibility: 'public',
          bundle: {
            id: 'bundle-1',
            accessMode: 'paid',
            status: 'published',
            priceUsdCents: 900,
            salesCount: 2,
            earningsUsdCents: 1800,
            resourceKinds: ['prompt'],
          },
        }),
      ]);
      expect(item.availableActions).toEqual(['edit-linked-resources', 'make-private', 'view-linked', 'recreate', 'archive', 'share', 'view-details']);
      expect(item.linkedPostBundle).toMatchObject({ id: 'bundle-1', accessMode: 'paid' });
      expect(item.linkedPostVisibility).toBe('public');
      expect(item.disabledActions).toEqual({});
    });

    it('returns add-unlock and make-public actions for a private linked creation without an unlock', () => {
      const [item] = buildImmersiveGenerationItems('profile-creations', [
        generation({ id: 'private-gen', linked_post_id: 'post-private', archived_at: null }),
      ], { creatorLabel: '@batman' }, [
        ownerPost({
          id: 'post-private',
          generationId: 'private-gen',
          visibility: 'private',
          publicPath: null,
          bundle: null,
        }),
      ]);

      expect(item.availableActions).toEqual(['edit-linked-resources', 'make-public', 'view-linked', 'recreate', 'archive', 'share', 'view-details']);
      expect(item.linkedPostBundle).toBeNull();
      expect(item.linkedPostVisibility).toBe('private');
    });

    it('uses open-post instead of visibility toggle for unlisted linked creations', () => {
      const [item] = buildImmersiveGenerationItems('profile-creations', [
        generation({ id: 'unlisted-gen', linked_post_id: 'post-unlisted', archived_at: null }),
      ], { creatorLabel: '@batman' }, [
        ownerPost({
          id: 'post-unlisted',
          generationId: 'unlisted-gen',
          visibility: 'unlisted',
          publicPath: '/showcase/post-unlisted',
          bundle: null,
        }),
      ]);

      expect(item.availableActions).toEqual(['edit-linked-resources', 'view-linked', 'recreate', 'archive', 'share', 'view-details']);
      expect(item.linkedPostVisibility).toBe('unlisted');
      expect(item.linkedPostPath).toBe('/showcase/post-unlisted');
    });

    it('returns correct actions for active owner post', () => {
      const [item] = buildImmersiveOwnerPostItems('profile-posts', [
        ownerPost({ id: 'active-post', archivedAt: null }),
      ], { creatorLabel: '@batman' });
      expect(item.isManualOwnerPost).toBe(true);
      expect(item.availableActions).toEqual(['edit-post', 'change-visibility', 'archive', 'delete-post', 'share', 'download', 'view-details']);
      expect(item.disabledActions).toEqual({});
    });

    it('returns correct actions for archived owner post', () => {
      const [item] = buildImmersiveOwnerPostItems('profile-posts', [
        ownerPost({ id: 'archived-post', archivedAt: '2026-06-10T00:00:00Z' }),
      ], { creatorLabel: '@batman' });
      expect(item.isManualOwnerPost).toBe(true);
      expect(item.availableActions).toEqual(['restore', 'delete-post', 'share', 'download', 'view-details']);
      expect(item.disabledActions).toEqual({
        'edit-post': 'This post is archived',
        'change-visibility': 'This post is archived',
      });
    });

    it('does not offer permanent delete for generated owner posts', () => {
      const [item] = buildImmersiveOwnerPostItems('profile-posts', [
        ownerPost({ id: 'generated-post', generationId: 'gen-1', archivedAt: null }),
      ], { creatorLabel: '@batman' });
      expect(item.isManualOwnerPost).toBe(false);
      expect(item.generationId).toBe('gen-1');
      expect(item.availableActions).toEqual(['edit-post', 'change-visibility', 'archive', 'share', 'download', 'recreate', 'view-details']);
    });

    it('returns correct actions for archived creation', () => {
      const [item] = buildImmersiveGenerationItems('profile-creations', [
        generation({ id: 'archived-gen', archived_at: '2026-06-10T00:00:00Z' }),
      ], { creatorLabel: '@batman' });
      expect(item.availableActions).toEqual(['restore', 'view-details']);
      expect(item.disabledActions).toEqual({
        publish: 'This creation is archived',
        recreate: 'This creation is archived',
        archive: 'This creation is archived',
        share: 'This creation is archived',
      });
    });
  });
});
