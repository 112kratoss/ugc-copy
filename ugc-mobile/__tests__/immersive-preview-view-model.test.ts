import { describe, expect, it } from 'vitest';

import {
  buildImmersiveGenerationItems,
  buildImmersiveOwnerPostItems,
  buildImmersiveShowcaseItems,
  getImmersiveHorizontalPageIndex,
  getImmersiveInitialIndex,
  hasImmersiveDetailsPage,
  isImmersiveDetailsHorizontalPage,
  immersiveViewerHref,
  selectActiveImmersiveVideoId,
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
      canSave: false,
      canShare: true,
      sharePath: null,
      recreateTool: 'motion',
      recreatePrompt: 'Animate the subject',
    });
    expect(items[0].details).toBeUndefined();
    expect(hasImmersiveDetailsPage(items[0])).toBe(false);
    expect(items[1]).toMatchObject({
      previewKind: 'text',
      displayText: 'Write three captions',
      recreateTool: 'image',
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
      ownerPost({ id: 'private-post', publicPath: null }),
    ], {
      creatorLabel: '@batman',
      creatorAvatar: null,
    });

    expect(privateItems[0]).toMatchObject({
      canShare: true,
      sharePath: null,
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
    expect(immersiveViewerHref({ source: 'studio-creations', initialId: 'gen-1' })).toEqual({
      pathname: '/viewer',
      params: {
        source: 'studio-creations',
        initialId: 'gen-1',
      },
    });
  });
});
