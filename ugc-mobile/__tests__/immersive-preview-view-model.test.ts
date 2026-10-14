import { describe, expect, it } from 'vitest';

import mobileApiContract from '../../contracts/mobile-api-v1.json';
import {
  buildImmersiveGenerationItems,
  getImmersiveStatusSlide,
  buildImmersiveOwnerPostItems,
  buildImmersiveShowcaseItems,
  getImmersiveInitialIndex,
  hasImmersiveDetailsPage,
  immersivePreviewOpenHref,
  immersiveViewerHref,
  immersiveViewerReturnPath,
  selectActiveImmersiveVideoId,
  showcaseFeedItemOpenHref,
  textPostViewerHref,
} from '../lib/immersive-preview-view-model';
import { buildGenerationStats, getDetailsPrimaryAction } from '../lib/post-details-view-model';
import { getViewerActionSlots, getViewerStateChip } from '../lib/viewer-actions';
import { getShowcasePlaybackUrl } from '../lib/showcase-media';
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
    // A succeeded run has media. Tests that want a run with none say so.
    output_url: 'https://cdn.example.com/gen-1.jpg',
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

/** An owned post with a picture, where the default one is a post of words. */
const ownerPostMedia: Partial<OwnerPostListItem> = {
  mediaUrl: 'https://cdn.example.com/owner-post.jpg',
  mediaKind: 'image',
  category: 'image',
  postFormat: 'media',
};

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
  it('carries Explore media-only scope into the reel and auth return', () => {
    const href = showcaseFeedItemOpenHref({ item: showcaseItem({}), source: 'showcase-feed', mediaOnly: true });
    expect(href).toMatchObject({ params: { mediaOnly: '1' } });
    expect(immersiveViewerReturnPath({ source: 'showcase-feed', initialId: 'post-1', mediaOnly: true })).toContain('mediaOnly=1');
    expect(immersiveViewerHref({ source: 'showcase-feed', initialId: 'post-1' })).not.toHaveProperty('params.mediaOnly');
  });
  it('keeps the creation descriptor on its matching output for playback and poster metadata', () => {
    const original = 'https://cdn.example.com/original.mp4';
    const rendition = 'https://cdn.example.com/playback.mp4';
    const media = {
      id: 'gen-1', kind: 'video' as const, url: original, renditionUrl: rendition,
      previewUrl: 'https://cdn.example.com/poster.webp', thumbhash: 'poster-hash',
      cacheKey: 'poster-object', expiresAt: '2026-09-06T12:00:00Z',
      width: 610, height: 1280, durationSeconds: 11.4,
      status: 'ready' as const, gridReady: true,
    };
    // The descriptor describes the primary output, which need not be the
    // first member of the legacy multi-output array.
    const [item] = buildImmersiveGenerationItems('studio-creations', [generation({
      category: 'video', output_url: original,
      output_urls: ['https://cdn.example.com/other.mp4', original], media,
    })], { creatorLabel: 'You' });
    const [other, primary] = item.mediaItems;
    expect(getShowcasePlaybackUrl(primary)).toBe(rendition);
    expect(primary.url).toBe(original);
    expect(primary.preview).toEqual(media);
    expect(primary).toMatchObject({
      previewUrl: media.previewUrl, width: 610, height: 1280, durationSeconds: 11.4,
    });
    expect(getShowcasePlaybackUrl(other)).toBe('https://cdn.example.com/other.mp4');
    expect(other.previewUrl).toBeNull();
  });

  it('reads a post\'s description as its story when it has no body, as the owner view does', () => {
    const [captionOnly, both, neither] = buildImmersiveShowcaseItems('showcase-feed', [
      showcaseItem({ id: 'caption-only', body: '', description: '  Written in the web composer.  ' }),
      showcaseItem({ id: 'both', body: 'The body wins.', description: 'A separate caption.' }),
      showcaseItem({ id: 'neither', body: '' }),
    ]);

    expect(captionOnly.details?.body).toBe('Written in the web composer.');
    expect(both.details?.body).toBe('The body wins.');
    expect(neither.details?.body).toBe('');
  });

  it('labels a motion post Motion, which its video category alone would not', () => {
    const [motion] = buildImmersiveShowcaseItems('showcase-feed', [showcaseItem({
      category: 'video',
      mediaKind: 'video',
      mediaUrl: 'https://cdn.example.com/dance.mp4',
      creationMode: 'motion',
    })]);

    expect(motion).toMatchObject({ badge: 'Motion', recreateTool: 'motion' });
  });

  it('builds the shared text-post viewer route for public and owner posts', () => {
    expect(textPostViewerHref({ postId: 'post-1' })).toBe('/post/post-1');
    expect(textPostViewerHref({ postId: 'private/post', source: 'profile-posts' }))
      .toBe('/post/private%2Fpost?source=profile-posts');
    expect(textPostViewerHref({ postId: 'saved-post', source: 'profile-saved' }))
      .toBe('/post/saved-post?source=profile-saved');
    expect(textPostViewerHref({ postId: 'saved/post', source: 'profile-saved', comments: true }))
      .toBe('/post/saved%2Fpost?source=profile-saved&comments=saved%2Fpost');
    // A Home card's delivery rides along, for the comments written there.
    expect(textPostViewerHref({ postId: 'post-1', comments: true, deliveryId: '9001' }))
      .toBe('/post/post-1?comments=post-1&deliveryId=9001');
    expect(textPostViewerHref({ postId: 'post-1', deliveryId: null })).toBe('/post/post-1');
  });

  it('opens showcase-feed text posts in the reading screen from every surface', () => {
    const textPost = showcaseItem({ id: 'text-1', category: 'text', postFormat: 'text' });

    // Creator profile: the tile renders as text, so the tap must agree.
    expect(showcaseFeedItemOpenHref({
      item: textPost,
      source: 'creator-profile',
      creatorUsername: 'luna',
    })).toBe('/post/text-1');

    // Showcase tab: feed-session context is irrelevant to a text post.
    expect(showcaseFeedItemOpenHref({
      item: textPost,
      source: 'showcase-feed',
      feedSessionId: 'session-1',
      algorithmVersion: 'v3',
    })).toBe('/post/text-1');

    expect(showcaseFeedItemOpenHref({ item: textPost, source: 'showcase-feed', comments: true }))
      .toBe('/post/text-1?comments=text-1');
  });

  it('keeps media posts in the reel and preserves their viewer context', () => {
    expect(showcaseFeedItemOpenHref({
      item: showcaseItem({ id: 'media-1', mediaUrl: 'https://cdn.test/a.jpg', mediaKind: 'image' }),
      source: 'creator-profile',
      creatorUsername: 'luna',
    })).toEqual({
      pathname: '/viewer',
      params: { source: 'creator-profile', initialId: 'media-1', creatorUsername: 'luna' },
    });

    expect(showcaseFeedItemOpenHref({
      item: showcaseItem({ id: 'media-2', mediaUrl: 'https://cdn.test/b.mp4', mediaKind: 'video' }),
      source: 'showcase-feed',
      feedSessionId: 'session-1',
      algorithmVersion: 'v3',
    })).toEqual({
      pathname: '/viewer',
      params: {
        source: 'showcase-feed',
        initialId: 'media-2',
        feedSessionId: 'session-1',
        algorithmVersion: 'v3',
      },
    });
  });

  it('treats a text-category post that carries media as a reel post', () => {
    // `isTextOnlyShowcasePost` requires the absence of media — a text post with an
    // attached image still has something to fill the reel.
    expect(showcaseFeedItemOpenHref({
      item: showcaseItem({
        id: 'text-with-media',
        category: 'text',
        postFormat: 'text',
        mediaUrl: 'https://cdn.test/c.jpg',
        mediaKind: 'image',
      }),
      source: 'creator-profile',
    })).toEqual({
      pathname: '/viewer',
      params: { source: 'creator-profile', initialId: 'text-with-media' },
    });
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
    expect(immersivePreviewOpenHref(savedImage!, { initialPage: 'details', initialSection: 'story' })).toMatchObject({
      pathname: '/viewer', params: { initialId: savedImage!.id, initialPage: 'details', initialSection: 'story' },
    });
    expect(immersivePreviewOpenHref(savedText!, { initialPage: 'details' }))
      .toBe('/post/saved-text?source=profile-saved');
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
      // In credits, as the unlock is paid in the app, never the web's cash quote.
      priceLabel: '900 credits',
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

  it("offers Edit post on the viewer's own showcase post and on no one else's", () => {
    const [own, other] = buildImmersiveShowcaseItems('showcase-feed', [
      showcaseItem({ id: 'post-own', creator: { id: 'viewer-1', username: 'me', name: 'Me', avatar: null } }),
      showcaseItem({ id: 'post-other' }),
    ], 'viewer-1');
    expect(own.availableActions[0]).toBe('edit-post');
    expect(other.availableActions).not.toContain('edit-post');
    // Signed out, nothing is editable.
    const [anonymous] = buildImmersiveShowcaseItems('showcase-feed', [showcaseItem({ id: 'post-own' })]);
    expect(anonymous.availableActions).not.toContain('edit-post');
  });

  it('turns comments off on an unlisted post, which the server takes no comments on', () => {
    const [unlisted, listed] = buildImmersiveShowcaseItems('showcase-feed', [
      showcaseItem({ id: 'post-unlisted', visibility: 'unlisted' }),
      showcaseItem({ id: 'post-public', visibility: 'public' }),
    ]);
    expect(unlisted.canComment).toBe(false);
    expect(listed.canComment).toBe(true);
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
      // Shared as its post, and it has none yet: Publish is the way to a link.
      canShare: false,
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

  it('carries the lane a tile was tapped in to the reel, and back to it after sign-in', () => {
    const lane = 'sort:for-you,category:media,unlock:free';
    expect(showcaseFeedItemOpenHref({ item: showcaseItem({}), source: 'showcase-feed', mediaOnly: true, lane }))
      .toMatchObject({ params: { source: 'showcase-feed', initialId: 'post-1', mediaOnly: '1', lane } });
    expect(immersiveViewerHref({ source: 'showcase-feed', initialId: 'post-1', lane, initialPage: 'details' }))
      .toMatchObject({ params: { lane, initialPage: 'details' } });
    expect(immersiveViewerReturnPath({ source: 'showcase-feed', initialId: 'post-1', lane }))
      .toBe('/viewer?source=showcase-feed&initialId=post-1&lane=sort%3Afor-you%2Ccategory%3Amedia%2Cunlock%3Afree');
    // No lane, no parameter: a link opens the reel's own window, as before.
    expect(immersiveViewerHref({ source: 'showcase-feed', initialId: 'post-1' })).not.toHaveProperty('params.lane');
  });

  describe('action builder available and disabled actions', () => {
    it('returns correct actions for saved media', () => {
      const [item] = buildImmersiveShowcaseItems('profile-saved', [showcaseItem({ id: 'saved-item', generationId: 'gen-saved', canRemix: true })]);
      expect(item.availableActions).toEqual(['unsave', 'comment', 'share', 'recreate', 'view-details']);
      expect(item.disabledActions).toEqual({});
    });

    it('lists Comments only on a post that takes comments, and never opens a second reel of itself', () => {
      // The rail hid Comments on an unlisted post while the ••• row stayed and
      // did nothing; "Open original post" pushed another reel of the same post.
      const [unlisted, listed] = buildImmersiveShowcaseItems('showcase-feed', [
        showcaseItem({ id: 'post-unlisted', visibility: 'unlisted' }),
        showcaseItem({ id: 'post-public', visibility: 'public' }),
      ]);
      expect(unlisted.availableActions).toEqual(['save', 'share', 'view-details']);
      expect(listed.availableActions).toEqual(['save', 'comment', 'share', 'view-details']);
      expect([...unlisted.availableActions, ...listed.availableActions]).not.toContain('open-original');
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

      expect(lockedItem.availableActions).toEqual(['save', 'comment', 'share', 'unlock-remix', 'view-details']);
      expect(lockedItem.remixAccess).toBe('paid-unlock');
      expect(unlockedItem.availableActions).toContain('recreate');
      expect(unlockedItem.remixAccess).toBe('open');
    });

    it('offers a plain Remix when it sits behind a free unlock', () => {
      // Used to offer neither action, so the reel had no Remix at all for a
      // post whose creator gave the remix away.
      const [item] = buildImmersiveShowcaseItems('showcase-feed', [
        showcaseItem({
          id: 'locked-free-remix-post',
          generationId: 'gen-free',
          category: 'video',
          canRemix: false,
          remixCapability: 'unlock_required',
          remixTarget: 'video',
          asset: {
            id: 'asset-free-remix',
            postId: 'locked-free-remix-post',
            title: 'Trending',
            accessMode: 'free',
            priceUsdCents: 0,
            previewText: 'The prompt behind this video.',
            allowRemix: true,
            resourceKinds: ['prompt'],
          },
        }),
      ]);

      expect(item.availableActions).toEqual(['save', 'comment', 'share', 'recreate', 'view-details']);
      // The tap claims the unlock on the way: this is what tells it to.
      expect(item.remixAccess).toBe('free-unlock');
      expect(getViewerActionSlots(item).find((slot) => slot.id === 'create')).toMatchObject({
        action: 'recreate',
        label: 'Remix',
      });
      expect(getDetailsPrimaryAction(item, { canAccess: false })).toEqual({ label: 'Remix' });
    });

    it('does not offer recreate for showcase posts that were not created in the app', () => {
      const [item] = buildImmersiveShowcaseItems('showcase-feed', [
        showcaseItem({ id: 'manual-showcase-post', generationId: null, canRemix: true }),
      ]);

      expect(item.availableActions).toEqual(['save', 'comment', 'share', 'view-details']);
      expect(item.generationId).toBeNull();
    });

    it('returns correct actions for unposted creation', () => {
      const [item] = buildImmersiveGenerationItems('profile-creations', [
        generation({ id: 'unposted-gen', linked_post_id: null, archived_at: null }),
      ], { creatorLabel: '@batman' });
      expect(item.availableActions).toEqual(['publish', 'recreate', 'archive', 'delete-creation', 'download', 'view-details']);
      expect(item.disabledActions).toEqual({});
    });

    it('offers a failed run another go, and nothing it cannot do', () => {
      const [item] = buildImmersiveGenerationItems('studio-creations', [
        generation({ id: 'failed-gen', output_url: null, status: 'failed', linked_post_id: null }),
      ], { creatorLabel: '@batman' });

      // Nothing came back from the model, so there is nothing to publish or
      // share -- only the prompt, and another attempt at it.
      expect(item.availableActions).toEqual(['recreate', 'archive', 'delete-creation', 'view-details']);
      // The rail reads canShare directly, and sharing an unposted creation
      // means publishing it first.
      expect(item.canShare).toBe(false);
      expect(getViewerActionSlots(item).map((slot) => slot.id)).toEqual(['details', 'create']);
      expect(item.runStatus).toBe('failed');
      expect(item.mediaItems).toEqual([]);
      expect(getImmersiveStatusSlide(item).title).toBe('This render failed');
    });

    it('says a run is still going rather than that it failed', () => {
      const [item] = buildImmersiveGenerationItems('studio-creations', [
        generation({ id: 'running-gen', output_url: null, status: 'processing' }),
      ], { creatorLabel: '@batman' });

      expect(getImmersiveStatusSlide(item).title).toBe('Still rendering');
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
      expect(item.availableActions).toEqual(['edit-linked-resources', 'change-linked-visibility', 'view-linked', 'recreate', 'archive', 'delete-creation', 'share', 'download', 'view-details']);
      expect(item.linkedPostBundle).toMatchObject({ id: 'bundle-1', accessMode: 'paid' });
      expect(item.linkedPostVisibility).toBe('public');
      expect(item.disabledActions).toEqual({});
    });

    it('returns add-unlock and change-visibility actions for a private linked creation without an unlock', () => {
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

      // A private post has no link to send: Share is not offered until it is public or unlisted.
      expect(item.availableActions).toEqual(['edit-linked-resources', 'change-linked-visibility', 'view-linked', 'recreate', 'archive', 'delete-creation', 'download', 'view-details']);
      expect(item.canShare).toBe(false);
      expect(item.sharePath).toBeNull();
      expect(item.linkedPostBundle).toBeNull();
      expect(item.linkedPostVisibility).toBe('private');
    });

    // The old two-way toggle had no state to offer an unlisted post; the
    // three-state picker covers it like any other.
    it('offers the visibility picker for unlisted linked creations too', () => {
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

      expect(item.availableActions).toEqual(['edit-linked-resources', 'change-linked-visibility', 'view-linked', 'recreate', 'archive', 'delete-creation', 'share', 'download', 'view-details']);
      expect(item.linkedPostVisibility).toBe('unlisted');
      expect(item.linkedPostPath).toBe('/showcase/post-unlisted');
    });

    it('returns correct actions for active owner post', () => {
      const [item] = buildImmersiveOwnerPostItems('profile-posts', [
        ownerPost({ id: 'active-post', archivedAt: null, ...ownerPostMedia }),
      ], { creatorLabel: '@batman' });
      expect(item.isManualOwnerPost).toBe(true);
      expect(item.availableActions).toEqual(['edit-post', 'change-visibility', 'archive', 'delete-post', 'share', 'download', 'view-details']);
      expect(item.disabledActions).toEqual({});
    });

    // Delete used to be offered only for uploaded posts; a post made from a
    // creation could not be deleted from the phone at all, while the web
    // offered it on every post.
    it('offers delete for a generation-backed owner post too', () => {
      const [item] = buildImmersiveOwnerPostItems('profile-posts', [
        ownerPost({ id: 'generated-post', archivedAt: null, generationId: 'gen-1', ...ownerPostMedia }),
      ], { creatorLabel: '@batman' });
      expect(item.isManualOwnerPost).toBe(false);
      expect(item.generationId).toBe('gen-1');
      expect(item.availableActions).toEqual(['edit-post', 'change-visibility', 'archive', 'delete-post', 'share', 'download', 'recreate', 'view-details']);
    });

    it('returns correct actions for archived owner post', () => {
      const [item] = buildImmersiveOwnerPostItems('profile-posts', [
        ownerPost({ id: 'archived-post', archivedAt: '2026-06-10T00:00:00Z', ...ownerPostMedia }),
      ], { creatorLabel: '@batman' });
      expect(item.isManualOwnerPost).toBe(true);
      expect(item.availableActions).toEqual(['restore', 'delete-post', 'share', 'download', 'view-details']);
      expect(item.disabledActions).toEqual({
        'edit-post': 'This post is archived',
        'change-visibility': 'This post is archived',
      });
    });

    it('offers no Download on a post of words, which has no file to save', () => {
      // The row only ever answered "No media file" there.
      const [active, archived] = buildImmersiveOwnerPostItems('profile-posts', [
        ownerPost({ id: 'note', archivedAt: null }),
        ownerPost({ id: 'old-note', archivedAt: '2026-06-10T00:00:00Z' }),
      ], { creatorLabel: '@batman' });
      expect(active.previewKind).toBe('text');
      expect(active.availableActions).toEqual(['edit-post', 'change-visibility', 'archive', 'delete-post', 'share', 'view-details']);
      expect(archived.availableActions).toEqual(['restore', 'delete-post', 'share', 'view-details']);
    });

    it('returns correct actions for archived creation', () => {
      const [item] = buildImmersiveGenerationItems('profile-creations', [
        generation({ id: 'archived-gen', archived_at: '2026-06-10T00:00:00Z' }),
      ], { creatorLabel: '@batman' });
      expect(item.availableActions).toEqual(['restore', 'delete-creation', 'view-details']);
      expect(item.canShare).toBe(false);
      expect(item.disabledActions).toEqual({
        publish: 'This creation is archived',
        recreate: 'This creation is archived',
        archive: 'This creation is archived',
        share: 'This creation is archived',
      });
    });
  });
});

/** An example the shared contract documents for `GET /api/generations`. */
function contractGeneration(id: string): GenerationListItem {
  const example = mobileApiContract.endpoints.listGenerations.response.generations.find((item) => item.id === id);
  if (!example) throw new Error(`No ${id} in the listGenerations fixture`);
  return example as unknown as GenerationListItem;
}

const owner = { creatorLabel: '@batman' };

describe('a failed run says what came back and why', () => {
  // The row keeps its cost after settlement returns it, so "Cost: 40 credits"
  // read as a charge for a run that cost nothing (audit 02-1).
  it('leads its status page with the credits returned, then the reason, for the contract example', () => {
    const [item] = buildImmersiveGenerationItems('studio-creations', [contractGeneration('failed-video-1')], owner);

    expect(getImmersiveStatusSlide(item)).toEqual({
      title: 'This render failed',
      body: '40 credits returned. This model would not accept the reference image because it looks like a photo of a real person. Try a reference image without a recognisable face, or generate this with a different video model.',
    });
  });

  it('says one credit in the singular', () => {
    const [item] = buildImmersiveGenerationItems('studio-creations', [
      generation({ status: 'failed', output_url: null, cost: 1, refunded: true, error_message: null }),
    ], owner);

    expect(getImmersiveStatusSlide(item).body).toMatch(/^1 credit returned\. No image came back from the model/);
  });

  it('shows no cost on the details slide for a refunded run, and what came back instead', () => {
    const [item] = buildImmersiveGenerationItems('studio-creations', [contractGeneration('failed-video-1')], owner);

    const stats = buildGenerationStats(item.details?.generationInfo);
    expect(stats.find((stat) => stat.label === 'Cost')).toBeUndefined();
    expect(stats).toContainEqual({ label: 'Returned', value: '40 credits' });
    expect(item.details?.generationInfo).toMatchObject({ refunded: true, failureReason: expect.stringMatching(/^This model would not accept/) });
  });

  it('keeps the cost of a failed run that was not refunded, and still gives its reason', () => {
    const [item] = buildImmersiveGenerationItems('studio-creations', [
      generation({ status: 'failed', output_url: null, cost: 40, refunded: false, error_message: 'The provider timed out.' }),
    ], owner);

    expect(buildGenerationStats(item.details?.generationInfo)).toContainEqual({ label: 'Cost', value: '40 credits' });
    expect(getImmersiveStatusSlide(item).body).toBe('The provider timed out.');
  });

  it('calls its Recreate "Try again" on the details page', () => {
    const [item] = buildImmersiveGenerationItems('studio-creations', [contractGeneration('failed-video-1')], owner);

    expect(getDetailsPrimaryAction(item, { canAccess: false })).toEqual({ label: 'Try again' });
    expect(getViewerActionSlots(item).find((slot) => slot.id === 'create')?.label).toBe('Try again');
  });
});

describe('a run still in flight', () => {
  it('says it is rendering while it waits for the provider, not that it has no file', () => {
    const [item] = buildImmersiveGenerationItems('profile-creations', [
      generation({ id: 'queued', status: 'pending', output_url: null }),
    ], owner);

    expect(getImmersiveStatusSlide(item).title).toBe('Still rendering');
  });

  // Its credits are held until the run settles, and only the row can settle it.
  it('is not offered Delete until it has settled', () => {
    const [item] = buildImmersiveGenerationItems('profile-creations', [
      generation({ id: 'running', status: 'processing', output_url: null }),
    ], owner);

    expect(item.availableActions).not.toContain('delete-creation');
  });
});

describe('a creation moderation removed', () => {
  const removed = () => buildImmersiveGenerationItems('profile-creations', [
    generation({
      id: 'removed',
      archived_at: '2026-10-01T00:00:00.000Z',
      moderation_removed_at: '2026-10-01T00:00:00.000Z',
    }),
  ], owner)[0];

  // Restore refuses it with "Creation not found." (audit 01-5).
  it('offers Delete and no Restore', () => {
    expect(removed().availableActions).toEqual(['delete-creation', 'view-details']);
  });

  it('draws none of its media, and its status page and chip say why', () => {
    const item = removed();

    expect(item.mediaItems).toEqual([]);
    expect(item.mediaUrl).toBeNull();
    expect(getImmersiveStatusSlide(item).title).toBe('Removed by moderation');
    expect(getViewerStateChip(item)).toEqual({ label: 'Removed by moderation', tone: 'danger' });
  });
});

describe("a template's output", () => {
  const template = (runStatus: 'succeeded' | 'cancelled' | 'failed', overrides: Partial<GenerationListItem> = {}) => (
    buildImmersiveGenerationItems('profile-creations', [
      generation({
        id: `template-${runStatus}`,
        origin: 'template',
        prompt: null,
        title: null,
        template: { runId: 'run-7', templateId: 'template-1', templateTitle: 'Product reveal', runStatus },
        ...overrides,
      }),
    ], owner)[0]
  );

  // The server refuses to recreate, archive or delete it (audit 01-3).
  it('offers Open run, and never Recreate, Archive or Delete', () => {
    expect(template('succeeded').availableActions).toEqual(['publish', 'open-run', 'download', 'view-details']);
    expect(template('succeeded').templateRun).toEqual({ runId: 'run-7', endedAs: null });
  });

  it('is named by its template, or "Template result" without one', () => {
    expect(template('succeeded').title).toBe('Product reveal');
    expect(template('succeeded', {
      template: { runId: 'run-7', templateId: 'template-1', templateTitle: null, runStatus: 'succeeded' },
    }).title).toBe('Template result');
  });

  // Only a succeeded run's result can be posted.
  it('notes the end of a run that did not succeed, and offers no Publish for its steps', () => {
    const cancelled = template('cancelled');
    const failed = template('failed');

    expect(cancelled.availableActions).toEqual(['open-run', 'download', 'view-details']);
    expect(failed.availableActions).toEqual(['open-run', 'download', 'view-details']);
    expect(getViewerStateChip(cancelled)).toEqual({ label: 'From template · run cancelled', tone: 'warning' });
    expect(getViewerStateChip(failed)).toEqual({ label: 'From template · run failed', tone: 'warning' });
    expect(cancelled.displayText).toBe('A finished step of a template run that was cancelled. Open the run to see every step.');
  });
});

describe('Share on a creation', () => {
  const linked = (visibility: string, overrides: Partial<GenerationListItem> = {}) => (
    buildImmersiveGenerationItems('profile-creations', [
      generation({ id: 'linked', linked_post_id: 'post-9', linked_post_visibility: visibility, ...overrides }),
    ], owner)[0]
  );

  // It always opened the composer, which then sent a posted creation to its
  // post: two hops and no share sheet (audit 01-6).
  it('shares the link of a public or unlisted post', () => {
    expect(linked('public')).toMatchObject({ canShare: true, sharePath: '/showcase/post-9' });
    expect(linked('unlisted')).toMatchObject({ canShare: true, sharePath: '/showcase/post-9' });
  });

  it('offers nothing to share for a private post, an archived post, or an archived creation', () => {
    expect(linked('private')).toMatchObject({ canShare: false, sharePath: null });
    expect(linked('public', { linked_post_archived_at: '2026-10-01T00:00:00.000Z' })).toMatchObject({ canShare: false, sharePath: null });
    expect(linked('public', { archived_at: '2026-10-01T00:00:00.000Z' }).canShare).toBe(false);
  });
});
